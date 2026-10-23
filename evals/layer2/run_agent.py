"""Run each fixture question through an agent and score its tool calls.

The agent is Claude Code in non-interactive mode, given only this project's
MCP server (.mcp.json): its built-in tools (shell, files, web) are switched
off, so everything it learns comes through the burn-evidence tools. Runs on
the signed-in Claude Code account; no API key is needed.

  python evals/layer2/run_agent.py                 # every fixture
  python evals/layer2/run_agent.py maungdaw_2017   # some fixtures
  python evals/layer2/run_agent.py --model sonnet  # a different model

Each run works on a snapshot of the database in evals/layer2/runs/<timestamp>/,
with its own scan worker, so agent searches and scans never reach the real
audit trail. Transcripts and scores are saved there too. Scans need Earth
Engine credentials.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from core.config import settings  # noqa: E402
from scoring import score  # noqa: E402

FIXTURES = Path(__file__).with_name("tool_sequences.json")
RUNS = Path(__file__).with_name("runs")
SERVER = "burn-evidence"
PREFIX = f"mcp__{SERVER}__"
TIMEOUT_S = 20 * 60
ROLE = (
    "You are the evidence-gathering agent for a burn and destruction evidence tool used by "
    "investigators. Answer using the burn-evidence tools only, report what they returned with "
    "their caveats, and do not give verdicts."
)


def snapshot(out_dir: Path) -> Path:
    """Copy the app database for this run, so the agent's searches and scans stay out of the real one."""
    copy = out_dir / "app.db"
    with sqlite3.connect(settings.database_path) as src, sqlite3.connect(copy) as dst:
        src.backup(dst)
    return copy


def mcp_config(out_dir: Path, db: Path) -> Path:
    path = out_dir / "mcp.json"
    server = {"command": sys.executable, "args": ["-m", "mcp_server.server"], "env": {"DATABASE_PATH": str(db)}}
    path.write_text(json.dumps({"mcpServers": {SERVER: server}}, indent=1))
    return path


def demo_site_ids(db: Path) -> dict[str, str]:
    """{"Demo A": "site_...", ...} from the seeded demo sites."""
    with sqlite3.connect(db) as conn:
        rows = conn.execute("SELECT id, name FROM sites WHERE name LIKE 'Demo %'").fetchall()
    return {m.group(0): sid for sid, name in rows if (m := re.match(r"Demo [A-Z]", name or ""))}


def fill(question: str, ids: dict[str, str]) -> str:
    def swap(m: re.Match) -> str:
        if m.group(1) not in ids:
            raise SystemExit(f"No seeded site '{m.group(1)}'. Start the API once to seed the demo sites.")
        return ids[m.group(1)]

    return re.sub(r"\{(Demo [A-Z])\}", swap, question)


def run_agent(question: str, config: Path, model: str | None) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict]]:
    cmd = [
        "claude", "-p", question,
        "--mcp-config", str(config), "--strict-mcp-config",
        "--tools", "",
        "--allowedTools", f"mcp__{SERVER}",
        "--append-system-prompt", ROLE,
        "--output-format", "stream-json", "--verbose",
        "--no-session-persistence",
    ]  # fmt: skip
    if model:
        cmd += ["--model", model]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=TIMEOUT_S)
    events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip().startswith("{")]
    if not events:
        raise RuntimeError(f"claude produced no output (exit {proc.returncode}): {proc.stderr[-500:]}")

    calls: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    final: dict[str, Any] = {}
    for ev in events:
        content = (ev.get("message") or {}).get("content")
        if ev.get("type") == "assistant" and isinstance(content, list):
            for block in content:
                if block.get("type") == "tool_use":
                    call = {"name": block["name"].removeprefix(PREFIX), "input": block.get("input"), "result": None}
                    by_id[block["id"]] = call
                    calls.append(call)
        elif ev.get("type") == "user" and isinstance(content, list):
            for block in content:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in by_id:
                    result = block.get("content")
                    if isinstance(result, list):  # MCP results arrive as text blocks
                        result = "".join(b.get("text", "") for b in result if isinstance(b, dict))
                    by_id[block["tool_use_id"]].update(result=result, is_error=bool(block.get("is_error")))
        elif ev.get("type") == "result":
            final = {k: ev.get(k) for k in ("result", "num_turns", "duration_ms", "total_cost_usd", "is_error")}
    return calls, final, events


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("fixtures", nargs="*", help="fixture ids (default: all)")
    ap.add_argument("--model")
    args = ap.parse_args()

    fixtures = json.loads(FIXTURES.read_text())["fixtures"]
    if args.fixtures:
        fixtures = [f for f in fixtures if f["id"] in args.fixtures]
    out_dir = RUNS / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir.mkdir(parents=True, exist_ok=True)
    db = snapshot(out_dir)
    config = mcp_config(out_dir, db)
    ids = demo_site_ids(db)
    worker = subprocess.Popen(
        [sys.executable, "-u", "-m", "api.worker"],
        cwd=ROOT,
        env={**os.environ, "DATABASE_PATH": str(db)},
        stdout=(out_dir / "worker.log").open("w"),
        stderr=subprocess.STDOUT,
    )
    try:
        summary = run_fixtures(fixtures, ids, config, out_dir, args.model)
    finally:
        worker.terminate()
        worker.wait(timeout=30)

    passed = sum(s["passed"] for s in summary)
    (out_dir / "summary.json").write_text(json.dumps({"model": args.model, "results": summary}, indent=1))
    print(f"\n{passed}/{len(summary)} fixtures passed · transcripts in {out_dir.relative_to(ROOT)}")


def run_fixtures(fixtures: list[dict], ids: dict[str, str], config: Path, out_dir: Path, model: str | None) -> list[dict]:
    summary = []
    for fx in fixtures:
        question = fill(fx["question"], ids)
        print(f"\n▸ {fx['id']}: {question}", flush=True)
        started = time.time()
        calls, final, events = run_agent(question, config, model)
        scored = score(fx, calls)
        for c in scored["checks"]:
            print(f"   {'✓' if c['ok'] else '✗'} {c['check']}" + (f"  ({c['detail']})" if not c["ok"] and c["detail"] else ""))
        print(f"   tools: {' → '.join(scored['tool_calls']) or 'none'}  ·  {time.time() - started:.0f}s")
        record = {"fixture": fx, "question": question, "calls": calls, "final": final, "score": scored}
        (out_dir / f"{fx['id']}.json").write_text(json.dumps(record, indent=1, default=str))
        (out_dir / f"{fx['id']}.stream.jsonl").write_text("\n".join(json.dumps(e) for e in events))
        summary.append({"id": fx["id"], "passed": scored["passed"], "tools": scored["tool_calls"]})
    return summary


if __name__ == "__main__":
    main()
