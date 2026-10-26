# Evaluation

Three layers, run with `pytest evals/`.

## Layer 1: model metrics

Regression tests for the burn classifier. They skip until a model file is present at `data/models/`, and their target figures will be set once the classifier is chosen (LightGBM or a single-index rule; see `DESIGN.md` §5.4).

## Layer 2: tool-call correctness

Fixture questions in `layer2/tool_sequences.json`, each with the MCP tools an agent should call (in order, or in any order), tools it must not call, and arguments each call must carry. For example, "Was there burning near Maungdaw in September 2017?" should call `check_coverage` → `screen_for_change` → `get_scan_result` → `classify_burn`.

`layer2/run_agent.py` puts each question to an agent (Claude Code, non-interactive, with only this MCP server and no shell, file or web tools), records every tool call and result, and scores them with `layer2/scoring.py`:

```bash
python evals/layer2/run_agent.py                  # all fixtures
python evals/layer2/run_agent.py maungdaw_2017    # one
python evals/layer2/run_agent.py --model sonnet   # compare models
```

Each run works on a snapshot of the database with its own scan worker, so agent searches and scans never reach the real audit trail. Transcripts, scores and the snapshot are saved in `layer2/runs/<timestamp>/` (git-ignored). `pytest evals/layer2` checks the scorer itself and that the fixtures name only tools the server really has.

## Layer 3: end to end

Areas with known answers, listed in `layer3/aois.md`. They are represented by synthetic demo locations until real imagery is exported.

