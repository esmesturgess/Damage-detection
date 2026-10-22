"""Earth Engine map layers for one analysed area.

Everything is clipped to the area, so tiles stay cheap and quota is spent
only where someone is looking. Returns XYZ tile URLs the browser can load
directly (Earth Engine embeds access in the map id).
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta
from typing import Any

from core.gee import initialize
from core.geo import assert_aoi_size, geojson_of, parse_geometry

L2A = "COPERNICUS/S2_SR_HARMONIZED"
L1C = "COPERNICUS/S2_HARMONIZED"
CLOUD_PROB = "COPERNICUS/S2_CLOUD_PROBABILITY"
MAX_SCENE_CLOUD = 60  # scene-level filter before per-pixel masking
MAX_PIXEL_CLOUD = 40  # s2cloudless probability above which a pixel is dropped
POST_EXTENSION_DAYS = 90  # widen the after-window when it has no clear scene

TRUE_COLOUR = {"bands": ["B4", "B3", "B2"], "min": 0, "max": 2500, "gamma": 1.2}
CHANGE_VIS = {"min": 3, "max": 5, "palette": ["ffff00", "ff0000", "800080"]}
# USGS dNBR severity classes, shown from "low" upwards.
BURN_VIS = {"min": 0.1, "max": 0.66, "palette": ["fff7bc", "fec44f", "f03b20", "7f0000"]}

_TTL_S = 3600
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def analysis_layers(
    aoi_geojson: str | dict[str, Any],
    baseline_window: dict[str, str],
    event_window: dict[str, str],
) -> dict[str, Any]:
    geom = parse_geometry(aoi_geojson)
    assert_aoi_size(geom)
    key = json.dumps([geojson_of(geom), baseline_window, event_window], sort_keys=True)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL_S:
        return hit[1]
    result = _build(geojson_of(geom), baseline_window, event_window)
    _cache[key] = (time.time(), result)
    return result


def _build(aoi: dict[str, Any], baseline: dict[str, str], event: dict[str, str]) -> dict[str, Any]:
    initialize()
    import ee

    from core._vendor import pwtt

    region = ee.Geometry(aoi)
    notes: list[str] = []
    layers: dict[str, Any] = {}

    # Structural change: Pixel-Wise T-Test on Sentinel-1, built-up areas only.
    ev_start, ev_end = date.fromisoformat(event["start"]), date.fromisoformat(event["end"])
    bl_start = date.fromisoformat(baseline["start"])
    change = pwtt.detect_damage(
        aoi=region,
        war_start=event["start"],
        inference_start=event["start"],
        pre_interval=max(1, round((ev_start - bl_start).days / 30.44)),
        post_interval=max(1, round((ev_end - ev_start).days / 30.44)),
    ).select("T_statistic")
    layers["change"] = _tiles(change.updateMask(change.gte(3)), CHANGE_VIS)

    # Optical: same product on both sides, L2A preferred (the burn detector's
    # training data), L1C where Earth Engine's L2A archive has gaps.
    post_end = ev_end
    optical = _pick_product(region, baseline["start"], baseline["end"], event["start"], post_end.isoformat())
    if optical is None:
        post_end = ev_end + timedelta(days=POST_EXTENSION_DAYS)
        optical = _pick_product(region, baseline["start"], baseline["end"], event["start"], post_end.isoformat())
        if optical:
            notes.append(f"No clear Sentinel-2 scene in the window; after-imagery extended to {post_end}.")

    if optical is None:
        notes.append("No clear Sentinel-2 scenes before and after: no true colour or burn layer.")
        optical_info = {"product": None, "provisional": True}
    else:
        product, pre_n, post_n = optical
        pre = _clear(product, region, baseline["start"], baseline["end"]).median().clip(region)
        post = _clear(product, region, event["start"], post_end.isoformat()).median().clip(region)
        layers["before"] = _tiles(pre, TRUE_COLOUR)
        layers["after"] = _tiles(post, TRUE_COLOUR)
        dnbr = pre.normalizedDifference(["B8", "B12"]).subtract(post.normalizedDifference(["B8", "B12"]))
        layers["burn"] = _tiles(dnbr.updateMask(dnbr.gte(0.1)), BURN_VIS)
        optical_info = {
            "product": "L2A" if product == L2A else "L1C",
            "provisional": product == L1C,
            "pre_scenes": pre_n,
            "post_scenes": post_n,
            "before_window": {"start": baseline["start"], "end": baseline["end"]},
            "after_window": {"start": event["start"], "end": post_end.isoformat()},
        }
        if product == L1C:
            notes.append("Burn layer uses Level-1C (top of atmosphere): the burn detector was trained on Level-2A, so read it as provisional.")

    return {"layers": layers, "optical": optical_info, "notes": notes}


def _clear(collection: str, region, start: str, end: str):
    """Sentinel-2 scenes over the region with cloudy pixels masked (s2cloudless)."""
    import ee

    scenes = (
        ee.ImageCollection(collection)
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", MAX_SCENE_CLOUD))
    )
    probs = ee.ImageCollection(CLOUD_PROB).filterBounds(region).filterDate(start, end)
    joined = ee.Join.saveFirst("cloud").apply(
        scenes, probs, ee.Filter.equals(leftField="system:index", rightField="system:index")
    )
    return ee.ImageCollection(joined).map(
        lambda img: img.updateMask(ee.Image(img.get("cloud")).select("probability").lt(MAX_PIXEL_CLOUD))
    )


def _pick_product(region, pre_start: str, pre_end: str, post_start: str, post_end: str):
    import ee

    for product in (L2A, L1C):
        counts = ee.List([
            _clear(product, region, pre_start, pre_end).size(),
            _clear(product, region, post_start, post_end).size(),
        ]).getInfo()
        if counts[0] and counts[1]:
            return product, counts[0], counts[1]
    return None


def _tiles(image, vis: dict[str, Any]) -> dict[str, str]:
    return {"url": image.getMapId(vis)["tile_fetcher"].url_format}
