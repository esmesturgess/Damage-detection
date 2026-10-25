"""Deployment guards: the API's shared secret and the daily scan limit."""

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from api import main
from core import config
from core.db import connect, init_db, session, utcnow


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config.settings, "database_path", tmp_path / "t.db")
    conn = connect()
    init_db(conn)
    conn.close()
    return TestClient(main.app)


def test_secret_required_except_health(client, monkeypatch):
    monkeypatch.setattr(config.settings, "api_shared_secret", SecretStr("s3cret"))
    assert client.get("/health").status_code == 200
    assert client.get("/sites").status_code == 401
    assert client.get("/sites", headers={"x-api-secret": "wrong"}).status_code == 401
    assert client.get("/sites", headers={"x-api-secret": "s3cret"}).status_code == 200


def test_no_secret_configured_means_open(client):
    assert client.get("/sites").status_code == 200


def test_daily_scan_limit(client, monkeypatch):
    monkeypatch.setattr(config.settings, "max_scans_per_day", 2)
    with session() as conn:
        for i in range(2):
            conn.execute(
                "INSERT INTO jobs (id, kind, status, params_json, created_at, updated_at) VALUES (?, 'screen_for_change', 'succeeded', '{}', ?, ?)",
                (f"job_{i}", utcnow(), utcnow()),
            )
    box = {"type": "Polygon", "coordinates": [[[92.36, 20.79], [92.37, 20.79], [92.37, 20.80], [92.36, 20.80], [92.36, 20.79]]]}
    res = client.post("/jobs", json={"aoi_geojson": box, "baseline_window": {"start": "2016-08-01", "end": "2017-07-31"},
                                     "event_window": {"start": "2017-08-01", "end": "2017-09-30"}})
    assert res.status_code == 429 and "daily limit" in res.json()["detail"]


def test_health_reports_demo_mode(client, monkeypatch):
    monkeypatch.setattr(config.settings, "demo_mode", True)
    assert client.get("/health").json()["demo_mode"] is True
