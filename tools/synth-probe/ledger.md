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
