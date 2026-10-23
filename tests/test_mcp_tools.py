"""MCP tools as an agent calls them, through the MCP layer's own argument handling."""

import asyncio
import json

import pytest

from core.config import settings
from core.db import connect, init_db, session
from core.seed import seed_demo
from mcp_server.server import mcp

BOX = {"type": "Polygon", "coordinates": [[[92.36, 20.79], [92.42, 20.79], [92.42, 20.85], [92.36, 20.85], [92.36, 20.79]]]}


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_path", tmp_path / "t.db")
    conn = connect()
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    conn.close()


def call(name, args):
    content, _ = asyncio.run(mcp.call_tool(name, args))
    return json.loads(content[0].text)


def test_prior_reports_take_an_area_as_geojson_text(monkeypatch):
    # Optional text arguments get JSON-parsed by the MCP layer; the area must survive that.
    monkeypatch.setattr(settings, "acled_sample", True)
    out = call("search_prior_reports", {"aoi_geojson": json.dumps(BOX), "start_date": "2017-09-01", "end_date": "2017-09-30"})
    assert out["searched_by"] == "agent" and out["count"] > 0


def test_bundle_reports_the_verification_level_not_a_status():
    bundle = call("get_evidence_bundle", {"site_id": _demo_site("Demo A")})
    assert bundle["verification"]["level"] in {"detected", "corroborated", "verified", "disputed", "ruled_out"}
    assert "status" not in bundle and "human_verdict_required" not in bundle


def _demo_site(prefix):
    with session() as conn:
        return conn.execute("SELECT id FROM sites WHERE name LIKE ?", (prefix + "%",)).fetchone()["id"]
