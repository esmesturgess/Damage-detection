"""Human-in-the-loop boundary. No code path lets the model set confirmed."""

from __future__ import annotations

import json
from typing import Any

from core.db import audit, new_id, row_to_dict, session, utcnow

ALLOWED = {"confirm", "reject", "unsure", "explained", "disputed"}


class VerdictError(ValueError):
    pass


def set_verdict(site_id: str, verdict: str, analyst: str, note: str | None = None) -> dict[str, Any]:
    if verdict not in ALLOWED:
        raise VerdictError(f"verdict must be one of {sorted(ALLOWED)}")
    status = {
        "confirm": "confirmed",
        "reject": "rejected",
        "unsure": "unsure",
        "explained": "explained",
        "disputed": "disputed",
    }[verdict]

    with session() as conn:
        row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        site = row_to_dict(row)
        if not site:
            raise VerdictError("site not found")

        snapshot = {
            "burn_probability": site.get("burn_probability"),
            "burn_threshold": site.get("burn_threshold"),
            "pwtt_z": site.get("pwtt_z"),
            "features": site.get("features"),
            "calibration_status": site.get("calibration_status"),
            "optical_read": site.get("optical_read"),
            "seismic": site.get("seismic"),
        }
        vid = new_id("vrd")
        now = utcnow()
        conn.execute(
            """
            INSERT INTO verdicts (id, site_id, verdict, analyst, model_snapshot_json, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (vid, site_id, verdict, analyst, json.dumps(snapshot), note, now),
        )
        conn.execute("UPDATE sites SET status = ? WHERE id = ?", (status, site_id))
        audit(
            conn,
            analyst,
            "verdict",
            "site",
            site_id,
            {"verdict": verdict, "status": status, "verdict_id": vid},
        )
        return {
            "verdict_id": vid,
            "site_id": site_id,
            "verdict": verdict,
            "status": status,
            "analyst": analyst,
            "model_snapshot": snapshot,
            "created_at": now,
        }
