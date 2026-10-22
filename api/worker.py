"""Single worker process polling the jobs table for long Earth Engine runs."""

from __future__ import annotations

import json
import time

from core.db import audit, init_db, session, utcnow
from core.gee import GeeUnavailable, gee_enabled, initialize
from core.seed import seed_demo


def claim_next() -> str | None:
    with session() as conn:
        row = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if not row:
            return None
        job_id = row["id"]
        conn.execute(
            "UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?",
            (utcnow(), job_id),
        )
        audit(conn, "worker", "job_started", "job", job_id, {})
        return job_id


def run_job(job_id: str) -> None:
    with session() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        params = json.loads(row["params_json"])
        kind = row["kind"]

    try:
        if kind == "screen_for_change":
            result = _run_pwtt(params)
        else:
            raise RuntimeError(f"unknown job kind {kind}")
        with session() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'succeeded', result_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(result), utcnow(), job_id),
            )
            audit(conn, "worker", "job_succeeded", "job", job_id, result)
    except Exception as exc:
        with session() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
                (str(exc), utcnow(), job_id),
            )
            audit(conn, "worker", "job_failed", "job", job_id, {"error": str(exc)})


def _run_pwtt(params: dict) -> dict:
    if not gee_enabled():
        raise GeeUnavailable(
            "PWTT needs Earth Engine. Demo detections are pre-seeded in SQLite. "
            "Set ENABLE_LIVE_GEE=true and GEE_SERVICE_ACCOUNT_JSON for a live run."
        )
    initialize()
    # Tiling + Export.image.toCloudStorage belongs here for large AOIs.
    # Interactive getInfo on a large AOI is how these projects stall.
    return {
        "status": "not_implemented_live",
        "note": "GEE is authenticated; tiled PWTT export is the next worker increment.",
        "params": params,
    }


def loop(poll_seconds: float = 2.0) -> None:
    init_db()
    with session() as conn:
        seed_demo(conn)
    while True:
        job_id = claim_next()
        if job_id:
            run_job(job_id)
        else:
            time.sleep(poll_seconds)


def run() -> None:
    loop()


if __name__ == "__main__":
    run()
