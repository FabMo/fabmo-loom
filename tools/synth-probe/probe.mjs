// Synthetic decline probe — drives Loom's REAL intent layer headlessly
// over a persona prompt set, applies + weaves + verifies each result,
// and records everything to a results JSONL for triage.
//
// Mirrors app/test-live.mjs: same buildParseRequest, same applyActions,
// same runRecipe/verify gate, guests registered like main.js does.
//
// Usage: node probe.mjs [promptsFile] [outFile] [startIndex]
//   promptsFile: .mjs exporting PROMPTS, or a .json array (default ./prompts.mjs)
//   outFile:     results JSONL to append to (default ./results.jsonl)
//
// A prompt row may carry a PICTURE (photo-pick.mjs writes them):
//   photo: { file, media_type, ... }  — file relative to this directory;
//   it rides the request as an image block (the user's prompt text may be
//   empty: Loom then uses its default "Build what is in this picture.").
//   statedSize: [W, H, D]            — the text named a size; the row
//   records sizeHonored = the woven furniture box matches it.
// Photo rows record `furniture` (the woven assemblies' box + panel count)
// and `assumedLine` (the "Assumed:" line the picture rule asks for).

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { FAKE_SVG } from './prompts.mjs';
const HERE = new URL('./', import.meta.url).pathname;
import { makeCallModel, INFRA_OUTCOME } from './model-call.mjs';

const promptsPath = process.argv[2] ?? './prompts.mjs';
const outPath = process.argv[3] ?? './results.jsonl';
const PROMPTS = promptsPath.endsWith('.json')
  ? JSON.parse(readFileSync(new URL(promptsPath, import.meta.url).pathname, 'utf8'))
  : (await import(new URL(promptsPath, import.meta.url).href)).PROMPTS;

const LOOM = '/var/opt/apps/contributors/brian.o/fabmo-loom';
const { EMPTY_RECIPE, runRecipe, controlDefaults } = await import(`${LOOM}/app/runtime.mjs`);
const { runIntentLoop, actionList, DEFAULT_IMAGE_UTTERANCE } = await import(`${LOOM}/app/intent.mjs`);
const { pickExemplars } = await import(`${LOOM}/app/exemplars.mjs`);
// the worked-example index the app retrieves from (exemplars-build.mjs);
// EXEMPLARS=off measures the model without it
const EXEMPLARS = process.env.EXEMPLARS === 'off' || !existsSync(`${LOOM}/app/exemplars.json`)
  ? [] : JSON.parse(readFileSync(`${LOOM}/app/exemplars.json`, 'utf8'));
// LOOP=always|trouble|off — the closed loop is the default; 'off' is the
// pre-loop one-shot behavior, kept so the two can be measured side by side
const LOOP_MODE = ['always', 'trouble', 'off'].includes(process.env.LOOP) ? process.env.LOOP : 'always';
const MODEL = process.env.MODEL || undefined;
const { registerCatalogEntries } = await import(`${LOOM}/app/catalog.mjs`);

// mount the same guests the deployment mounts (guests.local.mjs URLs → paths)
const guests = [
  '/var/opt/apps/contributors/brian.o/furniture_designer_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/braille_sign_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/furniture_compiler/shared/loom-guest.mjs',
];
for (const g of guests) {
  const mod = await import(g);
  const added = registerCatalogEntries(mod.entries);
  console.log(`guest ${g.split('/').slice(-3).join('/')}: registered [${added.join(', ')}]`);
}

const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('no key'); process.exit(1); }

