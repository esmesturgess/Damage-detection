"""Earth Engine auth and collection builders.

Live GEE is gated by ENABLE_LIVE_GEE. The public demo must never call this path.
"""

from __future__ import annotations

from pathlib import Path

from core.config import settings


class GeeUnavailable(RuntimeError):
    pass


def gee_enabled() -> bool:
    # Either a service-account key, or a project plus the personal
    # credentials that `earthengine authenticate` stores locally.
    return bool(
        settings.enable_live_gee
        and (settings.gee_service_account_json or settings.gee_project)
    )


def initialize() -> None:
    if not gee_enabled():
        raise GeeUnavailable(
            "Live Earth Engine is disabled. Set ENABLE_LIVE_GEE=true and either "
            "GEE_PROJECT (after running `earthengine authenticate`) or "
            "GEE_SERVICE_ACCOUNT_JSON. The demo uses precomputed SQLite results instead."
        )
    try:
        import ee
    except ImportError as exc:
        raise GeeUnavailable("earthengine-api is not installed. pip install -e '.[gee]'") from exc

    if not settings.gee_service_account_json:
        try:
            ee.Initialize(project=settings.gee_project)
        except Exception as exc:
            raise GeeUnavailable(
                f"Earth Engine login failed for project {settings.gee_project!r}: no service-account key is set "
                "(GEE_SERVICE_ACCOUNT_JSON) and this machine has no personal login. On a server, add the key as a "
                "secret file and point GEE_SERVICE_ACCOUNT_JSON at it; on your own computer, run `earthengine authenticate`."
            ) from exc
        return

    key_path = Path(settings.gee_service_account_json)
    if not key_path.exists():
        raise GeeUnavailable(f"GEE service account file not found: {key_path}")

    credentials = ee.ServiceAccountCredentials(
        None,
        key_file=str(key_path),
    )
    if settings.gee_project:
        ee.Initialize(credentials, project=settings.gee_project)
    else:
        ee.Initialize(credentials)


def sentinel1_collection(aoi_geojson: dict, start: str, end: str):
    import ee

    geom = ee.Geometry(aoi_geojson)
    return (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(geom)
        .filterDate(start, end)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
        .select("VV")
    )


def sentinel2_sr_collection(aoi_geojson: dict, start: str, end: str):
    import ee

    geom = ee.Geometry(aoi_geojson)
    return (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(geom)
        .filterDate(start, end)
    )
