"""Investigations: an area, a time window and an optional question.

An investigation is a site row with kind='investigation' and a polygon
geometry, so evidence, checks, verdicts, history and the overlay work on it
unchanged. Hot-spots (kind='hotspot', point geometry) inside its area and
window are linked to it through parent_id.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from shapely.geometry import shape

from core.db import audit, new_id, row_to_dict, session, utcnow
from core.geo import area_km2, calibration_status_for, geojson_of, in_rakhine, parse_geometry

NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "burn-evidence (open-source research tool; https://github.com/esmesturgess/Damage-detection)"
_place_cache: dict[tuple[float, float, int], dict[str, Any]] = {}


class InvestigationError(ValueError):
    pass


def place_name(lat: float, lon: float, area_km2_: float | None = None) -> dict[str, Any]:
    """English and local place name for a point, from OpenStreetMap.

    Small areas get the village; larger ones the town or township.
    """
    zoom = 14 if (area_km2_ or 0) <= 40 else 12 if area_km2_ <= 400 else 10
    key = (round(lat, 3), round(lon, 3), zoom)
    if key in _place_cache:
        return _place_cache[key]
    try:
        with httpx.Client(timeout=15.0, headers={"User-Agent": USER_AGENT}) as client:
            r = client.get(
                NOMINATIM,
                params={
                    "format": "jsonv2",
                    "lat": lat,
                    "lon": lon,
                    "zoom": zoom,
                    "namedetails": 1,
                    "accept-language": "en",
                },
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError:
        return {"name_en": None, "name_local": None, "context": None}
    names = data.get("namedetails") or {}
    english = names.get("name:en") or data.get("name")
    local = names.get("name")
    address = data.get("address") or {}
    result = {
        "name_en": english,
        "name_local": local if local and local != english else None,
        "context": ", ".join(
            v for v in (address.get("county"), address.get("state"), address.get("country")) if v
        )
        or data.get("display_name"),
        "region": address.get("state"),
    }
    _place_cache[key] = result  # Nominatim allows 1 request/s; the cache keeps repeat lookups off it
    return result


def find_overlaps(aoi_geojson: dict[str, Any], window: dict[str, str]) -> list[dict[str, Any]]:
    """Investigations whose area intersects this one and whose dates overlap."""
    geom = parse_geometry(aoi_geojson)
    with session() as conn:
        rows = conn.execute("SELECT * FROM sites WHERE kind = 'investigation'").fetchall()
        candidates = [row_to_dict(r) for r in rows]
        out = []
        for site in candidates:
            other = (site.get("timestamps") or {}).get("event_window")
            if not other or not _dates_overlap(window, other):
                continue
            if not shape(site["geometry"]).intersects(geom):
                continue
            from core.evidence import verification

            out.append(
                {
                    "id": site["id"],
                    "name": site["name"],
                    "name_local": site.get("name_local"),
                    "event_window": other,
                    "level": verification(conn, site["id"])["level"],
                }
            )
    return out


def start_investigation(
    aoi_geojson: dict[str, Any],
    baseline_window: dict[str, str],
    event_window: dict[str, str],
    name: str,
    name_local: str | None = None,
    question: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise InvestigationError("An investigation needs a name (the place name is suggested).")
    geom = parse_geometry(aoi_geojson)
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise InvestigationError("An investigation needs an area, not a point.")
    site_id = new_id("site")
    now = utcnow()
    with session() as conn:
        conn.execute(
            """
            INSERT INTO sites (
                id, kind, name, name_local, question, created_by, geometry_geojson, status,
                calibration_status, optical_read, timestamps_json, region, is_demo, created_at
            ) VALUES (?, 'investigation', ?, ?, ?, ?, ?, 'pending_review', ?, 'unknown', ?, ?, 0, ?)
            """,
            (
                site_id,
                name[:200],
                (name_local or "").strip()[:200] or None,
                (question or "").strip()[:2000] or None,
                (created_by or "").strip()[:64] or None,
                json.dumps(geojson_of(geom)),
                calibration_status_for(geom),
                json.dumps(
                    {
                        "event_window": [event_window["start"], event_window["end"]],
                        "baseline_window": [baseline_window["start"], baseline_window["end"]],
                    }
                ),
                "rakhine" if in_rakhine(geom) else None,
                now,
            ),
        )
        attached = _attach_hotspots(conn, site_id, geom, event_window)
        audit(
            conn,
            created_by or "investigator",
            "investigation_started",
            "site",
            site_id,
            {"name": name, "area_km2": round(area_km2(geom), 2), "hotspots_attached": attached},
        )
    return {"site_id": site_id, "hotspots_attached": attached}


def hotspots_of(investigation_id: str) -> list[dict[str, Any]]:
    with session() as conn:
        rows = conn.execute(
            "SELECT * FROM sites WHERE parent_id = ? ORDER BY pwtt_z DESC", (investigation_id,)
        ).fetchall()
    return [row_to_dict(r) for r in rows]


def attach_to_investigations(conn, site_id: str, point: dict[str, Any], window: dict[str, str]) -> str | None:
    """Link a new hot-spot to the most recent investigation covering it, if any."""
    pt = parse_geometry(point)
    for row in conn.execute(
        "SELECT id, geometry_geojson, timestamps_json FROM sites WHERE kind = 'investigation' ORDER BY created_at DESC"
    ):
        other = (json.loads(row["timestamps_json"] or "{}")).get("event_window")
        if other and _dates_overlap(window, other) and shape(json.loads(row["geometry_geojson"])).covers(pt):
            conn.execute("UPDATE sites SET parent_id = ? WHERE id = ?", (row["id"], site_id))
            return row["id"]
    return None


def _attach_hotspots(conn, investigation_id: str, geom, window: dict[str, str]) -> int:
    n = 0
    for row in conn.execute(
        "SELECT id, geometry_geojson, timestamps_json FROM sites WHERE kind = 'hotspot' AND parent_id IS NULL AND is_demo = 0"
    ).fetchall():
        other = (json.loads(row["timestamps_json"] or "{}")).get("event_window")
        if other and _dates_overlap(window, other) and geom.covers(shape(json.loads(row["geometry_geojson"]))):
            conn.execute("UPDATE sites SET parent_id = ? WHERE id = ?", (investigation_id, row["id"]))
            n += 1
    return n


def _dates_overlap(a: dict[str, str] | list[str], b: list[str]) -> bool:
    a_start, a_end = (a["start"], a["end"]) if isinstance(a, dict) else (a[0], a[1])
    return a_start <= b[1] and b[0] <= a_end
