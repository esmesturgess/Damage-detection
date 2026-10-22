"""Pixel-Wise T-Test change screening (Ballinger).

Each pixel is tested against its own prior Sentinel-1 time series, so no
regional training is needed. This module queues the job; the worker runs it
on Earth Engine.
"""

from __future__ import annotations

import json
from typing import Any

from core.config import settings
from core.db import audit, new_id, session, utcnow
from core.gee import gee_enabled
from core.geo import assert_aoi_size, geojson_of, parse_geometry


def screen_for_change(
    aoi_geojson: str | dict[str, Any],
    baseline_window: dict[str, str],
    event_window: dict[str, str],
    z_threshold: float | None = None,
) -> str:
    """Queue a PWTT job. Returns job_id. Long GEE work happens in the worker."""
    geom = parse_geometry(aoi_geojson)
    assert_aoi_size(geom)
    z = z_threshold if z_threshold is not None else settings.default_z_threshold
    params = {
        "aoi": geojson_of(geom),
        "baseline_window": baseline_window,
        "event_window": event_window,
        "z_threshold": z,
        "live_gee": gee_enabled(),
    }
    job_id = new_id("job")
    now = utcnow()
    with session() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, kind, status, params_json, created_at, updated_at)
            VALUES (?, 'screen_for_change', 'queued', ?, ?, ?)
            """,
            (job_id, json.dumps(params), now, now),
        )
        audit(conn, "system", "job_queued", "job", job_id, {"kind": "screen_for_change"})
    return job_id

