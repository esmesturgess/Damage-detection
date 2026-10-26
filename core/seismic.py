"""Seismic check: damaging earthquakes near a site during its window.

Earthquakes collapse buildings, which changes radar, and can also start fires,
so the check runs on any site and its result sits beside the site's burn
signal for an investigator to weigh. The result is a flag, never an
exclusion: arson and earthquakes can co-occur. Uses the USGS FDSN event
service and ShakeMap grids (no API key).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from core.db import audit, row_to_dict, session
from core.geo import centroid_lonlat, parse_geometry

FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"
MMI_DAMAGE_THRESHOLD = 6  # MMI VI: structural damage begins

# Distance is measured to the epicentre, but a large earthquake ruptures a
# fault hundreds of km long (Sagaing 2025, M7.7: ~450 km). A fixed radius
# misses sites on the far end of the rupture, so reach scales with magnitude
# and ShakeMap MMI at the site makes the actual call.
REACH_KM_BY_MAGNITUDE = ((7.0, 800.0), (6.0, 400.0), (0.0, 300.0))
MAX_SEARCH_RADIUS_KM = REACH_KM_BY_MAGNITUDE[0][1]
FALLBACK_RADIUS_KM = 300.0  # magnitude-only flag when no ShakeMap is available


def check_seismic_confound(site_ids: list[str], window_days: int = 30) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    with session() as conn:
        for site_id in site_ids:
            row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
            site = row_to_dict(row)
            if not site:
                results.append({"site_id": site_id, "error": "not_found"})
                continue

            geom = parse_geometry(site["geometry"])
            lon, lat = centroid_lonlat(geom)
            window_start, window_end, window_source = _detection_window(site)
            start = window_start - timedelta(days=window_days)
            events = _query_fdsn(lat, lon, start.isoformat(), window_end.isoformat())
            for ev in events:
                ev["distance_km"] = _distance_km(ev, lat, lon)
            events = [ev for ev in events if _within_reach(ev)]
            enriched = [_with_shakemap_mmi(ev, lat, lon) for ev in events]
            for ev in enriched:
                ev["days_before_event_window"] = _days_before(ev, window_start)
            damaging = [e for e in enriched if (e.get("modelled_mmi") or 0) >= MMI_DAMAGE_THRESHOLD]
            if not damaging and enriched:
                # Fall back: close M>=6 is still worth a flag even without ShakeMap.
                damaging = [
                    e
                    for e in enriched
                    if (e.get("magnitude") or 0) >= 6.0
                    and (e.get("distance_km") or 0) <= FALLBACK_RADIUS_KM
                ]

            flag = "possible_seismic" if damaging else "unexplained_change"
            payload = {
                "site_id": site_id,
                "consulted": True,
                "flag": flag,
                # Strongest shaking at the site first, so truncation never
                # drops the main shock behind its aftershocks.
                "events": sorted(
                    enriched,
                    key=lambda e: (e.get("modelled_mmi") or 0, e.get("magnitude") or 0),
                    reverse=True,
                )[:10],
                "window_days": window_days,
                "searched": {
                    "start": start.isoformat(),
                    "end": window_end.isoformat(),
                    "window_source": window_source,
                },
                "note": "Flag only. Never an auto-exclusion.",
            }
            import json

            conn.execute(
                "UPDATE sites SET seismic_json = ? WHERE id = ?",
                (json.dumps(payload), site_id),
            )
            audit(conn, "model", "check_seismic_confound", "site", site_id, {"flag": flag})
            results.append(payload)
    return results


def _detection_window(site: dict[str, Any]) -> tuple[date, date, str]:
    """The event window the change was detected in.

    Earthquakes are searched from window_days before its start to its end.
    Falls back to the row's created_at only when no window was recorded,
    which for a seeded or re-run site is not when the change happened.
    """
    window = (site.get("timestamps") or {}).get("event_window")
    if window and len(window) == 2:
        return date.fromisoformat(window[0]), date.fromisoformat(window[1]), "event_window"
    created = datetime.fromisoformat(site["created_at"].replace("Z", "+00:00")).date()
    return created, created, "created_at_fallback"


def _days_before(event: dict[str, Any], window_start: date) -> int | None:
    """Days from the earthquake to the start of the event window (negative: inside it)."""
    ms = event.get("time")
    if ms is None:
        return None
    quake = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date()
    return (window_start - quake).days


def _reach_km(magnitude: float | None) -> float:
    m = magnitude or 0.0
    return next(km for floor, km in REACH_KM_BY_MAGNITUDE if m >= floor)


def _within_reach(event: dict[str, Any]) -> bool:
    if event.get("error") or event.get("distance_km") is None:
        return True  # keep errors visible; can't filter what has no location
    return event["distance_km"] <= _reach_km(event.get("magnitude"))


def _distance_km(event: dict[str, Any], lat: float, lon: float) -> float | None:
    """Great-circle distance from the site to the epicentre."""
    import math

    elat, elon = event.get("latitude"), event.get("longitude")
    if elat is None or elon is None:
        return None
    p1, p2 = math.radians(lat), math.radians(elat)
    dp, dl = p2 - p1, math.radians(elon - lon)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * 6371.0 * math.asin(math.sqrt(a)), 1)


def _query_fdsn(lat: float, lon: float, start: str, end: str) -> list[dict[str, Any]]:
    params = {
        "format": "geojson",
        "starttime": start,
        "endtime": end,
        "latitude": lat,
        "longitude": lon,
        "maxradiuskm": MAX_SEARCH_RADIUS_KM,
        "minmagnitude": 4.5,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.get(FDSN, params=params)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as exc:
        return [{"error": f"fdsn_unavailable: {exc}"}]

    out = []
    for feat in data.get("features", []):
        props = feat.get("properties") or {}
        coords = (feat.get("geometry") or {}).get("coordinates") or [None, None, None]
        out.append(
            {
                "event_id": feat.get("id"),
                "magnitude": props.get("mag"),
                "place": props.get("place"),
                "time": props.get("time"),
                "url": props.get("url"),
                "longitude": coords[0],
                "latitude": coords[1],
                "depth_km": coords[2],
            }
        )
    return out


def _with_shakemap_mmi(event: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    """Best-effort ShakeMap grid sample. Failures leave modelled_mmi null."""
    event_id = event.get("event_id")
    if not event_id or event.get("error"):
        return event
    detail_url = f"https://earthquake.usgs.gov/fdsnws/event/1/query"
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            r = client.get(detail_url, params={"format": "geojson", "eventid": event_id})
            r.raise_for_status()
            detail = r.json()
            products = (
                (detail.get("properties") or {})
                .get("products", {})
                .get("shakemap", [])
            )
            if not products:
                event["modelled_mmi"] = None
                event["shakemap"] = False
                return event
            contents = products[0].get("contents") or {}
            grid = contents.get("download/grid.xml") or contents.get("grid.xml")
            if not grid or not grid.get("url"):
                event["modelled_mmi"] = None
                event["shakemap"] = False
                return event
            xml = client.get(grid["url"]).text
            event["modelled_mmi"] = _sample_grid_xml(xml, lat, lon)
            event["shakemap"] = True
    except Exception:
        event["modelled_mmi"] = None
        event["shakemap"] = False
    return event


def _sample_grid_xml(xml: str, lat: float, lon: float) -> float | None:
    """Nearest-neighbour MMI from a ShakeMap grid.xml.

    grid_data is nlat x nlon rows, north to south then west to east, one
    whitespace-separated line per point in grid_field order. Attribute order
    on grid_specification varies, so it is read by name. A site outside the
    grid returns None rather than an edge value.
    """
    import re

    spec_m = re.search(r"<grid_specification([^>]*)/?>", xml)
    data_m = re.search(r"<grid_data>(.*?)</grid_data>", xml, re.S)
    if not spec_m or not data_m:
        return None
    spec = dict(re.findall(r'(\w+)="([^"]*)"', spec_m.group(1)))
    fields = {
        name: int(index) - 1
        for index, name in re.findall(r'<grid_field\s+index="(\d+)"\s+name="([^"]+)"', xml)
    }
    if "MMI" not in fields:
        return None
    try:
        lat_min, lat_max = float(spec["lat_min"]), float(spec["lat_max"])
        lon_min, lon_max = float(spec["lon_min"]), float(spec["lon_max"])
        nlat, nlon = int(spec["nlat"]), int(spec["nlon"])
    except (KeyError, ValueError):
        return None
    if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
        return None
    if nlat < 2 or nlon < 2:
        return None

    ri = round((lat_max - lat) / (lat_max - lat_min) * (nlat - 1))
    ci = round((lon - lon_min) / (lon_max - lon_min) * (nlon - 1))
    rows = data_m.group(1).strip().splitlines()
    if len(rows) < nlat * nlon:
        return None
    values = rows[ri * nlon + ci].split()
    # Each row carries its own LON/LAT: confirm the index landed next to the site.
    if "LON" in fields and "LAT" in fields:
        spacing = max((lat_max - lat_min) / (nlat - 1), (lon_max - lon_min) / (nlon - 1))
        if (
            abs(float(values[fields["LON"]]) - lon) > spacing
            or abs(float(values[fields["LAT"]]) - lat) > spacing
        ):
            return None
    return float(values[fields["MMI"]])
