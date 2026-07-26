# Synthetic Decline Probe — Pilot Report (2026-07-26)

> **Update, same day:** backlog items 1 and 2 landed (see the repo diff /
> v0.67): `set_shape pattern` (grid + ring repeat of one cell),
> `applyActions` control-hoisting + retry sweep + flattened
> `set_derived`, `max_tokens` 2000 → 8000, and the app now surfaces
> truncated/empty responses. Live re-probe: **chess-board converts to a
> verified SBP**, hex-trivet no longer truncates (authors the honeycomb
> pattern; remaining miss is the clock-face-class "content vs fixed
> disc" sizing), **cribbage's silent empty payload upgrades to an honest
> decline** naming the missing capability, record-clock-svg and
> speaker-baffle rescued by the ordering/flattening fixes (replay,
> zero API cost). catan-insert still invents `posX` on pocket_shape —
> backlog item 8 now has 12 occurrences of evidence across two runs.
> Run `node live-retest.mjs <ids>` for future conversions.

50 persona-anchored prompts (sign makers, luthiers, van builders, shop
teachers, cosplayers…) run through the REAL intent pipeline headlessly:
`buildParseRequest` → live model → `applyActions` → `runRecipe` → verify,
guests mounted, font shelf loaded. Every prompt carried a written PRIOR
(covered / decline / unsure) so the run also measures where the model's
self-prediction fails. Cost: ~$5.75 (prompt-cached). Full per-prompt
records in `results2.jsonl` (raw actions included — each row is a ready
regression case).

## Headline

| Outcome | n |
|---|---|
| Fulfilled & verified | 18 |
| Partial (fulfilled + honest decline) | 11 |
| Declined cleanly | 12 |
| Fulfilled but verify FAILED | 8 |
| Truncated/malformed payload | 1 |

The verifier caught every *geometric* overclaim. The exposed classes live
**above the rail**: authoring failures, validator fragility, and — most
important — *semantic* overclaims the verifier cannot see.

## Finding 1 — the missing primitive: repeated patterns (top capability candidate)

Three failures with different symptoms, one root cause — **no
grid/array/radial-repeat primitive** in the recipe language, so the model
hand-authors every cell:

- `hex-trivet` — hit the 2000-token `max_tokens` ceiling mid-geometry →
  truncated tool input → `payload.actions` undefined (would crash a naive
  caller; the app should check `stop_reason`).
- `chess-board` — authored one giant 64-square path, then emitted ZERO
  operations; summary literally says "let me lay it out properly…" (a
  stall — the model planned a next turn that never comes).
- `cribbage` — 360 holes on S-curves → completely empty payload, no
  summary, no decline. User gets nothing.

Also feeding this: `flag-stars` (50-star union declined), `catan-insert`
(invented a `posX` param 5× trying to place repeated pockets). A
`pattern`/`repeat` derivation (linear/grid/radial over a shape, or `at`
generation) converts all five.

## Finding 2 — "confidently wrong" fulfillments (worse than declining)

The verifier passes these; the *physics or semantics* are wrong:

- `open-closed-flip` — engraved OPEN and CLOSED **on the same face** and
  told the user "flip the board to show either word." Flipping shows the
  blank back. Needs a two-sided/flip decline rule (or capability).
- `tahoe-bathymetry` — claims to carve "the real bathymetry (underwater
  depth)"; the elevation tiles carry no Tahoe lakebed — the lake weaves
  as a flat pane. Needs a grounding rule: terrain = land surface
  elevation; decline underwater-depth claims until a bathymetry source
  exists.
- `monogram-inlay` — summary promises "a matching walnut plug," pipeline
  is just `pocket_text` + `tag_cutout`. No plug op exists, and a real
  inlay plug needs bevel/kerf compensation. Decline the plug half until
  a v-inlay strategy lands.

These are exactly the cases the synthetic probe was built for: a real
novice would cut the board before discovering the lie.

## Finding 3 — validator fragility (cheap `applyActions` fixes, big win)

Model output was *nearly* right and the validator threw it away:

- **Ordering**: `set_shape` referencing `{logoSize}` arrived one action
  before `add_control logoSize` → shape skipped → whole design broken
  (`record-clock-svg`; same class in `serving-tray`). Fix: hoist
  `add_control` actions first, or two-pass validation.
- **Flattened fields**: `set_derived` emitted as `{kind, id, expr}`
  instead of `{kind, derived:{id, expr}}` — 3× in one response
  (`speaker-baffle`), cascading into 2 dead shapes + a dead op. Fix:
  accept the flattened form (same spirit as the `[object Object]`
  ctrl-binding fix).
- **Truncation**: `stop_reason: "max_tokens"` yields a silently partial
  payload. Fix: raise `max_tokens` in `buildParseRequest` (2000 → 8000)
  AND surface truncation as "too complex in one go — ask again in parts."
