# FabMo Loom

**The composition foundation for CNC/CAM apps: a canonical motion IR,
toolpath strategies, and an independent verifier.**

*From the makers of [ShopBot](https://www.shopbottools.com), part of the
[FabMo](https://github.com/FabMo) platform.*

The loom is where this all started, twice over: it is the icon of cottage
industry — one household, one machine, real production — and, through
Jacquard's punch cards, the ancestor of every programmable fabrication
machine and of computing itself. Loom is our bet that the next thing a
small shop fabricates is its own software: AI agents are now good enough
to build bespoke CAM tools, *if* they build on a foundation of verified
kernels instead of hallucinating toolpath theory from scratch. This
repository is that foundation.

**Start here → [QUICKSTART.md](QUICKSTART.md)** — clone to verified
toolpath in two minutes, then point your AI coding agent at the repo
([AGENTS.md](AGENTS.md) hands it the contract) and build your own app.

## The model (the fabrication hourglass, short form)

```
sources (wide)      STEP · DEM · SVG · fonts · STL · images
FORM rail (neck)    heightmap · polygon · solid
STRATEGY (bulge)    raster · medial-axis V-carve · pocket · rest · ...
MOVES rail (neck)   rapid / linear / arc / feed / toolchange      ← this repo
outputs (wide)      .sbp · .nc · verify · stats · simulate
```

Compose at the necks, compute in the bulge. A new primitive only has to
lower to `moves` to instantly work with every post, verifier, and
simulator — N+M adapters instead of N×M.

The **verifier is the admission gate**: an operation declares what it
intends to machine, and an independent check measures the motion against
the declaration — gouges and mask escapes are errors with measured
numbers, coverage shortfall is a warning. It returns numbers, not vibes.
That gate is what makes it safe to run a stranger's strategy — or an AI
agent's — on a real spindle.

## What's here

| file | role |
|---|---|
| `ir/moves.js` | Canonical moves rail (`rapid`/`linear`/`arc`/`feed`/`toolchange`) + `walkMoves`, the shared chassis for stats and verification. Distilled from the most complete of **twelve** near-identical per-app copies of `movesToSbp` in our app portfolio — the discovery that motivated this repo. |
| `ir/job.js` | `Job{units, stock, safeZ, tools, operations[]}` → `composeJob` (owns ALL program-level motion: retracts, toolchanges, per-op feeds) + `postJobToSbp` / `postJobToGcode`. |
| `ir/placement.js` | Op-local → job coordinates (translate/rotate/unit-scale). |
| `ir/verify.js` | Verifier v1: motion rules (stock envelope, depth vs thickness, no rapids below stock top, toolchange-at-safeZ, feeds in effect) + swept-footprint overlap checks + per-op **declared targets** (region or heightmap) checked independently of the strategy code that produced the motion — a shared bug must not self-certify. |
| `ir/arc-fit.js` | Polyline → G2/G3-quality arc recovery (center-seeded). |
| `strategies/pocket.js` | Contour-parallel pocket clearing (Clipper offsets, islands first-class, open-edge spillover, slot centerline fit); declares the bit's actual **swept** footprint, so partially reachable regions stay honest. |
| `strategies/rest.js` | Rest machining: each smaller bit pockets only `reachable(it) − reachable(previous)` — the corner blobs — gouge-safe by construction. |
| `strategies/tool-select.js` | Coverage-knee bit recommendation over a tool drawer; extends to REST chains. |
| `strategies/surface-raster.js` | Catch-all 3D strategy: ballnose-compensated raster over any heightmap source, with depth passes, masks, ridge-safe links, and run economy. |
| `strategies/bore.js` / `strategies/chamfer.js` | Helical bore entry; vee/ball edge-break with verifier-visible imprinted intent. |
| `adapters/terrain.js` | Reference lowering adapter (pass-structured relief JSON → moves). |
| `intent/` | The **only LLM touchpoint** in the platform: schema-constrained natural-language → app-action parsing (structured outputs, open intake / narrow fulfillment with an explicit `declined` channel), a thin server proxy, and a bring-your-own-key browser path. The LLM stays above the top rail; everything below it is deterministic, verified code. |
| `vendor/clipper.js` | clipper-lib 6.4.2 wrapped as ESM — no build step, runs in Node and the browser. |

## Tests

```bash
npm install
npm test
```

`npm test` runs the self-contained gauntlets: verifier suite,
surface-raster gauntlet (five synthetic surfaces + brute-force gouge
checks at every motion vertex), pocket-adjacent strategy suites (rest,
bore, chamfer, profile), tool selection, and arc fitting. Every check is
proven in both directions — clean work accepted, sabotaged work rejected
with measured numbers.

**Workspace-only tests** (not run by `npm test`): some gauntlets are
integration tests against sibling apps in the ShopBot Labs workspace
(`step_toolpath_app`, `pocket_strategy`, the terrain kernel's native Rust
harness) and against private customer part fixtures that we don't
distribute. They remain in `test/` for transparency; `npm run
test:workspace` runs the full suite in a workspace checkout. As the
sibling modules graduate into this repo, those gauntlets come with them.

## Status

Loom is extracted from a working system, not built as a spec: these
modules drive real apps at [ShopBot Labs](https://labs.shopbottools.com)
that cut real parts on real machines. It is early — APIs will move, and
several strategies (cross-raster and pencil finishing, ramp pocket entry)
are known gaps recorded in the code. The porcelain is thin; the kernels
are load-bearing.

## Decisions & caveats (recorded the hard way)

- **Plunge feed**: a Z-only linear posts as `MZ` (Z speed = plunge rate),
  not `M3` at XY speed. Same endpoint, more correct feed.
- **`placement.scale` is XY-only and layout-unsafe for V-carves**: V-carve
  depth is a function of XY geometry — scale input geometry *before*
  lowering. Unit conversion (mm↔in) scales all three axes; that's a
  coordinate-system change, not a layout edit.
- **Operation contract**: ops are mid-program move sequences — they begin
  with a rapid XY positioning move and own no retracts or preamble; the
  composer owns all program-level motion. The verifier enforces the result.
- **Verifier independence**: geometry checks are deliberately brute-forced
  here rather than shared with the strategies' kernel code, so a shared
  bug cannot self-certify.

## License

Code is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for
attribution requirements. FabMo is a trademark of ShopBot Tools, Inc.
