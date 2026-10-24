// One Loom turn, run to completion off the phone (worker_threads).
//
// The guest-pass relay used to forward each model call the phone made; the
// phone drove the loop (draft → weave/verify → the model's fix pass) and had
// to stay open the whole time. On a phone that is a tall order: a backgrounded
// Safari tab stops running within a minute or two, and the in-flight call
// still finished on the server, billed and counted, with nobody listening
// (2026-10-19). Now the server runs the whole loop here, in its own thread
// (a weave is seconds of synchronous CPU — production's event loop must not
// pay for it), and the phone polls or simply comes back later.
//
// workerData: { appDir, key, job: { recipe, utterance, model, image, exemplars,
// values, shop }, canned? } — `canned` is a list of model responses for tests
// (no network, no key). Messages out: { kind: 'stage', stage } as the turn
// progresses, then exactly one of { kind: 'done', result } / { kind: 'failed',
// error, intent }.

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

const CALL_TIMEOUT_MS = 240_000;   // per model call; the job as a whole is capped by the parent
const MAX_TOKENS = 16000;          // same ceiling as the relay (thinking models spend part of it reasoning)
const CONTRIBUTORS = '/var/opt/apps/contributors/';

const { appDir, key, job, canned = null } = workerData;
const post = (m) => parentPort.postMessage(m);
let intentErrorClass = null;   // Loom's IntentError, once the app is loaded

// the deployment's guests (app/guests.local.mjs holds same-origin URLs the
// production server serves as /c/<user>/<path>; on disk that is contributors/)
async function mountGuests(registerCatalogEntries) {
  let list = [];
  try { list = (await import(`${appDir}guests.local.mjs`)).default ?? []; } catch { return; }
  for (const url of list) {
    const m = /^\/c\/([^/]+)\/(.+)$/.exec(url);
    const file = m ? `${CONTRIBUTORS}${m[1]}/${m[2]}` : null;
    if (!file || !fs.existsSync(file)) continue;
    try { registerCatalogEntries((await import(file)).entries); }
    catch (e) { console.warn(`[loom-job] guest ${url} failed to load: ${e?.message ?? e}`); }
  }
}

const quiet = (fn) => {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
};

function pickExisting(values, rec) {
  const keep = {};
  for (const c of rec.controls ?? []) if (c.id in (values ?? {})) keep[c.id] = values[c.id];
  return keep;
}

// what the phone needs back; per-turn recipe snapshots are dropped (the
// final recipe is the result) — payloads stay, the funnel log reads them
function slim(out) {
  return {
    recipe: out.recipe,
    summary: out.summary,
    firstSummary: out.firstSummary,
    declined: out.declined,
    suggest: out.suggest,
    stance: out.stance,
    usage: out.usage,
    revised: out.revised,
    fixes: out.fixes,
    rolledBack: out.rolledBack,
    claimIssues: out.claimIssues,
    claimsCaught: out.claimsCaught,
    turns: out.turns.map(t => ({
      payload: t.payload, applied: t.applied, skipped: t.skipped, declined: t.declined, summary: t.summary,
      observation: t.observation ? { ok: t.observation.ok, errors: t.observation.errors, warnings: t.observation.warnings, pieces: t.observation.pieces ?? null } : null,
    })),
  };
}

try {
  const { runIntentLoop, isKnownModel, DEFAULT_MODEL, IntentError } = await import(`${appDir}intent.mjs`);
  intentErrorClass = IntentError;
  const { runRecipe, controlDefaults } = await import(`${appDir}runtime.mjs`);
  const { registerCatalogEntries } = await import(`${appDir}catalog.mjs`);
  const { FONTS } = await import(`${appDir}fonts.mjs`);
  await mountGuests(registerCatalogEntries);
  const fonts = {};
  for (const f of FONTS) {
    const b = fs.readFileSync(new URL(f.file, appDir).pathname);
    fonts[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }

  let call;
  if (canned) {
    const queue = [...canned];
    call = async () => { const r = queue.shift(); if (!r) throw new Error('canned responses exhausted'); return r; };
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    call = (req) => client.messages.create(
      { ...req, stream: false, max_tokens: Math.min(req.max_tokens ?? 2000, MAX_TOKENS) },
      { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
  }

  let calls = 0;
  post({ kind: 'stage', stage: job.image && !(job.recipe.pipeline ?? []).length ? 'reading the picture…' : 'thinking…' });
  const out = await runIntentLoop({
    recipe: job.recipe,
    utterance: job.utterance,
    shop: {},
    model: isKnownModel(job.model) ? job.model : DEFAULT_MODEL,
    image: job.image ?? null,
    exemplars: job.exemplars ?? null,
    client: job.client ?? null,
    call: (req) => { if (calls++ > 0) post({ kind: 'stage', stage: calls === 2 ? 'checking the weave…' : 'checking again…' }); return call(req); },
    weave: async (rec) => {
      post({ kind: 'stage', stage: 'weaving…' });
      if (rec.terrains?.length) return { ok: false, errors: ['terrain references are not available on the phone version — use the full app'], warnings: [], preview: { empty: true } };
      const values = { ...controlDefaults(rec), ...pickExisting(job.values, rec) };
      return quiet(() => runRecipe(rec, values, fonts, {}, job.shop ?? {}));
    },
  });
  post({ kind: 'done', result: slim(out) });
} catch (e) {
  const timedOut = e?.name === 'APIUserAbortError' || e?.name === 'TimeoutError' || e?.name === 'AbortError';
  post({
    kind: 'failed',
    intent: !!(intentErrorClass && e instanceof intentErrorClass),   // the model's answer was unusable — Loom's own words, safe to show
    timedOut,
    error: timedOut ? 'The model took longer than 4 minutes to answer.' : (e?.message ?? String(e)),
  });
}
