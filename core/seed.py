"""Synthetic demo sites so the globe is not empty without GEE.

These are labelled is_demo=1. They are not findings about real villages.
Real Rakhine seed rasters can replace them later without schema changes.
"""

from __future__ import annotations

import json

from core.db import new_id, utcnow

# Approximate Rakhine / northern corridor points for map orientation only.
DEMO_SITES = [
    {
        "name": "Demo A — burn-like spectral signature (Rakhine, synthetic)",
        "lon": 92.38,
        "lat": 20.82,
        "region": "rakhine",
        "pwtt_z": 4.7,
        "burn_probability": 0.91,
        "optical_read": "available",
        "calibration_status": "validated",
        "features": {
            "mean_dnbr": 0.42,
            "p95_dnbr": 0.61,
            "nbr2_change": 0.18,
            "stable_water_fraction": 0.02,
        },
        "scene_ids": {"s1_pre": ["S1A_demo_pre"], "s1_post": ["S1A_demo_post"], "s2_pre": ["S2_demo_pre"], "s2_post": ["S2_demo_post"]},
        "timestamps": {"event_window": ["2017-08-25", "2017-09-15"], "baseline_window": ["2016-08-01", "2017-08-01"]},
    },
    {
        # On the Sagaing fault near Sagaing town, so the change-without-burn
        # branch has a real earthquake (M7.7, 2025-03-28) to find.
        "name": "Demo B — change without burn, Sagaing fault (synthetic)",
        "lon": 95.98,
        "lat": 21.88,
        "region": "sagaing",
        "pwtt_z": 3.9,
        "burn_probability": 0.12,
        "optical_read": "available",
        "calibration_status": "provisional",
        "features": {
            "mean_dnbr": 0.04,
            "p95_dnbr": 0.09,
            "nbr2_change": 0.02,
            "stable_water_fraction": 0.11,
        },
        "scene_ids": {"s1_pre": ["S1A_demo_pre"], "s1_post": ["S1A_demo_post"]},
        "timestamps": {"event_window": ["2025-03-20", "2025-04-10"], "baseline_window": ["2024-03-01", "2025-03-01"]},
    },
    {
        "name": "Demo C — agricultural-burn confound (synthetic, implausible as settlement)",
        "lon": 92.90,
        "lat": 20.15,
        "region": "rakhine",
        "pwtt_z": 3.4,
        "burn_probability": 0.74,
        "optical_read": "available",
        "calibration_status": "validated",
        "features": {
            "mean_dnbr": 0.33,
            "p95_dnbr": 0.48,
            "nbr2_change": 0.14,
            "stable_water_fraction": 0.00,
        },
        "scene_ids": {"s2_pre": ["S2_demo_pre"], "s2_post": ["S2_demo_post"]},
        "timestamps": {"event_window": ["2018-03-01", "2018-03-20"]},
    },
    {
        "name": "Demo D — cloud gap, SAR change only (synthetic)",
        "lon": 93.10,
        "lat": 19.80,
        "region": "rakhine",
        "pwtt_z": 3.6,
        "burn_probability": None,
        "optical_read": "cloud_gap",
        "calibration_status": "validated",
        "features": {
            "mean_dnbr": None,
            "p95_dnbr": None,
            "nbr2_change": None,
            "stable_water_fraction": None,
        },
        "scene_ids": {"s1_pre": ["S1A_demo_pre"], "s1_post": ["S1A_demo_post"]},
        "timestamps": {"event_window": ["2017-09-01", "2017-09-30"]},
    },
    {
        "name": "Demo E — provisional outside Rakhine (synthetic)",
        "lon": 96.15,
        "lat": 21.97,
        "region": "mandalay",
        "pwtt_z": 4.1,
        "burn_probability": 0.55,
        "optical_read": "available",
        "calibration_status": "provisional",
        "features": {
            "mean_dnbr": 0.22,
            "p95_dnbr": 0.31,
            "nbr2_change": 0.09,
            "stable_water_fraction": 0.01,
        },
        "scene_ids": {},
        "timestamps": {"event_window": ["2025-04-01", "2025-04-20"]},
    },
]


