"""Readable activity history for one site, from the audit log.

Evidence submitters are never named: their audit rows use a generic actor.
"""

from __future__ import annotations

import json
from typing import Any

from core.db import session

FLAG_TEXT = {"possible_seismic": "possible earthquake cause", "unexplained_change": "no damaging earthquake"}
VERDICT_TEXT = {
    "confirm": "signed off as verified",
    "reject": "marked as a false detection",
    "unsure": "marked as unsure",
    "explained": "marked as explained",
    "disputed": "marked as disputed",
}


def site_history(site_id: str) -> list[dict[str, Any]]:
    with session() as conn:
        evidence_ids = [r["id"] for r in conn.execute("SELECT id FROM evidence WHERE site_id = ?", (site_id,))]
        marks = ",".join("?" * len(evidence_ids)) or "''"
        rows = conn.execute(
            f"""
            SELECT actor, action, payload_json, created_at FROM audit_log
            WHERE (entity_type = 'site' AND entity_id = ?)
               OR (entity_type = 'evidence' AND entity_id IN ({marks}))
            ORDER BY created_at
            """,
            (site_id, *evidence_ids),
        ).fetchall()
    events = []
    for row in rows:
        payload = json.loads(row["payload_json"]) if row["payload_json"] else {}
        summary = _summary(row["action"], row["actor"], payload)
        if summary:
            events.append({"at": row["created_at"], "summary": summary})
    return events


def _summary(action: str, actor: str, payload: dict[str, Any]) -> str | None:
    if action == "hotspot_detected":
        return "Detected by a radar change scan"
    if action == "classify_burn":
        return "Burn classifier run"
    if action == "check_seismic_confound":
        return f"Earthquake check: {FLAG_TEXT.get(payload.get('flag'), payload.get('flag'))}"
    if action == "evidence_added":
        return f"Evidence added ({payload.get('kind', 'item')})"
    if action == "evidence_checked":
        return f"{actor} checked evidence: located {payload.get('located')}, dated {payload.get('dated')}"
    if action == "verdict":
        return f"{actor} {VERDICT_TEXT.get(payload.get('verdict'), payload.get('verdict'))}"
    return None
