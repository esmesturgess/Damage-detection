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
# Palettes match the keys in web/app/AreaLayers.tsx.
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
    """Map tile URLs for the change, burn, before and after layers of one area."""
    return _cached("tiles", aoi_geojson, baseline_window, event_window, lambda img, _aoi: _tiles(img))


def area_thumbnails(
    aoi_geojson: str | dict[str, Any],
    baseline_window: dict[str, str],
    event_window: dict[str, str],
) -> dict[str, Any]:
    """Still images of one area: before, after, and after with change or burn drawn on top."""

    def thumbs(images: dict[str, Any], aoi: dict[str, Any]) -> dict[str, Any]:
        out = {}
        for name in ("before", "after"):
            if name in images:
                out[name] = _thumb(images[name], aoi)
        for name in ("change", "burn"):
            if name in images:
                base = images.get("after")
                out[name] = _thumb(base.blend(images[name]) if base is not None else images[name], aoi)
        return out

    return _cached("thumbs", aoi_geojson, baseline_window, event_window, thumbs, per_image=False)


def _cached(kind, aoi_geojson, baseline, event, render, per_image: bool = True) -> dict[str, Any]:
    geom = parse_geometry(aoi_geojson)
    assert_aoi_size(geom)
    key = json.dumps([kind, geojson_of(geom), baseline, event], sort_keys=True)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL_S:
        return hit[1]
    built = _images(geojson_of(geom), baseline, event)
    images = built.pop("images")
    aoi = geojson_of(geom)
    rendered = {name: render(img, aoi) for name, img in images.items()} if per_image else render(images, aoi)
    result = {"layers": rendered, **built}
    _cache[key] = (time.time(), result)
    return result


def _images(aoi: dict[str, Any], baseline: dict[str, str], event: dict[str, str]) -> dict[str, Any]:
    """Visualised (RGB) Earth Engine images for one area, plus what they were built from."""
    initialize()
    import ee

    from core._vendor import pwtt

    region = ee.Geometry(aoi)
    notes: list[str] = []
    images: dict[str, Any] = {}

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
    images["change"] = change.updateMask(change.gte(3)).visualize(**CHANGE_VIS)

    # Optical: same product on both sides, L2A preferred (the burn detector's
    # training data), L1C where Earth Engine's L2A archive has gaps.
    post_end = ev_end
    optical = pick_product(region, baseline["start"], baseline["end"], event["start"], post_end.isoformat())
    if optical is None:
        post_end = ev_end + timedelta(days=POST_EXTENSION_DAYS)
        optical = pick_product(region, baseline["start"], baseline["end"], event["start"], post_end.isoformat())
        if optical:
            notes.append(f"No clear Sentinel-2 scene in the window; after-imagery extended to {post_end}.")

    if optical is None:
        notes.append("No clear Sentinel-2 scenes before and after: no true colour or burn layer.")
        optical_info = {"product": None, "provisional": True}
    else:
        product, pre_n, post_n = optical
        pre = clear_scenes(product, region, baseline["start"], baseline["end"]).median().clip(region)
        post = clear_scenes(product, region, event["start"], post_end.isoformat()).median().clip(region)
        images["before"] = pre.visualize(**TRUE_COLOUR)
        images["after"] = post.visualize(**TRUE_COLOUR)
        dnbr = pre.normalizedDifference(["B8", "B12"]).subtract(post.normalizedDifference(["B8", "B12"]))
        images["burn"] = dnbr.updateMask(dnbr.gte(0.1)).visualize(**BURN_VIS)
        optical_info = {
            "product": "L2A" if product == L2A else "L1C",
            "provisional": product == L1C,
            "pre_scenes": pre_n,
            "post_scenes": post_n,
            "before_window": {"start": baseline["start"], "end": baseline["end"]},
            "after_window": {"start": event["start"], "end": post_end.isoformat()},
        }
        if product == L1C:
            notes.append("Burn layer uses Level-1C (top of atmosphere, no atmospheric correction), so its values are less reliable.")

    return {"images": images, "optical": optical_info, "notes": notes}


def clear_scenes(collection: str, region, start: str, end: str):
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


def pick_product(region, pre_start: str, pre_end: str, post_start: str, post_end: str):
    import ee

    for product in (L2A, L1C):
        counts = ee.List([
            clear_scenes(product, region, pre_start, pre_end).size(),
            clear_scenes(product, region, post_start, post_end).size(),
        ]).getInfo()
        if counts[0] and counts[1]:
            return product, counts[0], counts[1]
    return None


def _tiles(image) -> dict[str, str]:
    return {"url": image.getMapId()["tile_fetcher"].url_format}


def _thumb(image, region: dict[str, Any]) -> dict[str, str]:
    # Frame to the area explicitly: some layers (PWTT) have a larger footprint.
    return {"url": image.getThumbURL({"region": region, "dimensions": 640, "format": "png"})}
