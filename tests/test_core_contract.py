import inspect

import core
from core import burn, seismic


def test_core_does_not_import_web_frameworks():
    source = inspect.getsource(core)
    assert "fastapi" not in source
    assert "mcp" not in inspect.getsource(burn)
    assert "fastapi" not in inspect.getsource(seismic)


def test_seismic_skips_burn_positive(tmp_path, monkeypatch):
    from core import config
    from core.db import connect, init_db
    from core.seed import seed_demo
    from core.seismic import check_seismic_confound

    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    burn_id = conn.execute(
        "SELECT id FROM sites WHERE burn_probability >= burn_threshold LIMIT 1"
    ).fetchone()["id"]
    conn.close()

    out = check_seismic_confound([burn_id])
    assert out[0]["consulted"] is False
    assert out[0]["reason"] == "burn_positive"


def test_seismic_searches_event_window_not_created_at(tmp_path, monkeypatch):
    from core import config, seismic
    from core.db import connect, init_db
    from core.seed import seed_demo

    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    # Demo B: change without burn, event window 2025-03-20 → 2025-04-10.
    site_id = conn.execute(
        "SELECT id FROM sites WHERE name LIKE 'Demo B%'"
    ).fetchone()["id"]
    conn.close()

    calls = []
    sagaing = {
        "event_id": "us7000pn9s",
        "magnitude": 7.7,
        "time": 1743147793000,  # 2025-03-28 07:43 UTC
        "latitude": 22.01,
        "longitude": 95.92,
    }

    def fake_fdsn(lat, lon, start, end):
        calls.append((start, end))
        return [dict(sagaing)]

    monkeypatch.setattr(seismic, "_query_fdsn", fake_fdsn)
    monkeypatch.setattr(
        seismic, "_with_shakemap_mmi", lambda ev, lat, lon: {**ev, "modelled_mmi": 8.0}
    )

    out = seismic.check_seismic_confound([site_id], window_days=30)

    assert calls == [("2025-02-18", "2025-04-10")]
    assert out[0]["flag"] == "possible_seismic"
    assert out[0]["searched"]["window_source"] == "event_window"
    assert out[0]["events"][0]["days_before_event_window"] == -8


def test_shakemap_grid_parsed_in_usgs_attribute_order():
    from core.seismic import _sample_grid_xml

    # Real USGS grid.xml order: lon_min lat_min lon_max lat_max ... nlon nlat.
    # Rows run north to south, west to east.
    xml = """<shakemap_grid>
<grid_specification lon_min="95.0" lat_min="21.0" lon_max="96.0" lat_max="22.0"
 nominal_lon_spacing="1.0" nominal_lat_spacing="1.0" nlon="2" nlat="2"/>
<grid_field index="1" name="LON" units="dd" />
<grid_field index="2" name="LAT" units="dd" />
<grid_field index="3" name="MMI" units="intensity" />
<grid_data>
95.0 22.0 6.1
96.0 22.0 8.4
95.0 21.0 5.2
96.0 21.0 7.3
</grid_data>
</shakemap_grid>"""
    assert _sample_grid_xml(xml, 21.9, 95.9) == 8.4
    assert _sample_grid_xml(xml, 21.1, 95.1) == 5.2
    assert _sample_grid_xml(xml, 25.0, 95.5) is None  # outside the grid


def test_seismic_reach_scales_with_magnitude():
    from core.seismic import _within_reach

    # A small quake 500 km away is noise; a great one that far can still
    # have ruptured towards the site, so ShakeMap gets to decide.
    assert not _within_reach({"magnitude": 5.0, "distance_km": 500.0})
    assert _within_reach({"magnitude": 7.7, "distance_km": 500.0})
    assert not _within_reach({"magnitude": 7.7, "distance_km": 900.0})
    assert _within_reach({"error": "fdsn_unavailable"})


def test_imagery_needs_earth_engine(monkeypatch):
    from fastapi.testclient import TestClient

    from api.main import app
    from core import config

    monkeypatch.setattr(config.settings, "enable_live_gee", False)
    box = {"type": "Polygon", "coordinates": [[[92.3, 20.8], [92.4, 20.8], [92.4, 20.9], [92.3, 20.9], [92.3, 20.8]]]}
    res = TestClient(app).post(
        "/imagery/analysis",
        json={
            "aoi_geojson": box,
            "baseline_window": {"start": "2016-08-01", "end": "2017-07-31"},
            "event_window": {"start": "2017-08-01", "end": "2017-09-30"},
        },
    )
    assert res.status_code == 503
