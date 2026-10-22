# Evaluation

Three layers, run with `pytest evals/`.

## Layer 1: model metrics

Regression tests for the burn classifier. They skip until a model file is present at `data/models/`, and their target figures will be set once the classifier is chosen (LightGBM or a single-index rule; see `DESIGN.md` §5.4).

## Layer 2: tool-call correctness

Fixture questions in `layer2/tool_sequences.json`, each with the MCP tools an agent should call, in order, and tools it must not call. For example, "Was there burning near Maungdaw in September 2017?" should call `check_coverage` → `screen_for_change` → `classify_burn`, and should not call `check_seismic_confound` on a burn-positive site.

The tests currently check the fixtures against the tool list. Scoring real agent tool-call logs against them is still to build.

## Layer 3: end to end

Areas with known answers, listed in `layer3/aois.md`. They are represented by synthetic demo locations until real imagery is exported.
