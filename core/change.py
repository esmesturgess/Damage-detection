"""Signed-Stouffer PWTT: Ballinger's Pixel-Wise T-Test with the orbits combined by direction.

PWTT (core/_vendor/pwtt) takes the absolute t value on each orbit, then sums the orbits
with Stouffer's method. Absolute values can't cancel, so noise alone climbs with the
number of orbits: in Nablus, where nothing happened, the median pixel scores T 4.1 in
Aug-Sep 2017 and 3.4 in Aug-Sep 2016, from per-pixel changes of about 0.5 dB.

Here each orbit's t keeps its sign (after brighter or darker than before), the orbits are
combined with the same sqrt(df) Stouffer weights, and the absolute value is taken only
after combining. Destruction changes backscatter the same way from every orbit, so it
still adds up; noise points both ways and cancels. Everything else follows the vendored
code: per-image Lee filter, log backscatter, Welch t-test, at least 3 images before and 2
after, Dynamic World built-up mask, focal median then 50/100/150 m smoothing, the
stronger of VV and VH.
"""

from __future__ import annotations

from typing import Any

SMOOTH_KERNELS_M = (50, 100, 150)


def signed_pwtt(region, war_start: str, inference_start: str, pre_months: int, post_months: int):
    """Image with band T_statistic, comparable to pwtt.detect_damage(...).select("T_statistic")."""
    import ee

    from core._vendor import pwtt

    war_start, inference_start = ee.Date(war_start), ee.Date(inference_start)
    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD_FLOAT")
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filterBounds(region)
    )
    orbits = (
        s1.filterDate(inference_start, inference_start.advance(post_months, "month"))
        .aggregate_array("relativeOrbitNumber_start")
        .distinct()
    )
    empty = ee.Image.constant([0, 0, 0]).rename(["wVV", "wVH", "w2"]).updateMask(0).toFloat()

    def per_orbit(orbit):
        col = (
            s1.filter(ee.Filter.eq("relativeOrbitNumber_start", orbit))
            .map(pwtt.lee_filter)
            .select(["VV", "VH"])
            .map(lambda i: i.log())
        )
        pre = col.filterDate(war_start.advance(-pre_months, "month"), war_start)
        post = col.filterDate(inference_start, inference_start.advance(post_months, "month"))
        pre_n, post_n = pre.select("VV").count(), post.select("VV").count()
        var_pre = pre.reduce(ee.Reducer.stdDev()).pow(2).divide(pre_n)
        var_post = post.reduce(ee.Reducer.stdDev()).pow(2).divide(post_n)
        sum_var = var_pre.add(var_post)
        t = post.mean().subtract(pre.mean()).divide(sum_var.sqrt().rename(["VV", "VH"]))  # signed
        df = sum_var.pow(2).divide(var_pre.pow(2).divide(pre_n.subtract(1)).add(var_post.pow(2).divide(post_n.subtract(1))))
        w = df.select(0).max(df.select(1)).sqrt()
        out = t.multiply(w).rename(["wVV", "wVH"]).addBands(w.pow(2).rename("w2"))
        out = out.updateMask(pre_n.gte(3).And(post_n.gte(2)))
        return ee.Image(ee.Algorithms.If(pre.size().gt(0).And(post.size().gt(0)), out, empty))

    stack = ee.ImageCollection(orbits.map(per_orbit)).merge(ee.ImageCollection([empty]))
    norm = stack.select("w2").sum().sqrt()
    z = stack.select(["wVV", "wVH"]).sum().divide(norm).abs()
    max_change = z.select("wVV").max(z.select("wVH"))

    urban = (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterDate(war_start.advance(-pre_months, "month"), war_start)
        .select("built")
        .merge(ee.ImageCollection([ee.Image.constant(1).rename("built").updateMask(0)]))
        .mosaic()
    )
    raw = max_change.mask()
    smooth = max_change.updateMask(urban.gt(0.1)).updateMask(raw).focalMedian(10, "gaussian", "meters").clip(region)
    layers: list[Any] = [smooth] + [smooth.convolve(ee.Kernel.circle(r, "meters", True)) for r in SMOOTH_KERNELS_M]
    t_stat = layers[0].multiply(0.25)
    for layer in layers[1:]:
        t_stat = t_stat.add(layer.multiply(0.25))
    return t_stat.updateMask(raw).rename("T_statistic")
