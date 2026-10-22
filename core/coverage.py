from __future__ import annotations

from typing import Any

from core.gee import GeeUnavailable, gee_enabled, initialize, sentinel1_collection, sentinel2_sr_collection
from core.geo import area_km2, geojson_of, parse_geometry


def check_coverage(aoi_geojson: str | dict[str, Any], start_date: str, end_date: str) -> dict[str, Any]:
    """Sentinel-1/2 scene counts, cloud fraction, revisit gaps.

    Answers "is there enough imagery here" before a long PWTT run.
    """
    geom = parse_geometry(aoi_geojson)
    payload = {
        "aoi": geojson_of(geom),
        "start_date": start_date,
        "end_date": end_date,
        "area_km2": round(area_km2(geom), 2),
        "live_gee": gee_enabled(),
    }

    if not gee_enabled():
        payload.update(
            {
                "status": "offline_estimate",
                "note": (
                    "Live GEE is off (demo / no credentials). "
                    "Sentinel-1 IW typically revisits every 6–12 days; "
                    "Sentinel-2 optical is cloud-limited. Clone the repo and "
                    "set ENABLE_LIVE_GEE to get scene-level counts."
                ),
                "sentinel1": {"scene_count": None, "typical_revisit_days": 6},
                "sentinel2": {
                    "scene_count": None,
                    "mean_cloud_fraction": None,
                    "note": "Optical read may be unavailable under monsoon cloud.",
                },
                "enough_for_pwtt": True,
                "enough_for_burn_classifier": None,
            }
        )
        return payload

    initialize()
    aoi = geojson_of(geom)
    s1 = sentinel1_collection(aoi, start_date, end_date)
    s2 = sentinel2_sr_collection(aoi, start_date, end_date)

    try:
        import ee

        s1_count = int(s1.size().getInfo())
        s2_count = int(s2.size().getInfo())
        cloud = s2.aggregate_mean("CLOUDY_PIXEL_PERCENTAGE")
        cloud_frac = (cloud.getInfo() or 0) / 100.0 if s2_count else None
    except GeeUnavailable:
        raise
    except Exception as exc:
        raise GeeUnavailable(f"Earth Engine coverage query failed: {exc}") from exc

    payload.update(
        {
            "status": "ok",
            "sentinel1": {"scene_count": s1_count, "typical_revisit_days": 6},
            "sentinel2": {
                "scene_count": s2_count,
                "mean_cloud_fraction": cloud_frac,
            },
            "enough_for_pwtt": s1_count >= 8,
            "enough_for_burn_classifier": bool(s2_count and (cloud_frac is None or cloud_frac < 0.6)),
        }
    )
    return payload
