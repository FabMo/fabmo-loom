// The nightly Loom improvement probe — PROBE.md's procedure as a
// self-contained script (system cron runs it; no interactive session).
// The two LLM stages (batch generation, failure triage) call the API
// directly with the shop key; everything else is deterministic.
//
// Measure aggressively, convert conservatively: this script NEVER edits
// app code, prompt rules, or the catalog. Output = runs/ artifacts, a
// run-log line in ledger.md, and runs/ATTENTION-<date>.md when a human
// should look (new class, regression, broken infra).
//
// Usage: node nightly.mjs [--dry] [--no-photos]   (--dry: generate + pick, skip live probes)
//        node nightly.mjs --retriage YYYY-MM-DD
//        node nightly.mjs --photos-only
//   --retriage: backfill a night whose probe ran but whose triage never
//   landed — reads that day's saved runs/<day>-results.jsonl and does only
//   triage → corpus-add → run-log line (no corpus check, generation, or probes)
//   --photos-only: just the picture lane (pick → probe → judge → ledger
//   line), for attended checks of the lane; --no-photos skips it.
//
// The picture lane (2026-10-18): photo-pick.mjs gathers a few furniture
// photos (Wikimedia Commons categories + photos.local/), probe.mjs sends
// each through Loom as an attached picture, and a vision judge (the meta
// model, which sees the photo) scores how faithfully the build matches it.
// Its rows join triage and the corpus like any other; the run-log line
// carries its own tallies (outcomes, fidelity, size honored, Assumed line).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isInfraRow, INFRA_OUTCOME } from './model-call.mjs';

const HERE = new URL('./', import.meta.url).pathname;
const RUNS = `${HERE}runs/`;
const retriageAt = process.argv.indexOf('--retriage');
const retriage = retriageAt > 0 ? process.argv[retriageAt + 1] : null;
if (retriageAt > 0 && !/^\d{4}-\d\d-\d\d$/.test(retriage ?? '')) { console.error('usage: node nightly.mjs --retriage YYYY-MM-DD'); process.exit(1); }
const DAY = retriage ?? new Date().toISOString().slice(0, 10);
const dry = process.argv.includes('--dry');
const noPhotos = process.argv.includes('--no-photos');
const photosOnly = process.argv.includes('--photos-only');
mkdirSync(RUNS, { recursive: true });

const log = (m) => console.log(`[nightly ${new Date().toISOString().slice(11, 19)}] ${m}`);
const attention = [];
let results, tri, priorMisses = [], infraRows = [];
let tally = {};
let photoRows = [], photoTally = {}, judge = null;   // the picture lane
let funnelRows = [], funnelDeclines = [];   // declared up here: finish() can run before the funnel pull
// broken infra must never be silent: any crash still writes the run-log
// line and an ATTENTION file (a thrown fetch once killed four nights of
// triage with nothing but a stack trace in nightly.log)
let crashing = false;
process.on('uncaughtException', (e) => {
  console.error(e);
  if (crashing) process.exit(1);
  crashing = true;
  attention.push(`nightly CRASHED — ${String(e?.stack ?? e).slice(0, 600)}`);
  finish('crashed — see ATTENTION file');
});
// a trailing { timeout } object sets the step's own limit (default 30 min);
// timedOut is reported separately — a slow step is not a failed step
const runNode = (script, ...args) => {
  const opts = typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const r = spawnSync('node', [script, ...args], { cwd: HERE, encoding: 'utf8', timeout: opts.timeout ?? 30 * 60_000 });
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM');
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), timedOut };
};

const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('no shop key — aborting'); process.exit(1); }

