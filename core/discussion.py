"""Discussion: an open thread per site and comments on each evidence item.

Comments are conversation, not evidence: they never enter the verification
level. They are append-only, so the record of what was said stays intact.
An investigation's question is shown as the thread's opening post; it lives
on the site row, not here.
"""

from __future__ import annotations

from typing import Any

from core.db import audit, new_id, row_to_dict, session, utcnow

MAX_COMMENT = 5_000


class DiscussionError(ValueError):
    pass


def add_comment(site_id: str, author: str, body: str, evidence_id: str | None = None) -> dict[str, Any]:
    author = (author or "").strip()[:64]
    body = (body or "").strip()
    if not author:
        raise DiscussionError("a handle is needed to comment")
    if not body:
        raise DiscussionError("the comment is empty")
    if len(body) > MAX_COMMENT:
        raise DiscussionError(f"comments are limited to {MAX_COMMENT} characters")
    with session() as conn:
        if not conn.execute("SELECT 1 FROM sites WHERE id = ?", (site_id,)).fetchone():
            raise DiscussionError("site not found")
        if evidence_id and not conn.execute(
            "SELECT 1 FROM evidence WHERE id = ? AND site_id = ?", (evidence_id, site_id)
        ).fetchone():
            raise DiscussionError("that evidence item is not on this site")
        cid = new_id("cmt")
        now = utcnow()
        conn.execute(
            "INSERT INTO comments (id, site_id, evidence_id, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (cid, site_id, evidence_id, author, body, now),
        )
        audit(conn, author, "comment_added", "site", site_id, {"comment_id": cid, "evidence_id": evidence_id})
    return {"id": cid, "site_id": site_id, "evidence_id": evidence_id, "author": author, "body": body, "created_at": now}


def list_comments(site_id: str) -> list[dict[str, Any]]:
    """Every comment on a site, oldest first. evidence_id is null for the open thread."""
    with session() as conn:
        rows = conn.execute(
            "SELECT id, site_id, evidence_id, author, body, created_at FROM comments WHERE site_id = ? ORDER BY created_at",
            (site_id,),
        ).fetchall()
    return [row_to_dict(r) for r in rows]
