from __future__ import annotations

import json
from typing import Any

import httpx

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core.bundle import get_evidence_bundle
from core.burn import classify_burn
from core.config import settings
from core.coverage import check_coverage
from core.gee import GeeUnavailable
from core.history import site_history
from core.fires import FiresError, latest_fire_search, search_fire_detections
from core.geocode import GeocodeError, search_places
from core.investigations import (
    InvestigationError,
    find_overlaps,
    hotspots_of,
    place_name,
    start_investigation,
)
from core.imagery import analysis_layers, area_thumbnails
from core.db import init_db, row_to_dict, session
from core.discussion import DiscussionError, add_comment, list_comments
from core.evidence import (
    EvidenceError,
    add_evidence,
    assess,
    check_evidence,
    list_evidence,
    verification,
)
from core.prior_reports import PriorReportsError, add_report_as_evidence, latest_search, search_prior_reports
from core.pwtt import screen_for_change
from core.seed import seed_demo, seed_demo_evidence
from core.seismic import check_seismic_confound
from core.verdicts import VerdictError, set_verdict

app = FastAPI(title="Burn Evidence Screening Tool", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()
    with session() as conn:
        seed_demo(conn)
        seed_demo_evidence(conn)


def require_handle(handle: str | None) -> str:
    """Everyone in the group is equal; a check or verdict just needs a name.

    Real accounts replace handles later; until then this is a closed, local tool.
    """
    name = (handle or "").strip()[:64]
    if not name:
        raise HTTPException(status_code=400, detail="Pick a handle first (any name).")
    return name


class CoverageIn(BaseModel):
    aoi_geojson: dict[str, Any]
    start_date: str
    end_date: str


class ScreenIn(BaseModel):
    aoi_geojson: dict[str, Any]
    baseline_window: dict[str, str]
    event_window: dict[str, str]
    z_threshold: float = 3.0


class ClassifyIn(BaseModel):
    site_ids: list[str]
    threshold: float | None = None


class SeismicIn(BaseModel):
    site_ids: list[str]
    window_days: int = 30


class VerdictIn(BaseModel):
    verdict: str = Field(pattern="^(confirm|reject|unsure|explained|disputed)$")
    note: str | None = None
    handle: str | None = None


class EvidenceIn(BaseModel):
    kind: str = Field(pattern="^(link|testimony)$")
    url: str | None = None
    body: str | None = None
    visibility: str = Field(default="public", pattern="^(public|reviewers)$")
    handle: str | None = None


class CheckIn(BaseModel):
    located: str = Field(pattern="^(yes|no|unsure)$")
    dated: str = Field(pattern="^(yes|no|unsure)$")
    original: str = Field(pattern="^(original|repost|unsure)$")
    shares_source_with: list[str] = []
    note: str | None = None
    handle: str | None = None


class AssessmentIn(BaseModel):
    handle: str
    stance: str = Field(pattern="^(agree|disagree|unsure)$")
    reason: str | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "live_gee": settings.enable_live_gee,
    }


@app.get("/coverage")
def coverage_get(start_date: str, end_date: str, aoi: str) -> dict[str, Any]:
    return check_coverage(json.loads(aoi), start_date, end_date)


@app.post("/coverage")
def coverage_post(body: CoverageIn) -> dict[str, Any]:
    return check_coverage(body.aoi_geojson, body.start_date, body.end_date)


class AnalysisIn(BaseModel):
    aoi_geojson: dict[str, Any]
    baseline_window: dict[str, str]
    event_window: dict[str, str]


@app.post("/imagery/analysis")
def imagery_analysis(body: AnalysisIn) -> dict[str, Any]:
    """Earth Engine tile layers (change, burn, before, after) for one area."""
    try:
        return analysis_layers(body.aoi_geojson, body.baseline_window, body.event_window)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GeeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # Earth Engine computation errors
        raise HTTPException(status_code=502, detail=f"Earth Engine error: {exc}") from exc


