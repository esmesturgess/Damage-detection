"""Place search through Photon, an OpenStreetMap geocoder (photon.komoot.io).

Nothing is stored locally. Photon tolerates small typos and is built for
search-as-you-type; results are biased towards the point the map is looking
at, so a misspelt village near the current view still comes first. The
query and that point are sent to Photon, as the map tiles already are to
their providers. Answers are cached for an hour.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from core.investigations import USER_AGENT

PHOTON = "https://photon.komoot.io/api/"
SOURCE = "Photon · © OpenStreetMap contributors"
_TTL_S = 3600
_cache: dict[tuple, tuple[float, list[dict[str, Any]]]] = {}


class GeocodeError(RuntimeError):
    pass


def search_places(query: str, lat: float | None = None, lon: float | None = None, limit: int = 6) -> dict[str, Any]:
    q = " ".join(query.split())
    if len(q) < 2:
        return {"source": SOURCE, "results": []}
    near = (round(lat, 1), round(lon, 1)) if lat is not None and lon is not None else None
    key = (q.lower(), near, limit)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL_S:
        return {"source": SOURCE, "results": hit[1]}

    params: dict[str, Any] = {"q": q, "limit": limit, "lang": "en"}
    if near:
        # zoom 8 widens the bias to a region: a misspelt village near the view wins over a
        # look-alike abroad, while an exact name elsewhere in the world still comes first.
        params["lat"], params["lon"], params["zoom"] = *near, 8
    try:
        with httpx.Client(timeout=10.0, headers={"User-Agent": USER_AGENT}) as client:
            res = client.get(PHOTON, params=params)
            res.raise_for_status()
            features = res.json().get("features", [])
    except (httpx.HTTPError, ValueError) as exc:
        raise GeocodeError("Place search is unavailable right now. Try coordinates instead.") from exc

    results = [_place(f) for f in features if f.get("geometry", {}).get("type") == "Point"]
    _cache[key] = (time.time(), results)
    return {"source": SOURCE, "results": results}


def _place(feature: dict[str, Any]) -> dict[str, Any]:
    p = feature.get("properties", {})
    lon, lat = feature["geometry"]["coordinates"][:2]
    within = [p.get(k) for k in ("county", "state", "country") if p.get(k) and p.get(k) != p.get("name")]
    return {
        "name": p.get("name") or p.get("street") or "unnamed place",
        "kind": (p.get("osm_value") or p.get("type") or "").replace("_", " "),
        "within": ", ".join(dict.fromkeys(within)),
        "lat": lat,
        "lon": lon,
        "osm": f"{p.get('osm_type', '')}{p.get('osm_id', '')}",
    }
