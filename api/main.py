from __future__ import annotations

import json
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core.bundle import get_evidence_bundle
from core.burn import classify_burn
from core.config import settings
from core.coverage import check_coverage
from core.gee import GeeUnavailable
from core.history import site_history
from core.imagery import analysis_layers, area_thumbnails
from core.db import init_db, row_to_dict, session
from core.evidence import (
    EvidenceError,
    add_evidence,
    assess,
    check_evidence,
    list_evidence,
    verification,
)
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


def require_analyst(x_analyst_token: str | None = Header(default=None), x_analyst: str | None = Header(default=None)) -> str:
    if x_analyst_token != settings.analyst_token:
        raise HTTPException(status_code=401, detail="Invalid or missing analyst token")
    return x_analyst or "anonymous"


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


class AssessmentIn(BaseModel):
    handle: str
    stance: str = Field(pattern="^(agree|disagree|unsure)$")
    reason: str | None = None


def is_reviewer(x_analyst_token: str | None = Header(default=None)) -> bool:
    return x_analyst_token == settings.analyst_token


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
    lon, lat = site["geometry"]["coordinates"][:2]
    window = (site.get("timestamps") or {}).get("event_window")
    if not window:
        raise HTTPException(status_code=404, detail="This site has no event window to show imagery for.")
    baseline = (site.get("timestamps") or {}).get("baseline_window")
    if not baseline:
        start = date.fromisoformat(window[0])
        baseline = [(start - timedelta(days=365)).isoformat(), (start - timedelta(days=1)).isoformat()]
    try:
        return area_thumbnails(
            box_around(lon, lat, SITE_BOX_KM),
            {"start": baseline[0], "end": baseline[1]},
            {"start": window[0], "end": window[1]},
        )
    except GeeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # Earth Engine computation errors
        raise HTTPException(status_code=502, detail=f"Earth Engine error: {exc}") from exc


@app.get("/sites/{site_id}/history")
def get_history(site_id: str) -> list[dict[str, Any]]:
    get_site(site_id)  # 404 if missing
    return site_history(site_id)


@app.get("/sites/{site_id}/evidence")
def get_evidence(site_id: str, reviewer: bool = Depends(is_reviewer)) -> list[dict[str, Any]]:
    return list_evidence(site_id, reviewer_view=reviewer)


@app.post("/sites/{site_id}/evidence")
def post_evidence(site_id: str, body: EvidenceIn) -> dict[str, Any]:
    try:
        return add_evidence(site_id, body.kind, body.handle or "", body.url, body.body, body.visibility)
    except EvidenceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/evidence/{evidence_id}/check")
def post_check(evidence_id: str, body: CheckIn, analyst: str = Depends(require_analyst)) -> dict[str, Any]:
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
def post_verdict(site_id: str, body: VerdictIn, analyst: str = Depends(require_analyst)) -> dict[str, Any]:
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
