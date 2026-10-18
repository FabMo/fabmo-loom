# PROBE.md — the nightly Loom improvement probe

Operating doc for the scheduled probe agent. The loop's philosophy:
**measure aggressively, convert conservatively.** The probe finds and
ranks; humans decide what enters the shared surface (INTENT.md's
anti-Boeing rule). Never edit app code, prompt rules, or the catalog
from a nightly run — evidence goes in `ledger.md`, conversions happen in
attended sessions.

All paths relative to `tools/synth-probe/`. The suite lives on the
workspace deployment (guests + `/var/opt/apps/.intent.env` present).

**Executor:** `nightly.mjs` runs this whole procedure unattended — root's
crontab fires it at 07:23 UTC (~3:20am ET), logging to `runs/nightly.log`.
Its two LLM stages (batch generation, triage) call the API directly with
the shop key; an attended session uses this doc as the checklist when
running steps by hand. `node nightly.mjs --dry` generates without
probing.

## Nightly procedure

1. **Pipeline regression check (free):**
   `node test-corpus.mjs`
   A REGRESSION here means someone's commit broke handling of a recorded
   model response → notify immediately (see policy), include the row key
   and reason, and stop before spending on live calls.

2. **Pull the real stream:**
   `node funnel-pull.mjs`
   New declines are PRIORITY evidence. Classify each against ledger.md;
   increment funnel evidence counts; a decline fitting no class opens a
   new class entry (notify-worthy).

2b. **Corpus check runtime:** `test-corpus.mjs` replays in chunks of 100
   rows, each a short-lived child process, `--workers` at a time (one per
   CPU, max 4). Single-process it grew past 1.5 GB (the box has 3 GB) and
   took 28 minutes at 900 rows, past the executor's 30-minute window —
   2026-10-11..17 logged as "corpus regression" with an empty attention
   note were timeouts.
   `nightly.mjs` now gives the step 55 minutes, reports a timeout as its
   own attention line (not a regression) and runs the night anyway.

3. **Generate tonight's synthetic batch (25 prompts).**
   Write `runs/YYYY-MM-DD-prompts.json`: an array of
   `{ id, persona, prior, prompt, note?, asset? }` — same shape as
   `prompts.mjs`.
   - Pick 5 categories from the wheel below by rotation (day-of-year mod
     wheel length, take 5 consecutive), 5 prompts each.
   - Anchor in real project archetypes (Instructables/forum/shop-class
     genres), not paraphrases of previous batches. Vary voice: vague,
     unit-confused, half-remembered terminology, over-specified.
   - PRIORS ARE MANDATORY: predict covered/decline/unsure per prompt
     BEFORE probing. The prediction-vs-actual gap is our standing
     measurement of the overclaim blind spot.
   - Include 2–3 regression re-asks: prompts from ledger classes marked
     SHIPPED (the same words must keep working) and 1–2 by-design
     declines (must keep declining).

3b. **Pick tonight's pictures (free; network):**
   `node photo-pick.mjs YYYY-MM-DD` → `runs/YYYY-MM-DD-photo-prompts.json`
   and the pictures under `runs/photos/YYYY-MM-DD/`. See "The picture
   lane" below. Idempotent per day (`--fresh` to re-pick); zero pictures
   is an attention line, not a stop.

4. **Probe live (~$3):**
   `node probe.mjs ./runs/YYYY-MM-DD-prompts.json ./runs/YYYY-MM-DD-results.jsonl`
   Each model call retries a dropped connection (`fetch failed`), 429 and
   5xx up to 4 attempts with backoff (`model-call.mjs`, shared with
   `live-retest.mjs`); other 4xx are not retried. A row whose call still
   fails is recorded as outcome `INFRA_ERROR` (`infra: true`) — the
   network, not Loom. Plain `ERROR` means Loom threw. Three consecutive
   INFRA_ERROR rows abort the batch.

4b. **Probe the pictures (~$1.25 for six — three calls each, long answers):**
   `node probe.mjs ./runs/YYYY-MM-DD-photo-prompts.json ./runs/YYYY-MM-DD-photo-results.jsonl`
   Same runner; a row with `photo` rides the image into the request. Rows
   record `furniture` (woven box + panel count), `sizeHonored` when the
   text stated a size, and `assumedLine`.

