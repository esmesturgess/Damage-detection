# Burn Evidence — system design v4

A public probe-and-verify platform. Anyone can draw a box or enter coordinates, set a time range, and get a satellite read of what changed there: structural change (PWTT), burn indices, and seismic activity. People can then attach evidence, including people on the ground. Reviewers check that evidence against the imagery, and a location reaches the public map once it is corroborated.

**Supersedes v3.** v3 described an analyst's screening tool. v4 keeps its detection pipeline and human-in-the-loop rules, and adds the probe flow, the time bar, community evidence and a verification ladder.

**Decisions locked:** runs anywhere, validated in Rakhine · seismic confound on the change-without-burn branch · MCP server with no chat UI · dark map leads · Next.js + MapLibre + FastAPI + SQLite · **verification by evidence, never by votes** · **no machine path to "verified"**

**Open decisions** are marked ⚑ and collected in section 14.

---

## 1. What this is

| Layer | Purpose | State |
|---|---|---|
| Probe | Draw a box or enter coordinates, clamp a time range | Box draw built; time bar and coordinate entry to build |
| Detection | PWTT structural change, burn indices, seismic check | Seismic built; PWTT and indices to build |
| Evidence | Links (and later uploads) attached to a location, each with a checklist | To build |
| Verification | Reviewers move locations up a ladder; agreement counts are shown but don't decide | Single-analyst verdicts built; ladder to build |
| Public map | Locations at Corroborated and above, colour-coded by level | Map built; level styling to build |
| MCP | Any agent harness can probe and read evidence. No tool can verify | Built (5 tools) |

Change detection uses Ballinger's Pixel-Wise T-Test, which is already used for damage mapping. This project adds burn indices, a seismic check, and a public evidence layer verified the way open-source investigators verify material.

---

## 2. Principles

1. **Evidence, not votes.** On a contested topic a vote count measures who turned up, not what happened, and coordinated groups can push it either way. Verification rests on independent evidence that a reviewer has located and dated. Agreement counts are shown as a sign of interest and never move a location up the ladder.
2. **The machine detects; people verify.** Satellite output is always labelled *machine detection, not verified*. No code path, API route or MCP tool sets a level above Detected without a human reviewer. This extends v3's `pending_review` rule from one analyst to a group of reviewers.
3. **Contributor safety outranks convenience.** People submitting from conflict areas can be put in danger by metadata, by being linked to a place, or by being identifiable. Section 7 is a requirement, not a nice-to-have.
4. **Calibration is visible.** Burn readings carry `calibration_status`: `validated` inside Rakhine, `provisional` elsewhere. The UI draws the two differently.
5. **Raw values are always shown.** Any model score sits next to the indices it was computed from, never in place of them.

---

## 3. User flow

```
 Probe                 Scan                    Results                 Evidence              Map
┌──────────────┐   ┌──────────────────┐   ┌──────────────────────┐   ┌────────────────┐   ┌──────────────┐
│ draw box or  │──▶│ cache hit?       │──▶│ change map (PWTT z)  │──▶│ attach link /  │──▶│ Corroborated │
│ coordinates  │   │  yes → stored    │   │ dNBR, NBR2, before/  │   │ testimony;     │   │ and above    │
│ + time range │   │  no  → queue job │   │ after, seismic flags │   │ reviewer runs  │   │ shown, colour│
└──────────────┘   └──────────────────┘   │ "machine detection"  │   │ the checklist  │   │ by level     │
                                          └──────────────────────┘   └────────────────┘   └──────────────┘
```

A probe that finds nothing is still useful. It's stored, so the next person probing the same area and time sees "scanned, no change detected" without spending quota.

---

## 4. The time bar

- **A two-handle range slider across the top of the map**, from **October 2014** (Sentinel-1) to today. Optical burn indices are only available from mid-2015 (Sentinel-2), so the bar shades the period before that as "radar only".
- **The clamped range is the event window.** The baseline defaults to the 12 months before its start and can be changed in an advanced panel. This is the `baseline_window` / `event_window` pair the API already takes.
- **Long ranges get a warning.** PWTT compares before against after, so a 16-month window blurs everything inside it. Above about 6 months the UI says change detection gets weaker and suggests narrowing.
- **Later:** after a scan, the bar shows a strip of monthly change intensity, so people can see *when* something happened rather than only whether it did.