let spendIn = 0, spendOut = 0;
async function llm(system, user, maxTokens = 4000) {
  const pause = (attempt) => new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
  let lastErr = 'API retries exhausted';
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        // connection: close — runNode() is spawnSync, which blocks the event
        // loop for the whole live probe; a kept-alive socket goes stale behind
        // it and the next call dies with "other side closed" / EPIPE
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', connection: 'close' },
        // the META model (prompt generation + triage) stays on Opus 4.8 so the
        // nightly series keeps one judge; the intent layer under test uses the
        // app's own default (intent.mjs DEFAULT_MODEL, Opus 5.5 since v0.78)
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
    } catch (e) {
      // a thrown fetch is a transport failure (stale socket, reset) — retry it
      lastErr = `fetch failed: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}`;
      log(`llm: ${lastErr} — retrying`);
      await pause(attempt); continue;
    }
    if (res.status === 429 || res.status >= 500) { lastErr = `API ${res.status}`; await pause(attempt); continue; }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    spendIn += data.usage?.input_tokens ?? 0; spendOut += data.usage?.output_tokens ?? 0;
    return data.content.find(b => b.type === 'text')?.text ?? '';
  }
  throw new Error(lastErr);
}
// tolerate fences and preambles: parse from the first bracket to the last
const parseJson = (text) => {
  const open = text.search(/[[{]/);
  const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(text.slice(open, close + 1));
};

// ---- 1. corpus regression check (free) — a fail stops the night ------
// A TIMEOUT is not a regression: 2026-10-11..17 the check outgrew the
// 30-minute window (900+ rows at ~2 s each) and seven nights were skipped
// as "regressions" with an empty attention note. test-corpus.mjs now shards
// across workers; a timeout still gets its own note and the night goes on.
if (!retriage && !photosOnly) {
  log('corpus regression check…');
  const corpus = runNode('test-corpus.mjs', { timeout: 55 * 60_000 });
  if (corpus.timedOut) {
    attention.push(`corpus check TIMED OUT after 55 min — not a regression (nothing was judged); the corpus has outgrown the window: shard wider or raise the limit. Live probes ran.`);
    log('corpus check timed out — continuing');
  } else if (corpus.code !== 0) {
    const lines = corpus.out.split('\n').filter(l => l.includes('REGRESSION'));
    attention.push(`CORPUS REGRESSION — a commit broke handling of recorded model responses:\n${lines.join('\n') || `(no REGRESSION lines — the check exited ${corpus.code}; tail:)\n${corpus.out.slice(-600)}`}`);
    finish('corpus regression — live probes skipped');
  } else log(corpus.out.trim().split('\n').pop());
}

// ---- 2. real stream ---------------------------------------------------
if (!retriage && !photosOnly) {
  log('funnel pull…');
  const funnel = runNode('funnel-pull.mjs');
  log(funnel.out.trim().split('\n').filter(l => l.startsWith('[funnel]')).join(' | '));
}
const funnelFile = `${RUNS}funnel-${DAY}.jsonl`;
funnelRows = existsSync(funnelFile)
  ? readFileSync(funnelFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
funnelDeclines = funnelRows.filter(r => r.declined?.length);

// ---- 3. generate tonight's batch --------------------------------------
const ledger = readFileSync(`${HERE}ledger.md`, 'utf8');
const probeDoc = readFileSync(`${HERE}PROBE.md`, 'utf8');
const WHEEL = ['signage & wayfinding', 'gifts & keepsakes', 'kitchen & serving', 'furniture & storage', 'shop jigs & fixtures',
  'games & puzzles', 'musical instruments', 'electronics & enclosures', 'outdoor & garden', 'holiday & seasonal',
  'small-business fixtures', 'school & education', 'cosplay & props', 'maps & terrain', 'decorative patterns & texture',
  'kids & toys', 'pets', 'sports & recreation'];
const resultsFile = `${RUNS}${DAY}-results.jsonl`;
// ---- 3b. the picture lane: tonight's photos (free; network) --------------
const photoPromptsFile = `${RUNS}${DAY}-photo-prompts.json`;
const photoResultsFile = `${RUNS}${DAY}-photo-results.jsonl`;
let photoPrompts = [];
function pickPhotos() {
  log('picking tonight\'s pictures…');
  const pick = runNode('photo-pick.mjs', DAY, { timeout: 5 * 60_000 });
  const line = pick.out.split('\n').find(l => l.startsWith('[photos]')) ?? pick.out.trim().slice(-300);
  log(line);
  photoPrompts = existsSync(photoPromptsFile) ? JSON.parse(readFileSync(photoPromptsFile, 'utf8')) : [];
  if (!photoPrompts.length) attention.push(`picture lane picked NO photos (Commons unreachable? photos.local empty?): ${line.slice(0, 300)}`);
}
if (retriage) {
  if (!existsSync(resultsFile) && !existsSync(photoResultsFile)) { console.error(`no ${resultsFile} to retriage`); process.exit(1); }
  log(`retriage ${DAY}: saved probe results, triage + corpus-add only`);
} else if (photosOnly) {
  log('photos only: the picture lane alone');
  pickPhotos();
  if (dry) finish('dry run — no live probes');
} else {
  const doy = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + '-01-01')) / 86400e3);
  const cats = Array.from({ length: 5 }, (_, i) => WHEEL[(doy * 5 + i) % WHEEL.length]);
  log(`generating 25 prompts in: ${cats.join(' · ')}`);

  const genText = await llm(
    `You generate synthetic user prompts to probe a CNC/CAM "prompt-to-app" tool (Loom). Follow the generation rules in the PROBE.md excerpt. Output ONLY a JSON array, no fences, of {"id","persona","prior","prompt","note"} — id kebab-case unique, prior one of covered|decline|unsure (your honest prediction), note = one line on what the prompt probes.`,
    `PROBE.md (generation rules — step 3):\n${probeDoc}\n\nCurrent failure-class ledger (for regression re-asks and to avoid re-probing the known-by-design):\n${ledger}\n\nTonight's categories (5 prompts each): ${cats.join(', ')}.\nGenerate the 25 prompts now.`,
    6000);
  let prompts;
  try {
    prompts = parseJson(genText).filter(p => p?.id && p?.prompt && p?.prior);
  } catch (e) {
    attention.push(`generation output unparseable: ${String(e).slice(0, 120)}`);
    finish('generation failed');
  }
  if (prompts.length < 15) { attention.push(`generation produced only ${prompts.length} prompts`); finish('generation too small'); }
  const promptsFile = `${RUNS}${DAY}-prompts.json`;
  writeFileSync(promptsFile, JSON.stringify(prompts, null, 1));
  log(`${prompts.length} prompts → ${promptsFile}`);
  if (!noPhotos) pickPhotos();
  if (dry) finish('dry run — no live probes');

  // ---- 4. probe live -----------------------------------------------------
  writeFileSync(resultsFile, '');   // fresh file — a re-run the same day must not mix batches
  log('probing live…');
  const probe = runNode('probe.mjs', `./runs/${DAY}-prompts.json`, `./runs/${DAY}-results.jsonl`);
  if (!existsSync(resultsFile)) { attention.push(`probe produced no results:\n${probe.out.slice(-400)}`); finish('probe failed'); }
}
// ---- 4b. probe the pictures ----------------------------------------------
if (!retriage && photoPrompts.length) {
  writeFileSync(photoResultsFile, '');
  log(`probing ${photoPrompts.length} pictures…`);
  const pp = runNode('probe.mjs', `./runs/${DAY}-photo-prompts.json`, `./runs/${DAY}-photo-results.jsonl`);
  if (!existsSync(photoResultsFile) || !readFileSync(photoResultsFile, 'utf8').trim()) attention.push(`photo probe produced no results:\n${pp.out.slice(-400)}`);
}
results = (photosOnly || !existsSync(resultsFile)) ? [] : readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
photoRows = existsSync(photoResultsFile) ? readFileSync(photoResultsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
// infra rows = the network/API gave out after the probe's bounded retries
// (INFRA_ERROR; isInfraRow also recognizes the pre-marker "fetch failed"
// ERROR rows so a --retriage of an old night gets the same treatment).
// They are probe infrastructure, never Loom evidence: counted here, kept out
// of triage, prior-misses and the corpus. Picture rows are judged alongside.
const allRows = [...results, ...photoRows];
infraRows = allRows.filter(isInfraRow);
const infraIds = new Set(infraRows.map(r => r.id));
const loomRows = allRows.filter(r => !infraIds.has(r.id));
if (photoRows.length && photoRows.every(r => infraIds.has(r.id))) attention.push(`picture lane: every photo row was a network/API failure`);
const errors = loomRows.filter(r => r.outcome === 'ERROR').length + infraRows.length;
if (errors >= 3) attention.push(`${errors} probe rows ERRORED${infraRows.length ? ` (${infraRows.length} network/API after retries: ${infraRows.map(r => r.id).join(', ')})` : ''} — infrastructure suspect`);

// ---- 5. triage ----------------------------------------------------------
tally = {};
for (const r of results) { const k = infraIds.has(r.id) ? INFRA_OUTCOME : r.outcome; tally[k] = (tally[k] ?? 0) + 1; }
photoTally = {};
for (const r of photoRows) { const k = infraIds.has(r.id) ? INFRA_OUTCOME : r.outcome; photoTally[k] = (photoTally[k] ?? 0) + 1; }
priorMisses = loomRows.filter(r =>
  (r.prior === 'covered' && !/FULFILLED/.test(r.outcome ?? '')) ||
  (r.prior === 'decline' && r.outcome === 'FULFILLED'));
const compact = loomRows.map(r => ({
  id: r.id, prior: r.prior, outcome: r.outcome, verified: r.verified,
  prompt: r.prompt, summary: (r.summary ?? '').slice(0, 300),
  firstSummary: r.firstSummary && r.firstSummary !== r.summary ? r.firstSummary.slice(0, 300) : undefined,
  loop: r.loop ? { turns: r.loop.turns, fixes: r.loop.fixes, claimIssues: r.loop.claimIssues?.length ? r.loop.claimIssues : undefined, claimsCaught: r.loop.claimsCaught || undefined, rolledBack: r.loop.rolledBack ? `to turn ${r.loop.rolledBack.toTurn}: ${(r.loop.rolledBack.error ?? '').slice(0, 120)}` : undefined } : undefined,
  pipeline: r.pipeline, skipped: (r.skipped ?? []).slice(0, 4),
  weaveErrors: (r.weaveErrors ?? []).slice(0, 3),
  declined: (r.declined ?? []).map(d => ({ what: d.what, why: (d.why ?? '').slice(0, 200) })),
  // picture rows: what the picture was (by title — the triage model does
  // not see it; the vision judge does) and the lane's deterministic checks
  ...(r.photo ? { photo: r.photo.title, statedSize: r.statedSize, sizeHonored: r.sizeHonored, furniture: r.furniture, assumedLine: r.assumedLine } : {}),
}));
log('triaging…');
let triText = '';
// nothing but infra rows and no funnel declines = nothing to judge: skip the call
const nothingToTriage = !compact.length && !funnelDeclines.length;
try { if (!nothingToTriage) triText = await llm(
  `You triage probe results for the Loom improvement loop against its failure-class ledger. Rules: classify every non-clean row (declines, verify failures, skips, crashes) to an existing ledger class id when one fits; propose a NEW class only when nothing fits. Separately flag OVERCLAIMS: rows whose FINAL summary confidently claims something their pipeline/actions cannot deliver (the verifier cannot catch these — judge summary against pipeline). Rows may also carry firstSummary — what the model said BEFORE it saw the weave result; when firstSummary overclaimed and the final summary is honest, list the row under caughtByLoop instead of overclaims. Rows may carry loop.claimIssues (semantic claims the app refused and corrected deterministically in the final text/declines) — those are NOT overclaims; list them under caughtByClaims. By-design declines that declined correctly are "working-as-intended", not findings. Rows with a "photo" field came from a PICTURE of furniture (named by title; you do not see it — a separate vision judge scores likeness): classify their declines and failures exactly like text rows; a statedSize with sizeHonored:false is an authoring failure (the text's numbers were not used). Output ONLY JSON, no fences: {"classified":[{"id","class","evidence":"one line"}], "newClasses":[{"id","section":"capability|authoring|overclaim|robustness","description","examples":["prompt-id"]}], "overclaims":[{"id","claim","reality"}], "caughtByLoop":[{"id","claim"}], "caughtByClaims":[{"id","claim"}], "shippedRegressions":[{"id","class"}], "runNote":"one sentence"}`,
  `LEDGER:\n${ledger}\n\nTONIGHT'S RESULTS (${compact.length} rows${infraRows.length ? `; ${infraRows.length} more omitted — the probe's network/API call failed, they say nothing about Loom` : ''}):\n${JSON.stringify(compact, null, 1)}\n\nNEW FUNNEL DECLINES (real users — priority):\n${JSON.stringify(funnelDeclines.map(r => ({ id: r.id, utterance: (r.utterance ?? '').slice(0, 200), declined: r.declined })), null, 1)}`,
  4000); }
catch (e) { attention.push(`triage call failed (${String(e?.message ?? e).slice(0, 160)}) — rows still added to the corpus; backfill with: node nightly.mjs --retriage ${DAY}`); }
tri = { classified: [], newClasses: [], overclaims: [], caughtByLoop: [], shippedRegressions: [], runNote: 'triage unparseable' };
try { tri = { ...tri, ...parseJson(triText) }; }
catch { if (triText) { attention.push('triage output unparseable — raw saved to runs/'); writeFileSync(`${RUNS}${DAY}-triage-raw.txt`, triText); } else tri.runNote = nothingToTriage ? 'no Loom rows to triage — every probe row was a network/API failure' : 'triage call failed'; }
// belt and braces: an infra row can never be evidence, a new class, an
// overclaim or a SHIPPED regression, whatever the triage model returned
if (infraIds.size) {
  const keep = (x) => !infraIds.has(typeof x === 'string' ? x : x?.id);
  for (const k of ['classified', 'overclaims', 'caughtByLoop', 'caughtByClaims', 'shippedRegressions'])
    if (Array.isArray(tri[k])) tri[k] = tri[k].filter(keep);
  if (Array.isArray(tri.newClasses)) tri.newClasses = tri.newClasses
    .map(c => Array.isArray(c?.examples) && c.examples.length ? { ...c, examples: c.examples.filter(keep), _had: true } : c)
    .filter(c => !(c?._had && !c.examples.length))
    .map(({ _had, ...c }) => c);
  tri.infraErrors = infraRows.map(r => ({ id: r.id, error: String(r.error ?? '').split('\n')[0].slice(0, 160) }));
}
writeFileSync(`${RUNS}${DAY}-triage.json`, JSON.stringify(tri, null, 1));

// ---- 5b. picture fidelity: the judge SEES the photo ---------------------------
// The text triage cannot know whether "a 5-bay cube shelf" is what the
// picture shows. The meta model gets the photo plus the factual record of
// the build and scores likeness; its verdicts ride in runs/<day>-photo-judge.json
// and the run-log line. Nothing here edits app code or the ledger classes.
const JUDGE_SYSTEM = `You judge how faithfully a CNC prompt-to-app tool (Loom) reproduced the piece of furniture in the attached picture as FLAT-PANEL furniture (plywood panels with derived joinery). You see the picture and a factual record of what was built: the summary the user read, the pipeline (which verbs ran), the woven furniture box in inches [W,H,D] and panel count when furniture was built, what was declined, and the text the user typed (empty = the picture alone). Rules: "subject" = "flat-panel" when the picture's main subject is furniture flat panels can reproduce (shelves, bookcases, cabinets, benches, boxes, crates, tables and desks with panel legs); "other-furniture" when it is furniture that needs curves, turned legs, upholstery, frames or carving to be itself; "not-furniture" otherwise. "fidelity" 0-3 judged against the picture: 3 = the build IS the piece (same structure, same bay/shelf/drawer count, proportions right); 2 = the right kind with one structural miss (a shelf short, a back added without the picture showing one, bay count off by one); 1 = recognizably related but structurally wrong; 0 = unrelated, or nothing built. For other-furniture and not-furniture pictures the right behaviour is an honest, clearly-stated reinterpretation or decline — "honestDecline" true when the summary/declines say plainly what could not be reproduced, false when the build is passed off as the piece, null for flat-panel subjects. "additions" = parts the build has that the picture does not show (a back panel, a stretcher). "assumedOk" = the summary ends with an "Assumed:" line naming the guessed numbers/parts (false if missing or vague). If the text stated a size, "sizeHonored" is already measured — do not re-judge it. Output ONLY JSON, no fences: {"subject":"flat-panel|other-furniture|not-furniture","fidelity":0-3,"matches":["..."],"missing":["..."],"wrong":["..."],"additions":["..."],"assumedOk":true|false,"honestDecline":true|false|null,"note":"one line"}`;
const photoLoom = photoRows.filter(r => !infraIds.has(r.id) && r.photo?.file);
if (photoLoom.length) {
  log(`judging ${photoLoom.length} pictures…`);
  judge = { day: DAY, rows: [] };
  for (const r of photoLoom) {
    const path = r.photo.file.startsWith('/') ? r.photo.file : `${HERE}${r.photo.file}`;
    if (!existsSync(path)) { judge.rows.push({ id: r.id, title: r.photo.title, error: 'photo file missing' }); continue; }
    const image = { type: 'image', source: { type: 'base64', media_type: r.photo.media_type ?? 'image/jpeg', data: readFileSync(path).toString('base64') } };
    const facts = {
      typed: r.prompt, outcome: r.outcome, verified: r.verified, pipeline: r.pipeline,
      summary: (r.summary ?? '').slice(0, 1500), declined: (r.declined ?? []).map(d => d.what),
      furniture: r.furniture, statedSize: r.statedSize, sizeHonored: r.sizeHonored,
    };
    try {
      const text = await llm(JUDGE_SYSTEM, [image, { type: 'text', text: `WHAT LOOM BUILT FROM THIS PICTURE:\n${JSON.stringify(facts, null, 1)}` }], 1200);
      judge.rows.push({ id: r.id, title: r.photo.title, outcome: r.outcome, ...parseJson(text) });
    } catch (e) { judge.rows.push({ id: r.id, title: r.photo.title, outcome: r.outcome, error: String(e?.message ?? e).slice(0, 200) }); }
  }
  writeFileSync(`${RUNS}${DAY}-photo-judge.json`, JSON.stringify(judge, null, 1));
  const fp = judge.rows.filter(j => j.subject === 'flat-panel');
  const low = fp.filter(j => j.fidelity <= 1);
  log(`judge: ${fp.length} flat-panel subject${fp.length === 1 ? '' : 's'}${fp.length ? `, fidelity ${(fp.reduce((s, j) => s + (j.fidelity ?? 0), 0) / fp.length).toFixed(1)}/3` : ''}${low.length ? `, low: ${low.map(j => j.id).join(', ')}` : ''}`);
}

if (tri.newClasses?.length) attention.push(`NEW failure class(es): ${tri.newClasses.map(c => `${c.id} — ${c.description}`).join('; ')}`);
if (tri.shippedRegressions?.length) attention.push(`SHIPPED-class regression: ${tri.shippedRegressions.map(s => s.id).join(', ')}`);

// ---- 6. grow the corpus --------------------------------------------------
if (results.length) log(runNode('corpus-add.mjs', `./runs/${DAY}-results.jsonl`, DAY).out.trim().replace('\n', ' | '));
if (photoRows.length) log(runNode('corpus-add.mjs', `./runs/${DAY}-photo-results.jsonl`, `${DAY}-photo`).out.trim().replace('\n', ' | '));
if (funnelRows.length) log(runNode('corpus-add.mjs', `./runs/funnel-${DAY}.jsonl`, `funnel-${DAY}`).out.trim().replace('\n', ' | '));
// the worked-example index the app and the probe retrieve from grows with the corpus
try { log(runNode('exemplars-build.mjs').out.trim().split('\n')[0]); }
catch (e) { log(`exemplars-build skipped: ${String(e?.message ?? e).slice(0, 120)}`); }

// ---- 6b. refresh the fix-prompt queue (deterministic, no model call) ------
// Still measurement: autoprompt.mjs only writes briefs under runs/fix-prompts/
// for an attended session to execute. It never touches app code.
try { log(runNode('autoprompt.mjs').out.trim().split('\n').pop()); }
catch (e) { log(`autoprompt skipped: ${String(e?.message ?? e).slice(0, 120)}`); }

finish(tri.runNote);

// ---- 7+8. run log + attention ---------------------------------------------
function finish(note) {
  // meta calls at Opus 4.8 rates ($5/$25 per MTok); probe rows at the app
  // default's rates (Opus 5.5: $4 / $20, cache read $0.20, cache write $5)
  const cost = (spendIn * 5e-6 + spendOut * 25e-6
    + [...(results ?? []), ...photoRows].reduce((s, r) => s + (r.usage?.input_tokens ?? 0) * 4e-6 + (r.usage?.output_tokens ?? 0) * 20e-6 + (r.usage?.cache_read_input_tokens ?? 0) * 0.2e-6 + (r.usage?.cache_creation_input_tokens ?? 0) * 5e-6, 0)).toFixed(2);
  const outcomes = Object.keys(tally).length
    ? Object.entries(tally).map(([k, v]) => `${v} ${k}${k === INFRA_OUTCOME ? ' (network/API after retries — not Loom)' : ''}`).join(', ') : 'no probes';
  const evidence = tri?.classified?.length
    ? '; evidence: ' + Object.entries(tri.classified.reduce((m, c) => ((m[c.class] = (m[c.class] ?? 0) + 1), m), {})).map(([c, n]) => `${c} +${n}`).join(', ')
    : '';
  const misses = priorMisses.length ? `; ${priorMisses.length} prior-miss (${priorMisses.map(r => r.id).join(', ')})` : '';
  const over = tri?.overclaims?.length ? `; OVERCLAIMS: ${tri.overclaims.map(o => o.id).join(', ')}` : '';
  // the picture lane's own line: outcomes, the judge's likeness score on
  // flat-panel subjects, the deterministic size check, the Assumed line
  let photoLine = '';
  if (photoRows.length) {
    const live = photoRows.filter(r => !isInfraRow(r));
    const sized = live.filter(r => Array.isArray(r.statedSize));
    const fp = (judge?.rows ?? []).filter(j => j.subject === 'flat-panel');
    const fpFul = fp.filter(j => j.outcome === 'FULFILLED').length;
    const fid = fp.length ? (fp.reduce((s, j) => s + (j.fidelity ?? 0), 0) / fp.length).toFixed(1) : null;
    const honest = (judge?.rows ?? []).filter(j => j.subject && j.subject !== 'flat-panel');
    photoLine = `; photos: ${photoRows.length} (${Object.entries(photoTally).map(([k, v]) => `${v} ${k}`).join(', ')}`
      + (judge ? `; ${fp.length} flat-panel subject${fp.length === 1 ? '' : 's'}${fp.length ? `: ${fpFul} FULFILLED, fidelity ${fid}/3` : ''}${honest.length ? `; ${honest.filter(j => j.honestDecline).length}/${honest.length} non-panel pictures handled honestly` : ''}` : '')
      + (sized.length ? `; size honored ${sized.filter(r => r.sizeHonored).length}/${sized.length}` : '')
      + (live.length ? `; Assumed line ${live.filter(r => r.assumedLine).length}/${live.length}` : '') + ')';
  }
  const looped = (results ?? []).filter(r => r.loop);
  const loopLine = looped.length
    ? `; loop: ${looped.filter(r => r.loop.turns > 1).length}/${looped.length} took a second look, ${looped.reduce((n, r) => n + (r.loop.fixes || 0), 0)} corrections, ${looped.filter(r => r.loop.summaryChanged).length} summaries revised${looped.some(r => r.loop.rolledBack) ? `, ${looped.filter(r => r.loop.rolledBack).length} rolled back to a verified turn` : ''}${looped.some(r => r.loop.claimsCaught || r.loop.claimIssues?.length) ? `, claims: ${looped.filter(r => r.loop.claimsCaught).length} fixed on the second look + ${looped.filter(r => r.loop.claimIssues?.length).length} corrected in the final text` : ''}${tri?.caughtByLoop?.length ? `, ${tri.caughtByLoop.length} overclaim${tri.caughtByLoop.length === 1 ? '' : 's'} caught by the loop` : ''}`
    : '';
  appendFileSync(`${HERE}ledger.md`,
    `- ${DAY} — nightly${retriage ? ` (triage backfilled ${new Date().toISOString().slice(0, 10)})` : ''}${photosOnly ? ' (photos only)' : ''}: ${outcomes}${misses}${evidence}${over}${loopLine}${photoLine}; funnel +${funnelRows.length} (${funnelDeclines.length} declined); $${cost}; ${note}${attention.length ? ' ⚠ SEE ATTENTION FILE' : ''}\n`);
  if (attention.length) {
    writeFileSync(`${RUNS}ATTENTION-${DAY}.md`, `# Probe attention — ${DAY}\n\n${attention.map(a => `- ${a}`).join('\n\n')}\n`);
    log(`ATTENTION → runs/ATTENTION-${DAY}.md`);
  }
  log(`done: ${outcomes}; $${cost}; ${note}`);
  process.exit(attention.length ? 2 : 0);
}