5. **Triage.** For every non-FULFILLED row (and every FULFILLED row
   whose prior said decline — possible overclaim: read the summary
   against the pipeline and judge whether the fulfillment is REAL):
   classify against ledger.md; increment counts; open new classes as
   needed. Watch specifically for the semantic-overclaim pattern — a
   confident summary the pipeline doesn't back.
   `INFRA_ERROR` rows are NOT triaged: nightly.mjs withholds them from the
   triage call, strips them from anything it returns (so they can never be
   class evidence or a SHIPPED regression), leaves them out of prior-misses
   and the corpus, and tallies them separately in the run-log line. They
   still count toward the "3+ rows ERRORED — infrastructure suspect"
   attention rule.

5b. **Judge the pictures (vision; ~$0.40):** the meta model sees each
   photo plus the factual record of the build and scores `subject`
   (flat-panel / other-furniture / not-furniture), `fidelity` 0–3,
   additions, whether the Assumed line names the guesses, and for
   non-panel pictures whether the reinterpretation was honest →
   `runs/YYYY-MM-DD-photo-judge.json`. `nightly.mjs` does this inline.

6. **Grow the corpus:**
   `node corpus-add.mjs ./runs/YYYY-MM-DD-results.jsonl YYYY-MM-DD`
   `node corpus-add.mjs ./runs/YYYY-MM-DD-photo-results.jsonl YYYY-MM-DD-photo`
   `node corpus-add.mjs ./runs/funnel-YYYY-MM-DD.jsonl funnel-YYYY-MM-DD`
   (the last only when a funnel file was written; photo rows keep the
   picture's title + credit and the lane's measurements, never the bytes)

6b. **Refresh the fix-prompt queue (free):**
   `node autoprompt.mjs`
   Rewrites `runs/fix-prompts/INDEX.md` (every open class, ranked) and a
   ready-to-run brief for the top 8. No model call, no app-code edits —
   see "Autoprompting" below.

7. **Append the run-log line** to ledger.md: date, counts by outcome,
   prior-miss count, new classes, evidence increments, spend.

8. **Notify or stay silent** (policy below).

## Category wheel

signage & wayfinding · gifts & keepsakes · kitchen & serving ·
furniture & storage · shop jigs & fixtures · games & puzzles ·
musical instruments · electronics & enclosures · outdoor & garden ·
holiday & seasonal · small-business fixtures · school & education ·
cosplay & props · maps & terrain · decorative patterns & texture ·
kids & toys · pets · sports & recreation

## Notification policy

PushNotification ONLY for:
- a corpus REGRESSION (step 1),
- a NEW failure class (never seen in ledger.md),
- a SHIPPED-class regression re-ask that no longer works,
- probe infrastructure broken (API failures all night, missing key).

Everything else is a quiet ledger line. A quiet night is a good night;
do not manufacture significance.

## Guardrails

- ≤ 30 synthetic prompts/night; abort the batch if 3 consecutive API
  calls fail. Never loop on failures.
- Never commit, never push, never edit files outside `tools/synth-probe/`
  (ledger.md, runs/, corpus.jsonl, cursor). App code is out of bounds.
- Funnel utterances are user data: quote them in ledger.md only as far
  as needed to identify the class (decline rows are kept verbatim by
  design — see INTENT.md's PII stance — but the ledger is the summary,
  not a second copy of the log).
- Spend target ≈ $3–5/night on the shop key (the picture lane adds
  about $1.50 for six pictures). If a batch would exceed ~$10, stop and note it instead.

## Attended-session workflows (not nightly)

- **Conversion check after a capability lands:**
  `node live-retest.mjs <prompt-ids>` — the same words must now weave;
  move the ledger class to SHIPPED with the version.
- **Prompt-rule blast radius:** before/after any `buildSystemPrompt`
  edit, re-probe a fixed sample (20+ mixed prompts) and diff outcomes —
  prompt edits shift model behavior invisibly; this is the only
  instrument that sees it.
- **Re-blessing:** `node test-corpus.mjs --bless` after reviewing
  IMPROVED lines (deliberate improvements only).


## The closed loop (2026-09-26)

`probe.mjs` drives `runIntentLoop` — the same act → observe → revise path
the browser takes — so every row now records both `firstSummary` (what
the model said before it saw the weave) and `summary` (what the user
reads, written after), plus `loop.{turns, fixes, summaryChanged,
perTurn}` and `revisedActions`. Triage judges OVERCLAIMS on the final
summary only and lists rows whose first summary overclaimed but whose
final one is honest under `caughtByLoop`; the run-log line carries the
loop tallies.

