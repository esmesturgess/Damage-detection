import json
import logging
from urllib.parse import parse_qs

import httpx
import pytest

from core import config, prior_reports
from core.db import connect, init_db
from core.geo import box_around
from core.investigations import start_investigation
from core.prior_reports import AcledClient, PriorReportsError, latest_search, search_prior_reports

PASSWORD = "hunter2-not-a-real-password"
EVENT = {"start": "2017-08-25", "end": "2017-09-15"}


@pytest.fixture(autouse=True)
def db(tmp_path):
    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    conn.close()


def _event(event_id, lon, lat, day="2017-08-28", geo=1, time_=1):
    return {
        "event_id_cnty": event_id,
        "event_date": day,
        "time_precision": str(time_),
        "event_type": "Violence against civilians",
        "sub_event_type": "Attack",
        "location": "Maungdaw",
        "admin1": "Rakhine",
        "latitude": str(lat),
        "longitude": str(lon),
        "geo_precision": str(geo),
        "source": "Reuters; Radio Free Asia",
        "notes": "Houses were set on fire.",
        "fatalities": "0",
    }


class FakeAcled:
    """Stands in for ACLED: counts sign-ins and pages, can expire tokens."""

    def __init__(self, pages=None, reject_tokens=0, refresh_ok=True):
        self.pages = pages or [[]]
        self.reject_tokens = reject_tokens
        self.refresh_ok = refresh_ok
        self.password_grants = 0
        self.refresh_grants = 0
        self.reads = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            form = parse_qs(request.content.decode())
            if form["grant_type"] == ["refresh_token"]:
                self.refresh_grants += 1
                if not self.refresh_ok:
                    return httpx.Response(400, json={"error": "invalid_grant"})
            else:
                self.password_grants += 1
            n = self.password_grants + self.refresh_grants
            return httpx.Response(
                200, json={"access_token": f"tok-{n}", "refresh_token": f"ref-{n}", "expires_in": 86400}
            )
        if self.reject_tokens:
            self.reject_tokens -= 1
            return httpx.Response(401, json={"message": "expired"})
        self.reads.append(dict(request.url.params))
        page = int(request.url.params.get("page", 1))
        data = self.pages[page - 1] if page <= len(self.pages) else []
        return httpx.Response(200, json={"status": 200, "success": True, "data": data})


def _client(fake):
    return AcledClient("me@example.org", PASSWORD, transport=httpx.MockTransport(fake))


def test_reports_are_data_sorted_nearest_first_with_codebook_wording():
    near = _event("MMR1", 92.381, 20.821, geo=1)
    far = _event("MMR2", 92.43, 20.82, geo=3, time_=3)
    outside_radius = _event("MMR3", 92.60, 20.82)
    fake = FakeAcled(pages=[[far, outside_radius, near]])
    aoi = {"type": "Point", "coordinates": [92.38, 20.82]}

    result = search_prior_reports(aoi=aoi, start_date=EVENT["start"], end_date=EVENT["end"], client=_client(fake))

    assert [r["source_id"] for r in result["reports"]] == ["MMR1", "MMR2"]
    first, second = result["reports"]
    assert first["distance_km"] < 0.5
    assert first["sources"] == ["Reuters", "Radio Free Asia"]
    assert second["geo_precision_text"].startswith("Only a larger region")
    assert second["time_precision_text"] == "Sometime during a month"
    # No judgement fields of any kind.
    assert not {"verdict", "confidence", "match", "score", "rationale"} & set(first)


def test_search_pads_dates_and_reports_how_far_outside_each_falls():
    early = _event("MMR1", 92.38, 20.82, day="2017-08-01", time_=3)
    fake = FakeAcled(pages=[[early]])
    aoi = {"type": "Point", "coordinates": [92.38, 20.82]}
    result = search_prior_reports(aoi=aoi, start_date=EVENT["start"], end_date=EVENT["end"], client=_client(fake))

    sent = fake.reads[0]
    assert sent["event_date"] == "2017-07-25|2017-10-16"
    assert sent["event_date_where"] == "BETWEEN"
    assert sent["latitude_where"] == sent["longitude_where"] == "BETWEEN"
    assert result["reports"][0]["days_outside_window"] == 24


def test_investigation_area_counts_inside_as_zero_km_and_uses_its_window():
    inv = start_investigation(box_around(92.38, 20.82, 5), {"start": "2016-08-01", "end": "2017-07-31"}, EVENT, "Ka Nyin Tan")
    fake = FakeAcled(pages=[[_event("MMR1", 92.39, 20.83), _event("MMR2", 92.38, 20.82 + 0.0226 + 0.03)]])
    result = search_prior_reports(inv["site_id"], client=_client(fake))

    assert result["reports"][0]["distance_km"] == 0
    assert 2.5 < result["reports"][1]["distance_km"] < 4
    assert result["searched"]["dates"] == [EVENT["start"], EVENT["end"]]