const { FONTS } = await import(`${LOOM}/app/fonts.mjs`);
const FONT_SHELF = {};
for (const f of FONTS) {
  const b = readFileSync(new URL(f.file, `file://${LOOM}/app/`).pathname);
  FONT_SHELF[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const OUT = new URL(outPath, import.meta.url).pathname;

const quiet = (fn) => {
  const orig = console.log, origW = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = orig; console.warn = origW; }
};

function baseRecipe(p) {
  const r = structuredClone(EMPTY_RECIPE);
  if (p.asset === 'svg') {
    r.assets.push({ id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: FAKE_SVG });
  }
  return r;
}

// transport with bounded retries (dropped connection, 429, 5xx) lives in
// model-call.mjs; what still fails after them throws with `infra: true`
const send = makeCallModel({ key, onRetry: (why, attempt) => console.log(`  model call: ${why} — retry ${attempt + 1}`) });
async function callModel(req0) {
  // prompt caching: the system prompt is identical for every EMPTY_RECIPE
  // call — cache it so 50 probes cost like a handful (and the loop's
  // revise calls reuse the same prefix)
  const req = typeof req0.system === 'string'
    ? { ...req0, system: [{ type: 'text', text: req0.system, cache_control: { type: 'ephemeral' } }] }
    : req0;
  return send(req);
}

// synthetic elevation grid for any authored terrain reference (the browser
// resolver can't run in Node; the REFERENCE is what's being probed)
function syntheticGrids(recipe) {
  const grids = {};
  for (const t of recipe.terrains ?? []) {
    const cols = 200, rows = 150, elev = new Float32Array(cols * rows);
    for (let i = 0; i < elev.length; i++)
      elev[i] = 1500 + 600 * Math.sin((i % cols) / 17) * Math.sin(Math.floor(i / cols) / 13);
    grids[t.id] = { grid: { elev, cols, rows }, meta: { name: 'fixture', center: { lat: 36.1, lng: -112.1 }, min: 900, max: 2100 } };
  }
  return grids;
}

// the picture, as the browser would send it: an image block, bytes never
// recorded anywhere but the request (the row keeps the file name + credit)
function loadImage(p) {
  if (!p.photo?.file) return null;
  const path = p.photo.file.startsWith('/') ? p.photo.file : `${HERE}${p.photo.file}`;
  return { media_type: p.photo.media_type ?? 'image/jpeg', data: readFileSync(path).toString('base64') };
}
// the woven furniture box honors the size the TEXT stated (the picture
// rule: pictures decide proportion, text decides numbers)
const sizeHonored = (stated, box) => Array.isArray(stated) && Array.isArray(box) && box.length === 3
  && stated.every((v, i) => Math.abs(box[i] - v) <= Math.max(0.5, 0.02 * v));

async function probe(p) {
  const image = loadImage(p);
  const rec = { id: p.id, persona: p.persona, prior: p.prior, prompt: p.prompt || (image ? DEFAULT_IMAGE_UTTERANCE : p.prompt) };
  if (p.photo) rec.photo = { ...p.photo };
  if (p.statedSize) rec.statedSize = p.statedSize;
  const recipe = baseRecipe(p);
  rec.context = structuredClone(recipe);   // the starting document — makes the row a self-contained corpus candidate
  try {
    const t0 = Date.now();
    const weaveRec = (r) => quiet(() => runRecipe(r, controlDefaults(r), FONT_SHELF, syntheticGrids(r)));
    let out;
    // worked examples exactly as the app retrieves them — minus this very
    // prompt, so a re-probe is never handed its own previous answer
    const exemplars = EXEMPLARS.length
      ? pickExemplars(EXEMPLARS, p.prompt || DEFAULT_IMAGE_UTTERANCE, { hasImage: !!image, exclude: [p.prompt, p.id] }) : [];
    rec.exemplars = exemplars.map(e => e.key);
    try {
      out = await runIntentLoop({
        recipe, utterance: p.prompt, model: MODEL, mode: LOOP_MODE, image, exemplars,
        call: callModel,
        weave: async (r) => weaveRec(r),
      });
    } catch (e) {
      if (e?.name === 'IntentError' || e?.retryable !== undefined) {
        rec.ms = Date.now() - t0;
        rec.outcome = /no actions/.test(e.message) ? 'NO_TOOL_USE' : /overran/.test(e.message) ? 'TRUNCATED' : 'EMPTY';
        rec.error = e.message;
        return rec;
      }
      throw e;
    }
    rec.ms = Date.now() - t0;
    rec.usage = out.usage;
    const first = out.turns[0];
    rec.stop_reason = null;
    // summary = what the user READS (final); firstSummary = what the model
    // said before it saw the weave — the pair is the overclaim measurement
    rec.summary = out.summary;
    rec.firstSummary = out.firstSummary;
    rec.declined = out.declined;
    rec.actionKinds = actionList(first.payload).map(a => a.kind + (a.operation?.strategy ? `:${a.operation.strategy}` : ''));
    rec.rawActions = first.payload.actions ?? [];   // RAW on purpose: a malformed shape is corpus evidence
    rec.revisedActions = out.turns.slice(1).flatMap(t => t.payload.actions ?? []);
    rec.loop = {
      mode: LOOP_MODE, turns: out.turns.length, fixes: out.fixes, rolledBack: out.rolledBack ?? null,
      claimIssues: (out.claimIssues ?? []).map(i => i.code), claimsCaught: !!out.claimsCaught,
      claimsRefusedDuring: out.turns.flatMap(t => (t.observation?.claimIssues ?? []).map(i => i.code)),
      summaryChanged: out.revised && out.summary.trim() !== out.firstSummary.trim(),
      perTurn: out.turns.map(t => ({
        actions: actionList(t.payload).length, applied: t.applied.length, skipped: t.skipped.length,
        ok: t.observation ? t.observation.ok : null, pipeline: t.observation ? t.observation.pipeline.length : null,
      })),
    };
    rec.applied = out.turns.flatMap(t => t.applied);
    rec.skipped = out.turns[out.turns.length - 1].skipped;
    rec.firstSkipped = first.skipped;

    const drawShapes = (out.recipe.shapes ?? []).filter(s => s.draw).map(s => s.id);
    if (drawShapes.length) rec.awaitingDraw = drawShapes;

    try {
      const r = weaveRec(out.recipe);
      rec.verified = !!r.ok;
      rec.weaveErrors = r.errors ?? [];
      rec.weaveWarnings = (r.warnings ?? []).slice(0, 6);
      rec.hasSbp = !!r.sbp;
      rec.pipeline = out.recipe.pipeline.map(o => o.strategy);
      // flat-panel furniture reports its assembled box + panel count — the
      // photo lane's deterministic measurements ride on it
      const assemblies = (r.preview?.assemblies ?? []).filter(a => Array.isArray(a.box));
      if (assemblies.length) rec.furniture = assemblies.map(a => ({ box: a.box.map(v => +(+v).toFixed(3)), panels: a.panels?.length ?? 0 }));
      if (rec.statedSize) rec.sizeHonored = assemblies.some(a => sizeHonored(rec.statedSize, a.box));
      if (image) rec.assumedLine = (out.summary ?? '').match(/assumed:[^\n]*/i)?.[0]?.slice(0, 300) ?? null;
    } catch (e) {
      rec.outcome = 'WEAVE_CRASH'; rec.error = String(e?.stack ?? e).slice(0, 800); return rec;
    }

    rec.outcome =
      rec.declined.length && rec.actionKinds.length ? 'PARTIAL' :
      rec.declined.length ? 'DECLINED' :
      rec.skipped.length && !rec.applied.length ? 'ALL_SKIPPED' :
      rec.verified ? 'FULFILLED' : 'FULFILLED_UNVERIFIED';
    return rec;
  } catch (e) {
    // infra = the network/API gave out after bounded retries — the prompt
    // never got a fair run, so the row must not read as a Loom failure
    if (e?.infra) { rec.outcome = INFRA_OUTCOME; rec.infra = true; rec.error = String(e.message).slice(0, 500); return rec; }
    rec.outcome = 'ERROR'; rec.error = String(e?.stack ?? e).slice(0, 500);
    return rec;
  }
}

const start = parseInt(process.argv[4] ?? '0', 10);
const todo = PROMPTS.slice(start);
console.log(`probing ${todo.length} prompts → ${OUT} (loop: ${LOOP_MODE}${MODEL ? `, model ${MODEL}` : ''})`);

// warmup call first so the cached system prompt is written once
const CONCURRENCY = 4;
let done = 0, infraStreak = 0, aborted = false;
const record = (r) => {
  appendFileSync(OUT, JSON.stringify(r) + '\n');
  done++;
  // PROBE.md guardrail: 3 consecutive API failures abort the batch
  infraStreak = r.infra ? infraStreak + 1 : 0;
  if (infraStreak >= 3 && !aborted) { aborted = true; console.log('3 consecutive model calls failed — aborting the batch (infrastructure)'); }
  const flag = (r.photo ? ' [photo]' : '') + (r.statedSize ? (r.sizeHonored ? ' size ✓' : ' size ✗') : '') + (r.infra ? ' (network/API — not a Loom result)'
    : r.prior === 'covered' && /DECLINED|PARTIAL|ALL_SKIPPED|CRASH|ERROR/.test(r.outcome) ? ' ⚠ prior-miss'
    : r.prior === 'decline' && r.outcome === 'FULFILLED' ? ' ✓ better-than-expected' : '');
  const loop = r.loop ? ` [${r.loop.turns} call${r.loop.turns === 1 ? '' : 's'}${r.loop.fixes ? `, ${r.loop.fixes} fixes` : ''}${r.loop.summaryChanged ? ', summary revised' : ''}]` : '';
  console.log(`[${done}/${todo.length}] ${r.id}: ${r.outcome}${r.verified === false ? ' (verify FAIL)' : ''}${flag}${loop}`);
};

record(await probe(todo[0]));
const rest = todo.slice(1);
let idx = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < rest.length && !aborted) {
    const p = rest[idx++];
    record(await probe(p));
  }
}));

console.log(aborted ? `aborted after ${done}/${todo.length}${done < todo.length ? ' — remaining prompts not probed' : ''}` : 'done');
