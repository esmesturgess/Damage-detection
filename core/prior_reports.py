"""Prior reports: documented incidents near a site, from ACLED.

Search and display only. Reports are returned as data: distance, dates,
precision and ACLED's own description and sources. Nothing here judges
whether a report describes the same event as the satellite change; an
investigator reads them and may add one as evidence.

Every search is recorded (who, where, when, how many results), because
"we looked and found nothing" is itself a finding.

ACLED API: https://acleddata.com/api-documentation/getting-started
Precision codes: ACLED Codebook, "Spatial precision codes" and
"Time precision codes" (https://acleddata.com/methodology/acled-codebook).
"""

from __future__ import annotations

import json
import math
import threading
import time
from datetime import date, timedelta
from typing import Any

import httpx
import shapely
from shapely.geometry import Point

from core.config import settings
from core.db import audit, new_id, row_to_dict, session, utcnow
from core.geo import centroid_lonlat, parse_geometry

TOKEN_URL = "https://acleddata.com/oauth/token"
READ_URL = "https://acleddata.com/api/acled/read"
PAGE_SIZE = 5_000  # ACLED's default row cap; larger pulls must page
MAX_PAGES = 10  # beyond this the result is marked truncated, never silently cut
REFRESH_AT = 0.9  # refresh the access token at 90% of its lifetime

DEFAULT_RADIUS_KM = 10.0
# An event dated "sometime that month" (time precision 3) may be coded to a
# day outside the site's window, so the search reaches a month either side.
# Each report carries days_outside_window so the padding is visible.
DATE_PADDING_DAYS = 31

# Wording from the ACLED Codebook, shown beside each report.
GEO_PRECISION = {
    1: "Town named in reporting; coordinates are that town",
    2: "Near a town, or a small part of a region; coded to a nearby town",
    3: "Only a larger region named; coded to a representative location",
}
TIME_PRECISION = {
    1: "Exact date reported",
    2: "Sometime during a week or similar period",
    3: "Sometime during a month",
}

FIELDS = (
    "event_id_cnty|event_date|time_precision|disorder_type|event_type|sub_event_type|"
    "actor1|actor2|civilian_targeting|country|admin1|admin2|admin3|location|"
    "latitude|longitude|geo_precision|source|source_scale|notes|fatalities|timestamp"
)


class PriorReportsError(RuntimeError):
    pass


class AcledClient:
    """ACLED read client with OAuth password-grant tokens.

    The access token lives 24 h and the refresh token 14 days. Tokens are
    refreshed before they expire, a 401 triggers one refresh and one retry,
    and a dead refresh token falls back to signing in again. Credentials and
    tokens are never logged or returned.
    """

    def __init__(self, username: str, password: str, transport: httpx.BaseTransport | None = None):
        if not username or not password:
            raise PriorReportsError(
                "ACLED is not configured: set ACLED_USERNAME and ACLED_PASSWORD in .env."
            )
        self._username = username
        self._password = password
        self._http = httpx.Client(timeout=60.0, transport=transport)
        self._lock = threading.Lock()  # one refresh at a time
        self._access: str | None = None
        self._refresh: str | None = None
        self._refresh_after = 0.0

    def read(self, params: dict[str, Any]) -> dict[str, Any]:
        r = self._http.get(READ_URL, params=params, headers=self._auth_header())
        if r.status_code == 401:
            self._renew(force=True)
            r = self._http.get(READ_URL, params=params, headers=self._auth_header())
        if r.status_code == 401:
            raise PriorReportsError("ACLED refused the credentials.")
        r.raise_for_status()
        data = r.json()
        if data.get("success") is False or (data.get("status") not in (None, 200)):
            raise PriorReportsError(f"ACLED error: {data.get('messages') or data.get('error')}")
        return data

    def _auth_header(self) -> dict[str, str]:
        if self._access is None or time.monotonic() >= self._refresh_after:
            self._renew()
        return {"Authorization": f"Bearer {self._access}"}

    def _renew(self, force: bool = False) -> None:
        with self._lock:
            if not force and self._access and time.monotonic() < self._refresh_after:
                return  # another thread already renewed it
            if self._refresh:
                r = self._http.post(
                    TOKEN_URL,
                    data={"refresh_token": self._refresh, "grant_type": "refresh_token", "client_id": "acled"},
                )
                if r.status_code == 200:
                    self._store(r.json())
                    return
            r = self._http.post(
                TOKEN_URL,
                data={
                    "username": self._username,
                    "password": self._password,
                    "grant_type": "password",
                    "client_id": "acled",
                    "scope": "authenticated",
                },
            )
            if r.status_code != 200:
                raise PriorReportsError(f"ACLED sign-in failed (HTTP {r.status_code}).")
            self._store(r.json())

    def _store(self, token: dict[str, Any]) -> None:
        self._access = token["access_token"]
        self._refresh = token.get("refresh_token") or self._refresh
        self._refresh_after = time.monotonic() + REFRESH_AT * float(token.get("expires_in", 86_400))


