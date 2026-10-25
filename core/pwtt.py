"""Pixel-Wise T-Test change screening (Ballinger).

Each pixel is tested against its own prior Sentinel-1 time series, so no
regional training is needed. Orbits are combined by direction (core/change.py),
a change to the published method that stops noise adding up across orbits. `screen_for_change` queues a job; the worker
calls `run_scan`, which runs PWTT on Earth Engine, turns flagged pixels into
hot-spot locations, and computes the burn features around each one.
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta
from typing import Any

from core.config import settings
from core.db import audit, new_id, session, utcnow
from core.gee import gee_enabled, initialize
from core.geo import assert_aoi_size, calibration_status_for, geojson_of, in_rakhine, parse_geometry

# Vectorising flagged pixels is an interactive Earth Engine request, so scans
# are capped well below the general AOI limit until tiled export exists.
MAX_SCAN_KM2 = 400.0
HOTSPOT_SCALE_M = 20
MIN_HOTSPOT_M2 = 2_000  # roughly a handful of buildings
MAX_HOTSPOTS = 50
FEATURE_BUFFER_M = 100  # burn features are read around the hot-spot, not just on it
POST_EXTENSION_DAYS = 90


def screen_for_change(
    aoi_geojson: str | dict[str, Any],
    baseline_window: dict[str, str],
    event_window: dict[str, str],
    z_threshold: float | None = None,
) -> str:
    """Queue a PWTT job and return its id; an identical earlier scan is reused."""
    geom = parse_geometry(aoi_geojson)
    km2 = assert_aoi_size(geom)
    if km2 > MAX_SCAN_KM2:
        raise ValueError(f"Scans are limited to {MAX_SCAN_KM2:.0f} km² for now; this area is {km2:.0f} km².")
    z = z_threshold if z_threshold is not None else settings.default_z_threshold
    params = {
        "aoi": geojson_of(geom),
        "baseline_window": baseline_window,
        "event_window": event_window,
        "z_threshold": z,
        "live_gee": gee_enabled(),
    }
    params_json = json.dumps(params)
    with session() as conn:
        existing = conn.execute(
            """
            SELECT id FROM jobs WHERE kind = 'screen_for_change' AND params_json = ?
              AND status IN ('queued', 'running', 'succeeded')
            ORDER BY created_at DESC LIMIT 1
            """,
            (params_json,),
        ).fetchone()
        if existing:
            return existing["id"]
        job_id = new_id("job")
        now = utcnow()
        conn.execute(
            """
            INSERT INTO jobs (id, kind, status, params_json, created_at, updated_at)
            VALUES (?, 'screen_for_change', 'queued', ?, ?, ?)
            """,
            (job_id, params_json, now, now),
        )
        audit(conn, "system", "job_queued", "job", job_id, {"kind": "screen_for_change"})
    return job_id


def scan_result(job_id: str, wait_s: float = 0) -> dict[str, Any]:
    """A scan job's status, and its hot-spot site ids once it has finished. Waits up to wait_s for it to finish."""
    deadline = time.monotonic() + max(0.0, wait_s)
    while True:
        with session() as conn:
            row = conn.execute("SELECT status, result_json, error FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ValueError(f"no job {job_id}")
        done = row["status"] in ("succeeded", "failed")
        if done or time.monotonic() >= deadline:
            out: dict[str, Any] = {"job_id": job_id, "status": row["status"]}
            if row["status"] == "succeeded":
                out["result"] = json.loads(row["result_json"] or "{}")
            if row["status"] == "failed":
                out["error"] = row["error"]
            return out
        time.sleep(2)


def run_scan(job_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """Run PWTT for one queued job and store each hot-spot as a Detected site."""
    initialize()
    import ee

    from core.change import signed_pwtt
    from core.imagery import L1C, L2A, clear_scenes, optical_pair, stable_water
    from core.investigations import attach_to_investigations

    aoi, baseline, event = params["aoi"], params["baseline_window"], params["event_window"]
    region = ee.Geometry(aoi)
    ev_start, ev_end = date.fromisoformat(event["start"]), date.fromisoformat(event["end"])
    bl_start = date.fromisoformat(baseline["start"])
    notes: list[str] = []

    t_stat = signed_pwtt(
        region,
        event["start"],
        event["start"],
        max(1, round((ev_start - bl_start).days / 30.44)),
        max(1, round((ev_end - ev_start).days / 30.44)),
    )
    change = t_stat.addBands(t_stat.gt(params["z_threshold"]).rename("damage"))

    # Flagged pixels -> polygons, with mean and max T per polygon.
    vectors = (
        change.select("damage")
        .toInt()  # reduceToVectors needs an integer label band
        .selfMask()
        .addBands(change.select("T_statistic"))
        .reduceToVectors(
            geometry=region,
            scale=HOTSPOT_SCALE_M,
            geometryType="polygon",
            eightConnected=True,
            reducer=ee.Reducer.mean().combine(ee.Reducer.max(), sharedInputs=True),
            maxPixels=1e9,
            bestEffort=True,
        )
        .map(lambda f: f.set("area_m2", f.geometry().area(maxError=1)))
        .filter(ee.Filter.gte("area_m2", MIN_HOTSPOT_M2))
        .sort("area_m2", False)
    )
    total = vectors.size()
    hotspots = vectors.limit(MAX_HOTSPOTS)

    # Burn features from the same Sentinel-2 composites as the map layers.
    optical = optical_pair(region, baseline, event)
    if optical:
        notes.extend(optical["notes"])
        product, (pre_start, pre_end) = optical["product"], optical["pre"]
        pre = clear_scenes(product, region, pre_start, pre_end).median()
        post = clear_scenes(product, region, event["start"], optical["post_end"]).median()
        stack = (
            pre.normalizedDifference(["B8", "B12"]).subtract(post.normalizedDifference(["B8", "B12"])).rename("dnbr")
            .addBands(pre.normalizedDifference(["B11", "B12"]).subtract(post.normalizedDifference(["B11", "B12"])).rename("nbr2c"))
            .addBands(stable_water(pre, post))
        )
        hotspots = stack.reduceRegions(
            collection=hotspots.map(lambda f: f.setGeometry(f.geometry().buffer(FEATURE_BUFFER_M))),
            reducer=ee.Reducer.mean().combine(ee.Reducer.percentile([95]), sharedInputs=True),
            scale=HOTSPOT_SCALE_M,
        )
    else:
        product = None
        notes.append("No clear Sentinel-2 scenes before and after: hot-spots have no burn features.")

    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(region)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
    )
    s1_pre = s1.filterDate(baseline["start"], event["start"])
    s1_post = s1.filterDate(event["start"], (ev_end + timedelta(days=1)).isoformat())

    info = ee.Dictionary({
        "total": total,
        # A FeatureCollection inside a Dictionary serialises as metadata only; a list keeps the features.
        "hotspots": hotspots.map(lambda f: f.set("centroid", f.geometry().centroid(maxError=1).coordinates()))
        .toList(MAX_HOTSPOTS),
        "orbits_pre": s1_pre.aggregate_histogram("relativeOrbitNumber_start"),
        "orbits_post": s1_post.aggregate_histogram("relativeOrbitNumber_start"),
        "post_scenes": s1_post.aggregate_array("system:index"),
    }).getInfo()

    provenance = {
        "s1_post": info["post_scenes"],
        "s1_orbits_pre": info["orbits_pre"],
        "s1_orbits_post": info["orbits_post"],
        "s2_product": None if product is None else ("L2A" if product == L2A else "L1C"),
    }
    timestamps = {
        "event_window": [event["start"], event["end"]],
        "baseline_window": [baseline["start"], baseline["end"]],
        "optical_before_window": list(optical["pre"]) if optical else None,
        "optical_after_window": [event["start"], optical["post_end"]] if optical else None,
    }

    created = []
    with session() as conn:
        for f in info["hotspots"]:
            props = f["properties"]
            lon, lat = props["centroid"]
            point = {"type": "Point", "coordinates": [lon, lat]}
            geom = parse_geometry(point)
            features = {
                "hotspot_area_ha": round(props["area_m2"] / 10_000, 2),
                "max_t": _round(props.get("max")),
            }
            if product:
                features.update({
                    "mean_dnbr": _round(props.get("dnbr_mean")),
                    "p95_dnbr": _round(props.get("dnbr_p95")),
                    "nbr2_change": _round(props.get("nbr2c_p95")),
                    "stable_water_fraction": _round(props.get("water_mean")),
                })
            calibration = calibration_status_for(geom)
            if product == L1C:
                calibration = "provisional"
            site_id = new_id("site")
            conn.execute(
                """
                INSERT INTO sites (
                    id, job_id, name, geometry_geojson, status, calibration_status, optical_read,
                    pwtt_z, burn_probability, burn_threshold, features_json, scene_ids_json,
                    timestamps_json, region, is_demo, created_at
                ) VALUES (?, ?, ?, ?, 'pending_review', ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)
                """,
                (
                    site_id,
                    job_id,
                    f"Change hot-spot · {features['hotspot_area_ha']} ha · {event['start'][:7]}",
                    json.dumps(point),
                    calibration,
                    "available" if product else "cloud_gap",
                    _round(props.get("mean")),
                    settings.default_burn_threshold,
                    json.dumps(features),
                    json.dumps(provenance),
                    json.dumps(timestamps),
                    "rakhine" if in_rakhine(geom) else None,
                    utcnow(),
                ),
            )
            attach_to_investigations(conn, site_id, point, event)
            audit(conn, "model", "hotspot_detected", "site", site_id, {"job_id": job_id, "mean_t": props.get("mean")})
            created.append(site_id)

    if info["total"] > MAX_HOTSPOTS:
        notes.append(f"{info['total']} hot-spots found; kept the {MAX_HOTSPOTS} largest.")
    return {
        "hotspots_found": info["total"],
        "sites_created": len(created),
        "site_ids": created,
        "s1_orbits_post": info["orbits_post"],
        "s2_product": provenance["s2_product"],
        "notes": notes,
    }


def _round(value: Any, digits: int = 3) -> float | None:
    return None if value is None else round(float(value), digits)
