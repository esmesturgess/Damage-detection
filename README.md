# Burn Evidence

A map for investigating burning and structural destruction from satellite imagery, with a public evidence layer.

Draw a box or enter coordinates, pick a time range, and the tool screens the area for structural change (Sentinel-1 radar, Pixel-Wise T-Test), burn signatures (Sentinel-2 burn indices) and nearby earthquakes (USGS). Anyone can then attach evidence to a location. Reviewers check each item against the imagery, and a location's verification level is computed from that evidence, never from votes.

See [`DESIGN.md`](DESIGN.md) for the full design.

## Status

| Part | State |
|---|---|
| Map, time bar, area probe (box or coordinates) | Working |
| Verification levels, evidence (links, testimony), reviewer checks, agreement | Working |
| Seismic check (USGS FDSN + ShakeMap intensity at the site) | Working on live data |
| Earth Engine coverage check | Working with credentials; per-orbit breakdown to build |
| PWTT change detection worker | Not built yet: scans are queued but not run |
| Burn indices from Sentinel-2 | Not built yet |
| Burn classifier (LightGBM) | Inference code only; under evaluation against a single-index rule |

Locations on the map are synthetic demo data, labelled as such.

## Verification levels

| Level | Meaning |
|---|---|
| Detected | Satellite signal only. Hidden from the public map by default |
| Corroborated | At least one evidence item located and dated by a reviewer |
| Verified | Two or more independent sources, signed off by a second reviewer who checked none of them |
| Explained | A reviewer found a non-hostile cause (crop burning, earthquake, construction) |
| Disputed | Credible evidence on both sides |

Agreement counts are shown, but they never change a level. Reposts of the same source count once. No API route or MCP tool can raise a level without a reviewer.

## Contributor safety

Who submitted an item is never returned by the public API. Submitters can mark an item "reviewers only": it counts towards verification, but its content isn't published. Uploads aren't accepted yet; when they are, metadata (EXIF, GPS) will be stripped on the server before storage.

## Quick start

Python 3.11+, Node 22+.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env

uvicorn api.main:app --reload --port 8000
# in another shell
python -m api.worker
# in another shell
cd web && npm install && npm run dev
```

- UI: http://localhost:3000
- API docs: http://localhost:8000/docs
- Reviewer mode in the UI uses the `ANALYST_TOKEN` from `.env` (default `dev-token`).

### Earth Engine (optional)

Without Earth Engine the app runs on the seeded demo data. To run live coverage checks and scans:

```bash
pip install -e ".[gee]"
```

Then in `.env`, set `ENABLE_LIVE_GEE=true` and either:

- `GEE_PROJECT` only, after running `earthengine authenticate` (personal login), or
- `GEE_SERVICE_ACCOUNT_JSON` (path to a key file kept outside the repo) and `GEE_PROJECT`.

The project must be registered for Earth Engine. The Community tier allows 150 EECU-hours a month.

### MCP server

```bash
python -m mcp_server.server
```

Five tools over the same core as the API: `check_coverage`, `screen_for_change`, `classify_burn`, `check_seismic_confound`, `get_evidence_bundle`.

## Architecture

```
Next.js + MapLibre ── REST ── FastAPI ──┬── worker (jobs table)
                                        └── MCP server
                                  │
                      core/ (no web dependencies)
                                  │
                        SQLite + rasters on disk
```

The API and the MCP server both import `core/`, so the MCP server is a thin wrapper, not a second implementation. SQLite keeps the repo runnable with no database server; it's single-writer, so a public deployment needs Postgres. A `jobs` table polled by one worker handles long Earth Engine runs without a message broker.

## Tests

```bash
pytest
```

`tests/` covers the review rules, verification levels, contributor privacy and the seismic check. `evals/` holds model-metric, tool-call and end-to-end evaluation scaffolding; see [`evals/README.md`](evals/README.md).

## Known limitations

- **Agricultural burning** looks spectrally like settlement burning. It's handled through evidence and the Explained level, not by the detector.
- **Burn readings are calibrated on Rakhine State, Myanmar.** Elsewhere they're marked provisional.
- **Wildfire and deliberate burning** can't be told apart from spectra alone.
- **Sentinel-1 revisit varies by region**, and some areas have too few scenes for a reliable test.
- **Cloud gaps are reported, not filled.** Radar change detection still runs under cloud.
- **No user accounts yet.** Handles are self-chosen and reviewer access is a shared token: fine for a demo, not for public use.

## Acknowledgements

Pixel-Wise T-Test by Ollie Ballinger. Earthquake data from the USGS. Basemap © OpenStreetMap contributors, © CARTO.
