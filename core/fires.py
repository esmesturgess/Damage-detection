"""Fire detections: NASA FIRMS active-fire hotspots near a site and its dates.

Search and display only, like prior reports. Each detection is a satellite
pixel that was hotter than its surroundings when the satellite passed:
when, where, which sensor, the sensor's own confidence, and fire radiative
power. Nothing here decides whether a detection is a house fire, a crop
burn or a gas flare; an investigator reads them.

Every search is recorded against the site, including one that finds nothing.

API: https://firms.modaps.eosdis.nasa.gov/api/area/ (free MAP_KEY; 5,000
transactions per 10 minutes; at most 5 days per request).
"""

from __future__ import annotations

import csv
import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

import httpx

from core.config import settings
from core.db import audit, new_id, row_to_dict, session, utcnow
from core.geo import parse_geometry
from core.prior_reports import _expanded_bounds, _km_from

AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{area}/{days}/{day}"
KEY_URL = "https://firms.modaps.eosdis.nasa.gov/api/map_key/"
DAYS_PER_CALL = 5  # FIRMS's maximum
MAX_WINDOW_DAYS = 366
MAX_DETECTIONS = 5_000  # beyond this the result is marked truncated, never silently cut
DEFAULT_RADIUS_KM = 2.0
# Standard-processing (archive) data lags; newer days come from the near-real-time feed.
NRT_DAYS = 90

# (archive source, near-real-time source, first day of data), per sensor.
SENSORS = [
    ("MODIS_SP", "MODIS_NRT", date(2000, 11, 1)),
    ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", date(2012, 1, 20)),
    ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", date(2018, 4, 1)),
]
# FIRMS attribute tables: VIIRS confidence is l/n/h, MODIS 0-100; type is archive only.
VIIRS_CONFIDENCE = {"l": "low", "n": "nominal", "h": "high"}
FIRE_TYPE = {
    "0": "presumed vegetation fire",
    "1": "active volcano",
    "2": "other static land source",
    "3": "offshore",
}


class FiresError(RuntimeError):
    pass


