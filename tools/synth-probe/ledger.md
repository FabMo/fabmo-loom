# Loom failure-class ledger

The running memory of the improvement loop. One entry per FAILURE CLASS
(not per prompt): a capability gap, an authoring-quality slip the prompt
rules could close, a semantic overclaim needing a decline rule, or a
robustness bug. The nightly probe classifies new failures against this
list — **a failure that fits no class here is a NEW class, and new
classes are the only thing worth waking a human for.**

Evidence counts tally distinct prompts/utterances that hit the class
(synthetic and funnel tallied separately: funnel = real demand).
Conversion decisions stay human — this file ranks, it does not decide
(the shared surface stays clean; see INTENT.md).

## Capability gaps (candidate catalog moves)

| class | evidence (synth/funnel) | examples | status |
|---|---|---|---|
| ~~positioned-pockets — model invents posX/posY on pocket_shape~~ | 15 / 0 | catan-insert ×2 runs, pumpkin-porch-sign, solar-system-map | **SHIPPED 2026-07-27** — posX/posY (absolute center, template) + template dims on pocket_shape; bare expressions now resolve on template number params (runtime). Retest: catan-insert, pumpkin-porch-sign, solar-system-map all verify → SBP |
| counterbores — pocket + through-hole at the same spot trips the footprint-overlap gate (found by the posX conversion: cbores now LAND, then verify refuses) | 2 / 0 | drill-press-fence (recorded + live retest) | open — wants a scoped allowance like edgeTreatment's (bore fully inside an earlier shallower pocket), NOT a gate loosening |
| curved-text — text along an arc/path | 1 / 0 | curved-text-arc | open |
| open-path-engraving — score/V-line along an open curve | 2 / 0 | ruler-ticks, fret-slots | open |
| batch-input — mail-merge a list into per-part exports | 1 / 0 | wedding-batch-list | open |
| qr-codes — generate + pocket a QR module grid | 1 / 0 | qr-menu | open |
| mirror-text — flip for back-machining | 1 / 0 | mirror-text | open |
| tiling — split one design across boards | 1 / 0 | split-two-boards | open |
| irregular-hole-layouts — grouped/positioned hole runs (cribbage fives) | 1 / 0 | cribbage | open |
| v-inlay — pocket + kerf-compensated plug pair | 1 / 0 | monogram-inlay | open |
| two-sided — flip ops onto the back face | 1 / 0 | open-closed-flip | open |
| conditional-panels — furniture panels that appear/loop from a control (N shelves, base-vs-wall) | 0 / 1 | q_6a0e5c12 | open |
| drawer-doors — drawer boxes / hinged doors as parts | 0 / 2 | q_9b4d584b, q_6a0e5c12 | open |
| beveled-panels — non-90° panel edges / sloped profiles | 0 / 3 | lectern, q_b848b95f, q_12151bd9 | open |
| rotary — 4th axis / cylindrical stock | 1 / 1 | baseball-bat, q_3cf6be65 | open (likely by-design) |
| bathymetry-data — underwater depth source for terrain | 1 / 0 | tahoe-bathymetry | open (also see overclaim below) |
| ~~pattern-repeat — grid/ring of one cell~~ | 5 / 0 | hex-trivet, chess-board, cribbage, flag-stars, catan | **SHIPPED v0.67 2026-07-26** |

## By-design declines (working correctly — regression-watch only)

raster images/photos; STL/DXF/PDO file formats; representational
likenesses (bull/flag/katana); other fonts beyond the shelf;
raised bosses (additive); angled drilling; wheelbarrow-class
non-flat-stock objects; textile looms.

## Authoring-quality slips (prompt-rule candidates, no new code)

| class | evidence | examples | status |
|---|---|---|---|
| content-vs-fixed-disc — fixed-diameter cutout smaller than authored content | 2 | clock-face, hex-trivet (post-pattern) | open |
| overlapping-pockets — adjacent pockets should be difference-derived | 2 | make-it-fit, catan-hex-insert (slots overlap hexes — visible now that posX lands) | open |
| choice-option-shapes — a shape dropdown authored with an option whose shape was never defined | 1 | christmas-ornament-set (live retest) | open |
| texture-under-kerf — texture_field extends under a later cutout | 1 | herringbone-bg | open |
| bore-vs-pocket — holes >3× bit authored as bore_hole | 1 | serving-tray | open |

