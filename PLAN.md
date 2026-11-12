# Loom plan: safer cuts, fewer dead ends

Written 2026-11-11 from a read of the code and the nightly ledger. Six
workstreams, ordered so each one is measurable against the one before.
Status boxes are updated as sessions land.

Goal, in one line: any prompt ends in SOMETHING worth cutting, and nothing
that reaches a machine is unsafe or useless.

## Ground rules for every workstream

- `npm test` green, corpus replay with 0 regressions, re-bless only rows
  that improved.
- Safety behaviour is planner policy, never a param the model must remember.
- The verifier is never loosened to make a conversion pass.
- Server-side edits go to both copies (`fabmo-loom/intent/` and
  `seams/intent/`); production restart is Brian's.
- Nothing is committed or pushed without Brian's review.

## 0. Baseline (start of session 1, about 30 min)

- [~] Record today's numbers in `tools/synth-probe/runs/plan-baseline.md`:
      corpus ok count, last 14 nights FULFILLED / PARTIAL, median seconds
      and calls per prompt, system prompt size (about 83k chars + 16k tool
      schema before guests).
- [ ] Pick a fixed 25-prompt set (reuse a recent night's prompts file) as
      the A/B set for every later workstream.

## 1. Machinability gate (session 1)

Today `ir/verify.js` proves motion matches declared intent and stays in the
stock. It does not prove the cut is physically sound.

**1a. Part retention.** `tabs` defaults to false on `tag_cutout`,
`disc_cutout`, `shape_cutout`; multi-piece jobs free every piece loose.

- [x] Shop setting `holdDown`: `vacuum | screws-or-tape | none declared`.
- [x] Policy in the three cutouts (`holdTabs` in `app/catalog.mjs`): tabs on
      automatically when a freed piece is below an area or min-width
      threshold for the declared hold-down. The model's `tabs: true` still
      forces them; `tabs: false` on a small piece is overridden with a
      warning that names why.
- [~] Same policy exposed to guests that free their own parts (furniture,
      `rib_lattice`, `rib_chair`, `linker_logs`) - audit what each does now.
- [x] Weave-report note so the model can tell the user ("held by 4 tabs").

**1b. Pass depth from the bit.** Catalog constants (0.25" cutouts, 0.125"
pockets) ignore the bit; `recommendFeeds()` in `ir/tools.js` already
returns `depthPerPass` but the runtime takes only its feeds.

- [x] One helper `passDepthFor(tool, material)` used by every catalog
      entry; default material when none is declared = conservative plywood.
- [x] Cap at 1x diameter for flat bits whatever the table says.

**1c. Reach and thin stock.**

- [x] Flute reach: tool `maxDepth` (default 4x diameter) checked for every
      op, not only inside auto tool selection. Over reach = error naming a
      bit that would reach.
- [x] Thin web: after all regions are known, Clipper inset test for
      material left narrower than a threshold between two cuts, or between
      a cut and the part edge. Warn first; promote to error after a corpus
      sweep shows the false-positive rate.

**1d. Where it lives.** New `ir/machinability.js`, called beside
`verifyJob`, reported as its own block (`machinable: ok / refused`), so the
"matches intent" result and the "safe to cut" result stay separate.

Acceptance: sabotage tests for each check (loose 2" piece, 1/16" bit at
0.25" pass, 1.5" deep with a 1/4" bit, 0.05" web); corpus sweep listing how
many recorded jobs each check touches before it becomes an error.

**Status 2026-11-12 (session 1, uncommitted):** `ir/machinability.js` +
`test/machinability-test.mjs` (43 checks, in `npm test`) + a section in
`app/test.mjs`; gate runs on every weave (20-90 ms) and is reported as
`result.machinability`. All four checks are at WARN. Still open:

- [ ] Corpus sweep (`node tools/synth-probe/machinability-sweep.mjs`, 2
      workers): the first attempt with 6 workers ran the 3 GB server out of
      memory and was stopped. Needed before any check becomes an error.
- [ ] Full `npm test` incl. corpus replay after the tab / pass-depth
      changes (same memory caution).
- [ ] Guests (furniture, braille, compiler) still plan their own tabs and
      pass depths; the gate measures them, the sweep will show what it says.
- [ ] `[~]` baseline: suites recorded, corpus count and A/B set not yet.
- [ ] Pre-existing: one check in `test/reference-test.mjs` fails on the
      committed code and stops `npm test` before the app and corpus suites.
- [ ] Hold-down select added to the settings panel; not yet looked at in a
      browser. Phone page has no setting (always "not declared").

**Decided 2026-11-12 (Brian):** tab thresholds stay as built - tabs under
36 sq in or under 3" min width with no hold-down declared; under 9 sq in or
1.5" with vacuum; never when parts are fixed. Still open: whether an onion
skin is wanted as an alternative to tabs.

## 2. Measure and look (session 2, first half)

The repeated field lesson: the model cannot know rendered sizes, so it
guesses coordinates. Each case got its own param.

- [x] `measure` tool beside `apply_recipe_actions`: text (string, font,
      letter height) and shapes (id, glyph, asset, path, derivation) return
      width x height in inches, computed by the real font and shape code.
      Capped at 2 calls per turn. Loop option `measure`.
- [x] Picture of the cut on EVERY second look, not only photo likenesses,
      with pocket depth as grey levels - plus a `SIZES` line (each
      operation's woven size and center). Loop option `look`.
- [x] REVISE text gains one question: would a stranger see the thing that
      was asked for (step 6, with `look`).

Acceptance: A/B on the 25-prompt set - verified rate, corrections, cost,
seconds. Keep only if verified rises or corrections fall without a latency
hit over about 15%.

**Status 2026-11-12 (session 2, uncommitted):** built as three
`runIntentLoop` options, all OFF by default (`measure`, `look`, `ladder`);
`test/look-test.mjs` (42 checks) and `test/trace-test.mjs` (16) are in
`npm test`; `app/test.mjs` passes. Nothing is switched on in the app.

First A/B (2026-11-11 nightly prompts; baseline = that night's results,
new arm = all three on, `runs/plan-ab-eyes-2026-11-12.jsonl`):

| | baseline | measure + look + ladder |
|---|---|---|
| verified | 25 / 25 | 25 / 25 |
| FULFILLED / PARTIAL | 18 / 7 | 18 / 7 (3 rows up, 3 down) |
| median seconds | 41 | 58 |
| model calls | 53 | 65 |
| rows corrected on the second look | 3 | 15 |
| measure calls | - | 0 |
| ladder second calls | - | 0 |

By the acceptance rule this does NOT earn a switch-on: no gain in verified
or fulfilled, about 40% slower, five times the rows corrected. Caveats:
one run per arm on different days, and this prompt set has no zero-cut
rows and no fixed-size text, so it cannot show what `ladder` or `measure`
are for (a 4-prompt smoke did: measured text fitted 8.9" into 9", and a
rotary ask became a verified flat stand). Next:

- [ ] Re-run with the arms split (`EYES=ladder`, `EYES=measure`, and
      `look` as SIZES only, without the picture and step 6) on a set that
      includes declines and fixed-size layouts.
- [ ] Look at the 15 corrected rows by eye: real improvements, or churn?

## 3. Never end at zero cut (session 2, second half)

About 40% of recent nightly rows are PARTIAL, and a text-only likeness
still declines outright.

- [x] Fallback ladder as a prompt rule plus an observation check: exact
      verb, else generic flat part, else a DEPICTION of the subject
      (plaque or sign naming it, a glyph, or a shape the user draws). A
      whole-request decline with an empty pipeline is sent back to the
      model once. Loop option `ladder`.
- [x] `find_reference` extended to generic subjects - but as a PHOTO the
      model draws its own low-fidelity impression from (Brian, 2026-11-12:
      the fair-animal photos were "identified correctly and charmingly low
      fidelity"), not a fetched outline: nothing anyone else drew reaches
      the cut. Loop option `subjects` (needs a `lookUp`). ON in the desktop app since 2026-11-12 (Brian: "whimsy instead of predictability"); the phone page and guest builds have no lookup yet.
      People, characters, logos and brands stay refused. Live try, 8
      prompts: bull, horse (x2), tractor, rooster, spread-wing eagle and an
      eagle plaque all verified, about 70-140 s each; a cartoon character
      stayed declined. The eagle plaque was the weak one (a blob with a
      good head).
- [x] Raster upload to outline: `app/trace.mjs` (DOM-free threshold +
      trace); a two-tone upload is stored as an SVG asset, a photograph is
      refused with a reason. Wired into the desktop upload; not yet tried
      in a browser. Photos to relief stays with Relief Studio (not mounted).

Acceptance: the ledger's by-design likeness prompts (bull, eagle, katana)
each produce a verified, recognizable silhouette; zero-cut outcomes on the
25-prompt set drop to cases that are truly out of scope (rotary, two-sided).

**Decision for Brian:** switching `subjects` on in the app reverses "a
likeness is a decline without a picture" whenever a reference photo is
found. Freehand from memory stays banned. Decided 2026-11-12: on (desktop app).

## 4. Part-first verb (session 3)

Open ledger classes that are the model doing CAM sequencing: counterbores,
overlapping-pockets, bore-vs-pocket, cutout-as-slot, texture-under-kerf,
cutout-fit-authoring.

- [x] One new catalog verb `part`: outline (rectangle, circle, shape id) +
      features (circle, rectangle, slot, shape id; `at` repeats; `angle`),
      each at a depth (`through` allowed). No op order, no tool choice.
- [x] Planner: overlapping features are grouped and cut as stepped levels
      (deepest wins), circles bored and the rest pocketed, bits chosen per
      feature, one bit at a time, cutout last with tabs by policy. Written
      on the existing strategies; `part_studio` lowering not reused (its
      modules are drawing/DXF/PDF oriented).
- [x] Verification: `test/part-test.mjs` (31 checks) simulates each case
      and samples the depth map. Overlap allowances are scoped tokens
      inside one part only.
- [x] Prompt rule: `part` is preferred for flat pieces with holes, slots,
      pockets; op-level verbs stay for text, texture, terrain, dishes.
      LIVE (the catalog doc and rule are in every request).
- [ ] Not built: inside profiles for large windows (they are milled away),
      chamfered rims on a part, hole patterns along a curve as a feature.

Acceptance: replay every corpus row in the six classes above through a
`part` re-authoring (live retest ids from the ledger); target is most of
them verified with no new rules added to the prompt.

## 5. Route before authoring (session 3, if 4 lands early; else session 4)

- [x] Built as a CORE every request gets plus five SHELVES (`SHELVES` in
      `app/intent.mjs`: furniture, kits, ribs, terrain, texture) rather
      than exclusive families. Loop option `route`, OFF by default; probe
      `EYES=route`. Not on in the app.
- [x] Pick without a model call (`pickShelves`): words in the ask,
      strategies already in the recipe, strategies in the chosen worked
      examples. A picture turn, and a model that cannot choose a tool, get
      the full prompt. Shelves left out are listed by name; `read_docs`
      returns a shelf's documentation as a tool result (`MAX_READS` 3).
- [x] Caching: one cached prefix per shelf set; the unrouted prompt is
      byte-identical to before.
- Measured: core 57,400 chars vs 127,600 full; mean routed prompt 58% of
  full over the 541 exemplar rows; needed shelf included in 125 of 126
  (word list tuned on the same rows). Cascade run 6 with routing: 25
  verified, 18 fulfilled, $0.090 per prompt, median 40 s, `read_docs`
  never called.
- [ ] Routed A/B on Opus alone, a repeat run, and the full corpus replay
      before switching it on in the app.

Acceptance: A/B on the 25-prompt set plus full corpus replay - verified
rate not lower, input tokens and seconds per prompt lower.

## 6. Ground truth from real cuts (Brian, alongside)

- [ ] Ten jobs from the corpus cut for real after workstream 1 (small
      loose pieces, a deep pocket with a small bit, a multi-piece set, one
      furniture nest). Record per job: held, finish, anything alarming.
- [ ] Results go in `tools/synth-probe/cuts.md`; each surprise becomes a
      machinability check or a threshold change.
- [ ] Ledger ranking: keep weighting real asks over synthetic ones, and
      stop adding object-specific verbs for classes with no real ask.

## Session split

| session | work | ends with |
|---|---|---|
| 1 | 0 baseline, 1 machinability gate | sabotage tests + corpus sweep report |
| 2 | 2 measure and look, 3 fallback ladder | A/B table vs baseline |
| 3 | 4 part-first verb, start 5 | class replay results |
| 4 (if needed) | finish 5, fold in findings from 6 | A/B table, plan closed |

## 7. Small model first, escalate (added 2026-11-12)

Loom is free and exists to sell machines, so cost per prompt matters at
scale: the target is about a tenth of today's (about $0.17 on Opus 5.5,
of which output is 53%, uncached input 28%, the cached prompt 19%).

- [x] `runIntentCascade` (`app/intent.mjs`): cheapest model first; an
      attempt is kept only if it built, verifies, declined nothing and
      needed no after-the-fact correction; otherwise the next model starts
      from the original recipe. The top rung walks the fallback ladder.
      Probe: `CASCADE=claude-haiku-5-5,claude-opus-5-5`. Not wired into
      the app.
- [x] Loop repairs for small models: one tool call per reply on forced
      models, split calls merged and all answered, control bindings in
      `part` features.

| 25 prompts (2026-11-11 set) | Opus 5.5 alone | Haiku 5.5 alone (before repairs) | Cascade |
|---|---|---|---|
| verified | 25 | 8 | 25 |
| FULFILLED / PARTIAL | 18 / 7 | - | 18 / 7 |
| kept at the small model | - | - | 7 |
| cost per prompt | $0.172 | $0.003 | $0.136 |
| median seconds | 41 | 9 | 75 |

**Correction, same day.** The cascade row above overstates the small
model: of the 7 builds "kept", 3 were NAME TAGS for a router jig, a ukulele
fretboard and a kalimba - they verified, so nothing escalated. Cause, found
and fixed: with worked examples attached, the ask was an unlabelled sentence
after about 5,000 characters of examples, and Haiku read it as no request
("I need more detail", 6 rows) or rebuilt the example (3 rows). The ask is
now labelled (`ASK_LABEL`) whenever examples or a reference precede it.

Haiku 5.5 alone after the fix (`runs/plan-haiku55-fixed-2026-11-12.jsonl`):
20 of 25 verified (was 8), every build on the subject asked for, $0.0035 a
prompt, median 17 s - but only 5 verified with nothing declined. It builds
thinner than Opus and says so (17 partials: "one bar of the set", "only a
placeholder").

- [x] "Built nothing" explained and fixed (the unlabelled ask).
- [x] (done 2026-11-12) The probe's outcome labels do not check that the build is the thing
      asked for. A cascade needs that gate before it can ship: a cheap
      build that verifies but is off-subject or a stub must escalate.
- [x] (done 2026-11-12) Rerun the cascade with the fix (about $3 a run).
- [x] (done, see above) Six small-model attempts "built nothing" (about 700 output tokens,
      5 s): find out why and fix.
- [x] (done 2026-11-12) Nine escalated for a partial decline; seven of those the big model
      also declined. Do not pay to escalate a decline that is a fact about
      the machine (back face, rotary, 3D).
- [ ] Try a middle rung (Sonnet 5.5) and `mode: 'trouble'` on the top rung.

**Thin builds, same day.** Why the small model built a third of the ask and
called the rest "not authored yet": a forced tool call switches Haiku 5.5's
thinking off (thinking_tokens 0), so it wrote about 1,300 output tokens
where Opus writes 3,000 to 8,000, and it treated the loop as a conversation
with more building turns to come. Fix: Haiku 5.5 rides the `auto` tool
choice path (it thinks first) and gets `WHOLE_BUILD_RULE` ("build the whole
thing in this one call").

| Haiku 5.5 alone, 25 prompts | first run | ask labelled | + thinking, whole-build rule | Opus 5.5 |
|---|---|---|---|---|
| verified | 8 | 20 | 21 | 25 |
| verified, nothing declined | - | 5 | 14 | 18 |
| used `part` | 1 | 2 | 5 | - |
| cost per prompt | $0.0026 | $0.0035 | $0.0065 | $0.172 |
| median seconds | 9 | 17 | 29 | 41 |

Six of its remaining 7 declines are ones Opus also made on that prompt.
Checked by eye (featherboard, peg solitaire, nixie plate, counterbored
fence, kalimba): real builds of the thing asked for. Still failing: 3
verify errors (two the `part` verb would avoid) and 1 empty answer.

- [x] (done 2026-11-12) Rerun the cascade on this base; add the on-subject gate first.
- [ ] The worked examples all predate `part` and teach bore_hole + cutout;
      rebuild the exemplar index once `part` builds exist.

**The on-subject gate, same day.** `judgeBuild` (`app/intent.mjs`): one
small request - no catalog, no rules - that shows a judge the ask, the
facts of the build as the app computed them (`buildFacts`: operations with
resolved params, sizes, pieces, verified, declines) and the picture of the
cut. Never the builder's summary. It reports subject / on_subject /
missing / reduced; any finding means "redo" whatever word the judge chose,
and a judge that cannot be reached is not a pass. The cascade calls it on
every attempt below the top rung that would otherwise be kept.
`tools/synth-probe/judge-check.mjs` runs it over recorded rows.

Measured with Haiku 5.5 as judge (about 2,200 input + 700 output tokens a
call, well under a tenth of a cent):

| recorded builds | keep | redo | notes |
|---|---|---|---|
| the 7 the first cascade kept | 1 | 6 | all 3 wrong name tags caught; also a tangram with no medium triangle and a panel with 3 of 6 holes |
| Haiku before the thinking fix (20 verified) | 13 | 7 | the one-bar xylophone, the placeholder case, one of fifty tiles |
| Haiku with thinking (21 verified) | 16 | 5 | missing vent grid, missing cable slot, a screw hole that misses the part |
| Opus 5.5, the reference run (25) | 21 | 4 | one pair of fifty tiles, no vent grid, no USB cutout; one likely false alarm (engraving "not visible") |

- [x] (done 2026-11-12) The judge finds real gaps in Opus builds labelled FULFILLED. Feed
      its findings to the top rung as one more fix turn?
- [x] (done 2026-11-12) Rerun of the cascade with the judge: `runs/plan-cascade2-2026-11-12.jsonl`.

**Cascade rerun with every fix and the judge** (`runs/plan-cascade2-2026-11-12.jsonl`):
24 of 25 verified, 17 FULFILLED / 7 PARTIAL / 1 unverified; $0.118 a prompt
(68% of Opus alone; the judge is $0.0002 of it); median 70 s. The small
model's build was kept on 12 prompts after passing the judge. 13 escalated:
12 for a partial decline, 1 for a verify failure. On 4 of those 13 the
Opus attempt (with the ladder on) did NOT verify; for 3 the small model's
verified build was returned instead, 1 ended unverified.

- [x] (done 2026-11-12) Most escalations are for declines; Opus then declined too on 7. Let
      the judge rule whether a declined item is makeable on this machine,
      and escalate only those.
- [x] (done 2026-11-12) Why does Opus fail to verify 4 of 13 as the top rung when it
      verified 25 of 25 alone? Suspect the ladder's "do not decline"
      pressure. Test the top rung without it.

**Top-rung test, same day.** Opus alone on the four prompts whose Opus
attempt failed inside the cascade, ladder on and ladder off: all four
verified in both arms (8 of 8). The ladder is NOT the cause. One of the
four was a real defect in the `part` planner (a through notch that opens a
through hole to the edge left the hole as a pocket overlapping the cutout)
- fixed, with a test. The other three did not reproduce; their errors were
not recorded (the cascade row keeps only the escalation reason).

- [x] (done 2026-11-12) Record each attempt's weave errors in the cascade row.
- [ ] Run-to-run spread: 25 prompts once is not enough to tell 24 from 25.

## Corpus sweep result (workstream 1, finished 2026-11-12)

`runs/machinability-sweep-2026-11-12.json`: 1,720 of 1,739 corpus rows (19
lost when one worker hit its heap limit; the sweep is now resumable with
`--resume`). 1,354 wove, 1,259 verified. Of the verified jobs:

| check | jobs flagged | what they are |
|---|---|---|
| reach exceeded | 73 (5.8%) | almost all a 1/16" bit cutting 0.3" to 0.5" deep (rest passes and fine grids), some 1/8" through 3/4" |
| pass depth over 1x diameter | 3 (0.2%) | terrain relief with a ball bit at 1.1 to 1.2x |
| a small piece freed loose | 59 (4.7%) | mostly guest furniture panels under 3" across, cut with no tabs |
| thin web | 29 (2.3%) | not yet looked at one by one |

Gate time: median 90 ms, p90 630 ms. One row (`2026-07-27/multiplication-board`)
took 41 minutes to weave and 48 in the gate - most of the sweep's wall time.

- [ ] Do not promote any check to an error yet: each would refuse jobs
      that verify today. Fix the causes first - tool selection that
      ignores reach, guest furniture freeing small panels without tabs,
      the terrain ball pass - then re-sweep and promote.
- [ ] Find out why multiplication-board takes 41 minutes to weave.
- [ ] `--resume` the 19 missing rows.

**Judge rules on declines; third cascade run** (`runs/plan-cascade3-2026-11-12.jsonl`).
A partial decline on a build that verifies now goes to the judge: a real
limit of the machine stays at the small model, a decline of something
makeable escalates. On recorded builds it accepted the back face, a scarf
joint and a turned roller, and refused "not authored yet"; it also called
3 of Opus's own 7 declines makeable (counterbore, channel into a hole).

| 25 prompts | Opus alone | cascade 1 | cascade 2 (judge) | cascade 3 (+ decline rulings) |
|---|---|---|---|---|
| verified | 25 | 25 (3 wrong) | 24 | 25 |
| FULFILLED / PARTIAL | 18 / 7 | 18 / 7 | 17 / 7 (+1 unverified) | 17 / 8 |
| small model kept outright | - | 7 (3 wrong) | 12 | 13 |
| cost per prompt | $0.172 | $0.136 | $0.118 | $0.112 |
| median seconds | 41 | 75 | 70 | 44 |

Escalations in run 3 (12): judge 6 (reduced 3, missing 2, makeable
decline 1), blank summary 3, did not verify 2, rolled back 1.

- [x] Blank summaries are written by the app (`plainBuiltSummary`) and no
      longer escalate.
- [x] The judge's findings go up with the build (`reviewNote`): the right
      thing built short is FIXED in place (the top rung starts from the
      small build), the wrong thing is started over with a note. A fix
      that ends unverified hands back the small model's verified build.

**Runs 4-6 (same 25 prompts, 2026-11-12)**

| | cascade 4 (summaries + findings) | cascade 5 (+ cache split) | cascade 6 (+ routing) |
|---|---|---|---|
| verified | 25 | 25 | 25 |
| FULFILLED / PARTIAL | 22 / 3 | 19 / 6 | 18 / 7 |
| small model kept outright | 17 | 15 | 17 |
| cost per prompt | $0.140 | $0.118 | $0.090 |
| median seconds | 49 | 47 | 40 |

FULFILLED has ranged 17-22 over six runs of the same prompts: read
differences of two or three as noise. Run 4's cost rose because each fix
turn re-wrote the whole prompt cache (the recipe sat inside the cached
block); the cache split fixed that.

**Prompt caching was missing in production.** Only the probe cached the
system prompt; the app, the phone page, the guest relay and the job
worker sent ~59,000 uncached input tokens per call. `withPromptCache`
(`app/intent.mjs`, loop option `cache`) splits the system prompt at
CURRENT RECIPE and marks the fixed part cacheable. ON in `app/main.js`,
`app/mobile.js` and both copies of `intent/loom-job-worker.mjs` (the
worker needs a production restart). The funnel log records only
input/output tokens, so it cannot show cache reads yet.

- [ ] Log cache read/write tokens in the funnel: the desktop and phone
      pages now send `cacheRead` / `cacheWrite`; server-side job rows do
      not yet (needs a `server.js` edit in both repos and a restart).
- [ ] `arduino-din-rail-box`: the furniture fix turn spends 15-18k output
      tokens and ends unverified two runs in three; cap or skip fix turns
      on furniture ops.
- [ ] `state-capitals-match-tiles`: Opus overruns the token budget every
      run (50 tile pairs listed one by one); the small build is returned.
