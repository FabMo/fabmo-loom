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

4. **Probe live (~$3):**
   `node probe.mjs ./runs/YYYY-MM-DD-prompts.json ./runs/YYYY-MM-DD-results.jsonl`

5. **Triage.** For every non-FULFILLED row (and every FULFILLED row
   whose prior said decline — possible overclaim: read the summary
   against the pipeline and judge whether the fulfillment is REAL):
   classify against ledger.md; increment counts; open new classes as
   needed. Watch specifically for the semantic-overclaim pattern — a
   confident summary the pipeline doesn't back.

6. **Grow the corpus:**
   `node corpus-add.mjs ./runs/YYYY-MM-DD-results.jsonl YYYY-MM-DD`
   `node corpus-add.mjs ./runs/funnel-YYYY-MM-DD.jsonl funnel-YYYY-MM-DD`
   (second one only when a funnel file was written)

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
- Spend target ≈ $3–5/night on the shop key. If a batch would exceed
  ~$10, stop and note it instead.

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
