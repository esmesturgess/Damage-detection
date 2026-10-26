"""Evidence, checklists, agreement, and the verification ladder.

The level is computed from evidence checks and investigators' verdicts every
time it is read. Nothing stores it, so nothing can set it directly:

  detected      satellite signal only
  corroborated  >=1 item a colleague has located AND dated
  verified      a `confirm` verdict from a colleague, with at least one
                corroborating source. Provisional: the standard is still to be
                decided with OSINT practitioners.
  disputed      verdict: credible evidence on both sides
  ruled_out     verdict: non-hostile cause (crop burn, earthquake...) or a
                false detection. Closed; the reason says which.

Agreement counts are returned for display and queue sorting. They never
enter the level calculation.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from core.db import audit, new_id, row_to_dict, session, utcnow

KINDS = {"link", "testimony", "prior_report"}
VISIBILITY = {"public", "reviewers"}
YES_NO = {"yes", "no", "unsure"}
ORIGINALITY = {"original", "repost", "unsure"}
STANCES = {"agree", "disagree", "unsure"}
MAX_TEXT = 5_000


class EvidenceError(ValueError):
    pass


def add_evidence(
    site_id: str,
    kind: str,
    submitted_by: str,
    url: str | None = None,
    body: str | None = None,
    visibility: str = "public",
    record: dict[str, Any] | None = None,
    is_demo: bool = False,
) -> dict[str, Any]:
    if kind not in KINDS:
        raise EvidenceError(f"kind must be one of {sorted(KINDS)}")
    if visibility not in VISIBILITY:
        raise EvidenceError(f"visibility must be one of {sorted(VISIBILITY)}")
    url = (url or "").strip() or None
    body = (body or "").strip() or None
    # Links are often pasted without a scheme ("youtube.com/watch?v=..."): add one if it looks like an address.
    if kind == "link" and url and not url.startswith(("https://", "http://")) and "." in url and " " not in url:
        url = "https://" + url
    if kind == "link" and not (url and url.startswith(("https://", "http://"))):
        raise EvidenceError("That doesn't look like a web address. Paste the full link, e.g. https://…")
    if kind == "testimony" and not body:
        raise EvidenceError("testimony needs text")
    if kind == "prior_report" and not (record and body):
        raise EvidenceError("a prior report is added from a saved search (core.prior_reports)")
    if (url and len(url) > 2_000) or (body and len(body) > MAX_TEXT):
        raise EvidenceError("evidence is too long")
    handle = (submitted_by or "").strip()[:64] or "anonymous"

    with session() as conn:
        if not conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone():
            raise EvidenceError("site not found")
        eid = new_id("evd")
        conn.execute(
            """
            INSERT INTO evidence (id, site_id, kind, url, body, visibility, submitted_by, record_json, is_demo, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (eid, site_id, kind, url, body, visibility, handle, json.dumps(record) if record else None, int(is_demo), utcnow()),
        )
        # The audit log records that evidence arrived, not who sent it.
        audit(conn, "public", "evidence_added", "site", site_id, {"evidence_id": eid, "kind": kind})
    return {"evidence_id": eid, "site_id": site_id}


