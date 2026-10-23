"""Regression floor for place search on real variant spellings (see place_eval.py).

Floors sit just under the measured baseline (latin: top5 0.50, name_top5 0.593)
so a change that makes search worse fails here. Skips without the gazetteer.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from core.places import gazetteer_dir  # noqa: E402
from place_eval import GOLDEN, evaluate  # noqa: E402

# Resolved at import: other tests point settings at a temporary data folder.
GAZETTEER = gazetteer_dir()
pytestmark = pytest.mark.skipif(
    not list(GAZETTEER.glob("[A-Z][A-Z].txt")), reason="no gazetteer: python -m core.places fetch MM"
)


def test_latin_variants_floor():
    cases = [c for c in json.loads(GOLDEN.read_text(encoding="utf-8")) if c["category"] == "latin"]
    metrics = evaluate(cases, folder=GAZETTEER)["metrics"]["latin"]
    assert metrics["top5"] >= 0.48
    assert metrics["name_top5"] >= 0.57
