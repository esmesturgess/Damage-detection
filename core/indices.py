"""Spectral indices used by the burn classifier.

NBR, NBR2, MNDWI, dNBR. Feature values are physical quantities so the
classifier can transfer in principle; thresholds still need local calibration.
"""

from __future__ import annotations


def nbr(nir: float, swir2: float) -> float:
    return _norm_diff(nir, swir2)


def nbr2(swir1: float, swir2: float) -> float:
    return _norm_diff(swir1, swir2)


def mndwi(green: float, swir1: float) -> float:
    return _norm_diff(green, swir1)


def dnbr(pre_nbr: float, post_nbr: float) -> float:
    return pre_nbr - post_nbr


def _norm_diff(a: float, b: float) -> float:
    denom = a + b
    if denom == 0:
        return 0.0
    return (a - b) / denom


BURN_FEATURE_NAMES = (
    "mean_dnbr",
    "p95_dnbr",
    "nbr2_change",
    "stable_water_fraction",
)
