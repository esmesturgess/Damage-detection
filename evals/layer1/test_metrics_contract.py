from pathlib import Path

from core.config import settings

# Published LightGBM burn detector (ADS paper, Table II; burned subset only).
LIGHTGBM_F1 = 0.977
BURN_THRESHOLD = 0.91


def test_threshold_is_recall_first():
    assert settings.default_burn_threshold == BURN_THRESHOLD


def test_model_file_optional_for_demo():
    # Absence is allowed: demo uses seeded probabilities.
    # Presence will enable evals/layer1 regression in a later commit.
    if not settings.model_path.exists():
        return
    assert Path(settings.model_path).stat().st_size > 0