- **Empty payload**: zero actions + zero declines + no summary
  (`cribbage`) should render as a retryable error, not success.

## Finding 4 — authoring-quality gaps the prompt rules could close

- `clock-face` — hour-mark ring authored so big the fixed 10" disc needs
  23.3" (radius/diameter slip). Rule candidate: content must fit inside a
  fixed-diameter cutout; prefer `fit`/auto-size, or scale the ring to the
  disc.
- `make-it-fit` — sunflower petals pocket overlaps center pocket →
  footprint refusal. Rule candidate: adjacent pockets must be disjoint —
  derive with `difference` instead of stacking.
- `herringbone-bg` — `texture_field` extends under the `tag_cutout` kerf
  → overlap refusal. "Texture the background of a tag" is a natural ask
  that currently cannot verify; texture needs to clip to the eventual
  tag outline minus kerf (composition fix, not just prompting).
- `ruler-ticks` — ticks authored as open curves, then pocketed (invalid).
  The honest gap: **no open-path engraving** (score/V-carve along a
  curve). Would also serve fret slots (given computed positions) and
  ski-run linework.
- `serving-tray` — 0.9" hand-hole attempted with `bore_hole` (>3× bit) —
  the weave error's own hint ("use pocket_shape") wasn't available at
  authoring time; a prompt rule ("holes over ~3× the bit are pockets or
  shape cutouts") closes it.

## Finding 5 — genuinely better than predicted

- `vertical-text` — model stacked five one-letter `vcarve_text` ops with
  `place:"below"` for a marquee sign. Verified. Clever composition.
- `acrylic-feeds` — feeds/speeds are real catalog params; it set V-carve
  40 IPM, plunge 25, profile 50 + shallow passes and explained chip-melt.
- `metric-board` — mm → inches conversion clean throughout.
- `dogbone-corners` — authored dog-bone fillets in a custom path,
  verified. (Prior said unsure; it's covered.)
- `logo-no-upload` — routed "my logo" to the draw-a-shape flow with the
  upload alternative, exactly per the representational-likeness rule.
- Declines were uniformly honest and well-worded; `fret-slots` even
  offered the right escape hatch (paste measured slot centers).

## Prior-miss analysis (the self-play check)

11 covered-priors: 8 held, 3 failed (clock-face, herringbone-bg,
record-clock-svg). 17 decline-priors: 13 held, 2 legitimately fulfilled
(vertical-text, acrylic-feeds), **2 wrongly fulfilled** (open-closed-flip,
monogram-inlay). The systematic bias was NOT under-generating hard
prompts — it was failing to predict *overclaim*: the same model family
prefers a plausible fulfillment to a decline in ambiguous territory, and
self-prediction can't see that from the outside. Live execution (not
static triage) is the only grade of this that works.

## Ranked backlog candidates (by evidence weight)

1. **Pattern/repeat primitive** — 5 prompts, includes the only 3
   hard-failure modes. (Finding 1)
2. **applyActions robustness trio** — ordering hoist, flattened
   `set_derived`, truncation surfacing. Code-only, no new capability.
3. **Semantic-overclaim decline rules** — two-sided, bathymetry, inlay
   plug. Three prompt-rule lines.
4. **Curved/along-path text** — classic sign-shop ask (`curved-text-arc`),
   adjacent to open-path engraving.
5. **Open-path engraving** (score/V-line along a curve) — ruler, frets,
   route lines.
6. **Batch/list input** (mail-merge names) — wedding place cards; the
   sheet-ledger flow is 80% of the machinery already.
7. **QR code pocket** — deterministic generation, verifiable, zero
   likeness risk, small-business demand (`qr-menu`).
8. **`posX`/`posY` on pocket_shape** — the model already believes it
   exists; param-surface parity would have saved `catan-insert`.
9. **Mirror text** — trivial transform, real acrylic-backside use.
10. **Tiling/panelization** (split a wide sign across boards) — pairs
    with the shop-limits story.

## Incidental repo bugs

- `app/test-live.mjs` passes a single font ArrayBuffer; `runRecipe` now
  takes the fonts.mjs shelf map — every text op fails with "unknown
  font." The committed live test cannot currently pass.
- The browser app should check `stop_reason === 'max_tokens'` and the
  zero-actions/zero-declines case (Findings 1/3) — both currently look
  like silent success.

## Harness

`tools/synth-probe/`: `prompts.mjs` (the 50 prompts + priors),
`probe.mjs` (live runner, prompt-cached, 4-way), `replay.mjs` (re-weave
from recorded actions, no API cost), `results.jsonl` / `results2.jsonl`.
Every recorded row replays offline — converted declines become
regression cases by flipping the prior and re-running `replay.mjs`.
