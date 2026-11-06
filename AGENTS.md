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
  below. The Loom app runs it as a closed loop (`app/intent.mjs`
  `runIntentLoop`): parse → apply → weave → the model reads the app's
  own report (`buildObservation` / `observationText`) as a tool_result
  → corrects and writes the final summary. The observation is data the
  app computed; never let the model author what it then "observes".
  `checkClaims` is the semantic gate above it: the model's `claims`
  (faces / pieces / parts / dataSource / mating) and its summary are
  checked against the recipe, never against its own words — add a check
  there when a new class of confident-but-false promise shows up in the
  ledger, and keep the summary lint precise (it runs on every turn).
- `app/exemplars.mjs` — worked examples for the model: past VERIFIED
  builds retrieved lexically (BM25 + subject class) from
  `app/exemplars.json`, which `tools/synth-probe/exemplars-build.mjs`
  distills from the synthetic corpus (never funnel rows — the index is
  served to every visitor) and the nightly rebuilds. Examples ride in the
  first USER turn so the cached system prompt never varies per ask; the
  probe excludes a prompt's own prior answer (`EXEMPLARS=off` measures
  without retrieval). Tune STOP / ALIAS / CLASS_WORDS there when the
  funnel's `intent.exemplars` keys show off-subject picks.

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

### Piece scopes (several loose pieces in one job)

A cutout (`wrapsContent` entry: tag/disc/shape_cutout) frees a piece and
ENDS it. The ops after it belong to the next piece: `runRecipe` gives
each piece its own content context (contentBBox / contentRings /
priorCutouts / opBoxes / edgeOps), so a cutout's content-fit check and
every self-sizing or centering default read only their own piece, and the
model authors every piece about the origin exactly as if it were alone.
The first piece IS the recipe ctx, untouched — a one-piece recipe behaves
as before. A cutout straight after a cutout is tried against the closed
piece first; enclosing it whole (content and outline) is nesting (a ring
from a disc), anything else is the next piece. As each piece closes,
`placeScope` slides any later piece that lands on an earlier one into a
row to the right (wrapping to a row above when the shop declares its
width — a wrapped row stands on a FLOOR, the top of everything below it
plus the gap, so pieces of different heights grow upward, never down into
the row below); pieces authored clear of each other stay put. A set whose
pieces glue up into one object may declare `recipe.assembly = {kind:'stack',
align:'holes'|'center'}` (action `set_assembly`): `buildStackAssembly` then
emits one assembly entry — each piece's closing-cutout outline with its bores
and nested cutouts as holes, stacked in pipeline order one stock thickness per
layer, lined up on each piece's first hole — and app/assembly3d.mjs draws the
stack rising out of the board exactly as it draws furniture. A verb that
frees SEVERAL pieces itself (`freesPieces: true` — `rib_lattice` in
app/lattice.mjs: a form from interlocking half-lap slotted ribs, one op →
every rib cut free, laid out, counted via `r.pieces`, previewed through
its own `assembly {kind:'lattice'}`) closes the piece like a cutout and
adds its own count; `placeScope` carries an assembly's sheet poses along
when such a piece is laid out. The translation is
`frameTransformers` with rot 0 — moves, declared targets, previews and the
referenced shapes' construction outlines move together — and the
verifier's footprint-overlap gate, unchanged, is still the proof that no
two kerfs touch. Built entries carry `piece` and `r.pieceShift` (main.js
subtracts the shift when a drag writes posX/posY); the result carries
`pieces` (nested cutouts count once) for the observation and claims.

### Kits of loose parts (no assembly)