_client: AcledClient | None = None


def acled_client() -> AcledClient:
    global _client
    if _client is None:
        _client = AcledClient(settings.acled_username, settings.acled_password.get_secret_value())
    return _client


def search_prior_reports(
    site_id: str | None = None,
    aoi: dict[str, Any] | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    radius_km: float = DEFAULT_RADIUS_KM,
    searched_by: str = "investigator",
    client: AcledClient | None = None,
) -> dict[str, Any]:
    """ACLED events within radius_km of a site (or area) and near its dates.

    Pass a site_id to use the site's own area and event window, or an aoi
    (GeoJSON point or polygon) with dates. Reports are sorted nearest first.
    """
    if not 0 < radius_km <= 100:
        raise PriorReportsError("radius_km must be between 0 and 100.")
    if site_id:
        with session() as conn:
            site = row_to_dict(conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone())
        if not site:
            raise PriorReportsError("site not found")
        aoi = site["geometry"]
        window = (site.get("timestamps") or {}).get("event_window")
        start_date = start_date or (window[0] if window else None)
        end_date = end_date or (window[1] if window else None)
    if not aoi or not start_date or not end_date:
        raise PriorReportsError("Give a site, or an area with start and end dates.")
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if end < start:
        raise PriorReportsError("end_date is before start_date.")

    geom = parse_geometry(aoi)
    west, south, east, north = _expanded_bounds(geom, radius_km)
    query_start, query_end = start - timedelta(days=DATE_PADDING_DAYS), end + timedelta(days=DATE_PADDING_DAYS)
    params = {
        "latitude": f"{south:.5f}|{north:.5f}",
        "latitude_where": "BETWEEN",
        "longitude": f"{west:.5f}|{east:.5f}",
        "longitude_where": "BETWEEN",
        "event_date": f"{query_start.isoformat()}|{query_end.isoformat()}",
        "event_date_where": "BETWEEN",
        "fields": FIELDS,
        "limit": PAGE_SIZE,
    }

    client = client or acled_client()
    rows: list[dict[str, Any]] = []
    truncated = False
    for page in range(1, MAX_PAGES + 1):
        batch = client.read({**params, "page": page}).get("data") or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
    else:
        truncated = True

    reports = []
    for row in rows:
        report = _normalise(row, geom, start, end)
        if report and report["distance_km"] <= radius_km:
            reports.append(report)
    reports.sort(key=lambda r: (r["distance_km"], r["days_outside_window"]))

    searched = {
        "source": "acled",
        "radius_km": radius_km,
        "dates": [start.isoformat(), end.isoformat()],
        "dates_searched": [query_start.isoformat(), query_end.isoformat()],
        "bounds": [round(v, 5) for v in (west, south, east, north)],
    }
    search_id = new_id("prs")
    now = utcnow()
    with session() as conn:
        conn.execute(
            """
            INSERT INTO prior_report_searches
                (id, site_id, source, params_json, result_count, truncated, reports_json, searched_by, created_at)
            VALUES (?, ?, 'acled', ?, ?, ?, ?, ?, ?)
            """,
            (
                search_id,
                site_id,
                json.dumps(searched),
                len(reports),
                int(truncated),
                json.dumps(reports),
                searched_by[:64],
                now,
            ),
        )
        if site_id:
            audit(conn, searched_by, "prior_reports_searched", "site", site_id, {**searched, "found": len(reports)})
    return {
        "search_id": search_id,
        "searched": searched,
        "searched_by": searched_by,
        "searched_at": now,
        "truncated": truncated,
        "count": len(reports),
        "reports": reports,
    }