def test_empty_result_is_recorded_as_a_finding():
    inv = start_investigation(box_around(92.38, 20.82, 5), {"start": "2016-08-01", "end": "2017-07-31"}, EVENT, "Ka Nyin Tan")
    result = search_prior_reports(inv["site_id"], searched_by="esme", client=_client(FakeAcled()))

    assert result["reports"] == [] and result["count"] == 0
    saved = latest_search(inv["site_id"])
    assert saved["count"] == 0 and saved["searched_by"] == "esme"
    conn = connect()
    action = conn.execute("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY created_at DESC", (inv["site_id"],)).fetchone()
    conn.close()
    assert action["action"] == "prior_reports_searched"


def test_pages_past_the_row_cap(monkeypatch):
    monkeypatch.setattr(prior_reports, "PAGE_SIZE", 2)
    rows = [_event(f"MMR{i}", 92.38, 20.82) for i in range(5)]
    fake = FakeAcled(pages=[rows[:2], rows[2:4], rows[4:]])
    aoi = {"type": "Point", "coordinates": [92.38, 20.82]}
    result = search_prior_reports(aoi=aoi, start_date=EVENT["start"], end_date=EVENT["end"], client=_client(fake))

    assert result["count"] == 5 and result["truncated"] is False
    assert [r["page"] for r in fake.reads] == ["1", "2", "3"]


def test_too_many_pages_is_flagged_never_silently_cut(monkeypatch):
    monkeypatch.setattr(prior_reports, "PAGE_SIZE", 1)
    monkeypatch.setattr(prior_reports, "MAX_PAGES", 2)
    fake = FakeAcled(pages=[[_event(f"MMR{i}", 92.38, 20.82)] for i in range(5)])
    aoi = {"type": "Point", "coordinates": [92.38, 20.82]}
    result = search_prior_reports(aoi=aoi, start_date=EVENT["start"], end_date=EVENT["end"], client=_client(fake))

    assert result["truncated"] is True


def test_token_is_reused_across_searches():
    fake = FakeAcled()
    client = _client(fake)
    aoi = {"type": "Point", "coordinates": [92.38, 20.82]}
    for _ in range(3):
        search_prior_reports(aoi=aoi, start_date=EVENT["start"], end_date=EVENT["end"], client=client)
    assert fake.password_grants == 1


def test_expired_token_refreshes_once_and_retries_once():
    fake = FakeAcled(reject_tokens=1)
    client = _client(fake)
    client.read({})
    assert fake.refresh_grants == 1 and len(fake.reads) == 1

    fake.reject_tokens = 2
    with pytest.raises(PriorReportsError):
        client.read({})


def test_proactive_refresh_before_expiry(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(prior_reports.time, "monotonic", lambda: clock[0])
    fake = FakeAcled()
    client = _client(fake)
    client.read({})
    clock[0] += 0.91 * 86400
    client.read({})
    assert fake.password_grants == 1 and fake.refresh_grants == 1


def test_dead_refresh_token_signs_in_again(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(prior_reports.time, "monotonic", lambda: clock[0])
    fake = FakeAcled(refresh_ok=False)
    client = _client(fake)
    client.read({})
    clock[0] += 15 * 86400
    client.read({})
    assert fake.refresh_grants == 1 and fake.password_grants == 2


def test_not_configured_is_a_clear_error():
    with pytest.raises(PriorReportsError, match="not configured"):
        AcledClient("", "")


def test_credentials_never_reach_logs_or_the_database(caplog, tmp_path):
    caplog.set_level(logging.DEBUG)
    inv = start_investigation(box_around(92.38, 20.82, 5), {"start": "2016-08-01", "end": "2017-07-31"}, EVENT, "Ka Nyin Tan")
    fake = FakeAcled(pages=[[_event("MMR1", 92.38, 20.82)]], reject_tokens=1)
    result = search_prior_reports(inv["site_id"], client=_client(fake))

    dump = "\n".join(connect().iterdump())
    secrets = [PASSWORD, "tok-1", "tok-2", "ref-1", "ref-2", "me@example.org"]
    for secret in secrets:
        assert secret not in caplog.text
        assert secret not in dump
        assert secret not in json.dumps(result)
    assert PASSWORD not in repr(config.settings)
