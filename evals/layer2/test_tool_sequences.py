import json
from pathlib import Path


FIXTURES = json.loads((Path(__file__).with_name("tool_sequences.json")).read_text())

IMPLEMENTED = {
    "check_coverage",
    "screen_for_change",
    "classify_burn",
    "check_seismic_confound",
    "get_evidence_bundle",
}
ABSENT = {"publish_finding", "write_report"}


def test_expected_tools_exist():
    for fx in FIXTURES["fixtures"]:
        for name in fx.get("expected_tools", []):
            assert name in IMPLEMENTED, fx["id"]


def test_publish_tools_do_not_exist():
    for name in ABSENT:
        assert name not in IMPLEMENTED


def test_maungdaw_does_not_require_seismic_on_burn():
    fx = next(f for f in FIXTURES["fixtures"] if f["id"] == "maungdaw_2017")
    assert "check_seismic_confound" not in fx["expected_tools"]
    assert "check_seismic_confound" in fx["forbidden_tools_if_burn_positive"]
