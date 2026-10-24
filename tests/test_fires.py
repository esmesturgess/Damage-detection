"""Fire detections: NASA FIRMS hotspots near a site, returned as data and recorded."""

import json
from datetime import date

import httpx
import pytest
from pydantic import SecretStr

from core import config, fires
from core.db import connect, init_db, session
from core.fires import FiresError, search_fire_detections

BOX = {"type": "Polygon", "coordinates": [[[92.36, 20.79], [92.42, 20.79], [92.42, 20.85], [92.36, 20.85], [92.36, 20.79]]]}
VIIRS_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type"
MODIS_HEADER = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type"


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(config.settings, "database_path", tmp_path / "t.db")
    monkeypatch.setattr(config.settings, "firms_map_key", SecretStr("TESTKEY"))
    conn = connect()
    init_db(conn)
    conn.close()


def fake_firms(rows_by_source=None, reply=None, seen=None):
    def handler(request):
        parts = request.url.path.split("/")  # /api/area/csv/KEY/SOURCE/AREA/DAYS/DATE
        if seen is not None:
            seen.append({"key": parts[4], "source": parts[5], "area": parts[6], "days": int(parts[7]), "date": parts[8]})
        if reply is not None:
            return httpx.Response(200, text=reply)
        source = parts[5]
        header = VIIRS_HEADER if source.startswith("VIIRS") else MODIS_HEADER
        rows = [r for r in (rows_by_source or {}).get(source, []) if r.split(",")[5] == parts[8]]
        return httpx.Response(200, text="\n".join([header, *rows]) + "\n")

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_requests_cover_the_window_in_five_day_chunks_per_sensor():
    seen = []
    search_fire_detections(aoi=BOX, start_date="2017-08-25", end_date="2017-09-15", client=fake_firms(seen=seen))
    # 22 days -> 5 chunks; 2017 has MODIS and VIIRS S-NPP archive data, not NOAA-20 (2018)
    assert sorted({s["source"] for s in seen}) == ["MODIS_SP", "VIIRS_SNPP_SP"]
    assert len(seen) == 10 and sum(s["days"] for s in seen if s["source"] == "MODIS_SP") == 22
    west, south, east, north = map(float, seen[0]["area"].split(","))
    assert west < 92.36 < 92.42 < east and south < 20.79 < 20.85 < north  # west,south,east,north
    assert seen[0]["key"] == "TESTKEY"


def test_recent_days_use_the_near_real_time_feed():
    calls = fires._plan(date.today(), date.today())
    assert {c[0] for c in calls} == {"MODIS_NRT", "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT"}


def test_detections_are_normalised_filtered_and_sorted():
    rows = {
        "VIIRS_SNPP_SP": [
            "20.80,92.38,340.1,0.4,0.4,2017-08-30,0645,N,VIIRS,h,1,290,12.3,D,0",  # inside the box
            "20.80,92.50,330.0,0.4,0.4,2017-08-25,1840,N,VIIRS,n,1,290,3.0,N,0",  # ~8 km east: outside 2 km
        ],
        "MODIS_SP": ["20.81,92.40,320.5,1.0,1.0,2017-08-25,0410,T,MODIS,72,6.03,300,25.0,D,0"],
    }
    out = search_fire_detections(aoi=BOX, start_date="2017-08-25", end_date="2017-09-15", client=fake_firms(rows))
    assert out["count"] == 2
    first, second = out["detections"]
    assert (first["source"], first["acq_time"], first["confidence"], first["pixel_m"]) == ("MODIS_SP", "04:10", "72%", 1000)
    assert (second["source"], second["confidence"], second["daynight"], second["type"]) == (
        "VIIRS_SNPP_SP", "high", "day", "presumed vegetation fire"
    )
    assert second["distance_km"] == 0 and second["frp_mw"] == 12.3
    assert (first["satellite"], second["satellite"]) == ("Terra", "S-NPP")


def test_no_judgement_fields():
    rows = {"VIIRS_SNPP_SP": ["20.80,92.38,340.1,0.4,0.4,2017-08-30,0645,N,VIIRS,h,1,290,12.3,D,0"]}
    d = search_fire_detections(aoi=BOX, start_date="2017-08-25", end_date="2017-09-15", client=fake_firms(rows))["detections"][0]
    assert not {"score", "likely", "verdict", "match", "burned"} & set(d)


def test_search_is_recorded_against_the_site_without_the_key():
    from core.seed import seed_demo

    conn = connect()
    seed_demo(conn)
    conn.commit()
    sid = conn.execute("SELECT id FROM sites WHERE name LIKE 'Demo A%'").fetchone()["id"]
    conn.close()
    search_fire_detections(sid, searched_by="amira", client=fake_firms())
    latest = fires.latest_fire_search(sid)
    assert latest["count"] == 0 and latest["searched_by"] == "amira"
    with session() as c:
        audit = c.execute("SELECT * FROM audit_log WHERE action='fire_detections_searched'").fetchone()
        dump = json.dumps([dict(r) for r in c.execute("SELECT * FROM fire_searches")]) + audit["payload_json"]
    assert audit["entity_id"] == sid and "TESTKEY" not in dump


def test_bad_key_and_missing_key_say_what_to_do(monkeypatch):
    with pytest.raises(FiresError, match="rejected the key"):
        search_fire_detections(aoi=BOX, start_date="2017-08-25", end_date="2017-08-26", client=fake_firms(reply="Invalid MAP_KEY."))
    monkeypatch.setattr(config.settings, "firms_map_key", SecretStr(""))
    with pytest.raises(FiresError, match="FIRMS_MAP_KEY"):
        search_fire_detections(aoi=BOX, start_date="2017-08-25", end_date="2017-08-26")


def test_window_limits():
    with pytest.raises(FiresError, match="366"):
        search_fire_detections(aoi=BOX, start_date="2016-01-01", end_date="2017-09-15", client=fake_firms())
    with pytest.raises(FiresError, match="before"):
        search_fire_detections(aoi=BOX, start_date="2017-09-15", end_date="2017-08-25", client=fake_firms())