`linker_logs` (app/linkerlogs.mjs — Bill Young's notched play planks) is a
`freesPieces` verb whose pieces do NOT make one object: it returns no
`assembly` and reports what it cut as `kit` instead. `runRecipe` collects
these into `preview.kits`, and `buildObservation` turns the first into the
model's "kit of loose planks" line (plank counts and lengths, the notch,
the course rise, the sheet count) — the model summarises from that, never
from memory of the design. Its sheet packing is its own: rows along the
long side of the sheet, first-fit, `setups` when the kit needs several
sheets, and two kerfs plus a web between planks — an outside profile
sweeps a full bit diameter past the outline, so the fixed half-inch gap
the rib verbs use only clears a 1/4" bit. The proportions are measured
from Bill's drawings and recorded in the module header;
test/linker-logs-test.mjs is the geometry and sabotage gauntlet. THE BIT IS
SIZED TO THE PLANKS (`STOCK_BITS`, `MIN_GRIP`): each notch wall carries a
round relief at its floor, and the relief takes its whole diameter off the
straight wall the crossing plank grips — so a fixed bit and relief that
suit a 3.5" plank leave a half-size one almost nothing to hold (a field
report, 2026-11-05: 0.05" of a 0.43" wall, and the verifier had no reason
to object — the cut matched its target). With `toolDiameter` and
`reliefDiameter` at 0 the verb takes the largest of 1/4", 1/8", 1/16" that
fits the notch and leaves at least half of every wall straight, sizes the
relief to just clear it, never steps down more than the bit's diameter, and
reports the bit and the wall in `kit` for the observation; a named bit or
relief that leaves less than half is refused with the bit that fits. A
verb that scales must scale its cutter with it. The kit's ANGLE CONNECTORS (`connectors`
[{angle, count}], `connectorRing`) are ring segments with one plank notch in
each straight edge; the notch radius follows the rule recovered from his
15°/30°/45° drawings (the two seated planks' inner corners meet), so any
angle up to about 70° is generated, and each connector's angle is scored
along its bisector in ONE label op that runs before the profiles — a
V-bit by default (a tool change), the cutting bit on request. With `tiers` the same
verb builds a STRUCTURE: rectangular tiers on the notch grid, two planks a
course, courses alternating direction (`towerPlan`); a stepped-in tier's
first course runs the full extent of the tier below so it lands on that
tier's walls. Tiers form a tree (`on`: the earlier tier a tier stands on;
default the previous one): several may share a tier — spires on a hall —
a clear cell apart, and siblings whose walls share a line share the beam. It then cuts exactly those planks and DOES publish an
assembly (`kind: 'linker_tower'` — tiers, courses, height, footprint, a
posed panel per plank), which the observation reports as the tower line;
the gauntlet audits the poses by brute force (every contact is two notches
meeting, every plank is carried at two, nothing else touches). Without
tiers a kit is
what is cut, not what it becomes: the prompt rule has the model decline
any structure that is not stacked rectangles, and a named building's
ornament always (only the stepped massing is built; proportions not taken
from a picture or the user's numbers are named as estimates).

### The picture of the cut (likeness from a photo)

With a picture attached, the second look also SEES the build:
`app/snapshot.mjs` rasterizes the lowered geometry (cutout rings light,
pocket / V-carve regions dark, bores darker) into a small grayscale PNG —
pure JS, stored-deflate, so it runs in the browser, Node and the guest-job
worker alike — and `runIntentLoop` puts it INSIDE the tool_result as an
image block beside the observation text (`PICTURE OF THE CUT`). The
observation records only its size and content counts; the image itself is
never logged. Rendered from the geometry that will be machined, never from
the model's description. This is what lets a REPRESENTATIONAL subject in
the picture (an animal, a building, a vehicle) be authored instead of
declined: the `PHOTO_LIKENESS_RULE` (with a picture only) asks for
`observed` — the schema's FIRST field, concrete features seen in the
picture — before the geometry, and the second look compares the picture of
the cut with the photo. Text-only likeness asks still decline (nothing is
in view). Markings inside markings are `set_shape difference`, never two
overlapping pockets.

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

### Looking a real building up (the reference pattern)

The model has no web access, so "a Linker Logs Chrysler Building" used to
be built from memory or declined. The second network seam above the rail
is `app/reference-fetch.mjs`: `findReference(subject)` asks Wikipedia
which article the name means, takes the article's pictures in article
order (the infobox view first), keeps only JPEGs that live on Wikimedia
Commons (a file on en.wikipedia alone is fair use and is skipped), and
returns ONE photo with its author and licence, the Wikidata height /
floors / length / width, and the article's sentences that state a size.
It refuses people, logos, brands and companies on what Wikidata says the
subject IS, whatever was asked, and it never throws — every failure is a
named non-answer the turn carries on from.

How the model gets it (`app/intent.mjs`):

- `find_reference` is a second client tool, offered only when the caller
  passes `lookUp` to `runIntentLoop`, no picture is attached, and the
  model can choose its tool. A caller that passes nothing (the phone page,
  the server jobs, the nightly probe) sends byte-for-byte the request it
  always did.
- Calling it does NOT continue the conversation. The loop STARTS THE TURN
  OVER with the photo and `referenceText()` attached to the ask. The
  Claude 5 models tie thinking blocks to the tool list they were produced
  under, so a tool (web search) cannot be added to a conversation under
  way; a fresh one is the only append-only form.
- Web search (`WEB_SEARCH_TOOL`, the basic `web_search_20250305`, two
  uses at most) rides ONLY on a request that carries a reference — an
  ordinary prompt can never bill a search. The newer search version is
  refused by the API beside `disable_parallel_tool_use`, which this loop
  needs. If the API rejects the search-bearing call, it is sent once more
  without search.
- One retry (`MAX_LOOKUPS = 2`) exists for "that is the town, not the
  courthouse"; after it the tool is withdrawn.

Invariants when extending this:

1. A reference is REFERENCE, NOT DATA. Nothing fetched becomes geometry;
   the model reads massing and proportion and still has to build from the
   catalog and pass the verifier. It is not the user's picture: the
   picture rules and the picture-vs-board comparison stay off.
2. The credit travels, the bytes do not. `recipe.reference` and the
   funnel log carry the article, the file, the author and the licence —
   never the image.
3. The likeness rule is untouched. A reference never licenses tracing an
   outline, and the refusals in `REFUSED_KINDS` are the backstop that does
   not depend on the model following its rule.

`test/reference-test.mjs` proves it with no network and no model (a
recorded Wikimedia fixture behind an injected fetch, a scripted model).

## Mounting a guest app

A whole sibling app can register itself as catalog verbs — the biggest
possible macro-strategy. The contract a guest must satisfy:

1. **A declarative document** the model can author (the guest entry's
   big param), with numeric fields optionally given as expression
   strings over the recipe's controls (`"h - t/2"`) resolved via
   `ctx.evalNumber(str, extras)`. A guest that lays parts out should
   also consult `ctx.shop` — the user's declared physical limits
   (`{ machineW, machineH, materialW, materialH }` in inches, 0/absent
   = no limit; app-level settings, never part of the recipe) — and nest
   within the tightest of them, splitting into multiple setups when the
   parts cannot share one; a SINGLE part bigger than the limit is an
   honest error naming the part, never a file the machine can't run.
   The machine's cutting area is absolute — it does not scale with a
   guest's model/prototype mode.
2. **A deterministic, DOM-free interpreter** from that document to
   moves + declared verifier targets on the canonical rail. The LLM
   authors the document; the guest's own tested kernels make motion.
3. **Working-frame output**: `run()` returns Loom sub-ops (`{ subName,
   tool: {name, diameter}, cutter, feedRate, plungeRate, moves, target,
   allowOverlap? }`) with any internal layout ALREADY baked into the
   moves/targets. Translation is trivial; quarter-turn rotation is also
   bakeable if done RIGHT: rotate rings and move endpoints identically
   (an axis-hold move must gain both coords, filled from the tracked
   position), rotate arc centers as vectors ((i, j) → (−j, i) for 90°
   CCW; `cw` is preserved — quarter turns keep handedness). The verify
   gate independently proves every placed cut either way. Loom composes,
   verifies, and posts exactly as for native ops.
4. **Optionally, `assembly` data** — the assembled view. A guest whose
   ops cut FLAT PARTS OF A 3D OBJECT (furniture panels) may return
   `assembly` alongside `ops`: `{ box: [W, H, D], panels: [{ id, rings,
   thickness, sheet: {x, y, rot?}, world: { origin: [x,y,z], u: [3], v: [3] } }] }`.
   `rings` are the panel's outline + holes in the op frame (y-up, the
   same frame its moves cut in); `sheet` is its working-frame placement
   on the board (`rot` in degrees, applied about the op origin BEFORE
   the translation — match your placement math exactly or the preview
   panel lies about where the cut is); `world` is its pose in the
   piece's own Y-up frame — ring
   point (a, b) lands at `origin + a·u + b·v`, extruded along `w = u×v`
   by the thickness. Emit PROPER rotations only (det +1 with that w) so
   poses tween as rigid motions. Loom renders an "assemble" scrub on the
   3D view blending every panel between its spot in the machined board
   and its assembled pose (app/assembly3d.mjs). Purely visual — the
   verifier neither sees nor trusts it. Two optional refinements: a
   panel may carry `pockets: [{ ring, depth }]` for BLIND recesses
   (dados, blind mortises, stopped bores) — the view cuts them `depth`
   deep from the machined face instead of punching them through, so
   keep only true through holes in `rings`; and when a layout needs
   several sheets/fixturings, return EVERY panel with `setup: n`
   (1-based) and `active: false` on the ones this weave does not cut —
   the view shows the whole piece with the other sheets' panels ghosted.
   A multi-sheet entry also returns `setups: { count, current, groups:
   [[panel ids]…] }`: Loom's sheet picker flips the entry's `setup`
   param (a bindable number, 1-based) through them and re-weaves, and
   exported filenames carry `-sheetKofN`. The exported file is always
   ONE fixturing.
