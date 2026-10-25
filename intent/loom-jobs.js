// Server-side Loom turns for guest passes: a job store around
// loom-job-worker.mjs. The phone (app/mobile.js) posts the turn, keeps the
// job id, and polls — or closes the browser and finds the design waiting
// when it comes back. See the worker's header for why.
//
// A job's INPUT (recipe, photo, utterance) lives only in memory, for the
// life of the worker. What is written to disk (`dir`, root-only) is the
// job's status and its RESULT: the woven recipe and the model's words — the
// same things the phone keeps in its own localStorage — so a finished design
// survives a production restart. Jobs expire after `ttlMs`.
//
// Metering is the caller's (server.js): it consumes the guest's prompt before
// start() and gets onDone({ token, usage }) / onFailed({ token }) to record or
// refund. Jobs that were still running when the server last stopped are
// handed back by takeOrphans() so those prompts can be refunded too.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const JOBS_DIR = '/var/opt/apps/.intent-jobs';
const DEFAULT_TTL_MS = 24 * 3600_000;
const DEFAULT_MAX_ACTIVE = 3;          // one weave at a time per thread; three threads is plenty for a trial link
const JOB_CAP_MS = 15 * 60_000;        // three 4-minute calls plus weaves — anything past this is stuck

const STAGES = new Set(['thinking…', 'reading the picture…', 'weaving…', 'checking the weave…', 'checking again…']);

// the Loom app whose modules the worker runs: the repo's own app/ when this
// file lives beside it (fabmo-loom/intent), else the published Loom
export function resolveLoomApp() {
  const local = new URL('../app/', import.meta.url);
  if (fs.existsSync(new URL('runtime.mjs', local).pathname)) return local.href;
  return 'file:///var/opt/apps/published/loom/app/';
}

export function newJobId() {
  return 'lj_' + crypto.randomBytes(12).toString('base64url');
}

export class LoomJobs {
  constructor({ dir = JOBS_DIR, appDir = resolveLoomApp(), maxActive = DEFAULT_MAX_ACTIVE, ttlMs = DEFAULT_TTL_MS, capMs = JOB_CAP_MS, onDone = null, onFailed = null, log = console } = {}) {
    this.dir = dir;
    this.appDir = appDir;
    this.maxActive = maxActive;
    this.ttlMs = ttlMs;
    this.capMs = capMs;
    this.onDone = onDone;
    this.onFailed = onFailed;
    this.log = log;
    this.jobs = new Map();      // id → record (public fields + token)
    this.workers = new Map();   // id → { worker, timer }
    this.orphans = [];
    this.workerFile = new URL('./loom-job-worker.mjs', import.meta.url);
    try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { /* read-only: jobs are memory-only */ }
    this.load();
  }

