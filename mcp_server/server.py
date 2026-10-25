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
from core.fires import search_fire_detections as core_fires
from core.prior_reports import search_prior_reports as core_prior_reports
from core.pwtt import scan_result as core_scan_result
from core.pwtt import screen_for_change as core_screen
from core.seismic import check_seismic_confound as core_seismic

INSTRUCTIONS = """Tools for gathering evidence about possible burning and destruction of settlements.

You gather data for human investigators; you do not decide what happened.
Report what each tool returned, with its caveats (calibration_status,
precision codes, sample or provisional data), and leave conclusions to the
investigators. No tool here can publish, verify or change a site's level.

Usual order for an area and dates: check_coverage, then screen_for_change,
then get_scan_result (scans take minutes), then classify_burn on the site
ids it returns. check_seismic_confound belongs only to sites that changed
on radar but are not burn-positive. search_prior_reports finds documented
incidents (ACLED) near a site or area; search_fire_detections finds NASA
FIRMS active-fire detections; get_evidence_bundle gives one site's full
satellite record."""

mcp = FastMCP("burn-evidence-screening", instructions=INSTRUCTIONS)


# Areas arrive as GeoJSON text or, once the MCP layer has parsed that text, as an object.
Area = str | dict[str, Any]


def _area(aoi_geojson: Area | None) -> dict[str, Any] | None:
    return json.loads(aoi_geojson) if isinstance(aoi_geojson, str) else aoi_geojson


@mcp.tool()
def check_coverage(aoi_geojson: Area, start_date: str, end_date: str) -> dict[str, Any]:
    """Sentinel-1/2 scene counts and cloud fraction for an AOI. Call before screen_for_change."""
    return core_coverage(_area(aoi_geojson), start_date, end_date)


@mcp.tool()
def screen_for_change(
    aoi_geojson: Area,
    baseline_start: str,
    baseline_end: str,
    event_start: str,
    event_end: str,
    z_threshold: float = 3.0,
) -> dict[str, str]:
    """PWTT over the AOI, orbits combined by direction. Returns a job id; this takes minutes.

    Hot-spots are pixels with T above z_threshold. T measures how sure the test is that
    backscatter changed, not how much: in cities with many Sentinel-1 passes, everyday change
    can pass 3. Treat hot-spots as places to look, not as damage.
    """
    job_id = core_screen(
        _area(aoi_geojson),
        {"start": baseline_start, "end": baseline_end},
        {"start": event_start, "end": event_end},
        z_threshold,
    )
    return {"job_id": job_id}


@mcp.tool()
def get_scan_result(job_id: str, wait_seconds: float = 60) -> dict[str, Any]:
    """Status of a screen_for_change job; when it has succeeded, the hot-spot site ids it created.

    Waits up to wait_seconds (at most 120) for the scan to finish. If status is still
    queued or running, call again. Pass result.site_ids to classify_burn.
    """
    return core_scan_result(job_id, min(max(wait_seconds, 0), 120))


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
    aoi_geojson: Area | None = None,
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
    return core_prior_reports(site_id, _area(aoi_geojson), start_date, end_date, radius_km, searched_by="agent")


@mcp.tool()
def search_fire_detections(
    site_id: str | None = None,
    aoi_geojson: Area | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    radius_km: float = 2.0,
) -> dict[str, Any]:
    """NASA FIRMS active-fire detections near a site or area during its dates, earliest first.

    Give a site_id to use its area and event window, or aoi_geojson with start_date and
    end_date (YYYY-MM-DD, at most 366 days). Each detection is one satellite pixel (VIIRS
    375 m from 2012, MODIS 1 km from 2000) that was unusually hot at acq_date acq_time UTC.
    confidence is the sensor's own (VIIRS low/nominal/high, MODIS 0-100%); frp_mw is fire
    radiative power. A detection does not say what burned: crop and forest fires look the
    same as burning houses, and type (archive data only) marks known volcanoes and static
    sources such as gas flares. No detections is not proof of no fire: cloud, smoke and the
    time between satellite passes all hide fires. Every search is recorded against the site.
    """
    return core_fires(site_id, _area(aoi_geojson), start_date, end_date, radius_km, searched_by="agent")


def main() -> None:
    init_db()
    mcp.run()


if __name__ == "__main__":
    main()