---

## 5. Detection pipeline

### 5.1 Coverage, per orbit

`check_coverage(aoi, baseline_window, event_window)` returns, for each Sentinel-1 relative orbit over the area, its pass direction and scene counts in each window, plus Sentinel-2 scene count and mean cloud fraction. It runs before every new scan and refuses, with a reason, when there isn't enough imagery.

### 5.2 PWTT

Use Ollie Ballinger's open-source `pwtt` package as a dependency rather than a rewrite (check its licence first). Its `detect_damage` already handles the orbit problem v3 section 3 described, in a better way than picking one track: it runs the test separately on **every** orbit covering the area and combines them with Stouffer's weighted Z (weighted by √df). Mixing viewing angles inside one test, the thing that ruins results, never happens.

- The worker tiles AOIs above the interactive limit and uses Earth Engine export for large areas.
- Every result records which orbits contributed, the scene IDs and acquisition times.
- `screen_for_change` accepts an optional orbit subset for analysts who want to exclude one.

### 5.3 Burn indices

Computed from Sentinel-2 SR for every scan with an optical read: dNBR (B8/B12) percentiles and threshold fractions, NBR2 change, dNDVI. These match the ADS feature definitions (`dnbr_b8_p95`, `dnbr_b8_frac_gt_0_10`, `dnbr_b8_frac_gt_0_27`, `dnbr_b8_top_5pct_mean`, `delta_nbr2_p95`, optionally `dndvi_p95`, `dndvi_top_5pct_mean`). Under cloud the result says "no optical read" rather than nothing.

### 5.4 LightGBM: keep or drop?

Decided by experiment, not assumption. On the ADS held-out test set, compare:

- LightGBM (5- and 7-feature variants), against
- a single-feature rule, `dnbr_b8_p95 > t`, with `t` tuned on the same internal validation split.

If the rule is within a couple of F1 points, drop the model: a public tool is easier to defend with an interpretable threshold. If LightGBM is clearly better, keep it as a ranking score shown beside the raw indices. Either way the raw indices are always displayed.

The published figures need resolving first (⚑ section 14): the ADS repo shows test F1 0.714 (5 features, threshold 0.46) and 0.903 (7 features, threshold 0.71); 0.977 and 0.397 don't appear in it.

### 5.5 Seismic check (built)

Runs on the change-without-burn branch only. It searches USGS FDSN from 30 days before the event window to its end. Earthquakes count up to a distance that scales with magnitude (300 km below M6, 400 km for M6–7, 800 km at M7+), because large ruptures run hundreds of km from the epicentre. The ShakeMap MMI sampled at the site then decides: MMI ≥ VI flags `possible_seismic`. Without a ShakeMap, M≥6 within 300 km still flags. It's a flag, never an exclusion. Verified on live data: a site on the Sagaing fault finds the 2025 M7.7 at 15 km with MMI 9.2.

ShakeMap grids are ~18 MB per large event. Cache them by event ID before scans run at volume.

---

## 6. Verification ladder and evidence model

### 6.1 Levels

| Level | Rule | Map style |
|---|---|---|
| **Detected** | Satellite signal only, no reviewed evidence | grey outline; not on public map ⚑ |
| **Corroborated** | ≥1 evidence item that a reviewer has located **and** dated against the imagery | amber |
| **Verified** | ≥2 **independent** corroborating items, and sign-off from a second reviewer who didn't check those items | red |
| **Explained** | Reviewer-confirmed non-hostile cause: agricultural burn, earthquake, construction, wildfire | blue |
| **Disputed** | Credible evidence on both sides, flagged by a reviewer | striped amber/blue |

Levels are computed from evidence checks and reviews, never set directly, so every level can be traced to the specific items and reviewers behind it. Burn readings that are `provisional` (outside Rakhine) can still reach Verified on evidence; the calibration label stays attached to the satellite reading.

### 6.2 Evidence item

Each item is one of: **link** (social post, news article; archiving on submission is still to build), **testimony** (text), **upload** (photo or video, ⚑ v1 or later), or **satellite** (a scan result, added automatically).

Each item carries a checklist that a reviewer completes:

