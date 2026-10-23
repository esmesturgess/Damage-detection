from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from core.config import ROOT, settings

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or settings.database_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


# Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
# existing databases untouched, so these are added in place when missing.
ADDED_COLUMNS = {
    "sites": [
        ("kind", "TEXT NOT NULL DEFAULT 'hotspot'"),  # hotspot | investigation
        ("parent_id", "TEXT"),  # investigation a hot-spot belongs to
        ("name_local", "TEXT"),  # place name in the local language
        ("question", "TEXT"),  # optional prompt that opens an investigation
        ("created_by", "TEXT"),
    ],
}


def init_db(conn: sqlite3.Connection | None = None) -> None:
    own = conn is None
    conn = conn or connect()
    conn.executescript(SCHEMA_PATH.read_text())
    for table, columns in ADDED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sites_parent ON sites(parent_id)")
    conn.commit()
    if own:
        conn.close()


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    for key in (
        "params_json",
        "result_json",
        "features_json",
        "seismic_json",
        "scene_ids_json",
        "timestamps_json",
        "model_snapshot_json",
        "payload_json",
        "shares_source_with_json",
        "geometry_geojson",
    ):
        if key in data and isinstance(data[key], str) and data[key]:
            try:
                parsed = json.loads(data[key])
            except json.JSONDecodeError:
                continue
            data[key.replace("_json", "") if key != "geometry_geojson" else "geometry"] = parsed
    return data


def audit(conn: sqlite3.Connection, actor: str, action: str, entity_type: str, entity_id: str | None, payload: dict | None = None) -> None:
    conn.execute(
        """
        INSERT INTO audit_log (id, actor, action, entity_type, entity_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_id("aud"),
            actor,
            action,
            entity_type,
            entity_id,
            json.dumps(payload) if payload is not None else None,
            utcnow(),
        ),
    )
