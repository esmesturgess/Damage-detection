"""Place-search evaluation: does a variant spelling find the right place?

The golden set is real alternate spellings from GeoNames. Each case holds one
alternate out of the index, searches for it, and checks whether the place it
belongs to comes back (top 1, top 5). Many villages share a name, so name_top5
also counts any place with the expected main name: the spelling was solved,
and the investigator picks between same-named places by district. Two categories:

  latin    another romanisation of the name ("Buthedaung" for Buthidaung)
  burmese  the name in Burmese script

Usage:
  python evals/places/place_eval.py build      # write golden.json from data/gazetteer
  python evals/places/place_eval.py run        # search alone
  python evals/places/place_eval.py run --scout  # search plus the spelling scout (needs Ollama)
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from core.places import Gazetteer, gazetteer_dir, load, plain  # noqa: E402

GOLDEN = Path(__file__).with_name("golden.json")
SEED = 20261023
PER_CATEGORY = 150


def is_burmese(s: str) -> bool:
    return any("က" <= c <= "႟" for c in s)


def build_golden(per_category: int = PER_CATEGORY) -> list[dict]:
    gaz = load(gazetteer_dir())
    rng = random.Random(SEED)
    pools: dict[str, list[dict]] = {"latin": [], "burmese": []}
    for p in gaz.places:
        if p.feature_class != "P":
            continue
        names = [n for n in p.alternates if not plain(n).startswith("mmr")]
        keys = [plain(n) for n in names]
        for alt, key in zip(names, keys):
            # A real variant: unlike the main name and unique among this place's spellings.
            if not key or key == plain(p.name) or keys.count(key) > 1:
                continue
            category = "burmese" if is_burmese(alt) else "latin"
            if category == "latin" and (not alt.isascii() or len(key) < 4):
                continue
            pools[category].append(
                {"query": alt, "category": category, "geonames_id": p.id, "name": p.name, "admin1": p.admin1}
            )
    cases = []
    for category, pool in pools.items():
        rng.shuffle(pool)
        seen_places: set[int] = set()
        for case in pool:
            if case["geonames_id"] in seen_places:
                continue
            seen_places.add(case["geonames_id"])
            cases.append(case)
            if len(seen_places) == per_category:
                break
    return cases


def held_out_index(cases: list[dict], folder: Path | None = None) -> Gazetteer:
    """The full gazetteer minus every held-out spelling, so a case can't match itself."""
    gaz = load(folder or gazetteer_dir())
    held: dict[int, set[str]] = {}
    for c in cases:
        held.setdefault(c["geonames_id"], set()).add(plain(c["query"]))
    places = [
        replace(p, alternates=tuple(a for a in p.alternates if plain(a) not in held[p.id])) if p.id in held else p
        for p in gaz.places
    ]
    return Gazetteer(places, gaz.admin, gaz.features)


def evaluate(cases: list[dict], scout: bool = False, folder: Path | None = None) -> dict:
    index = held_out_index(cases, folder)
    if scout:
        from core import scout as scout_module

        scout_module.gazetteer = lambda: index  # search the held-out index
    by_cat: dict[str, dict[str, int]] = {}
    misses: list[dict] = []
    started = time.time()
    for c in cases:
        if scout:
            out = scout_module.scouted_search(c["query"], limit=5)
            hits = out["results"]
        else:
            hits = index.search(c["query"], limit=5)
        ids = [r["geonames_id"] for r in hits]
        m = by_cat.setdefault(c["category"], {"n": 0, "top1": 0, "top5": 0, "name_top5": 0})
        m["n"] += 1
        m["top1"] += bool(ids) and ids[0] == c["geonames_id"]
        m["top5"] += c["geonames_id"] in ids
        m["name_top5"] += any(plain(r["name"]) == plain(c["name"]) for r in hits)
        if c["geonames_id"] not in ids:
            misses.append(c)
    report = {
        cat: {"n": m["n"], **{k: round(m[k] / m["n"], 3) for k in ("top1", "top5", "name_top5")}}
        for cat, m in by_cat.items()
    }
    return {"scout": scout, "seconds": round(time.time() - started, 1), "metrics": report, "misses": misses}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["build", "run"])
    ap.add_argument("--scout", action="store_true")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if args.command == "build":
        cases = build_golden()
        GOLDEN.write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {len(cases)} cases to {GOLDEN}")
        return
    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))
    result = evaluate(cases, scout=args.scout)
    print(json.dumps({k: v for k, v in result.items() if k != "misses"}, indent=1))
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