`LOOP=off node probe.mjs …` reproduces the one-shot behavior on the same
prompt set — run both on one night's prompts to measure the loop
(`LOOP=trouble` is the cheaper variant: a second call only when the
observation has skips, failures, or an empty pipeline). `MODEL=<id>`
overrides the model for the same purpose across model generations.
Corpus rows keep replaying turn-1 payloads (zero API cost); the loop's
corrections are recorded, not replayed.

## The claims channel (2026-09-26)

Rows now carry `loop.claimsRefusedDuring` (claim codes the app refused on
any turn), `loop.claimIssues` (codes still standing at the end — corrected
deterministically in the final summary and declines) and
`loop.claimsCaught` (refused mid-loop, fixed by the model). Triage lists
rows with claimIssues under `caughtByClaims`, not `overclaims`. Codes:
faces, faces-text, dataSource, bathymetry, phantom-part, phantom-plug,
pieces, mating. A NEW confident-but-false promise class = a new check in
`checkClaims`, with a corpus sweep for precision before it ships.

## The picture lane (2026-10-18)

Loom builds from a photo of a piece of furniture plus (optionally) its
overall size: the picture decides kind, structure and proportion, the
text decides the numbers, every guess goes on an "Assumed:" line
(`intent.mjs` PICTURE_RULE). The nightly measures that promise on
pictures nobody curated.

- **Sources.** `photo-pick.mjs` draws from a rotating wheel of Wikimedia
  Commons furniture *categories* (Bookshelves, Nightstands, Workbenches,
  Crates, Wooden chairs… — full-text search was far too loose) at 1200px,
  CC/PD, credit and license kept with the row; plus up to 2 per night from
  `photos.local/` (gitignored — drop real photos there, a sidecar
  `<name>.txt` is the prompt text, e.g. the tape-measure numbers). Six
  pictures a night by default (`--count`), seeded by the day, never the
  same Commons file twice (`runs/photos/used.json`).
- **Two kinds of row.** Every other Commons row states a plausible size
  in the text ("Make it about 36 wide, 72 tall and 12 deep"): since nobody
  measured the real piece, this is the one deterministic check of "text
  decides the numbers" — `probe.mjs` records `sizeHonored` from the woven
  box. The other rows send the picture alone and test the assume-and-say-so
  path (`assumedLine`).
- **Two judges.** The text triage classifies photo rows' declines and
  failures against the ledger like any other row (it sees the title, not
  the picture). The vision judge (meta model, Opus 4.8) sees the picture
  and scores likeness: `subject`, `fidelity` 0–3, `additions`, `assumedOk`,
  `honestDecline` for non-panel subjects. Noise in the wheel — an ornate
  antique, a chair that needs curves — is deliberate: those rows measure
  the honest-decline path, and the judge's `subject` keeps them out of the
  fidelity average.
- **Run-log line:** `photos: N (outcomes; k flat-panel subjects: f FULFILLED,
  fidelity x/3; honest m/n; size honored a/b; Assumed line c/d)`. Rows join
  the corpus under `<day>-photo/`; `autoprompt.mjs` reads them for briefs.
- **Attended:** `node nightly.mjs --photos-only` runs just this lane (same
  day's pictures again unless `photo-pick.mjs --fresh`); `--no-photos`
  skips it. Image bytes are never logged, never committed, never sent
  anywhere but the API.

## Autoprompting (2026-10-05)

`autoprompt.mjs` turns the ledger into work orders. For each OPEN class it
joins every night's triage to the recorded rows and writes
`runs/fix-prompts/<class>.md`: the asks verbatim, what the user was told,
the failing op, the ledger's design note, the kind-specific procedure
(capability → AGENTS.md's decline → feature list; authoring → make the
runtime accept it before adding a prompt rule; robustness → replay and fix
at the root), and the acceptance test (`npm test` + `live-retest.mjs` on
the same prompt ids). Ranking: 5 × real-user asks + 2 × distinct synthetic
prompts in the last 14 days + ¼ × older ones. Probe rows that died on a
dropped connection (`INFRA_ERROR`, or the older `ERROR` + "fetch failed"
rows) are excluded and listed as infrastructure.

The brief is the hand-off, not the conversion: a brief is executed in an
attended session (paste it, or `claude -p "$(cat runs/fix-prompts/<class>.md)"`
from the repo root), it tells the agent not to commit or push, and its
first step is a written design call that may end in "by-design decline —
change nothing". The nightly only regenerates the queue.

`node autoprompt.mjs <class>` rewrites and prints one brief;
`--top N` changes how many are written. Funnel evidence appears as counts
and query ids only.
