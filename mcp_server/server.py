"""MCP server exposing the detection core to agent harnesses.

Read and screen only: no tool submits evidence, checks it, or changes a
verification level.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from core.bundle import get_evidence_bundle as core_bundle
from core.burn import classify_burn as core_classify
from core.coverage import check_coverage as core_coverage
from core.db import init_db
from core.prior_reports import search_prior_reports as core_prior_reports
from core.pwtt import screen_for_change as core_screen
from core.seismic import check_seismic_confound as core_seismic

mcp = FastMCP("burn-evidence-screening")


@mcp.tool()
def check_coverage(aoi_geojson: str, start_date: str, end_date: str) -> dict[str, Any]:
    """Sentinel-1/2 scene counts and cloud fraction for an AOI. Call before screen_for_change."""
    aoi = json.loads(aoi_geojson) if isinstance(aoi_geojson, str) else aoi_geojson
    return core_coverage(aoi, start_date, end_date)


@mcp.tool()
def screen_for_change(
    aoi_geojson: str,
    baseline_start: str,
    baseline_end: str,
    event_start: str,
    event_end: str,
    z_threshold: float = 3.0,
) -> dict[str, str]:
    """PWTT over the AOI. Returns a job id; this takes minutes. Runs anywhere Sentinel-1 reaches."""
    aoi = json.loads(aoi_geojson) if isinstance(aoi_geojson, str) else aoi_geojson
    job_id = core_screen(
        aoi,
        {"start": baseline_start, "end": baseline_end},
        {"start": event_start, "end": event_end},
        z_threshold,
    )
    return {"job_id": job_id}


@mcp.tool()
def classify_burn(site_ids: list[str], threshold: float | None = None) -> list[dict[str, Any]]:
    """LightGBM over spectral features. calibration_status is validated in Rakhine, provisional elsewhere."""
    return core_classify(site_ids, threshold)


@mcp.tool()
def check_seismic_confound(site_ids: list[str], window_days: int = 30) -> list[dict[str, Any]]:
    """Only meaningful on change-without-burn sites. USGS FDSN plus ShakeMap MMI sampling."""
    return core_seismic(site_ids, window_days)


@mcp.tool()
def get_evidence_bundle(site_id: str) -> dict[str, Any]:
    """Before/after chips, dNBR, burn mask, features, PWTT z, scene IDs, provenance. Not a finding."""
    return core_bundle(site_id)



@mcp.tool()
def search_prior_reports(
    site_id: str | None = None,
    aoi_geojson: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    radius_km: float = 10.0,
) -> dict[str, Any]:
    """Documented incidents (ACLED) near a site or area and its dates. Raw records, nearest first.

    Give a site_id to use that site's area and event window, or aoi_geojson
    (a GeoJSON Point or Polygon) with start_date and end_date (YYYY-MM-DD).
    The search reaches 31 days either side of the dates, because ACLED dates
    events known only to a week or month to a single day; days_outside_window
    says how far each report falls outside the requested dates.

    Each report's distance_km is from the site (0 = inside the area). Read it
    against geo_precision, ACLED's own code for how exact the location is:
      1 = the town named in reporting; coordinates are that town
      2 = near a town or a small part of a region; coded to a nearby town
      3 = only a larger region named; coded to a representative location
    and the date against time_precision:
      1 = exact date, 2 = sometime that week, 3 = sometime that month

    An empty list is a real answer: nothing documented in ACLED near this
    place and time. It is not evidence the event did not happen. If
    truncated is true, results were cut off; narrow the dates or radius.

    Every search is recorded against the site. The query is sent to ACLED.
    """
    aoi = json.loads(aoi_geojson) if aoi_geojson else None
    return core_prior_reports(site_id, aoi, start_date, end_date, radius_km, searched_by="agent")


def main() -> None:
    init_db()
    mcp.run()


if __name__ == "__main__":
    main()