def latest_search(site_id: str) -> dict[str, Any] | None:
    """The most recent saved search for a site, so the overlay needn't query ACLED again."""
    with session() as conn:
        row = conn.execute(
            "SELECT * FROM prior_report_searches WHERE site_id = ? ORDER BY created_at DESC LIMIT 1",
            (site_id,),
        ).fetchone()
    if not row:
        return None
    reports = json.loads(row["reports_json"] or "[]")
    return {
        "search_id": row["id"],
        "searched": json.loads(row["params_json"]),
        "searched_by": row["searched_by"],
        "searched_at": row["created_at"],
        "truncated": bool(row["truncated"]),
        "count": row["result_count"],
        "reports": reports,
    }


def _normalise(row: dict[str, Any], geom, start: date, end: date) -> dict[str, Any] | None:
    try:
        lat, lon = float(row["latitude"]), float(row["longitude"])
        event_date = date.fromisoformat(row["event_date"])
    except (KeyError, TypeError, ValueError):
        return None
    geo_p = _int_or_none(row.get("geo_precision"))
    time_p = _int_or_none(row.get("time_precision"))
    days_outside = (start - event_date).days if event_date < start else (event_date - end).days if event_date > end else 0
    return {
        "source": "acled",
        "source_id": row.get("event_id_cnty"),
        "event_date": event_date.isoformat(),
        "days_outside_window": days_outside,
        "time_precision": time_p,
        "time_precision_text": TIME_PRECISION.get(time_p),
        "latitude": lat,
        "longitude": lon,
        "distance_km": round(_km_from(geom, lon, lat), 1),
        "geo_precision": geo_p,
        "geo_precision_text": GEO_PRECISION.get(geo_p),
        "location": row.get("location"),
        "admin": [a for a in (row.get("admin3"), row.get("admin2"), row.get("admin1")) if a],
        "country": row.get("country"),
        "disorder_type": row.get("disorder_type"),
        "event_type": row.get("event_type"),
        "sub_event_type": row.get("sub_event_type"),
        "actors": [a for a in (row.get("actor1"), row.get("actor2")) if a],
        "civilian_targeting": row.get("civilian_targeting") or None,
        "fatalities": _int_or_none(row.get("fatalities")),
        "notes": row.get("notes"),
        "sources": [s.strip() for s in (row.get("source") or "").split(";") if s.strip()],
        "source_scale": row.get("source_scale"),
    }


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _km_from(geom, lon: float, lat: float) -> float:
    """Distance from a site to a point: 0 inside an area, else to its edge.

    Projects to km around the site's centre; accurate enough at tens of km.
    """
    lon0, lat0 = centroid_lonlat(geom)
    scale = [111.32 * math.cos(math.radians(lat0)), 110.57]
    to_km = lambda coords: (coords - [lon0, lat0]) * scale  # noqa: E731
    return shapely.transform(geom, to_km).distance(shapely.transform(Point(lon, lat), to_km))


def _expanded_bounds(geom, radius_km: float) -> tuple[float, float, float, float]:
    minx, miny, maxx, maxy = geom.bounds
    lat = (miny + maxy) / 2
    d_lat = radius_km / 110.57
    d_lon = radius_km / (111.32 * math.cos(math.radians(lat)))
    return minx - d_lon, miny - d_lat, maxx + d_lon, maxy + d_lat