  // ---- persistence -------------------------------------------------------
  file(id) { return path.join(this.dir, `${id}.json`); }
  save(job) {
    const { input, ...rest } = job;   // never the input
    try { fs.writeFileSync(this.file(job.id), JSON.stringify(rest), { mode: 0o600 }); } catch (e) { this.log.warn?.(`[loom-jobs] save failed: ${e?.message ?? e}`); }
  }
  load() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => n.endsWith('.json')); } catch { return; }
    const now = Date.now();
    for (const n of names) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')); } catch { continue; }
      if (!j?.id || now - (j.startedAt ?? 0) > this.ttlMs) { try { fs.unlinkSync(path.join(this.dir, n)); } catch {} continue; }
      if (j.status === 'running') {
        // the process that was running it is gone; the guest got nothing
        j.status = 'failed';
        j.finishedAt = now;
        j.error = 'The server restarted while this design was being built — your prompt was not counted. Ask again.';
        this.orphans.push({ id: j.id, token: j.token });
        this.save(j);
      }
      this.jobs.set(j.id, j);
    }
  }
  // jobs interrupted by a restart, once (the caller refunds those prompts)
  takeOrphans() { const o = this.orphans; this.orphans = []; return o; }
  sweep() {
    const now = Date.now();
    for (const [id, j] of this.jobs) {
      if (now - j.startedAt > this.ttlMs && j.status !== 'running') {
        this.jobs.delete(id);
        try { fs.unlinkSync(this.file(id)); } catch {}
      }
    }
  }

  // ---- lifecycle ---------------------------------------------------------
  active() { return this.workers.size; }
  busy() { return this.workers.size >= this.maxActive; }

  // input: { recipe, utterance, model, image, exemplars, values, shop } — validated by the caller
  start({ token, input, key = null, canned = null }) {
    this.sweep();
    const job = {
      id: newJobId(), token, status: 'running', stage: 'thinking…',
      startedAt: Date.now(), finishedAt: null, utterance: input.utterance, hadImage: !!input.image,
      result: null, error: null, input,
    };
    this.jobs.set(job.id, job);
    this.save(job);

    let worker;
    try {
      worker = new Worker(this.workerFile, { workerData: { appDir: this.appDir, key, job: input, canned } });
    } catch (e) {
      this.finish(job, { kind: 'failed', error: `could not start the build: ${e?.message ?? e}` });
      return job.id;
    }
    const timer = setTimeout(() => {
      this.log.warn?.(`[loom-jobs] ${job.id} exceeded ${this.capMs / 60000} minutes — terminating`);
      worker.terminate().catch(() => {});
      this.finish(job, { kind: 'failed', error: 'The build took too long and was stopped — your prompt was not counted. Ask again, maybe for something simpler.' });
    }, this.capMs);
    this.workers.set(job.id, { worker, timer });

    worker.on('message', (m) => {
      if (m?.kind === 'stage') { if (STAGES.has(m.stage)) { job.stage = m.stage; } return; }
      if (m?.kind === 'done' || m?.kind === 'failed') this.finish(job, m);
    });
    worker.on('error', (e) => this.finish(job, { kind: 'failed', error: `the build crashed: ${e?.message ?? e}` }));
    worker.on('exit', (code) => {
      if (job.status === 'running') this.finish(job, { kind: 'failed', error: `the build stopped unexpectedly (exit ${code}) — your prompt was not counted.` });
    });
    return job.id;
  }

  finish(job, m) {
    if (job.status !== 'running') return;   // first word wins (done/failed/exit/timeout race)
    const w = this.workers.get(job.id);
    if (w) { clearTimeout(w.timer); this.workers.delete(job.id); w.worker.terminate?.().catch?.(() => {}); }
    job.finishedAt = Date.now();
    delete job.input;
    if (m.kind === 'done') {
      job.status = 'done';
      job.stage = null;
      job.result = m.result;
      this.save(job);
      try { this.onDone?.({ id: job.id, token: job.token, usage: m.result?.usage ?? null }); } catch (e) { this.log.error?.(`[loom-jobs] onDone failed: ${e?.message ?? e}`); }
    } else {
      job.status = 'failed';
      job.stage = null;
      if (m.cancelled) job.cancelled = true;
      // IntentError text is Loom's own ("the model returned no actions") and
      // reads fine on the phone; anything else is logged and summarised
      job.error = m.intent || m.timedOut || /not counted/.test(m.error ?? '') ? m.error : 'The AI call failed — your prompt was not counted. Try again.';
      if (!m.intent) this.log.error?.(`[loom-jobs] ${job.id} failed: ${m.error}`);
      this.save(job);
      try { this.onFailed?.({ id: job.id, token: job.token, error: m.error }); } catch (e) { this.log.error?.(`[loom-jobs] onFailed failed: ${e?.message ?? e}`); }
    }
  }

  // The person started over (a new photo on the phone page cancels the
  // build): stop the worker now and give the prompt back through onFailed.
  // null = unknown or not this pass's job; false = it had already ended.
  cancel(id, token) {
    const j = this.jobs.get(id);
    if (!j || j.token !== token) return null;
    if (j.status !== 'running') return false;
    this.finish(j, { kind: 'failed', intent: true, cancelled: true, error: 'Stopped — you started over. Your prompt was not counted.' });
    return true;
  }

  // the phone's view; null when unknown or not this pass's job
  get(id, token) {
    const j = this.jobs.get(id);
    if (!j || j.token !== token) return null;
    return {
      id: j.id, status: j.status, stage: j.stage, startedAt: j.startedAt, finishedAt: j.finishedAt,
      utterance: j.utterance, hadImage: j.hadImage, result: j.result, error: j.error, ...(j.cancelled ? { cancelled: true } : {}),
    };
  }

  // wait for a job (tests); resolves to the public view
  async wait(id, token, { pollMs = 25, timeoutMs = 60_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = this.get(id, token);
      if (!v) return null;
      if (v.status !== 'running') return v;
      if (Date.now() - t0 > timeoutMs) throw new Error('job wait timed out');
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  async close() {
    for (const [, w] of this.workers) { clearTimeout(w.timer); await w.worker.terminate().catch(() => {}); }
    this.workers.clear();
  }
}

// ---- input validation (shared by server.js and the test) ----------------
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_UTTERANCE = 2000;
const MAX_INPUT_BYTES = 512 * 1024;   // everything but the picture
const MAX_EXEMPLARS = 2;
const MAX_EXEMPLAR_BYTES = 48 * 1024;

// returns { ok: true, input } or { ok: false, error }
export function validateJobInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'a job body is required' };
  const { recipe, utterance, model, image, exemplars, values, shop, client } = body;
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.pipeline)) return { ok: false, error: 'recipe (with a pipeline) is required' };
  if (typeof utterance !== 'string' || !utterance.trim()) return { ok: false, error: 'utterance is required' };
  if (utterance.length > MAX_UTTERANCE) return { ok: false, error: `utterance is too long (max ${MAX_UTTERANCE} characters)` };
  if (model !== undefined && (typeof model !== 'string' || !model.startsWith('claude-'))) return { ok: false, error: 'unsupported model' };
  let img = null;
  if (image != null) {
    if (typeof image !== 'object' || !IMAGE_TYPES.has(image.media_type) || typeof image.data !== 'string' || !image.data) return { ok: false, error: 'image must be { media_type, data }' };
    img = { media_type: image.media_type, data: image.data };
  }
  let ex = null;
  if (exemplars != null) {
    if (!Array.isArray(exemplars) || exemplars.length > MAX_EXEMPLARS || !exemplars.every(e => e && typeof e === 'object')) return { ok: false, error: `exemplars must be a list of at most ${MAX_EXEMPLARS}` };
    if (JSON.stringify(exemplars).length > MAX_EXEMPLAR_BYTES) return { ok: false, error: 'exemplars are too large' };
    ex = exemplars;
  }
  const vals = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const sh = shop && typeof shop === 'object' && !Array.isArray(shop) ? shop : {};
  const cl = client === 'phone' ? 'phone' : null;   // which page asked: the phone page has no sketch dialog (intent.mjs NO_DRAW_RULE)
  const input = { recipe, utterance: utterance.trim(), model, image: img, exemplars: ex, values: vals, shop: sh, client: cl };
  if (JSON.stringify({ ...input, image: null }).length > MAX_INPUT_BYTES) return { ok: false, error: 'the design is too large to send' };
  return { ok: true, input };
}