def check_evidence(
    evidence_id: str,
    reviewer: str,
    located: str,
    dated: str,
    original: str,
    shares_source_with: list[str] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    if located not in YES_NO or dated not in YES_NO:
        raise EvidenceError(f"located and dated must be one of {sorted(YES_NO)}")
    if original not in ORIGINALITY:
        raise EvidenceError(f"original must be one of {sorted(ORIGINALITY)}")
    with session() as conn:
        row = conn.execute("SELECT site_id, submitted_by FROM evidence WHERE id = ?", (evidence_id,)).fetchone()
        if not row:
            raise EvidenceError("evidence not found")
        if row["submitted_by"] == reviewer:
            raise EvidenceError("reviewers cannot check their own submissions")
        siblings = {
            r["id"]
            for r in conn.execute("SELECT id FROM evidence WHERE site_id = ?", (row["site_id"],))
        }
        shared = sorted(set(shares_source_with or []) & siblings - {evidence_id})
        cid = new_id("chk")
        conn.execute(
            """
            INSERT INTO evidence_checks
                (id, evidence_id, reviewer, located, dated, original, shares_source_with_json, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (cid, evidence_id, reviewer, located, dated, original, json.dumps(shared), note, utcnow()),
        )
        audit(
            conn,
            reviewer,
            "evidence_checked",
            "evidence",
            evidence_id,
            {"located": located, "dated": dated, "original": original, "shares_source_with": shared},
        )
        level = verification(conn, row["site_id"])
    return {"check_id": cid, "evidence_id": evidence_id, "verification": level}


def assess(site_id: str, user: str, stance: str, reason: str | None = None) -> dict[str, Any]:
    if stance not in STANCES:
        raise EvidenceError(f"stance must be one of {sorted(STANCES)}")
    handle = (user or "").strip()[:64]
    if not handle:
        raise EvidenceError("a handle is needed so one person counts once")
    with session() as conn:
        if not conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone():
            raise EvidenceError("site not found")
        conn.execute(
            """
            INSERT INTO assessments (site_id, user, stance, reason, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(site_id, user) DO UPDATE SET stance = excluded.stance,
                reason = excluded.reason, created_at = excluded.created_at
            """,
            (site_id, handle, stance, (reason or "")[:MAX_TEXT] or None, utcnow()),
        )
        return verification(conn, site_id)


def list_evidence(site_id: str, reviewer_view: bool = False) -> list[dict[str, Any]]:
    """Evidence for one site. Submitter identity is never included.

    Public viewers see that reviewer-only items exist and how they were
    checked, but not their content.
    """
    with session() as conn:
        rows = conn.execute(
            "SELECT * FROM evidence WHERE site_id = ? ORDER BY created_at", (site_id,)
        ).fetchall()
        latest = _latest_checks(conn, site_id)
    out = []
    for row in rows:
        item = row_to_dict(row)
        hidden = item["visibility"] == "reviewers" and not reviewer_view
        check = latest.get(item["id"])
        out.append(
            {
                "id": item["id"],
                "kind": item["kind"],
                "visibility": item["visibility"],
                "url": None if hidden else item["url"],
                "body": None if hidden else item["body"],
                "record": None if hidden else item.get("record"),
                "is_demo": bool(item["is_demo"]),
                "created_at": item["created_at"],
                "check": None
                if check is None
                else {
                    "located": check["located"],
                    "dated": check["dated"],
                    "original": check["original"],
                    "shares_source_with": check.get("shares_source_with") or [],
                    "reviewer": check["reviewer"],
                    "note": None if hidden else check.get("note"),
                    "created_at": check["created_at"],
                },
            }
        )
    return out


def verification(conn: sqlite3.Connection, site_id: str) -> dict[str, Any]:
    latest = _latest_checks(conn, site_id)
    corroborating = [eid for eid, c in latest.items() if c["located"] == "yes" and c["dated"] == "yes"]
    sources = _independent_groups(corroborating, latest)

    evidence_count = conn.execute("SELECT COUNT(*) FROM evidence WHERE site_id = ?", (site_id,)).fetchone()[0]
    stances = {
        r["stance"]: r["n"]
        for r in conn.execute(
            "SELECT stance, COUNT(*) AS n FROM assessments WHERE site_id = ? GROUP BY stance", (site_id,)
        )
    }
    verdict = conn.execute(
        "SELECT verdict, analyst FROM verdicts WHERE site_id = ? ORDER BY created_at DESC LIMIT 1",
        (site_id,),
    ).fetchone()
    last = verdict["verdict"] if verdict else None

    ruled_out_reason = None
    if last in ("explained", "reject"):
        level, ruled_out_reason = "ruled_out", ("explained" if last == "explained" else "false_detection")
        why = (
            f"Ruled out by {verdict['analyst']}: a non-hostile cause."
            if last == "explained"
            else f"Ruled out by {verdict['analyst']}: a false detection."
        )
    elif last == "disputed":
        level, why = "disputed", f"{verdict['analyst']} found credible evidence on both sides."
    elif sources and last == "confirm":
        level, why = "verified", f"Signed off by {verdict['analyst']}, with {_sources(len(sources))}."
    elif sources:
        level, why = "corroborated", f"{_sources(len(sources)).capitalize()}; awaiting a colleague's sign-off."
    else:
        level = "detected"
        why = (
            "Satellite signal only. Evidence needs to be located and dated by a colleague."
            if evidence_count
            else "Satellite signal only. No evidence submitted yet."
        )

    return {
        "level": level,
        "why": why,
        "ruled_out_reason": ruled_out_reason,
        "evidence_count": evidence_count,
        "independent_sources": len(sources),
        "agreement": {s: stances.get(s, 0) for s in sorted(STANCES)},
    }


def verification_for(site_id: str) -> dict[str, Any]:
    with session() as conn:
        return verification(conn, site_id)


def _latest_checks(conn: sqlite3.Connection, site_id: str) -> dict[str, dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT c.* FROM evidence_checks c JOIN evidence e ON e.id = c.evidence_id
        WHERE e.site_id = ? ORDER BY c.created_at
        """,
        (site_id,),
    ).fetchall()
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest[row["evidence_id"]] = row_to_dict(row)  # later checks replace earlier ones
    return latest


def _sources(n: int) -> str:
    return f"{n} checked source{'' if n == 1 else 's'}"


def _independent_groups(items: list[str], latest: dict[str, dict[str, Any]]) -> list[set[str]]:
    """Merge items that share a source; ten reposts of one video are one source."""
    parent = {i: i for i in items}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for item in items:
        for other in latest[item].get("shares_source_with") or []:
            if other in parent:
                parent[find(item)] = find(other)
    groups: dict[str, set[str]] = {}
    for item in items:
        groups.setdefault(find(item), set()).add(item)
    return list(groups.values())
