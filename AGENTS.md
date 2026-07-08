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

## Growing the Loom catalog (app/)

The Loom app (app/) exposes foundation skills as prompt-facing catalog
entries. A skill is not "in Loom" until it is in `app/catalog.mjs`. The
pipeline: skill honed in an app → graduated into the workspace seams repo
with a gauntlet → `tools/sync-from-seams.sh` (which NOTEs strategies not
yet in the catalog) → catalog integration here. The integration checklist:

1. Decide the prompt-facing shape. Catalog entries are macro-strategies —
   verbs a user would say — not 1:1 wrappers of strategy modules. A new
   capability is often a new PARAM on an existing entry (3D tabs became
   `tabs`/`tabHeight`/`tabSpacing` on `tag_cutout`), not a new entry.
2. Write the entry in `app/catalog.mjs`: typed params (string/number/
   boolean, defaults, min/max, `bindable` on user-tweakable ones) and a
   `doc` string written FOR THE MODEL — the catalog doc is the LLM's
   entire knowledge of the capability. Say what it does, when to use it,
   and any physical caveats. `run()` returns moves + a declared verifier
   target (never omit it) + `bbox` + any `preview*` data the canvas can
   draw.
3. If the capability was previously named as a decline example — in the
   RULES list of `buildSystemPrompt` (app/intent.mjs) or in another
   entry's doc — remove it there, or the model will keep declining it.
4. Extend `app/test.mjs`: a scripted action payload that uses the new
   capability and verifies, plus (if it replaced a decline) move the
   decline test to something still out of scope. Wire nothing new; the
   file is already in `npm test`.
5. Run `npm test`, then exercise it live in the app with a real key.

Declines logged by users are the backlog for this section — a decline
converts to a feature by exactly this list.

## World-data references (the terrain pattern)

Some capabilities need real-world data too big to embed (elevation
grids). The pattern: the recipe stores a REFERENCE (`terrains:` — id +
place-name query or lat/lng box), a BROWSER-ONLY resolver
(`app/terrain-fetch.mjs`) geocodes and fetches public data on the user's
own connection, pins the resolved bbox/zoom/meta back into the recipe
(the document names an exact region from then on), and hands grids to
`runRecipe` as a plain argument. Three invariants when extending this:

1. The network lives ABOVE the rail. Lowering strategies must be pure
   functions of the resolved grid — the gauntlet feeds them synthetic
   fixtures and never fetches.
2. The LLM authors references, never data. `set_terrain` carries a query
   or a box; elevation numbers the model "knows" are not data sources.
3. Resolved metadata (center lat/lng, elevation range) is pinned into
   the recipe so later intent turns can author true facts (coordinates
   carved on a plaque) from the document instead of from model memory.

## Mounting a guest app

A whole sibling app can register itself as catalog verbs — the biggest
possible macro-strategy. The contract a guest must satisfy:

1. **A declarative document** the model can author (the guest entry's
   big param), with numeric fields optionally given as expression
   strings over the recipe's controls (`"h - t/2"`) resolved via
   `ctx.evalNumber(str, extras)`.
2. **A deterministic, DOM-free interpreter** from that document to
   moves + declared verifier targets on the canonical rail. The LLM
   authors the document; the guest's own tested kernels make motion.
3. **Working-frame output**: `run()` returns Loom sub-ops (`{ subName,
   tool: {name, diameter}, cutter, feedRate, plungeRate, moves, target,
   allowOverlap? }`) with any internal layout ALREADY baked into the
   moves/targets (translate rings and move endpoints; rotation is not
   yet supported for baking). Loom composes, verifies, and posts exactly
   as for native ops — the export gate is unchanged.
4. **Optionally, a `handoff` hook** — round-tripping out of Loom:
   `handoff: { label, carry(params, { evalNumber, vars, recipeName }) }`
   on the entry. `carry` receives RAW params (control bindings arrive as
   `{ ctrl: id }` — resolve via `vars`; expression strings via
   `evalNumber`). Loom shows the label as a button whenever the entry is in
   the pipeline; `carry` resolves the entry's authored document at the
   CURRENT slider values (via `evalNumber`), stores the now-static
   document wherever the guest's own app will find it (e.g. a shared
   same-origin design store), and returns `{ url }` for Loom to open in
   a new tab (or `{ error }`). This is how a prompt-woven design
   graduates to hand-editing in the guest app's full UI. `carry` runs in
   the browser only — keep it out of `run()`'s DOM-free path.

Wiring: the guest ships a module exporting `entries` (catalog-shaped);
an uncommitted `app/guests.local.mjs` lists guest module URLs per
deployment (`export default ['/c/<user>/<app>/shared/loom-guest.mjs']`);
`main.js` registers them at boot via `registerCatalogEntries`. Guests
never enter this public repo — the mechanism is public, the mounts are
per-deployment. Entry docs are the model's ONLY knowledge of the guest
format: condense the guest's document spec into the doc string, with a
worked example, exactly as native entries do.

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