def search_fire_detections(
    site_id: str | None = None,
    aoi: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    radius_km: float = DEFAULT_RADIUS_KM,
    searched_by: str = "investigator",
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """FIRMS detections within radius_km of a site (or area) during its event window, earliest first."""
    key = settings.firms_map_key.get_secret_value()
    if not key:
        raise FiresError(f"Fire detections need a free NASA FIRMS key: add FIRMS_MAP_KEY to .env ({KEY_URL}).")
    if not 0 < radius_km <= 50:
        raise FiresError("radius_km must be between 0 and 50.")
    if site_id:
        with session() as conn:
            site = row_to_dict(conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone())
        if not site:
            raise FiresError("site not found")
        aoi = site["geometry"]
        window = (site.get("timestamps") or {}).get("event_window")
        start_date = start_date or (window[0] if window else None)
        end_date = end_date or (window[1] if window else None)
    if not aoi or not start_date or not end_date:
        raise FiresError("Give a site, or an area with start and end dates.")
    start, end = date.fromisoformat(start_date), min(date.fromisoformat(end_date), date.today())
    if end < start:
        raise FiresError("end_date is before start_date.")
    if (end - start).days + 1 > MAX_WINDOW_DAYS:
        raise FiresError(f"Search at most {MAX_WINDOW_DAYS} days at a time.")

    geom = parse_geometry(aoi)
    west, south, east, north = _expanded_bounds(geom, radius_km)
    area = f"{west:.4f},{south:.4f},{east:.4f},{north:.4f}"
    calls = _plan(start, end)

    own = client is None
    client = client or httpx.Client(timeout=60.0)
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(lambda c: _fetch(client, key, c[0], area, c[1], c[2]), calls))
    finally:
        if own:
            client.close()

    detections: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for source, rows in batches:
        for row in rows:
            d = _normalise(row, source, geom)
            ident = (d["source"], d["lat"], d["lon"], d["acq_date"], d["acq_time"])
            if d["distance_km"] <= radius_km and start.isoformat() <= d["acq_date"] <= end.isoformat() and ident not in seen:
                seen.add(ident)
                detections.append(d)
    detections.sort(key=lambda d: (d["acq_date"], d["acq_time"], d["distance_km"]))
    truncated = len(detections) > MAX_DETECTIONS
    detections = detections[:MAX_DETECTIONS]

    searched = {
        "radius_km": radius_km,
        "dates": [start.isoformat(), end.isoformat()],
        "sources": sorted({c[0] for c in calls}),
        "bounds": [round(v, 4) for v in (west, south, east, north)],
    }
    search_id = new_id("fir")
    now = utcnow()
    with session() as conn:
        conn.execute(
            """
            INSERT INTO fire_searches (id, site_id, params_json, result_count, truncated, detections_json, searched_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (search_id, site_id, json.dumps(searched), len(detections), int(truncated), json.dumps(detections), searched_by[:64], now),
        )
        if site_id:
            audit(conn, searched_by, "fire_detections_searched", "site", site_id, {**searched, "found": len(detections)})
    return {
        "search_id": search_id,
        "searched": searched,
        "searched_by": searched_by,
        "searched_at": now,
        "truncated": truncated,
        "count": len(detections),
        "detections": detections,
    }


def latest_fire_search(site_id: str) -> dict[str, Any] | None:
    """The most recent saved search for a site, so the page needn't ask FIRMS again."""
    with session() as conn:
        row = conn.execute(
            "SELECT * FROM fire_searches WHERE site_id = ? ORDER BY created_at DESC LIMIT 1", (site_id,)
        ).fetchone()
    if not row:
        return None
    return {
        "search_id": row["id"],
        "searched": json.loads(row["params_json"]),
        "searched_by": row["searched_by"],
        "searched_at": row["created_at"],
        "truncated": bool(row["truncated"]),
        "count": row["result_count"],
        "detections": json.loads(row["detections_json"] or "[]"),
    }


def _plan(start: date, end: date) -> list[tuple[str, date, int]]:
    """(source, first day, number of days) for each request: 5-day chunks per sensor that covers them."""
    recent = date.today() - timedelta(days=NRT_DAYS)
    calls = []
    day = start
    while day <= end:
        days = min(DAYS_PER_CALL, (end - day).days + 1)
        for archive, nrt, first in SENSORS:
            if day + timedelta(days=days - 1) >= first:
                calls.append((nrt if day >= recent else archive, day, days))
        day += timedelta(days=days)
    return calls


def _fetch(client: httpx.Client, key: str, source: str, area: str, day: date, days: int) -> tuple[str, list[dict]]:
    url = AREA_URL.format(key=key, source=source, area=area, days=days, day=day.isoformat())
    try:
        res = client.get(url)
    except httpx.HTTPError as exc:
        raise FiresError("NASA FIRMS is unreachable right now. Try again shortly.") from exc
    text = res.text.strip()
    # FIRMS answers problems in plain text ("Invalid MAP_KEY.") rather than with a CSV.
    if res.status_code != 200 or not text.startswith("latitude"):
        detail = text.splitlines()[0][:160] if text else f"HTTP {res.status_code}"
        if "map_key" in detail.lower():
            raise FiresError(f"NASA FIRMS rejected the key ({detail}). Check FIRMS_MAP_KEY in .env.")
        raise FiresError(f"NASA FIRMS error: {detail}")
    return source, list(csv.DictReader(io.StringIO(text)))


def _normalise(row: dict[str, str], source: str, geom) -> dict[str, Any]:
    lat, lon = float(row["latitude"]), float(row["longitude"])
    hhmm = (row.get("acq_time") or "").zfill(4)
    raw_conf = (row.get("confidence") or "").strip()
    viirs = source.startswith("VIIRS")
    confidence = VIIRS_CONFIDENCE.get(raw_conf.lower(), raw_conf) if viirs else (f"{raw_conf}%" if raw_conf else None)
    brightness = row.get("bright_ti4") if viirs else row.get("brightness")
    return {
        "source": source,
        "satellite": row.get("satellite"),
        "instrument": row.get("instrument") or ("VIIRS" if viirs else "MODIS"),
        "lat": lat,
        "lon": lon,
        "distance_km": round(_km_from(geom, lon, lat), 2),
        "acq_date": row.get("acq_date"),
        "acq_time": f"{hhmm[:2]}:{hhmm[2:]}",
        "daynight": {"D": "day", "N": "night"}.get(row.get("daynight", ""), None),
        "confidence": confidence,
        "frp_mw": _float(row.get("frp")),
        "brightness_k": _float(brightness),
        "type": FIRE_TYPE.get((row.get("type") or "").strip()),
        "pixel_m": 375 if viirs else 1000,
    }


def _float(value: Any) -> float | None:
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None