def seed_demo(conn) -> int:
    existing = conn.execute("SELECT COUNT(*) FROM sites WHERE is_demo = 1").fetchone()[0]
    if existing:
        return 0
    now = utcnow()
    n = 0
    for spec in DEMO_SITES:
        sid = new_id("site")
        geom = {
            "type": "Point",
            "coordinates": [spec["lon"], spec["lat"]],
        }
        conn.execute(
            """
            INSERT INTO sites (
                id, job_id, name, geometry_geojson, status, calibration_status,
                optical_read, pwtt_z, burn_probability, burn_threshold,
                features_json, scene_ids_json, timestamps_json, region, is_demo, created_at
            ) VALUES (?, NULL, ?, ?, 'pending_review', ?, ?, ?, ?, 0.397, ?, ?, ?, ?, 1, ?)
            """,
            (
                sid,
                spec["name"],
                json.dumps(geom),
                spec["calibration_status"],
                spec["optical_read"],
                spec["pwtt_z"],
                spec["burn_probability"],
                json.dumps(spec["features"]),
                json.dumps(spec["scene_ids"]),
                json.dumps(spec["timestamps"]),
                spec["region"],
                now,
            ),
        )
        n += 1
    return n


# One demo site per verification level, so the ladder is visible without
# real submissions. Links are example.org placeholders except Demo B's,
# which is the real USGS page for the 2025 Sagaing earthquake.
DEMO_EVIDENCE = {
    "Demo A": {
        "items": [
            ("link", "https://example.org/demo/village-a-video", None, "original"),
            ("link", "https://example.org/demo/village-a-photos", None, "original"),
        ],
        "verdict": ("confirm", "Two independent sources match the burn scar and window."),
    },
    "Demo B": {
        "items": [
            ("link", "https://earthquake.usgs.gov/earthquakes/eventpage/us7000pn9s", None, "original"),
        ],
        "verdict": ("explained", "M7.7 Sagaing earthquake; ShakeMap MMI ~9 at the site."),
    },
    "Demo C": {
        "items": [
            ("testimony", None, "Synthetic: fields burned after harvest, as every March.", "original"),
        ],
        "verdict": ("explained", "Agricultural burning: scar is on cropland, no structures."),
    },
    "Demo D": {
        "items": [("link", "https://example.org/demo/site-d-report", None, "original")],
        "verdict": None,
    },
    "Demo E": {
        "items": [("link", "https://example.org/demo/site-e-post", None, None)],
        "verdict": None,
        "assessments": {"demo-user-1": "agree", "demo-user-2": "agree", "demo-user-3": "unsure"},
    },
}


def seed_demo_evidence(conn) -> int:
    if conn.execute("SELECT COUNT(*) FROM evidence WHERE is_demo = 1").fetchone()[0]:
        return 0
    n = 0
    for prefix, spec in DEMO_EVIDENCE.items():
        row = conn.execute(
            "SELECT id FROM sites WHERE is_demo = 1 AND name LIKE ?", (prefix + "%",)
        ).fetchone()
        if not row:
            continue
        site_id = row["id"]
        for kind, url, body, original in spec["items"]:
            eid = new_id("evd")
            conn.execute(
                """
                INSERT INTO evidence (id, site_id, kind, url, body, visibility, submitted_by, is_demo, created_at)
                VALUES (?, ?, ?, ?, ?, 'public', 'demo-submitter', 1, ?)
                """,
                (eid, site_id, kind, url, body, utcnow()),
            )
            if original:
                conn.execute(
                    """
                    INSERT INTO evidence_checks
                        (id, evidence_id, reviewer, located, dated, original, shares_source_with_json, note, created_at)
                    VALUES (?, ?, 'demo-reviewer-1', 'yes', 'yes', ?, '[]', 'Synthetic demo check.', ?)
                    """,
                    (new_id("chk"), eid, original, utcnow()),
                )
            n += 1
        if spec["verdict"]:
            verdict, note = spec["verdict"]
            conn.execute(
                """
                INSERT INTO verdicts (id, site_id, verdict, analyst, model_snapshot_json, note, created_at)
                VALUES (?, ?, ?, 'demo-reviewer-2', '{"demo": true}', ?, ?)
                """,
                (new_id("vrd"), site_id, verdict, note, utcnow()),
            )
            status = "confirmed" if verdict == "confirm" else verdict
            conn.execute("UPDATE sites SET status = ? WHERE id = ?", (status, site_id))
        for user, stance in spec.get("assessments", {}).items():
            conn.execute(
                "INSERT OR IGNORE INTO assessments (site_id, user, stance, created_at) VALUES (?, ?, ?, ?)",
                (site_id, user, stance, utcnow()),
            )
    return n