## Semantic overclaims (decline rules needed — verifier CANNOT catch these)

| class | evidence | examples | status |
|---|---|---|---|
| same-face-flip — two-sided ask fulfilled on one face | 1 | open-closed-flip | open |
| bathymetry-claim — "underwater depth" promised from land-elevation tiles | 1 | tahoe-bathymetry | open |
| phantom-plug — inlay plug promised, no plug op exists | 1 | monogram-inlay | open |

## Robustness (validator/app fixes)

| class | status |
|---|---|
| action-ordering (control after its binder) | **FIXED v0.67** — hoist + retry sweep |
| flattened set_derived {kind,id,expr} | **FIXED v0.67** |
| max_tokens truncation as silent success | **FIXED v0.67** — 8000 + stop_reason refusal |
| empty payload as silent success | **FIXED v0.67** — surfaced as retryable |
| stale single-font arg in app/test-live.mjs | open (test cannot pass) |
| flattened add_control / add_operation payloads ({kind, id, type…} with no control:/operation: object) → "bad control" / unknown strategy "undefined", a reason too vague for the second look to fix | **FIXED v0.76 2026-09-26** — applyActions normalizes the flattened form + specific skip reasons; corpus replay: 19 rows improved (12 now verify, incl. 2 real funnel rows), 0 regressions; birdhouse live retest → verified |
| tag_cutout with explicit width/height larger than the content → cutout leaves the auto-sized stock envelope (stock sizes from content, not the pinned tag) | open — found by the model A/B (toggle-switch-panel ×3 models, pumpkin-porch-sign, reserved-parking-sign); runtime fix: size stock from the largest explicit cutout |
| `payload.actions` not an array (object keyed 0..n / string) → applyActions TypeError killed the turn | **FIXED v0.77** — coerced, shape noted in skipped |
| numeric `text` param (advent number 24) → text layout "not iterable" crash | **FIXED v0.77** — string params stringify numbers/booleans, reject objects with a reason |
| weave THROWS inside the loop → whole turn ERROR | **FIXED v0.77** — safeWeave turns it into a failing observation the model can route around |
| blank final summary (Sonnet 5, 5/25 incl. a failing build) → user sees only the badge | **FIXED v0.77** — deterministic minimum synthesized from the observation + declines; never falls back to the blind first summary after a look |
| `auto` tool choice: prose answer instead of a tool call (Fable 5.1, 1/25) | **FIXED v0.77** — one nudge on the same conversation, then the old 'no actions' error |
| final call emits fixes despite "no actions" → applied unseen, summary describes the OLD state (ornament-shape-set recheck: job verified, summary said "does NOT yet post") | **FIXED v0.76** — runIntentLoop re-weaves after a late fix and appends a deterministic "(Update: … verifies / still fails — <error>)" when the verdict changed |

## Closed-loop A/B (2026-09-26)

Same 25 prompts (the 2026-08-10 set), same model (opus-4-8), one-shot vs
the v0.75 loop (`LOOP=off` vs `LOOP=always`; `compare-loop.mjs`). Judged
by eye on final summaries, not the word-list proxy.

| | one-shot | loop |
|---|---|---|
| confident summary over a failed/empty/crashed pipeline | **10 / 25** | **0 / 25** |
| verified | 11 | 13 |
| empty pipeline | 7 | 3 |
| rows carrying an honest decline | 9 | 15 |
| corrections applied by the second look | — | 59 (24 rows took a look) |
| model calls / output tokens | 25 / 25k | 67 / 46k (input 2.8×, mostly cached) |