5. **Optionally, published `frames`** — native verbs mounted on guest
   geometry. `run()` may return `frames: [{ id, cx, cy, rot, w, h }]`
   (e.g. each furniture panel's placed body: center, rotation in
   degrees, panel-local dims). Any LATER pipeline op may carry
   `frame: "<id>"` at the op level: the runtime runs it in a clean
   frame-local context (content centers on the frame; place/posX/posY
   compose frame-locally; consecutive framed ops on the same frame see
   each other as content), then rotates + translates the whole result —
   moves, target rings, previews — into place. Rings-based results only;
   heightmap targets are refused with a clear error. Content whose
   panel-local extent exceeds the frame's `w × h` is REFUSED outright
   (thin engraving strokes crossing a kerf only graze it, so the overlap
   gate alone cannot catch that); the gate is otherwise unchanged:
   framed content that strays across the guest's own cuts is a footprint
   overlap and the job is refused. SEQUENCING: framed content is
   machined AHEAD of its publisher's own sub-ops (spliced in before the
   first of them, pipeline order kept among framed ops): the panel is
   untouched stock under the V-bit rather than a tabbed island after its
   release profile, and the job mounts each tool once. ENGRAVING RIDES
   THE PANEL into the assembled view: a framed op's panel-local pocket /
   V-carve regions are kept before the frame transform (`framedMarks`)
   and, once every op has run, become `pockets` on the matching assembly
   panel (frame-local origin = the panel body's center; the panel's rings
   have their origin at the body's bottom-left corner), so a house gable's
   windows show on the standing gable, not on the board behind it. Which
   FACE they land on is the guest's call: a furniture panel is machined
   from one face, and the compiler's `face` field ("+"/"-") pins it — the
   A-frame's gables face OUT with through tenons at every gable joint.
6. **Optionally, a `handoff` hook** — round-tripping out of Loom:
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

### Starting over while a build runs (v0.112)

A generation in flight is a **turn object** (`activeTurn` in `app/main.js`
and `app/mobile.js`: `{ cancelled, ac: AbortController, stop() }`); the
page awaits `Promise.race([work, stopped])`, so cancelling frees the page
at once instead of waiting for a stuck model call or guest job to end.
Rules: a cancelled turn's result lands nowhere (every `then` after the
race checks `turn.cancelled`, stage labels are guarded), its fetches
carry `activeTurn?.ac.signal`, and a guest job is told to stop with
`DELETE /api/intent/loom/job/:id` (same pass only; `LoomJobs.cancel`
terminates the worker and `onFailed` refunds the prompt). On the phone
page **a new photo is a fresh start** — it cancels the build, clears the
design (`resetDesign()`), keeps the typed text, and the next Build is a
first build; the "Start over" button does the same and drops the photo.
On the desktop a new picture only cancels; the design stays. Headless
checks: `test/browser-mobile-cancel-test.mjs`, `test/browser-cancel-test.mjs`.

