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

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { FAKE_SVG } from './prompts.mjs';

const promptsPath = process.argv[2] ?? './prompts.mjs';
const outPath = process.argv[3] ?? './results.jsonl';
const PROMPTS = promptsPath.endsWith('.json')
  ? JSON.parse(readFileSync(new URL(promptsPath, import.meta.url).pathname, 'utf8'))
  : (await import(new URL(promptsPath, import.meta.url).href)).PROMPTS;

const LOOM = '/var/opt/apps/contributors/brian.o/fabmo-loom';
const { EMPTY_RECIPE, runRecipe, controlDefaults } = await import(`${LOOM}/app/runtime.mjs`);
const { runIntentLoop } = await import(`${LOOM}/app/intent.mjs`);
// LOOP=always|trouble|off — the closed loop is the default; 'off' is the
// pre-loop one-shot behavior, kept so the two can be measured side by side
const LOOP_MODE = ['always', 'trouble', 'off'].includes(process.env.LOOP) ? process.env.LOOP : 'always';
const MODEL = process.env.MODEL || undefined;
const { registerCatalogEntries } = await import(`${LOOM}/app/catalog.mjs`);

// mount the same guests the deployment mounts (guests.local.mjs URLs → paths)
const guests = [
  '/var/opt/apps/contributors/brian.o/furniture_designer_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/braille_sign_app/shared/loom-guest.mjs',
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

async function callModel(req0) {
  // prompt caching: the system prompt is identical for every EMPTY_RECIPE
  // call — cache it so 50 probes cost like a handful (and the loop's
  // revise calls reuse the same prefix)
  const req = typeof req0.system === 'string'
    ? { ...req0, system: [{ type: 'text', text: req0.system, cache_control: { type: 'ephemeral' } }] }
    : req0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }
  throw new Error('API retries exhausted');
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

async function probe(p) {
  const rec = { id: p.id, persona: p.persona, prior: p.prior, prompt: p.prompt };
  const recipe = baseRecipe(p);
  rec.context = structuredClone(recipe);   // the starting document — makes the row a self-contained corpus candidate
  try {
    const t0 = Date.now();
    const weaveRec = (r) => quiet(() => runRecipe(r, controlDefaults(r), FONT_SHELF, syntheticGrids(r)));
    let out;
    try {
      out = await runIntentLoop({
        recipe, utterance: p.prompt, model: MODEL, mode: LOOP_MODE,
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
    rec.actionKinds = (first.payload.actions ?? []).map(a => a.kind + (a.operation?.strategy ? `:${a.operation.strategy}` : ''));
    rec.rawActions = first.payload.actions ?? [];
    rec.revisedActions = out.turns.slice(1).flatMap(t => t.payload.actions ?? []);
    rec.loop = {
      mode: LOOP_MODE, turns: out.turns.length, fixes: out.fixes, rolledBack: out.rolledBack ?? null,
      summaryChanged: out.revised && out.summary.trim() !== out.firstSummary.trim(),
      perTurn: out.turns.map(t => ({
        actions: (t.payload.actions ?? []).length, applied: t.applied.length, skipped: t.skipped.length,
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
    rec.outcome = 'ERROR'; rec.error = String(e?.stack ?? e).slice(0, 500);
    return rec;
  }
}

const start = parseInt(process.argv[4] ?? '0', 10);
const todo = PROMPTS.slice(start);
console.log(`probing ${todo.length} prompts → ${OUT} (loop: ${LOOP_MODE}${MODEL ? `, model ${MODEL}` : ''})`);

// warmup call first so the cached system prompt is written once
const CONCURRENCY = 4;
let done = 0;
const record = (r) => {
  appendFileSync(OUT, JSON.stringify(r) + '\n');
  done++;
  const flag = r.prior === 'covered' && /DECLINED|PARTIAL|ALL_SKIPPED|CRASH|ERROR/.test(r.outcome) ? ' ⚠ prior-miss'
    : r.prior === 'decline' && r.outcome === 'FULFILLED' ? ' ✓ better-than-expected' : '';
  const loop = r.loop ? ` [${r.loop.turns} call${r.loop.turns === 1 ? '' : 's'}${r.loop.fixes ? `, ${r.loop.fixes} fixes` : ''}${r.loop.summaryChanged ? ', summary revised' : ''}]` : '';
  console.log(`[${done}/${todo.length}] ${r.id}: ${r.outcome}${r.verified === false ? ' (verify FAIL)' : ''}${flag}${loop}`);
};

record(await probe(todo[0]));
const rest = todo.slice(1);
let idx = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < rest.length) {
    const p = rest[idx++];
    record(await probe(p));
  }
}));

console.log('done');
