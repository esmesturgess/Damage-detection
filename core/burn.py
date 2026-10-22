"""LightGBM burn vs non-burn classification.

Inference only. Place a LightGBM text model at data/models/burn_lgbm.txt to
score new sites; seeded demo sites store their probabilities. Thresholds are
calibrated on Rakhine, so results elsewhere are marked provisional.
"""

from __future__ import annotations

import json
from typing import Any

from core.config import settings
from core.db import audit, row_to_dict, session, utcnow
from core.geo import calibration_status_for, parse_geometry
from core.indices import BURN_FEATURE_NAMES



def classify_burn(site_ids: list[str], threshold: float | None = None) -> list[dict[str, Any]]:
    thresh = threshold if threshold is not None else settings.default_burn_threshold
    results: list[dict[str, Any]] = []
    with session() as conn:
        for site_id in site_ids:
            row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
            site = row_to_dict(row)
            if not site:
                results.append({"site_id": site_id, "error": "not_found"})
                continue

            geom = parse_geometry(site["geometry"])
            calibration = site.get("calibration_status") or calibration_status_for(geom)
            features = site.get("features") or {}
            probability = site.get("burn_probability")
            source = "stored"

            if probability is None:
                inferred = _infer(features)
                if inferred is not None:
                    probability = inferred
                    source = "model"
                else:
                    results.append(
                        {
                            "site_id": site_id,
                            "error": "model_unavailable",
                            "note": (
                                "No stored probability and no LightGBM model file. "
                                "Place a rewritten model at data/models/burn_lgbm.txt "
                                "or run against seeded demo sites."
                            ),
                            "calibration_status": calibration,
                        }
                    )
                    continue

            burn_positive = probability >= thresh
            payload = {
                "site_id": site_id,
                "probability": probability,
                "threshold": thresh,
                "burn_positive": burn_positive,
                "features": {k: features.get(k) for k in BURN_FEATURE_NAMES},
                "burn_mask_ref": f"/bundle/{site_id}#burn_mask",
                "calibration_status": calibration,
                "optical_read": site.get("optical_read"),
                "source": source,
            }
            conn.execute(
                """
                UPDATE sites
                SET burn_probability = ?, burn_threshold = ?, calibration_status = ?,
                    features_json = COALESCE(features_json, ?)
                WHERE id = ?
                """,
                (
                    probability,
                    thresh,
                    calibration,
                    json.dumps(features) if features else None,
                    site_id,
                ),
            )
            audit(conn, "model", "classify_burn", "site", site_id, payload)
            results.append(payload)
    return results


def _infer(features: dict[str, Any]) -> float | None:
    if not settings.model_path.exists():
        return None
    missing = [k for k in BURN_FEATURE_NAMES if k not in features or features[k] is None]
    if missing:
        return None
    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError:
        return None
    booster = lgb.Booster(model_file=str(settings.model_path))
    x = np.array([[features[k] for k in BURN_FEATURE_NAMES]], dtype=float)
    pred = booster.predict(x)
    return float(pred[0])
