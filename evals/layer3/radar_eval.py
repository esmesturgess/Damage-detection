"""Which change and burn measures separate burned villages from unburned ones?

Ground truth is the ADS dataset (private; read from a local ADS checkout, never
copied into this repo): villages labelled burned (label 1, excluding the
"negative only" IDs in splits.json) and unburned control villages (label 0),
each with an event window from its pre_4 to post_1 image dates, as in the
LightGBM training. This run keeps windows that end in 2017, the main campaign.

For every village, within BUFFER_M of its point, it records:
  T          PWTT T statistic (Ballinger), 12 months before vs the window: what the app shows now
  d          effect size per orbit, |mean after - mean before| / sd before, orbits averaged:
             change measured against the pixel's own variability; doesn't grow with more passes
  dnbr_seas  dNBR with the before taken from the same months a year earlier (app's new burn layer)
  dnbr_12m   dNBR with a 12-month before (the old burn layer)
and reports, per measure, ROC AUC and the share of burned and control cases above
each cut-off.

Two designs:
  default    burned villages vs the control villages. Confounded: the controls sit
             further south-east, on different ground, so this mostly compares places.
  --within   each burned village in its burn window vs the same village in the same
             months a year earlier (the paper's logic: negatives are the same villages
             at times without burning). Control windows ending on or after 9 Oct 2016
             are dropped, since the October 2016 operations in Maungdaw burned villages too.

  python evals/layer3/radar_eval.py --ads /path/to/ADS [--within]   # writes evals/layer3/runs/<time>/
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

BUFFER_M = 250
QUIET_UNTIL = "2016-10-08"  # last day before the October 2016 operations
SCALE_M = 20
CUTS = {"T": [3, 4, 5], "d": [1.0, 1.5, 2.0], "dnbr_seas": [0.1, 0.27], "dnbr_12m": [0.1, 0.27]}


def load_labels(ads: Path) -> list[dict]:
    show = lambda ref: subprocess.run(["git", "-C", str(ads), "show", ref], capture_output=True, text=True, check=True).stdout  # noqa: E731
    neg_only = set(json.loads(show("origin/ensemble:models/ensemble/splits.json"))["negative_only_ids"])
    villages = []
    for path, label in (("s1_all_images", 1), ("s1_negatives", 0)):
        rows = csv.DictReader(io.StringIO(show(f"origin/Damage_Ttest:Ttest_myanmar/{path}/index.csv")))
        by: dict[str, dict] = defaultdict(dict)
        for r in rows:
            by[r["village_id"]][(r["period"], r["slot"])] = r
        for vid, slots in by.items():
            pre4, post1 = slots.get(("pre", "4")), slots.get(("post", "1"))
            if not pre4 or not post1 or vid in neg_only:
                continue
            if label == 1 and pre4["label"] != "1.0":
                continue
            villages.append({
                "id": vid, "label": label, "lon": float(pre4["lon"]), "lat": float(pre4["lat"]),
                "start": pre4["target_date"], "end": post1["target_date"],
            })
    return [v for v in villages if v["end"] <= "2017-12-31"]


def measure(window: tuple[str, str], villages: list[dict]) -> list[dict]:
    import ee

    from core._vendor import pwtt
    from core.imagery import clear_scenes, optical_pair, pick_product

    start, end = window
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    pre_start = (s - timedelta(days=365)).isoformat()
    pts = ee.FeatureCollection([ee.Feature(ee.Geometry.Point(v["lon"], v["lat"]).buffer(BUFFER_M), {"id": v["id"]}) for v in villages])
    region = pts.geometry().bounds().buffer(2000)
    months = max(1, round((e - s).days / 30.44))
    layers = []

    t = pwtt.detect_damage(aoi=region, war_start=start, inference_start=start, pre_interval=12, post_interval=months)
    layers.append(t.select("T_statistic").rename("T"))

    s1 = (ee.ImageCollection("COPERNICUS/S1_GRD_FLOAT").filterBounds(region)
          .filter(ee.Filter.eq("instrumentMode", "IW"))
          .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH")))
    orbits = s1.filterDate(start, end).aggregate_array("relativeOrbitNumber_start").distinct()

    def per_orbit(o):
        col = s1.filter(ee.Filter.eq("relativeOrbitNumber_start", o)).map(pwtt.lee_filter).select(["VV", "VH"]).map(lambda i: i.log())
        pre, post = col.filterDate(pre_start, start), col.filterDate(start, end)
        d = post.mean().subtract(pre.mean()).abs().divide(pre.reduce(ee.Reducer.stdDev()).rename(["VV", "VH"]))
        return d.updateMask(pre.select("VV").count().gte(3).And(post.select("VV").count().gte(2)))

    d = ee.ImageCollection(orbits.map(per_orbit)).mean()
    layers.append(d.select("VV").max(d.select("VH")).rename("d"))

    baseline = {"start": pre_start, "end": (s - timedelta(days=1)).isoformat()}
    event = {"start": start, "end": end}
    pair = optical_pair(region, baseline, event)
    if pair and pair["seasonal"]:
        pre = clear_scenes(pair["product"], region, *pair["pre"]).median()
        post = clear_scenes(pair["product"], region, start, pair["post_end"]).median()
        layers.append(pre.normalizedDifference(["B8", "B12"]).subtract(post.normalizedDifference(["B8", "B12"])).rename("dnbr_seas"))
    found = pick_product(region, baseline["start"], baseline["end"], start, (e + timedelta(days=90)).isoformat())
    if found:
        pre = clear_scenes(found[0], region, baseline["start"], baseline["end"]).median()
        post = clear_scenes(found[0], region, start, (e + timedelta(days=90)).isoformat()).median()
        layers.append(pre.normalizedDifference(["B8", "B12"]).subtract(post.normalizedDifference(["B8", "B12"])).rename("dnbr_12m"))

    stats = ee.Image.cat(layers).reduceRegions(pts, ee.Reducer.mean(), SCALE_M).getInfo()["features"]
    by_id = {f["properties"]["id"]: f["properties"] for f in stats}
    return [{**v, **{k: by_id.get(v["id"], {}).get(k) for k in CUTS}} for v in villages]


def auc(pos: list[float], neg: list[float]) -> float | None:
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 3)


def report(rows: list[dict]) -> dict:
    out = {}
    for k, cuts in CUTS.items():
        pos = [r[k] for r in rows if r["label"] == 1 and r[k] is not None]
        neg = [r[k] for r in rows if r["label"] == 0 and r[k] is not None]
        out[k] = {
            "villages_with_value": {"burned": len(pos), "control": len(neg)},
            "auc": auc(pos, neg),
            "above_cut": {
                str(c): {"burned": f"{100 * sum(p >= c for p in pos) / max(1, len(pos)):.0f}%",
                         "control": f"{100 * sum(n >= c for n in neg) / max(1, len(neg)):.0f}%"}
                for c in cuts
            },
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ads", type=Path, required=True, help="local checkout of the ADS repo (all branches fetched)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--within", action="store_true", help="burned villages vs themselves a year earlier")
    args = ap.parse_args()

    from core.gee import initialize

    initialize()
    villages = load_labels(args.ads)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    if args.within:
        year = timedelta(days=365)
        for v in (v for v in villages if v["label"] == 1):
            groups[(v["start"], v["end"])].append(v)
            earlier = ((date.fromisoformat(v["start"]) - year).isoformat(), (date.fromisoformat(v["end"]) - year).isoformat())
            if earlier[1] <= QUIET_UNTIL:
                groups[earlier].append({**v, "label": 0, "start": earlier[0], "end": earlier[1]})
        villages = [v for vs in groups.values() for v in vs]
    else:
        for v in villages:
            groups[(v["start"], v["end"])].append(v)
    print(f"{'within-village' if args.within else 'between-village'}: {sum(v['label'] for v in villages)} burned, "
          f"{sum(1 - v['label'] for v in villages)} control cases; {len(groups)} windows", flush=True)

    out_dir = Path(__file__).with_name("runs") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir.mkdir(parents=True, exist_ok=True)
    rows, failed = [], []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(measure, w, vs): w for w, vs in groups.items()}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                rows.extend(fut.result())
            except Exception as exc:  # one window failing shouldn't sink the run
                failed.append({"window": futures[fut], "error": str(exc)[:200]})
            if i % 10 == 0 or i == len(futures):
                print(f"  {i}/{len(futures)} windows", flush=True)

    result = {"design": "within" if args.within else "between", "buffer_m": BUFFER_M, "villages": len(rows), "failed_windows": failed, "measures": report(rows)}
    (out_dir / "villages.json").write_text(json.dumps(rows))
    (out_dir / "report.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result["measures"], indent=1))
    print(f"failed windows: {len(failed)} · saved to {out_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