- **Located:** matched to the satellite imagery or known landmarks (yes / no / can't tell), with a note on how
- **Dated:** consistent with the event window (yes / no / can't tell), with method
- **Original:** first-hand source, or a repost (and of what)
- **Shares a source with:** which other items come from the same underlying source
- **Checked by:** reviewer, and when

Independence matters most: ten reposts of one video are one source.

### 6.3 Agreement

Signed-in users can mark a location agree / disagree / unsure with an optional reason. Counts are shown. They sort the reviewers' queue (high interest first), but never change a level.

---

## 7. Contributor safety

Requirements, not options:

1. **Metadata removed on the server before anything is stored.** EXIF, GPS, device IDs, embedded thumbnails. The upload screen says plainly that this happens.
2. **No real identity required.** Pseudonymous accounts. The public never sees who submitted an item, and nothing publicly links "this person" to "this place".
3. **Reviewer-only option.** A submitter can mark an item "share with reviewers only". It counts towards the level, but its content isn't published.
4. **Approximate location for others.** An item's exact position is shown only to reviewers. Everyone else sees the location's box.
5. **Links accepted as well as uploads.** Much evidence is already on Telegram, X or Facebook. Pasting a link, which the system archives, is safer for someone who has already posted.
6. **Graphic material blurred by default**, with a click to reveal.
7. **No submitter IP or device logging** beyond what abuse prevention strictly needs, and even that is kept briefly.
8. **External review before launch.** Get advice from someone experienced in source protection before opening submissions from conflict areas.

---

## 8. Public map

- Shows locations at **Corroborated and above** ⚑, coloured by level, with evidence count and agreement count on hover.
- Detected locations are visible to the person who probed them and to reviewers.
- Every location page shows the satellite readings with their calibration label, the evidence list with checklist results, the level history, and the reviewers who moved it.
- Demo data stays labelled synthetic (`is_demo`).

---

## 9. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js + MapLibre                                          │
│  time bar · probe (box / coordinates) · results panel ·      │
│  evidence submit · review queue · public map by level        │
└───────────────────────────┬──────────────────────────────────┘
                            │ REST
┌───────────────────────────▼──────────────────────────────────┐
│  FastAPI                                                     │
│  /probes  /coverage  /jobs  /locations  /evidence            │
│  /evidence/{id}/check  /locations/{id}/review  /assessments  │
│  auth: pseudonymous users, reviewer role                     │
└──────┬──────────────────────────────┬────────────────────────┘
       │                              │
┌──────▼───────────────┐      ┌───────▼────────────────────────┐
│ Worker (jobs table)  │      │ MCP server (same core)         │
│ PWTT, indices,       │      │ probe, coverage, results,      │
│ seismic, archiving   │      │ read evidence. No verify tool  │
└──────┬───────────────┘      └───────┬────────────────────────┘
       │                              │
┌──────▼──────────────────────────────▼────────────────────────┐
│  core/ (no web dependencies)                                 │
│  gee · coverage · pwtt · indices · burn · seismic · bundle · │
│  probes · evidence · levels · safety (metadata stripping)    │
└──────┬───────────────────────────────────────────────────────┘
       │
┌──────▼───────────────────────────────────────────────────────┐
│  SQLite (Postgres once there are concurrent writers)         │
│  users · probes · scan_results · locations · evidence ·      │
│  evidence_checks · assessments · reviews · audit_log         │
│  rasters and archived media on a volume                      │
└──────────────────────────────────────────────────────────────┘
```

**Data model changes from v3.** `sites` becomes `locations` (built under the old `sites` name for now; the rename is cosmetic). `verdicts` becomes `reviews`, which now carry a level transition. New tables:

- `probes`: who probed which box over which window
- `scan_results`: cached by a normalised box and window key, so repeat probes are free
- `evidence` and `evidence_checks`
- `assessments`: agree / disagree / unsure
- `users`: pseudonymous, with a role

`audit_log` keeps recording every change.

**SQLite to Postgres.** Single-writer SQLite was right for one analyst. A public platform with concurrent submissions needs Postgres, and the move happens before public launch. The core already isolates storage in `db.py`.

---

## 10. Quota and cost

The Community tier allows 150 EECU-hours a month, and an open "scan" button would use that up quickly.

- **Cache first.** Results are keyed by box (snapped to a grid) and window. A probe overlapping a cached scan reuses it.
- **Sign-in required for new scans.** Viewing cached results and the public map needs no account.
- **Per-user scan limit**, and a size cap on boxes (the current 2,500 km² cap stays).
- **Measure** EECU use per scan on the first real runs, then decide whether to move to the Contributor tier.
- The **deployed demo** still ships with pre-computed results, so it works for anyone without touching quota.

---

## 11. MCP server

Kept as an interoperability surface: any agent harness can probe an area, read coverage, fetch scan results and read evidence. Deliberately absent: anything that submits evidence, completes a checklist, or changes a level. An agent can assemble what's known about a place, but it cannot verify one.

---

## 12. Evaluation

- **Layer 1, model metrics.** The LightGBM-vs-rule experiment (5.4) becomes a regression test on whichever wins, using confirmed figures only.
- **Layer 2, tool-call correctness.** About 15 fixture questions with expected tool sequences, scored against real tool-call logs, not just the fixture file. Includes: an unfamiliar region calls `check_coverage` first; no seismic call on burn-positive sites; requests to "verify" or "publish" use no write tool.
- **Layer 3, end to end.** Five areas: a confirmed settlement burn; a seismic site (the Sagaing demo); an agricultural burn; a quiet control; one area outside Rakhine that runs cleanly and returns provisional.
- **New: ladder rules.** Tests that votes alone never move a level, that two reposts of one source don't count as independent, and that no code path reaches Verified without two reviewers.
- **New: safety.** Tests that uploaded files leave the server with no EXIF or GPS, and that public API responses never include submitter identity or exact item locations.

---

## 13. Build order

Each phase ships something usable.

| Phase | What |
|---|---|
| 1 | Per-orbit `check_coverage`; PWTT worker on upstream `pwtt`; scan-result cache. Earth Engine smoke test in Rakhine and one other region |
| 2 | Time bar, coordinate entry, results panel showing PWTT z, burn indices, before/after, seismic |
| 3 | LightGBM-vs-rule experiment; keep or drop the model |
| 4 | Evidence by link and testimony, archiving, checklist, reviewer role, ladder computation, public map by level |
| 5 | Contributor safety hardening; uploads with metadata stripping if ⚑ approved for v1 |
| 6 | Agreement counts, review queue sorting |
| 7 | Postgres, deploy (frontend and worker as well as the API), evals for ladder and safety |

Phases 1–4 make a complete working tool; 5–7 harden it for public use.

---

## 14. Open decisions

| ⚑ | Question | Default in this doc | Why |
|---|---|---|---|
| A | Does the public map show Detected locations? | **No**: Corroborated and above only | Unreviewed detections of atrocities on a public map invite misreading and misuse |
| B | Who can be a reviewer? | **Invited** to start; earned reputation later | Earned reputation can be gamed; start small and trusted |
| C | Uploads in v1, or links only? | **Links and text testimony only** in v1 | Avoids storing sensitive media and the moderation load until safety work (7) is done |
| D | Where do F1 0.977 and threshold 0.397 come from? | **Unresolved** | ADS shows 0.714 / 0.46 and 0.903 / 0.71. Don't publish either number until confirmed |
| E | `pwtt` package licence | **Check before adding** | Use as a dependency if permissive; otherwise reimplement from the paper |

---

## 15. Known limitations

- **Agricultural and stubble burning** is spectrally close to settlement burning. It's handled by evidence and the Explained level, not by the detector. Building-footprint overlap (Google Open Buildings) is the obvious next detector feature.
- **Burn readings are calibrated on Rakhine only.** Elsewhere they're provisional until checked against confirmed local sites.
- **Wildfire vs deliberate burning** can't be told apart from spectra. That's what evidence is for.
- **Sentinel-1 revisit varies globally.** Coverage says so before a scan rather than failing quietly.
- **Cloud gaps are reported, not filled.** PWTT on radar still runs.
- **The verification ladder is a method, not a guarantee.** Reviewers can be wrong; the audit log and level history make that visible and correctable.
- **Repo permissions.** The ADS repo is private with six authors. The burn classifier code was your contribution and can be rewritten cleanly; PWTT comes from Ballinger's public package, not the ADS copy.
