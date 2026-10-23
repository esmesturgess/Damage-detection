# Evaluation

Three layers, run with `pytest evals/`.

## Layer 1: model metrics

Regression tests for the burn classifier. They skip until a model file is present at `data/models/`, and their target figures will be set once the classifier is chosen (LightGBM or a single-index rule; see `DESIGN.md` §5.4).

## Layer 2: tool-call correctness

Fixture questions in `layer2/tool_sequences.json`, each with the MCP tools an agent should call, in order, and tools it must not call. For example, "Was there burning near Maungdaw in September 2017?" should call `check_coverage` → `screen_for_change` → `classify_burn`, and should not call `check_seismic_confound` on a burn-positive site.

The tests currently check the fixtures against the tool list. Scoring real agent tool-call logs against them is still to build.

## Layer 3: end to end

Areas with known answers, listed in `layer3/aois.md`. They are represented by synthetic demo locations until real imagery is exported.

## Place search

`places/golden.json` holds 300 real variant spellings from GeoNames: 150 other romanisations and 150 Burmese-script names, one per place. Each case removes its spelling from the index, searches for it, and checks whether the right place comes back (top 1, top 5), or at least a place with the right name (many villages share one).

```bash
python evals/places/place_eval.py run           # search alone
python evals/places/place_eval.py run --scout   # with the spelling scout (Ollama)
```

Baseline, search alone: romanisations top 5 0.50 (right name 0.59); Burmese script 0.00 (right name 0.37, only via other places with the same name). `places/test_place_search.py` keeps the romanisation figures from slipping.
