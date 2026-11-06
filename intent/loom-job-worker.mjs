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
// (no network, no key). Messages out, as the turn progresses:
//   { kind: 'stage', stage }  — which step is running (a fixed set of labels)
//   { kind: 'note', note }    — the model's own progress line while it thinks
//                               (summarized reasoning, streamed; Claude 5 only)
//   { kind: 'draft', draft }  — the FIRST woven state (recipe + first summary +
//                               verdict): the phone shows it while the second
//                               look runs, as a draft, export shut
// then exactly one of { kind: 'done', result } / { kind: 'failed', error, intent }.

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

const CALL_TIMEOUT_MS = 240_000;   // per model call; the job as a whole is capped by the parent
const MAX_TOKENS = 16000;          // same ceiling as the relay (thinking models spend part of it reasoning)
const CONTRIBUTORS = '/var/opt/apps/contributors/';

const { appDir, key, job, canned = null } = workerData;
const post = (m) => parentPort.postMessage(m);

// The latest complete sentence of the summarized reasoning so far, as one
// short line, posted at most ~once a second and only when it changed. The
// phone shows it in place of "thinking…" — "Choosing a tenoned-panel box
// with a face frame for the drawers." — for the 20–40 s before any action
// arrives (hidden reasoning is most of a turn's wait, measured 2026-11-01).
const NOTE_MAX = 140, NOTE_EVERY_MS = 1000;
let lastNote = '', lastNoteAt = 0;
function postNote(snapshot) {
  const text = String(snapshot ?? '').replace(/\s+/g, ' ').trim();
  // sentences end at . ! ? followed by a space — never inside 0.25" or 1.5"
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let note = parts[parts.length - 1]?.trim() ?? '';
  if (!/[.!?]$/.test(note)) note = parts[parts.length - 2]?.trim() ?? '';   // the last one is still being written
  if (!note) return;
  if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX - 1).replace(/\s+\S*$/, '') + '…';
  const now = Date.now();
  if (note === lastNote || now - lastNoteAt < NOTE_EVERY_MS) return;
  lastNote = note; lastNoteAt = now;
  post({ kind: 'note', note });
}
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
  const { runIntentLoop, isKnownModel, DEFAULT_MODEL, IntentError, FORCED_TOOL_CHOICE_UNSUPPORTED } = await import(`${appDir}intent.mjs`);
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

  const model = isKnownModel(job.model) ? job.model : DEFAULT_MODEL;
  let call;
  if (canned) {
    const queue = [...canned];
    call = async () => {
      const r = queue.shift();
      if (!r) throw new Error('canned responses exhausted');
      if (r.hang) return new Promise(() => {});   // a model that never answers (the cancel test)
      return r;
    };
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    // The Claude 5 models always think; asking for the SUMMARIZED display
    // streams readable progress notes while they reason (billed the same,
    // the blocks ride back into the next call unchanged as before). Older
    // models keep their request shape — adaptive thinking would switch
    // reasoning ON for them. Streaming also keeps the socket alive through
    // a long first call instead of waiting on one buffered response.
    const notes = FORCED_TOOL_CHOICE_UNSUPPORTED.test(model);
    call = async (req) => {
      const params = { ...req, max_tokens: Math.min(req.max_tokens ?? 2000, MAX_TOKENS), ...(notes ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}) };
      const stream = client.messages.stream(params, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (notes) stream.on('thinking', (_delta, snapshot) => postNote(snapshot));
      return stream.finalMessage();
    };
  }

  let calls = 0;
  post({ kind: 'stage', stage: job.image && !(job.recipe.pipeline ?? []).length ? 'reading the picture…' : 'thinking…' });
  const out = await runIntentLoop({
    recipe: job.recipe,
    utterance: job.utterance,
    shop: {},
    model,
    image: job.image ?? null,
    exemplars: job.exemplars ?? null,
    client: job.client ?? null,
    call: (req) => { if (calls++ > 0) post({ kind: 'stage', stage: calls === 2 ? 'checking the weave…' : 'checking again…' }); return call(req); },
    // the first woven state, shown on the phone while the second look runs
    onDraft: (d) => post({ kind: 'draft', draft: { turn: d.turn, recipe: d.recipe, summary: d.summary, declined: d.declined, ok: d.ok, errors: (d.result?.errors ?? []).slice(0, 3) } }),
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
