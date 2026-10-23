import json

import pytest

from core import config
from core.db import connect, init_db, new_id, utcnow
from core.geo import box_around
from core.investigations import (
    InvestigationError,
    attach_to_investigations,
    find_overlaps,
    hotspots_of,
    start_investigation,
)

BASELINE = {"start": "2016-08-01", "end": "2017-07-31"}
EVENT = {"start": "2017-08-01", "end": "2017-09-30"}


@pytest.fixture(autouse=True)
def db(tmp_path):
    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    conn.close()


def _hotspot(lon, lat, window=("2017-08-01", "2017-09-30")):
    conn = connect()
    sid = new_id("site")
    conn.execute(
        """
        INSERT INTO sites (id, kind, name, geometry_geojson, status, timestamps_json, is_demo, created_at)
        VALUES (?, 'hotspot', 'hot-spot', ?, 'pending_review', ?, 0, ?)
        """,
        (sid, json.dumps({"type": "Point", "coordinates": [lon, lat]}), json.dumps({"event_window": list(window)}), utcnow()),
    )
    conn.commit()
    conn.close()
    return sid


def test_start_attaches_hotspots_inside_area_and_dates():
    inside = _hotspot(92.38, 20.82)
    outside_area = _hotspot(92.60, 20.82)
    other_dates = _hotspot(92.38, 20.82, ("2019-01-01", "2019-02-28"))
    result = start_investigation(box_around(92.38, 20.82, 5), BASELINE, EVENT, "Ka Nyin Tan", "ကညင်တန်း")
    assert result["hotspots_attached"] == 1
    assert [h["id"] for h in hotspots_of(result["site_id"])] == [inside]
    assert outside_area and other_dates


def test_overlap_needs_both_area_and_dates():
    start_investigation(box_around(92.38, 20.82, 5), BASELINE, EVENT, "Ka Nyin Tan")
    assert len(find_overlaps(box_around(92.39, 20.82, 5), EVENT)) == 1
    assert find_overlaps(box_around(92.60, 20.82, 5), EVENT) == []
    assert find_overlaps(box_around(92.38, 20.82, 5), {"start": "2019-01-01", "end": "2019-02-28"}) == []


def test_name_and_area_are_required():
    with pytest.raises(InvestigationError):
        start_investigation(box_around(92.38, 20.82, 5), BASELINE, EVENT, "  ")
    with pytest.raises(InvestigationError):
        start_investigation({"type": "Point", "coordinates": [92.38, 20.82]}, BASELINE, EVENT, "Somewhere")


def test_later_scan_hotspots_join_the_covering_investigation():
    inv = start_investigation(box_around(92.38, 20.82, 5), BASELINE, EVENT, "Ka Nyin Tan")["site_id"]
    sid = _hotspot(92.381, 20.821)
    conn = connect()
    parent = attach_to_investigations(conn, sid, {"type": "Point", "coordinates": [92.381, 20.821]}, EVENT)
    conn.commit()
    conn.close()
    assert parent == inv