### The first draft, shown early (v0.113)

Most of a turn's wait is the model's hidden reasoning (measured
2026-11-01 on six photo turns: 70–75 % of output tokens are thinking;
`tools/synth-probe/runs/latency-2026-11-01-*.jsonl`), and the first woven
state exists about halfway through. `runIntentLoop` takes `onDraft` and
calls it (never awaited) after each weave the model is about to look at,
with `{ turn, recipe, summary, declined, result, ok }`. Both pages render
that state at once — loom overlay down, badge "FIRST DRAFT · checking…",
every export control shut, the recipe NOT yet committed — and the final
result replaces it. A draft is provisional by construction: a fix turn, a
claims correction or the rollback guard may still change it. The guest-job
worker posts `{ kind: 'draft' }` (shape-checked and saved by `LoomJobs`, so
a phone that comes back mid-build finds it) and, on the Claude 5 models,
`{ kind: 'note' }`: the last complete sentence of the SUMMARIZED thinking
stream (`thinking: { type: 'adaptive', display: 'summarized' }`, billed the
same), shown on the button in place of "thinking…". Headless check:
`test/browser-mobile-draft-test.mjs`.

### Installable phone page + one push when a build ends (v0.113)

A guest can leave the phone page for another app while the server builds
(iOS suspends a backgrounded tab within a minute or two; the job keeps
running, the page catches up on return). What brings them back is a push.
`app/manifest.webmanifest` + `app/icons/` make `mobile.html` installable;
`app/sw.js` is a notifications-only service worker (nothing cached — the
page is always live). Once a guest job is posted, `offerPush` in
`app/mobile.js` attaches the browser's push subscription to THAT job
(`POST /api/intent/loom/job/:id/push`, same pass only; silently when
permission is already granted, else a "Ping me when it's ready" button —
subscribing needs a gesture; on iOS not yet installed, a line says to Add
to Home Screen). `LoomJobs.attachPush` keeps it on the job record;
`finish()` calls `notify(job)` once and drops it. `intent/loom-push.js`
holds the VAPID keys (self-provisioned at `/var/opt/apps/.loom-push.json`,
mode 600, OWNED BY THE SERVER'S USER — production runs as nodeapp, and a
root-owned file it cannot read means fresh in-memory keys at every restart
and every earlier subscription goes dead; `subscribePush` on the page
compares the subscription's key with the server's and resubscribes when
they differ; subject = the site, never a person's address) and sends the one
message via `web-push`: ready / did not verify / did not finish, tag = the
job id, tap reopens the page (which resumes the job from local storage).
Tests: `test/loom-push-test.mjs`, push cases in `test/loom-jobs-test.mjs`,
the browser draft test checks registration and the offer. LIVE copy:
`seams/intent` (server.js, loom-jobs.js, loom-push.js, worker) — edit both.

### Open builds: no pass, no key (v0.113)

"Adoption before lock-down." A phone-page build with neither a guest pass
nor an API key runs on the shop's key as an OPEN build, metered by
`intent/open-allowance.js`: 3 a day per IP address (the fairness rule) and
100 a day app-wide (the abuse bound), both ROLLING 24 h windows (no
midnight to game; "come back at" = the oldest build in the window + 24 h),
ledger at `/var/opt/apps/.intent-open.json`, read fresh per call and
WRITABLE BY THE SERVER'S USER (nodeapp) — the constructor probes it at
startup; a build it cannot record still runs but reports `remaining: null`
and the page shows no count (never "2 more" forever, the 2026-11-01 bug). Guest
passes and BYO keys are not counted — a workshop on one wifi keeps its
pass. The job route hands back a one-off `pass` ('op_…') that is the
job's token: the phone polls, stops and pings with it and keeps it in
`loom:job` for a reopen; a failed build refunds the slot (`openSlots`,
in memory). Refusals are 429 with `reason: 'ip' | 'app'` + `resetsAt`; the
page then opens the key box. The funnel log route still wants a real
invite header (open builds log without one). Test:
`test/open-allowance-test.mjs`; the browser draft test has an open-build
section.

### Download nested vectors — DXF for VCarve (v0.113)

`app/dxf.mjs` `weaveToDxf(result)` writes the woven layout as a strict R12
DXF (POLYLINE/VERTEX + CIRCLE only, LTYPE table — the flavour VCarve
actually imports; LWPOLYLINE/R14 layer tables get dropped, see the step
app's writer) in sheet coordinates (inches, X0 Y0 = board corner): layers
SHEET, PROFILE, THROUGH (nested cutouts, full-depth pockets),
POCKET_D<depth>, VCARVE (letter outlines, counters as holes), HOLES_D<dia>
(CIRCLEs), ENGRAVE (on-the-line traces), RELIEF_BOUNDARY (a 3D relief's
outline only, with a warning). Source = preview.built's preview* fields
(the same the canvas draws) + each op's declared target as the fallback
for guest ops, shifted by preview.placement. Design lines, not kerf
paths: VCarve offsets itself. The buttons ("Download .dxf vectors" /
"Vectors .dxf") are enabled whenever something is built, verified or not —
a DXF is not a machine program — and shut during a first draft. Test:
`test/dxf-test.mjs` (measured against the preview rings + placement).

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
