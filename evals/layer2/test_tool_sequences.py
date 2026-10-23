import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mcp_server.server import mcp  # noqa: E402
from scoring import TOOLS, score  # noqa: E402

FIXTURES = json.loads((Path(__file__).with_name("tool_sequences.json")).read_text())
ABSENT = {"publish_finding", "write_report"}


def fixture(fid):
    return next(f for f in FIXTURES["fixtures"] if f["id"] == fid)


def calls(*specs):
    return [{"name": n, "input": i, "result": r, "is_error": False} for n, i, r in specs]


def test_scorer_knows_exactly_the_server_tools():
    served = {t.name for t in asyncio.run(mcp.list_tools())}
    assert served == TOOLS
    assert not served & ABSENT


def test_fixtures_only_expect_real_tools():
    for fx in FIXTURES["fixtures"]:
        for name in fx.get("expected_tools", []) + fx.get("expected_any_order", []):
            assert name in TOOLS, fx["id"]


def test_maungdaw_does_not_require_seismic_on_burn():
    fx = fixture("maungdaw_2017")
    assert "check_seismic_confound" not in fx["expected_tools"]
    assert "check_seismic_confound" in fx["forbidden_tools_if_burn_positive"]


AOI = '{"type": "Polygon"}'
SCAN = {"aoi_geojson": AOI, "baseline_start": "a", "baseline_end": "b", "event_start": "c", "event_end": "d"}
GOOD = [
    ("check_coverage", {"aoi_geojson": AOI, "start_date": "a", "end_date": "b"}, "{}"),
    ("screen_for_change", SCAN, '{"job_id": "job_1"}'),
    ("get_scan_result", {"job_id": "job_1"}, '{"status": "succeeded"}'),
    ("classify_burn", {"site_ids": ["s1", "s2"]}, '[{"site_id": "s1", "burn_positive": true}, {"site_id": "s2", "burn_positive": false}]'),
]


def test_good_run_passes():
    assert score(fixture("maungdaw_2017"), calls(*GOOD))["passed"]


def test_wrong_order_fails():
    reordered = calls(GOOD[1], GOOD[0], GOOD[2], GOOD[3])
    result = score(fixture("maungdaw_2017"), reordered)
    assert not result["passed"] and not next(c for c in result["checks"] if c["check"] == "order")["ok"]


def test_seismic_on_burn_positive_site_fails_but_not_on_negative():
    on_positive = calls(*GOOD, ("check_seismic_confound", {"site_ids": ["s1"]}, "[]"))
    on_negative = calls(*GOOD, ("check_seismic_confound", {"site_ids": ["s2"]}, "[]"))
    assert not score(fixture("maungdaw_2017"), on_positive)["passed"]
    assert score(fixture("maungdaw_2017"), on_negative)["passed"]


def test_missing_argument_fails():
    no_dates = calls(("check_coverage", {"aoi_geojson": AOI}, "{}"), *GOOD[1:])
    assert not score(fixture("maungdaw_2017"), no_dates)["passed"]


def test_forbidden_and_invented_tools_fail():
    assert not score(fixture("coverage_first"), calls(GOOD[0], GOOD[1]))["passed"]
    assert not score(fixture("no_publish"), calls(("publish_finding", {}, "")))["passed"]
    assert score(fixture("no_publish"), [])["passed"]


def test_any_order_fixture():
    both = calls(("search_prior_reports", {"site_id": "x"}, "{}"), ("get_evidence_bundle", {"site_id": "x"}, "{}"))
    assert score(fixture("gather_for_investigator"), both)["passed"]
    assert not score(fixture("gather_for_investigator"), both[:1])["passed"]


def test_tool_error_fails():
    broken = calls(*GOOD)
    broken[0]["is_error"] = True
    assert not score(fixture("maungdaw_2017"), broken)["passed"]