Rescued by the loop: garden-row-markers (cutout fit fixed → verified),
rain-gauge-bracket (4 fixes → verified), advent (crash → honest partial),
fraction-circle + number-line (empty stalls → partial builds with the
exact failing op named), toggle-switch (bore-vs-pocket → pocket, verified,
missing holes declared). Made worse by the loop: ornament-shape-set
(revision converted the cutout op into a bore — verified but hollow,
honestly reported) and birdhouse-flatpack (turn 1 emitted FLATTENED
add_control/add_operation payloads; the skip reason "bad control" gave
the second look nothing to act on, so it repeated the mistake — see the
robustness row below). The semantic classes (same-face-flip,
bathymetry-claim, phantom-plug) are untouched by design: the observation
cannot see them either.

## Model-generation A/B — priors written BEFORE the run (2026-09-26)

Same 25 prompts (2026-08-10 set), v0.76 loop on, four models:
claude-opus-4-8 (the incumbent, re-run on v0.76), claude-sonnet-5,
claude-opus-5-5, claude-fable-5-1. Predictions on record:

1. Authoring slips (bore-vs-pocket, content-vs-fixed-disc, overlapping
   pockets, envelope overflow, math-fn misuse) DROP on the Claude 5 models
   → more rows verified on the FIRST turn, fewer corrections needed.
2. Confident-on-failure stays at ~0 for all four — the loop, not the
   model, owns that number now.
3. Semantic overclaims (same-face flip, bathymetry, phantom plug) do NOT
   move with model generation: no observation exposes them.
4. Sonnet 5 lands close to Opus 4.8 on verified-rate at a fraction of the
   tokens; Fable 5.1 and Opus 5.5 lead on verified-first-turn and on
   honest declines of by-design asks (rotary, raised bosses, likenesses).
5. Risk to watch: a stronger model authoring MORE (bigger pipelines,
   more shapes) trips more verifier gates, so verified-rate could dip
   even as quality rises — read the failing rows, not just the tally.

## Model-generation A/B — RESULTS (2026-09-26, same day as the priors)

25 prompts × 4 models, v0.76+ loop on, one run each (n=25: read as
direction, not decimals). Fable 5.1 / Opus 5.5 reject forced tool_choice →
`auto` + a call-the-tool rule (intent.mjs `withAutoToolChoice`).

| | Opus 4.8 | Sonnet 5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|
| verified (final) | 13 | 10 | **20** | **20** |
| verified on the FIRST turn (before any look) | 9/22 | 10/22 | **17/25** | 17/24 |
| first-turn actions skipped by the validator | 7 | 7 | **0** | **0** |
| empty pipeline | 3 | 4 | 0 | 1 (prose instead of a tool call) |
| confident-on-failure (by eye) | 0 | 0 (but 5 BLANK summaries) | 0 | 0 |
| corrections the loop applied | 57 | 70 | **29** | 61 |
| output tokens | 41k | 45k | 109k | 174k |
| median wall time / prompt | 21 s | 23 s | 44 s | **95 s (max 287 s)** |
| cost of the 25-prompt run (first-party rates) | ~$2.5 | ~$1.1 | ~$3.4 | ~$12 |

Priors vs actuals: (1) authoring slips DROP on Claude 5 — held hard
(0 validator skips, 17 first-turn verifies vs 9); (2) confident-on-failure
~0 everywhere — held (the loop owns it); (3) semantic overclaims unmoved —
held, none of the three classes is even exercised by this set; (4) Sonnet 5
≈ Opus 4.8 — WRONG: Sonnet 5 is below Opus 4.8 here (10 vs 13 verified,
blank summaries on 5 rows → deterministic fallback shipped); Fable/Opus 5.5
lead — held; (5) stronger model trips more gates — did not show: Opus 5.5
authored more AND verified more. Unpredicted: Fable 5.1 is 4.5× slower, ~4× the output tokens and ~5× the
cost of Opus 4.8 for the same verified count as Opus 5.5;
under `auto` it answered one prompt in prose (nudge-once shipped).

