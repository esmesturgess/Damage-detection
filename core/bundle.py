"""Per-site evidence pack: imagery, indices, scores and provenance."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from core.config import settings
from core.db import row_to_dict, session
from core.evidence import verification


def get_evidence_bundle(site_id: str) -> dict[str, Any]:
    with session() as conn:
        row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
        site = row_to_dict(row)
        if not site:
            return {"site_id": site_id, "error": "not_found"}

        raster_dir = settings.raster_dir / site_id
        files = _list_existing(raster_dir)
        return {
            "site_id": site_id,
            # The verification ladder, computed from evidence checks and verdicts. Only people move it.
            "verification": {k: v for k, v in verification(conn, site_id).items() if k != "agreement"},
            "calibration_status": site.get("calibration_status"),
            "optical_read": site.get("optical_read"),
            "geometry": site.get("geometry"),
            "pwtt_z": site.get("pwtt_z"),
            "burn_probability": site.get("burn_probability"),
            "burn_threshold": site.get("burn_threshold"),
            "features": site.get("features"),
            "seismic": site.get("seismic"),
            "scene_ids": site.get("scene_ids"),
            "acquisition_timestamps": site.get("timestamps"),
            "artifacts": {
                "before_png": files.get("before.png"),
                "after_png": files.get("after.png"),
                "dnbr_geotiff": files.get("dnbr.tif"),
                "burn_mask": files.get("burn_mask.tif"),
                "pwtt_z": files.get("pwtt_z.tif"),
            },
            "provenance": {
                "job_id": site.get("job_id"),
                "region": site.get("region"),
                "is_demo": bool(site.get("is_demo")),
                "note": "Evidence for review, not a finding.",
            },
        }


def _list_existing(directory: Path) -> dict[str, str | None]:
    names = ["before.png", "after.png", "dnbr.tif", "burn_mask.tif", "pwtt_z.tif"]
    if not directory.exists():
        return {n: None for n in names}
    return {n: str(directory / n) if (directory / n).exists() else None for n in names}


def write_provenance_json(site_id: str, bundle: dict[str, Any]) -> Path:
    out_dir = settings.raster_dir / site_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "provenance.json"
    path.write_text(json.dumps(bundle, indent=2))
    return path
