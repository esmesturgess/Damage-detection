from __future__ import annotations

import json
from typing import Any

from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry

from core.config import settings


RAKHINE_BBOX = (92.15, 17.50, 94.80, 21.50)  # west, south, east, north


def parse_geometry(aoi: str | dict[str, Any]) -> BaseGeometry:
    if isinstance(aoi, str):
        aoi = json.loads(aoi)
    geom = aoi
    if aoi.get("type") == "Feature":
        geom = aoi["geometry"]
    elif aoi.get("type") == "FeatureCollection":
        geoms = [shape(f["geometry"]) for f in aoi["features"]]
        from shapely.ops import unary_union

        return unary_union(geoms)
    return shape(geom)


def geojson_of(geom: BaseGeometry) -> dict[str, Any]:
    return mapping(geom)


def centroid_lonlat(geom: BaseGeometry) -> tuple[float, float]:
    c = geom.centroid
    return float(c.x), float(c.y)


def area_km2(geom: BaseGeometry) -> float:
    # Approximate on WGS84 using an equal-area-ish local projection in degrees.
    # Good enough for AOI caps; not a cadastral measurement.
    lon, lat = centroid_lonlat(geom)
    # 1 deg lat ~ 110.57 km; 1 deg lon ~ 111.32 * cos(lat)
    import math

    km_per_deg_lat = 110.57
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat))
    minx, miny, maxx, maxy = geom.bounds
    # Use projected affine approximation on the polygon
    from shapely.affinity import scale

    projected = scale(
        geom,
        xfact=km_per_deg_lon,
        yfact=km_per_deg_lat,
        origin=(lon, lat),
    )
    return float(projected.area)


def assert_aoi_size(geom: BaseGeometry) -> float:
    km2 = area_km2(geom)
    if km2 > settings.max_aoi_km2:
        raise ValueError(
            f"AOI is {km2:.0f} km²; cap is {settings.max_aoi_km2:.0f} km². "
            "Tile the request or export via Earth Engine batch for larger areas."
        )
    return km2


def in_rakhine(geom: BaseGeometry) -> bool:
    lon, lat = centroid_lonlat(geom)
    w, s, e, n = RAKHINE_BBOX
    return w <= lon <= e and s <= lat <= n


def calibration_status_for(geom: BaseGeometry) -> str:
    return "validated" if in_rakhine(geom) else "provisional"