Recommendation: **Opus 5.5 as Loom's default model** (same verified rate
as Fable 5.1 at ~60% of its output tokens, half its wall time and ~30% of its cost; a
better first draft than Opus 4.8 by 8 verified rows; fewest corrections
needed). Fable 5.1 for an "expert" toggle, not the default. Sonnet 5 not
for authoring.

Model-independent bug this surfaced (3 of 4 models on toggle-switch-panel,
2 on pumpkin-porch-sign, reserved-parking): **a tag_cutout with EXPLICIT
width/height larger than the content runs outside the auto-sized stock
envelope** — the stock sizes from content, not from the pinned tag. Runtime
fix wanted (size stock from the largest explicit cutout), top of the
robustness backlog.

## Run log

(One line per nightly run, appended by the probe agent: date,
prompts probed, outcomes, new classes, evidence increments, cost.)

- 2026-07-26 — pilot: 50 synthetic, $5.75; 18F/11P/12D/8VF/1T; corpus seeded (49 rows); pattern + robustness shipped v0.67; funnel baseline pulled (67 loom entries, 14 with declines — beveled-panels, drawer-doors, conditional-panels classes opened from real stream)
- 2026-07-26 — nightly: no probes; funnel +67 (14 declined); $0.29; dry run — no live probes
- 2026-07-26 — nightly: 14 FULFILLED_UNVERIFIED, 5 FULFILLED, 1 DECLINED, 5 PARTIAL; 2 prior-miss (catan-hex-insert, hose-guide-stake); funnel +67 (14 declined); $3.45; triage unparseable ⚠ SEE ATTENTION FILE
- 2026-07-27 — nightly: 5 FULFILLED_UNVERIFIED, 6 PARTIAL, 11 FULFILLED, 3 DECLINED; 7 prior-miss (menorah-candle-holder, retail-ring-display, periodic-table-tiles, pegboard-tool-labels, prop-sword-blade, lake-tahoe-topo, tahoe-depth-map); evidence: positioned-pockets +3, drawer-doors +1, qr-codes +1, beveled-panels +1, trig-derived-geometry +1, two-sided +1, open-path-engraving +2, curved-text +1, tiling +1; OVERCLAIMS: tahoe-depth-map, prop-sword-blade, geometry-protractor, christmas-ornament-set; funnel +1 (0 declined); $3.70; 25 rows: positioned-pockets keeps recurring (posX rejected on pocket_shape across 3 rows), one new trig-derived-geometry gap, and four overclaims where confident summaries outran empty/partial pipelines including a repeat bathymetry-claim. ⚠ SEE ATTENTION FILE
- 2026-07-27 — nightly: 6 FULFILLED_UNVERIFIED, 8 FULFILLED, 9 PARTIAL, 2 DECLINED; 4 prior-miss (name-tracing-boards, foam-armor-templates, coastline-bathymetry-reask, star-chart-plaque); evidence: same-face-flip / positioned-pockets adjacency +1, choice-option-shapes +1, drawer-doors +1, raised bosses (by-design decline) +1, empty-payload-as-fulfilled +1, qr-codes +1, content-vs-fixed-disc / bit-fit +1, positioned-pockets +1, open-path-engraving +1, curved-text +1, wheelbarrow-class non-flat-stock (by-design) +1, bound-to-missing-control +1, representational-likeness (by-design) + open-curve-band +1, representational-likeness (by-design) +3, tiling / layered-contour-stacking +1, ephemeris-data +1; OVERCLAIMS: product-riser-set, halloween-porch-numbers, foam-armor-templates, christmas-ornament-set-reask; funnel +1 (0 declined); $3.90; positioned-pockets posY still failing on text-op rows after the ship, multiple empty/error pipelines summarized as built (4 overclaims), and two new capability classes (ephemeris-data, layered-contour-stacking) plus an open-curve band robustness bug surfaced. ⚠ SEE ATTENTION FILE
- 2026-07-28 — nightly: 7 PARTIAL, 1 DECLINED, 10 FULFILLED_UNVERIFIED, 7 FULFILLED; evidence: open-path-engraving +1, NEW random-voronoi-geometry +1, NEW envelope-overflow-verify +3, texture-under-kerf +1, NEW floor-fn-unavailable +1, bound-to-missing-control +1, empty-payload-as-fulfilled +1, bore-vs-pocket +1, working-as-intended +2, content-vs-fixed-disc +2, counterbores +1, NEW mirror-flip-geometry +1, qr-codes +1, curved-text +1; OVERCLAIMS: greek-key-border-sign, name-puzzle-tray, cornhole-board-set, disc-golf-scorecard, restroom-pictogram-sign; funnel +4 (0 declined); $3.98; Three empty/failed pipelines summarized as built plus a recurring stock-envelope-overflow robustness pattern and a new random-voronoi capability gap dominate tonight. ⚠ SEE ATTENTION FILE
- 2026-07-29 — nightly: 1 DECLINED, 9 PARTIAL, 7 FULFILLED, 1 ERROR, 7 FULFILLED_UNVERIFIED; 3 prior-miss (cheese-board-slots, angled-shoe-rack, dice-tower-panels); evidence: raster images/photos (by-design decline) +1, representational-likeness (by-design decline) +1, curved-text +1, other fonts beyond the shelf (by-design decline) +1, envelope-overflow-verify +6, empty-payload-as-fulfilled +2, conditional-panels +1, drawer-doors +1, bore-vs-pocket +1, counterbores +1, overlapping-pockets +1, irregular-hole-layouts +1, tool-table-assignment +1, positioned-pockets +1; OVERCLAIMS: coaster-set-monogram, router-circle-jig, puzzle-name-tray, nightstand-drawer-box, cutting-board-juice-groove; funnel +17 (2 declined); $4.11; Recurring stock-envelope-overflow (5 rows) and empty/collision pipelines summarized as built dominate; two new capability classes (tool-table-assignment, keyhole-mounts) and a real-funnel per-square positioning ask surfaced. ⚠ SEE ATTENTION FILE
- 2026-07-30 — nightly: 11 FULFILLED_UNVERIFIED, 1 DECLINED, 6 FULFILLED, 7 PARTIAL; 3 prior-miss (din-rail-bracket, led-diffuser-grid, pegboard-tool-labels); evidence: bore-vs-pocket +5, working-as-intended +3, floor-fn-unavailable +3, envelope-overflow-verify +4, empty-payload-as-fulfilled +1, choice-option-shapes +1, qr-codes +1, batch-input +1; OVERCLAIMS: advent-calendar-boxes, christmas-ornament-set, retail-ring-display, business-card-holder, ukulele-fret-slots; funnel +7 (0 declined); $4.17; Bore-vs-pocket bit-fit slips dominate (5 rows), math-fn-unavailable (pow/sin) breaks three authored geometry chains, and five confident summaries overclaim empty or collapsed pipelines. ⚠ SEE ATTENTION FILE
- 2026-07-31 — nightly: 8 FULFILLED_UNVERIFIED, 5 FULFILLED, 4 DECLINED, 8 PARTIAL; 5 prior-miss (name-tracing-boards-reask, periodic-table-tiles-reask, coastline-bathymetry-reask, stacking-name-puzzle, peg-stacking-toy); evidence: empty-payload-as-fulfilled +2, open-path-engraving +2, working-as-intended +3, envelope-overflow-verify +4, raised bosses (by-design decline) +1, tiling +1, representational-likeness (by-design decline) +4, random-voronoi-geometry +1, texture-under-kerf +1, bound-to-missing-control +1; OVERCLAIMS: fraction-teaching-tiles, prop-sword-blade-reask, foam-armor-pauldron, greek-key-border-reask, hex-geometric-wall-art, marble-run-track, peg-stacking-toy; funnel +4 (0 declined); $3.77; Empty/overflow pipelines dominate again (7 overclaims incl. envelope-overflow on sword/pauldron/hex/peg), open-path-engraving recurs on protractor+number-line, and representational-likeness declines are working-as-intended.
- 2026-08-01 — nightly: 6 FULFILLED_UNVERIFIED, 2 DECLINED, 1 ERROR, 7 FULFILLED, 7 PARTIAL; 2 prior-miss (room-number-plates, spice-drawer-insert); evidence: content-vs-fixed-disc +2, irregular-hole-layouts +1, representational-likeness (by-design decline) +2, bound-to-missing-control +1, choice-option-shapes +2, counterbores +1, envelope-overflow-verify +2, curved-text +1, working-as-intended +2, beveled-panels +3, empty-payload-as-fulfilled +1; OVERCLAIMS: cat-feeding-station-mat, hex-trivet-reask, parking-reserved-sign, cutting-board-juice-groove, room-number-plates; funnel +0 (0 declined); $3.69; Envelope/content-fit overflow and empty-pipeline overclaims dominate again (5 overclaims incl. a hex-trivet ghost build), with beveled-panels recurring on three sloped-geometry asks and a new conical-taper capability gap plus a cornerRadius-NaN robustness bug. ⚠ SEE ATTENTION FILE
- 2026-08-02 — nightly: 11 FULFILLED_UNVERIFIED, 3 DECLINED, 8 FULFILLED, 3 PARTIAL; 3 prior-miss (nightstand-drawer, name-puzzle-tray, guitar-pick-holder); evidence: envelope-overflow-verify +6, beveled-panels +1, empty-payload-as-fulfilled +2, counterbores +1, irregular-hole-layouts +1, bore-vs-pocket +2, working-as-intended +2, floor-fn-unavailable +1, curved-text +1; OVERCLAIMS: bench-dog-holes, catan-hex-insert, ukulele-fret-slots, router-circle-jig, cubby-storage-grid; funnel +3 (0 declined); $4.52; Envelope-overflow dominates again (6 rows) with two empty pipelines (bench-dog, catan) and a pow-fn break all summarized as built; no new classes and two furniture cross-lap collisions surfaced. ⚠ SEE ATTENTION FILE
- 2026-08-03 — nightly: 7 FULFILLED_UNVERIFIED, 4 DECLINED, 7 PARTIAL, 7 FULFILLED; 1 prior-miss (cafe-table-number); evidence: positioned-pockets +2, bore-vs-pocket +1, beveled-panels +5, rotary +1, open-path-engraving +5, drawer-doors +1, two-sided +1, qr-codes +1, cornerRadius-NaN +1, envelope-overflow-verify +1; OVERCLAIMS: garden-row-markers, rain-gauge-mount, geometry-protractor, fraction-circle-set, number-line-ruler, prop-sword-blade, prop-shield-boss; funnel +0 (0 declined); $4.08; positioned-pockets posY still failing on text/engrave rows after ship, open-path-engraving recurs across five bit-fit/open-curve education asks, and seven confident summaries overclaim errored pipelines. ⚠ SEE ATTENTION FILE
- 2026-08-04 — nightly: 9 PARTIAL, 4 DECLINED, 5 FULFILLED, 7 FULFILLED_UNVERIFIED; 1 prior-miss (coastline-bathymetry-reask); evidence: tiling / layered-contour-stacking +1, envelope-overflow-verify +4, ephemeris-data +1, working-as-intended +7, random-voronoi-geometry +1, floor-fn-unavailable +1, bore-vs-pocket +3, empty-payload-as-fulfilled +1, keyhole-mounts +1, rotary +1, positioned-pockets +1; OVERCLAIMS: herringbone-tray-bg, hex-geometric-wall-art, cat-feeding-mat-reask, cribbage-travel-board, disc-golf-scorecard, cornhole-board-set; funnel +0 (0 declined); $4.12; Envelope-overflow (3 rows) and empty/errored pipelines summarized as built (6 overclaims) dominate again; positioned-pockets posY still failing on text-engrave rows post-ship, plus coastline-bathymetry now verifying resolves a prior decline. ⚠ SEE ATTENTION FILE
- 2026-08-05 — nightly: 12 FULFILLED_UNVERIFIED, 7 PARTIAL, 6 FULFILLED; 3 prior-miss (floating-shelf-count, nightstand-drawer-box, fret-slot-jig); evidence: envelope-overflow-verify +9, curved-text +1, working-as-intended +3, irregular-hole-layouts +1, v-inlay +1, qr-codes +1, beveled-panels +1, bore-vs-pocket +1, open-path-engraving +1, empty-payload-as-fulfilled +1; OVERCLAIMS: ada-restroom-arrow-set, room-number-plates-reask, parking-numbered-run, coordinate-keepsake, cheese-serving-slots, juice-groove-board, serving-tray-handles, cubby-storage-grid, bench-dog-hole-grid, drill-press-fence-reask; funnel +0 (0 declined); $4.26; Envelope-overflow-verify dominates again (8 rows) with ten confident summaries overclaiming errored/empty pipelines, and a new cubby cross-lap collision robustness bug surfaced. ⚠ SEE ATTENTION FILE
- 2026-08-06 — nightly: 3 FULFILLED, 14 FULFILLED_UNVERIFIED, 1 ERROR, 3 PARTIAL, 4 DECLINED; 3 prior-miss (dominoes-tin-tray, hose-guide-stake, birdhouse-flatpack); evidence: empty-payload-as-fulfilled +2, envelope-overflow-verify +5, open-path-engraving +1, floor-fn-unavailable +1, keyhole-mounts +1, bore-vs-pocket +2, beveled-panels +3, overlapping-pockets +3, working-as-intended +2, drawer-doors +1, choice-option-shapes +1; OVERCLAIMS: cribbage-travel-board, dominoes-tin-tray, marble-maze-topper, menorah-candle-holder, ornament-shape-set, garden-row-markers, led-diffuser-grid; funnel +0 (0 declined); $4.27; Electronics/hobby batch dominated by empty-pipeline and envelope-overflow overclaims plus recurring overlapping-pocket collisions and pow-fn breaks; bevel/mixed-stock and 3D-stake declines are working-as-intended. ⚠ SEE ATTENTION FILE
- 2026-08-07 — nightly: 9 PARTIAL, 7 FULFILLED_UNVERIFIED, 5 FULFILLED, 4 DECLINED; 5 prior-miss (cafe-menu-board-slots, retail-ring-display-reask, prop-sword-blade-reask, lake-topo-plaque, city-street-grid-coaster); evidence: bore-vs-pocket / hole-center parse +1, envelope-overflow-verify +3, beveled-panels +1, empty-payload-as-fulfilled +4, content-vs-fixed-disc +1, overlapping-pockets +1, working-as-intended +6, tiling / layered-contour-stacking +1, ephemeris-data +1, random-voronoi-geometry +1; OVERCLAIMS: number-line-ruler, pegboard-tool-labels, coastline-bathymetry-reask, hex-geometric-wall-art-reask, tip-jar-sign-frame, herringbone-tray-bg; funnel +0 (0 declined); $4.54; Empty/errored pipelines summarized as built dominate again (5 overclaims incl. a repeat bathymetry ghost-build), bore-hole 'at'-string parse regresses on menu/pegboard, and cosplay likeness/boss declines are working-as-intended. ⚠ SEE ATTENTION FILE
- 2026-08-08 — nightly: 12 PARTIAL, 2 DECLINED, 5 FULFILLED_UNVERIFIED, 5 FULFILLED; 3 prior-miss (abc-name-puzzle-tray, reserved-parking-sign, restroom-pictogram-sign); evidence: rotary / non-flat-stock (upright peg) + multi-part-set +1, batch-input + furniture tray +1, open-path-engraving +2, envelope-overflow-verify +5, empty-payload-as-fulfilled +2, beveled-panels +2, working-as-intended +2, irregular-hole-layouts +1, curved-text +1, batch-input +1, v-inlay +1; OVERCLAIMS: marble-run-track-board, cat-feeding-station-mat, pet-bowl-stand-panels, fish-tank-lid-cutout, disc-golf-scorecard-holder, engraved-photo-locket, ada-room-number-plate, cafe-table-number-blocks, monogram-inlay-cutting-board; funnel +0 (0 declined); $4.19; Envelope-overflow-verify (5 rows) and empty/errored pipelines summarized as built (9 overclaims) dominate again; one new multi-part-set capability gap surfaced across toddler-toy and domino asks, and no funnel declines tonight. ⚠ SEE ATTENTION FILE
- 2026-08-09 — nightly: 13 FULFILLED_UNVERIFIED, 5 FULFILLED, 6 PARTIAL, 1 DECLINED; 3 prior-miss (angled-shoe-rack, dice-tower-panels, guitar-pick-holder); evidence: envelope-overflow-verify +2, empty-payload-as-fulfilled +1, open-path-engraving +3, conditional-panels +1, drawer-doors +1, cubby-crosslap-collision +1, floor-fn-unavailable +2, bore-vs-pocket +3, bound-to-missing-control +1, working-as-intended +2, overlapping-pockets +3; OVERCLAIMS: cheese-board-handle-slots, serving-tray-handles, cutting-board-juice-groove, nightstand-drawer-box, cubby-storage-grid, bench-dog-hole-grid, router-circle-jig, catan-hex-insert-reask, cribbage-travel-board, marble-run-track-board, ukulele-fret-slots; funnel +0 (0 declined); $4.73; Envelope-overflow, overlapping-pocket/cross-lap collisions, and math-fn parse failures dominate again with 11 confident summaries overclaiming empty or errored pipelines; crosscut-sled and countersink/back-face declines are working-as-intended. ⚠ SEE ATTENTION FILE
- 2026-08-10 — nightly: 7 FULFILLED_UNVERIFIED, 3 DECLINED, 7 PARTIAL, 8 FULFILLED; evidence: empty-payload-as-fulfilled +3, working-as-intended +6, bore-vs-pocket +1, content-vs-fixed-disc +3, envelope-overflow-verify +2, drawer-doors +1, beveled-panels +1, curved-text +1; OVERCLAIMS: toggle-switch-panel, reserved-parking-sign, fraction-circle-set, pi-hat-enclosure, number-line-ruler, cafe-menu-slot-board; funnel +0 (0 declined); $4.20; Electronics/education batch: four empty/failed pipelines summarized as built plus recurring bore-vs-pocket, content-vs-disc and envelope-overflow slips; all declines (arduino, diffuser, stake, bat, wedge) working-as-intended and no new classes.
- 2026-09-26 — manual A/B (not a nightly; nightlies were dead Aug 11–Sep 26 on an invalid key, rotated today): 25 prompts × {one-shot, loop}; loop: 24/25 took a second look, 59 corrections, 24 summaries revised; confident-on-failure 10 → 0, verified 11 → 13, empty pipeline 7 → 3; 2 rows worse (ornament, birdhouse); ~$12 total. See "Closed-loop A/B" above.
- 2026-09-26 — recheck after the flattened-payload fix (2 prompts, loop): birdhouse-flatpack → FULFILLED (first-turn skips 0); ornament-shape-set → FULFILLED with 8 fixes but a stale final summary (fixed itself on the last call, never saw the result) → the postscript rule above.
- 2026-09-26 — model A/B (manual): 25 prompts × {opus-4-8, sonnet-5, opus-5-5, fable-5-1}, loop on; verified 13/10/20/20; first-turn verified 9/10/17/17; validator skips 7/7/0/0; ~$2.5/$1.1/$3.4/$12; median 21/23/44/95 s per prompt. See "Model-generation A/B — RESULTS". Recommendation: Opus 5.5 default.
- 2026-09-26 — DEFAULT MODEL SWITCHED to claude-opus-5-5 (v0.78) per the A/B; Fable 5.1 offered as the expert pick in the AI-account box; Opus 4.8 kept as a fallback option. Nightly meta model (generation/triage) stays Opus 4.8 so the series keeps one judge; probe rows now run on the new default — expect the verified tally to step up and the cost column to be priced at Opus 5.5 rates from tonight.
