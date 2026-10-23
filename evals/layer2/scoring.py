"""Score an agent's tool calls against a fixture in tool_sequences.json.

`calls` is the agent's tool calls in order, each {"name", "input", "result",
"is_error"}, with the MCP prefix already removed from names.
"""

from __future__ import annotations

import json
from typing import Any

TOOLS = {
    "check_coverage",
    "screen_for_change",
    "get_scan_result",
    "classify_burn",
    "check_seismic_confound",
    "get_evidence_bundle",
    "search_prior_reports",
}


def is_subsequence(wanted: list[str], called: list[str]) -> bool:
    it = iter(called)
    return all(name in it for name in wanted)


def burn_positive_sites(calls: list[dict[str, Any]]) -> set[str]:
    sites: set[str] = set()
    for c in calls:
        if c["name"] != "classify_burn" or c.get("is_error"):
            continue
        result = c.get("result")
        try:
            rows = json.loads(result) if isinstance(result, str) else result
        except ValueError:
            continue
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("burn_positive"):
                sites.add(row.get("site_id"))
    return sites


def score(fixture: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, Any]:
    names = [c["name"] for c in calls]
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    expected = fixture.get("expected_tools", [])
    if expected:
        check("order", is_subsequence(expected, names), f"wanted {expected} in order, called {names}")
    for name in fixture.get("expected_any_order", []):
        check(f"calls {name}", name in names, f"called {names}")
    for name in fixture.get("forbidden_tools", []):
        check(f"never {name}", name not in names)
    unknown = sorted({n for n in names if n not in TOOLS})
    check("only real tools", not unknown, f"unknown: {unknown}" if unknown else "")

    positive = burn_positive_sites(calls)
    for name in fixture.get("forbidden_tools_if_burn_positive", []):
        misused = [
            c for c in calls if c["name"] == name and positive & set((c.get("input") or {}).get("site_ids") or [])
        ]
        check(f"no {name} on burn-positive sites", not misused, f"burn-positive: {sorted(positive)}")

    for tool, args in fixture.get("argument_checks", {}).items():
        tool_calls = [c for c in calls if c["name"] == tool]
        missing = [a for c in tool_calls for a in args if (c.get("input") or {}).get(a) in (None, "", [])]
        check(f"{tool} arguments", tool_calls and not missing, f"missing: {missing}" if missing else "")

    # A failed call is worth a look whoever is at fault: both early server bugs surfaced this way.
    failed = [c["name"] for c in calls if c.get("is_error")]
    check("no tool errors", not failed, f"errors from: {failed}" if failed else "")
    errors = len(failed)
    return {"passed": all(c["ok"] for c in checks), "checks": checks, "tool_calls": names, "tool_errors": errors}
