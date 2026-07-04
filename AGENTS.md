# Agent contract — FabMo Loom

You are building CNC/CAM software on a foundation of verified toolpath
kernels. The person running you will cut what you generate on a real
machine with a real spindle. These rules are not style preferences.

## The non-negotiables

1. **Every exported program passes `verifyJob` first.** Compose with
   `composeJob(job)`, verify with `verifyJob(job, composed)`, and only
   post (`postJobToSbp` / `postJobToGcode`) when `report.ok` is true.
   Surface `report.warnings` to the user; treat `report.errors` as bugs
   in your strategy or parameters.
2. **Never weaken the verifier to make a job pass.** If `verifyJob`
   rejects your output, the motion is wrong or the declaration is wrong.
   Do not loosen tolerances, drop targets, or bypass checks. The
   verifier's geometry is deliberately independent of the strategies'
   kernels so a shared bug cannot self-certify — keep it that way.
3. **Declare targets.** An operation should carry `target:` (a
   `{type:'region', ...}` or `{type:'heightmap', ...}` declaration of
   what it intends to machine). Strategies here return one; pass it
   through. Motion without a declaration gets only the basic motion
   checks — that's a weaker guarantee, not a shortcut.
4. **Respect the operation contract.** An op's `moves` are mid-program:
   they begin with a rapid XY positioning move, they own no retracts,
   preamble, feeds, or toolchanges — `composeJob` owns all program-level
   motion. Plunges are Z-only `linear` moves (they post at plunge rate).
5. **Don't guess CAM theory.** The strategies encode tested geometry
   (Clipper offsets from the original region, ballnose compensation
   against the full heightmap, rest = reachable(small) − reachable(big)).
   Reuse them. If you need a new strategy, follow "Adding a strategy"
   below — do not free-hand toolpath math into an app.

## Coordinates, units, conventions

- Canonical units: **inches** (`job.units: 'in'`); mm supported per-op.
- Stock origin: bottom-left corner; **Z = 0 is the stock TOP**; cutting
  depths are negative Z; `safeZ` is positive.
- Regions: `{ outer: [{x,y},...], holes?: [ring,...] }` — polygons,
  simple rings, no self-intersections. Use `vendor/clipper.js` for
  boolean/offset work; never roll naive polygon offsetting (a corner
  gouge taught us this).
- SBP feeds are inches/sec (`MS`), G-code feeds units/min — the posts
  handle this; do not hand-emit motion lines.

## Module map

- `ir/moves.js` — the canonical rail: `rapid/linear/arc/feed/toolchange/
  comment` + `walkMoves` (chassis for stats/verification).
- `ir/job.js` — `Job` shape (header comment = the spec), `composeJob`,
  `postJobToSbp`, `postJobToGcode`.
- `ir/verify.js` — `verifyJob(job, composed, opts)` → `{ ok, errors,
  warnings, stats }`. The admission gate.
- `ir/placement.js` — op-local → job coords. `scale` is XY-only and
  invalid for V-carves (depth is a function of XY geometry — scale the
  input geometry before lowering instead).
- `ir/arc-fit.js` — polyline → arc recovery for G2/G3-quality output.
- `strategies/pocket.js` — `generatePocket(region, tool, params)` →
  `{ moves, target, contours, levels, warnings, stats }`.
- `strategies/rest.js` — smaller-bit corner cleanup after a bulk bit.
- `strategies/tool-select.js` — coverage-knee bit recommendation.
- `strategies/surface-raster.js` — ballnose 3D raster over a heightmap.
- `strategies/bore.js`, `strategies/chamfer.js` — helical bores; vee/ball
  edge-breaks.
- `adapters/terrain.js` — reference lowering adapter.
- `intent/` — schema-constrained NL→actions parsing. The ONLY place an
  LLM output touches the pipeline, and it emits *parameters*, never
  motion. Keep that boundary: LLM above the top rail, deterministic code
  below.

## Adding a strategy

Signature: `(form, tool, params) → { moves, target, warnings, stats }`.

Checklist:
- Motion on the canonical rail only; entry from above (first move rapid
  XY), Z-only linear plunges, no retract at the end.
- `target` declares the SWEPT footprint actually machined (honest about
  partial reachability — unreached area flows to rest/residual passes,
  never silently claimed).
- A gauntlet test in `test/` proving BOTH directions: clean output
  accepted by `verifyJob` and by an independent brute-force geometry
  check inside the test; sabotaged output (stray cut, over-depth, mask
  escape) rejected with measured numbers. Look at
  `test/surface-raster-test.mjs` for the pattern.
- Wire it into the `test` script in `package.json` if self-contained.

## Testing

- `npm test` — self-contained gauntlets; must stay green.
- Tests print measured numbers and exit nonzero on failure; follow that
  style. No mocks for geometry — brute force is the point.
- Some tests import sibling apps from the private ShopBot Labs workspace
  (`test:workspace`); don't try to run or "fix" those here.

## For app code built on Loom

- Plain ES modules, no build step — everything runs in Node and the
  browser unchanged. A one-file HTML app importing `ir/` and
  `strategies/` directly is a legitimate architecture.
- Always show the user the verifier's numbers (gouge samples, coverage
  residual, cut time) before offering the export.
- Remind users of physical-world checks Loom cannot make: fixturing,
  bit actually loaded, Z zero, material. First run cuts air.
