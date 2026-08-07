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