@app.post("/jobs")
def create_job(body: ScreenIn) -> dict[str, str]:
    try:
        job_id = screen_for_change(
            body.aoi_geojson,
            body.baseline_window,
            body.event_window,
            body.z_threshold,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with session() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    job = row_to_dict(row)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/sites")
def list_sites() -> list[dict[str, Any]]:
    with session() as conn:
        rows = conn.execute("SELECT * FROM sites ORDER BY created_at DESC").fetchall()
        sites = [row_to_dict(r) for r in rows]
        for site in sites:
            site["verification"] = verification(conn, site["id"])
    return sites


@app.get("/sites/{site_id}")
def get_site(site_id: str) -> dict[str, Any]:
    with session() as conn:
        row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        site = row_to_dict(row)
        if not site:
            raise HTTPException(status_code=404, detail="site not found")
        site["verification"] = verification(conn, site_id)
    return site


SITE_BOX_KM = 3


@app.get("/sites/{site_id}/imagery")
def site_imagery(site_id: str) -> dict[str, Any]:
    """Before/after/change/burn images of a site's 3 km box for its own dates."""
    from datetime import date, timedelta

    from core.geo import box_around

    site = get_site(site_id)
    window = (site.get("timestamps") or {}).get("event_window")
    if not window:
        raise HTTPException(status_code=404, detail="This site has no event window to show imagery for.")
    baseline = (site.get("timestamps") or {}).get("baseline_window")
    if not baseline:
        start = date.fromisoformat(window[0])
        baseline = [(start - timedelta(days=365)).isoformat(), (start - timedelta(days=1)).isoformat()]
    try:
        geometry = site["geometry"]
        if geometry["type"] == "Point":  # hot-spots: a box around the point
            geometry = box_around(*geometry["coordinates"][:2], SITE_BOX_KM)
        return area_thumbnails(
            geometry,
            {"start": baseline[0], "end": baseline[1]},
            {"start": window[0], "end": window[1]},
        )
    except GeeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # Earth Engine computation errors
        raise HTTPException(status_code=502, detail=f"Earth Engine error: {exc}") from exc


@app.get("/sites/{site_id}/hotspots")
def get_hotspots(site_id: str) -> list[dict[str, Any]]:
    get_site(site_id)
    hotspots = hotspots_of(site_id)
    with session() as conn:
        for hotspot in hotspots:
            hotspot["verification"] = verification(conn, hotspot["id"])
    return hotspots


class OverlapIn(BaseModel):
    aoi_geojson: dict[str, Any]
    event_window: dict[str, str]


class InvestigationIn(BaseModel):
    aoi_geojson: dict[str, Any]
    baseline_window: dict[str, str]
    event_window: dict[str, str]
    name: str
    name_local: str | None = None
    question: str | None = None
    created_by: str | None = None


@app.get("/places/search")
def get_place_search(
    q: str = Query(max_length=200), lat: float | None = None, lon: float | None = None
) -> dict[str, Any]:
    """Places matching q (OpenStreetMap, via Photon), nearest the given point first."""
    try:
        return search_places(q, lat, lon)
    except GeocodeError as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/places/name")
def get_place_name(lat: float, lon: float, area_km2: float | None = None) -> dict[str, Any]:
    """English and local name of the place at a point (OpenStreetMap)."""
    return place_name(lat, lon, area_km2)


@app.post("/investigations/overlaps")
def post_overlaps(body: OverlapIn) -> list[dict[str, Any]]:
    return find_overlaps(body.aoi_geojson, body.event_window)


@app.post("/investigations")
def post_investigation(body: InvestigationIn) -> dict[str, Any]:
    try:
        return start_investigation(
            body.aoi_geojson,
            body.baseline_window,
            body.event_window,
            body.name,
            body.name_local,
            body.question,
            body.created_by,
        )
    except (InvestigationError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/sites/{site_id}/history")
def get_history(site_id: str) -> list[dict[str, Any]]:
    get_site(site_id)  # 404 if missing
    return site_history(site_id)


class PriorReportsIn(BaseModel):
    radius_km: float = Field(default=10.0, gt=0, le=100)
    handle: str | None = None


@app.get("/sites/{site_id}/prior-reports")
def get_prior_reports(site_id: str) -> dict[str, Any] | None:
    """The last saved search for this site, or null if nobody has searched yet."""
    get_site(site_id)
    return latest_search(site_id)


@app.post("/sites/{site_id}/prior-reports")
def post_prior_reports(site_id: str, body: PriorReportsIn) -> dict[str, Any]:
    """Search ACLED near this site and its dates. Data only; nothing is judged."""
    get_site(site_id)
    try:
        return search_prior_reports(site_id, radius_km=body.radius_km, searched_by=(body.handle or "").strip() or "investigator")
    except PriorReportsError as exc:
        status = 503 if "not configured" in str(exc) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"ACLED unreachable: {exc}") from exc


class FiresIn(BaseModel):
    radius_km: float = Field(default=2.0, gt=0, le=50)
    handle: str | None = None


@app.get("/sites/{site_id}/fires")
def get_fires(site_id: str) -> dict[str, Any] | None:
    """The last saved fire-detection search for this site, or null."""
    get_site(site_id)
    return latest_fire_search(site_id)


@app.post("/sites/{site_id}/fires")
def post_fires(site_id: str, body: FiresIn) -> dict[str, Any]:
    """NASA FIRMS fire detections near this site during its event window. Data only."""
    get_site(site_id)
    try:
        return search_fire_detections(site_id, radius_km=body.radius_km, searched_by=(body.handle or "").strip() or "investigator")
    except FiresError as exc:
        raise HTTPException(status_code=503 if "FIRMS_MAP_KEY" in str(exc) else 502, detail=str(exc)) from exc


class ReportEvidenceIn(BaseModel):
    search_id: str
    source_id: str
    handle: str | None = None


@app.post("/sites/{site_id}/prior-reports/evidence")
def post_report_as_evidence(site_id: str, body: ReportEvidenceIn) -> dict[str, Any]:
    try:
        return add_report_as_evidence(site_id, body.search_id, body.source_id, body.handle or "")
    except EvidenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class CommentIn(BaseModel):
    body: str
    handle: str | None = None
    evidence_id: str | None = None


@app.get("/sites/{site_id}/comments")
def get_comments(site_id: str) -> list[dict[str, Any]]:
    get_site(site_id)
    return list_comments(site_id)


@app.post("/sites/{site_id}/comments")
def post_comment(site_id: str, body: CommentIn) -> dict[str, Any]:
    try:
        return add_comment(site_id, body.handle or "", body.body, body.evidence_id)
    except DiscussionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/sites/{site_id}/evidence")
def get_evidence(site_id: str) -> list[dict[str, Any]]:
    return list_evidence(site_id, reviewer_view=True)  # a closed group sees everything


@app.post("/sites/{site_id}/evidence")
def post_evidence(site_id: str, body: EvidenceIn) -> dict[str, Any]:
    try:
        return add_evidence(site_id, body.kind, body.handle or "", body.url, body.body, body.visibility)
    except EvidenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/evidence/{evidence_id}/check")
def post_check(evidence_id: str, body: CheckIn) -> dict[str, Any]:
    analyst = require_handle(body.handle)
    try:
        return check_evidence(
            evidence_id, analyst, body.located, body.dated, body.original, body.shares_source_with, body.note
        )
    except EvidenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sites/{site_id}/assessment")
def post_assessment(site_id: str, body: AssessmentIn) -> dict[str, Any]:
    try:
        return assess(site_id, body.handle, body.stance, body.reason)
    except EvidenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/sites/{site_id}/verdict")
def post_verdict(site_id: str, body: VerdictIn) -> dict[str, Any]:
    analyst = require_handle(body.handle)
    try:
        return set_verdict(site_id, body.verdict, analyst, body.note)
    except VerdictError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/classify_burn")
def post_classify(body: ClassifyIn) -> list[dict[str, Any]]:
    return classify_burn(body.site_ids, body.threshold)


@app.post("/seismic")
def post_seismic(body: SeismicIn) -> list[dict[str, Any]]:
    return check_seismic_confound(body.site_ids, body.window_days)


@app.get("/bundle/{site_id}")
def bundle(site_id: str) -> dict[str, Any]:
    pack = get_evidence_bundle(site_id)
    if pack.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="site not found")
    return pack


def run() -> None:
    import uvicorn

    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
