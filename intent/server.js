// Intent parsing proxy + funnel log — the one place the platform talks to
// an LLM, and the one place demand signal lands.
//
// Mounted into production.js via dynamic import (CJS → ESM). Two parse
// paths exist by design (testing model: bring-your-own-AI-account):
//
//   browser-direct  the user's own Anthropic key, stored only in their
//                   browser, calls api.anthropic.com straight from the
//                   page (CORS opt-in header). Our server never sees the
//                   key — the page just reports the RESULT to /api/intent/log.
//   server proxy    POST /api/intent/step using the shop key from
//                   /var/opt/apps/.intent.env (mode 600). Without a key it
//                   answers 503 and the apps fall back to their forms.
//   guest pass      POST /api/intent/loom — invite-gated relay on the shop
//                   key for the Loom app, which builds its own request
//                   (its system prompt includes runtime-registered guest
//                   entries the server can't know about). Metered per
//                   5-hour window; see invites.js.
//
// Both paths append to the funnel log (open intake, narrow fulfillment:
// every utterance + what was fulfilled + what was DECLINED). The declined
// entries are the contributor backlog; the usage numbers are the pricing
// data. One JSONL line per parse at /var/opt/apps/.intent-funnel.jsonl.

import fs from 'fs';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { buildParseRequest } from './step-schema.js';
import { loadRegistry, saveRegistry, inviteStatus, consumeInvite, refundInvite, recordUsage, newToken, newInvite } from './invites.js';
import { LoomJobs, validateJobInput } from './loom-jobs.js';

const ENV_FILE = '/var/opt/apps/.intent.env';
const FUNNEL_FILE = '/var/opt/apps/.intent-funnel.jsonl';
const MAX_UTTERANCE = 2000;       // chars; a shop request is a sentence or two
const MAX_CONTEXT_BYTES = 64 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 12 };  // per IP
const RELAY_MAX_TOKENS = 16000;   // ceiling on what a relayed request may ask for (thinking models spend part of it reasoning)
const RELAY_TIMEOUT_MS = 240_000; // give up (and refund the prompt) before nginx's 300s proxy_read_timeout abandons us

function readKey() {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const m = text.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const hits = new Map(); // ip → [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter(t => now - t < RATE_LIMIT.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 1000) hits.clear(); // crude memory bound; resets all windows
  return list.length > RATE_LIMIT.max;
}

const clip = (s, n) => typeof s === 'string' ? s.slice(0, n) : undefined;

// Funnel entries carry which app the ask came from; unknown/absent tags
// fall back to step_toolpath (the original sole tenant of this log).
const KNOWN_APPS = new Set(['step_toolpath', 'furniture', 'loom']);

// One JSONL line per parse, stamped with a QUERY ID the user can quote in
// a bug report — `node intent/replay.mjs q_xxxxxxxx` reconstructs exactly
// what the model saw and decided. `context` is the recipe/document view
// the parse ran against (already asset-elided by the client); without it,
// mid-session parses ("make the legs thicker") are not reproducible.
// Never throws — logging must not break parsing. Returns the id (or null).
function appendFunnel(entry) {
  try {
    let context = entry.context && typeof entry.context === 'object' ? entry.context : undefined;
    if (context && JSON.stringify(context).length > MAX_CONTEXT_BYTES) context = undefined;
    const id = 'q_' + crypto.randomBytes(4).toString('hex');
    const line = JSON.stringify({
      id,
      ts: new Date().toISOString(),
      source: entry.source,                       // 'server' | 'browser'
      app: KNOWN_APPS.has(entry.app) ? entry.app : 'step_toolpath',
      utterance: clip(entry.utterance, MAX_UTTERANCE),
      // a picture rode with this parse (never the bytes — replay.mjs can't
      // reproduce such a parse from text alone, and says so)
      ...(entry.image?.attached ? { image: { attached: true, width: Number(entry.image.width) || undefined, height: Number(entry.image.height) || undefined } } : {}),
      summary: clip(entry.intent?.summary, 500),
      actions: (entry.intent?.actions ?? []).slice(0, 50),
      declined: (entry.intent?.declined ?? []).slice(0, 20),
      // the closed loop's record (Loom): what the model said before it saw
      // the weave vs. after, and the corrections its second look emitted
      ...(entry.intent?.loop && typeof entry.intent.loop === 'object' ? {
        loop: {
          turns: Number(entry.intent.loop.turns) || 1,
          fixes: Number(entry.intent.loop.fixes) || 0,
          firstSummary: clip(entry.intent.loop.firstSummary, 500),
          revisedActions: (Array.isArray(entry.intent.loop.revisedActions) ? entry.intent.loop.revisedActions : []).slice(0, 50),
          observed: (Array.isArray(entry.intent.loop.observed) ? entry.intent.loop.observed : []).slice(0, 4),
          claimIssues: (Array.isArray(entry.intent.loop.claimIssues) ? entry.intent.loop.claimIssues : []).slice(0, 8).map(String),
          claimsCaught: !!entry.intent.loop.claimsCaught,
          rolledBack: entry.intent.loop.rolledBack && typeof entry.intent.loop.rolledBack === 'object' ? { toTurn: Number(entry.intent.loop.rolledBack.toTurn), error: clip(entry.intent.loop.rolledBack.error, 200) } : null,
        },
      } : {}),
      usage: entry.usage ?? null,
      invite: clip(entry.invite, 100),            // guest-pass holder, if any
      context,
    }) + '\n';
    fs.appendFileSync(FUNNEL_FILE, line);
    return id;
  } catch (err) {
    console.error('[intent] funnel append failed:', err?.message ?? err);
    return null;
  }
}

let client = null;

export function mountIntent(app) {
  app.post('/api/intent/step', async (req, res) => {
    try {
      const key = readKey();
      if (!key) {
        return res.status(503).json({ ok: false, error: 'Intent parsing is not configured on this server (no API key). Add your own key in the AI account settings, or use the form controls.' });
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (rateLimited(ip)) {
        return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute.' });
      }

      const { utterance, context } = req.body ?? {};
      if (typeof utterance !== 'string' || !utterance.trim()) {
        return res.status(400).json({ ok: false, error: 'utterance (string) is required' });
      }
      if (utterance.length > MAX_UTTERANCE) {
        return res.status(400).json({ ok: false, error: `utterance too long (max ${MAX_UTTERANCE} chars)` });
      }
      if (!context || typeof context !== 'object' || JSON.stringify(context).length > MAX_CONTEXT_BYTES) {
        return res.status(400).json({ ok: false, error: 'context (object, <64KB) is required' });
      }

      client ??= new Anthropic({ apiKey: key });
      const response = await client.messages.create(buildParseRequest(utterance, context));

      if (response.stop_reason === 'max_tokens') {
        return res.status(502).json({ ok: false, error: 'Parse came back incomplete — try a shorter request.' });
      }
      const text = response.content.find(b => b.type === 'text')?.text;
      if (!text) {
        return res.status(502).json({ ok: false, error: 'No parse produced.' });
      }
      const intent = JSON.parse(text);
      const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
      const queryId = appendFunnel({ source: 'server', utterance, intent, usage, context });
      return res.json({ ok: true, intent, usage, queryId });
    } catch (err) {
      const status = err?.status >= 400 && err?.status < 600 ? 502 : 500;
      console.error('[intent] parse failed:', err?.message ?? err);
      return res.status(status).json({ ok: false, error: 'Intent parsing failed — use the form controls.' });
    }
  });

  // Guest-pass relay for the Loom app. The client sends the full Anthropic
  // request it built (system prompt spans runtime-registered guest entries,
  // so only the client can build it); we gate on the invite, clamp what a
  // relay could be abused for, meter the 5-hour window, and forward on the
  // shop key. Metering (registry) and demand signal (funnel) stay separate:
  // the page still reports the applied result to /api/intent/log.
  app.post('/api/intent/loom', async (req, res) => {
    try {
      const key = readKey();
      if (!key) {
        return res.status(503).json({ ok: false, error: 'Guest passes are not available on this server (no API key configured). Add your own key in the AI account settings.' });
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (rateLimited(ip)) {
        return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute.' });
      }

      const token = req.get('x-loom-invite');
      const reg = loadRegistry();
      const entry = token ? reg[token] : null;
      if (!entry) {
        return res.status(401).json({ ok: false, error: 'Prompting here needs a guest-pass link or your own API key.' });
      }

      const r = req.body?.req;
      if (!r || typeof r !== 'object' || !Array.isArray(r.messages)) {
        return res.status(400).json({ ok: false, error: 'req (an Anthropic messages request) is required' });
      }
      if (typeof r.model !== 'string' || !r.model.startsWith('claude-')) {
        return res.status(400).json({ ok: false, error: 'unsupported model' });
      }

      const take = consumeInvite(entry);
      if (!take.ok) {
        if (take.reason === 'window') {
          return res.status(429).json({ ok: false, reason: 'window', resetsAt: take.resetsAt, error: 'This guest pass is out of prompts for now.' });
        }
        return res.status(403).json({ ok: false, reason: take.reason, error: take.reason === 'expired' ? 'This guest pass has expired.' : 'This guest pass was revoked.' });
      }
      saveRegistry(reg);   // meter before the spend — a crash mid-call still counted

      const clamped = { ...r, stream: false, max_tokens: Math.min(r.max_tokens ?? 2000, RELAY_MAX_TOKENS) };
      client ??= new Anthropic({ apiKey: key });
      let response;
      try {
        // one deadline across the SDK's retries: nginx stops waiting at 300s and
        // the phone would see a 504 while we finished and billed the call (2026-10-19)
        response = await client.messages.create(clamped, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
      } catch (err) {
        // the guest got nothing — give the prompt back (fresh read: other
        // requests may have advanced the registry while we awaited)
        const reg2 = loadRegistry();
        if (reg2[token]) { refundInvite(reg2[token]); saveRegistry(reg2); }
        throw err;
      }

      const reg2 = loadRegistry();
      const entry2 = reg2[token] ?? entry;
      recordUsage(entry2, { input: response.usage?.input_tokens, output: response.usage?.output_tokens });
      saveRegistry(reg2);
      const s = inviteStatus(entry2);
      return res.json({ ok: true, data: response, invite: { name: entry2.name, remaining: s.remaining, resetsAt: s.resetsAt, expires: s.expires } });
    } catch (err) {
      const timedOut = err?.name === 'APIUserAbortError' || err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const status = timedOut ? 504 : err?.status >= 400 && err?.status < 600 ? 502 : 500;
      console.error('[intent] loom relay failed:', timedOut ? `timed out after ${RELAY_TIMEOUT_MS / 1000}s` : (err?.message ?? err));
      return res.status(status).json({ ok: false, error: timedOut
        ? `The model took longer than ${Math.round(RELAY_TIMEOUT_MS / 60000)} minutes — your prompt was not counted. Try again; a shorter ask or note helps.`
        : 'The AI call failed — your prompt was not counted. Try again.' });
    }
  });

  // ---- server-side turns: the phone posts the whole ask and comes back ----
  // intent/loom-jobs.js runs the closed loop (draft → weave/verify → fix) in
  // a worker thread. The per-call relay above needed the phone open for the
  // whole turn; a backgrounded or closed Safari tab lost the design and the
  // in-flight call was still billed and counted (2026-10-19). One prompt per
  // ask here — the loop's two or three model calls are the server's business.
  const jobs = new LoomJobs({
    onDone: ({ token, usage }) => {
      const reg = loadRegistry();
      if (!reg[token]) return;
      recordUsage(reg[token], { input: usage?.input_tokens, output: usage?.output_tokens });
      saveRegistry(reg);
    },
    onFailed: ({ token }) => {
      const reg = loadRegistry();   // the guest got nothing — give the prompt back
      if (!reg[token]) return;
      refundInvite(reg[token]);
      saveRegistry(reg);
    },
  });
  {
    const orphans = jobs.takeOrphans();
    if (orphans.length) {
      const reg = loadRegistry();
      for (const o of orphans) if (reg[o.token]) refundInvite(reg[o.token]);
      saveRegistry(reg);
      console.log(`[intent] ${orphans.length} Loom build(s) were interrupted by the restart — prompts refunded`);
    }
  }

  app.post('/api/intent/loom/job', (req, res) => {
    try {
      const key = readKey();
      if (!key) {
        return res.status(503).json({ ok: false, error: 'Guest passes are not available on this server (no API key configured). Add your own key in the AI account settings.' });
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (rateLimited(ip)) {
        return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute.' });
      }
      const token = req.get('x-loom-invite');
      const reg = loadRegistry();
      const entry = token ? reg[token] : null;
      if (!entry) {
        return res.status(401).json({ ok: false, error: 'Prompting here needs a guest-pass link or your own API key.' });
      }
      const v = validateJobInput(req.body);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
      if (jobs.busy()) {
        return res.status(503).json({ ok: false, reason: 'busy', error: 'Loom is building for several people right now — try again in a minute. Your prompt was not counted.' });
      }
      const take = consumeInvite(entry);
      if (!take.ok) {
        if (take.reason === 'window') {
          return res.status(429).json({ ok: false, reason: 'window', resetsAt: take.resetsAt, error: 'This guest pass is out of prompts for now.' });
        }
        return res.status(403).json({ ok: false, reason: take.reason, error: take.reason === 'expired' ? 'This guest pass has expired.' : 'This guest pass was revoked.' });
      }
      saveRegistry(reg);   // meter before the spend; onFailed refunds
      const id = jobs.start({ token, input: v.input, key });
      const s = inviteStatus(entry);
      console.log(`[intent] loom build ${id} started for ${entry.name}${v.input.image ? ' (with a picture)' : ''}`);
      return res.status(202).json({ ok: true, job: id, invite: { name: entry.name, remaining: s.remaining, resetsAt: s.resetsAt, expires: s.expires } });
    } catch (err) {
      console.error('[intent] loom build start failed:', err?.message ?? err);
      return res.status(500).json({ ok: false, error: 'The server could not start the build — try again.' });
    }
  });

  // the phone polls this, or comes back to it later; only the pass that
  // started a build can see it, and finished builds are kept for a day
  app.get('/api/intent/loom/job/:id', (req, res) => {
    const token = req.get('x-loom-invite');
    const v = token ? jobs.get(String(req.params.id), token) : null;
    res.set('cache-control', 'no-store');
    if (!v) return res.status(404).json({ ok: false, error: 'That build is no longer on the server (builds are kept for a day) — ask again.' });
    const entry = loadRegistry()[token];
    const s = entry ? inviteStatus(entry) : null;
    return res.json({ ok: true, ...v, invite: s ? { name: entry.name, remaining: s.remaining, resetsAt: s.resetsAt, expires: s.expires } : null });
  });

  // the phone started over (a new photo while a build was running): stop
  // the worker and give the prompt back — only the pass that started it may
  app.delete('/api/intent/loom/job/:id', (req, res) => {
    const token = req.get('x-loom-invite');
    const r = token ? jobs.cancel(String(req.params.id), token) : null;
    res.set('cache-control', 'no-store');
    if (r === null) return res.status(404).json({ ok: false, error: 'That build is not on the server.' });
    if (r) console.log(`[intent] loom build ${req.params.id} stopped by its owner — prompt refunded`);
    return res.json({ ok: true, cancelled: r });
  });

  // Mint a guest pass from the app. The shop's own Anthropic key is the
  // credential: whoever holds it may hand out metered access to it. The
  // phone already sends that key to api.anthropic.com for BYO parses; here
  // it travels only to this server (HTTPS), is compared in constant time,
  // and is never stored or logged. Windows are hourly by default for these
  // links (a trial someone texts around), capped so a typo can't mint a
  // firehose.
  app.post('/api/intent/invite', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute.' });
    const key = readKey();
    if (!key) return res.status(503).json({ ok: false, error: 'This server has no API key of its own, so it cannot host guest passes.' });
    const given = Buffer.from(String(req.get('x-api-key') ?? ''));
    const own = Buffer.from(key);
    if (given.length !== own.length || !crypto.timingSafeEqual(given, own)) {
      return res.status(403).json({ ok: false, error: 'Only the holder of this server\'s own Anthropic key can make guest links — the key saved in this browser is a different one.' });
    }
    const clampInt = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
    const { name, perWindow, windowHours, days } = req.body ?? {};
    const nm = (clip(String(name ?? ''), 60) ?? '').trim() || `Guest ${new Date().toISOString().slice(0, 10)}`;
    const reg = loadRegistry();
    const token = newToken();
    reg[token] = newInvite(nm, {
      days: clampInt(days, 1, 90, 14),
      perWindow: clampInt(perWindow, 1, 20, 4),
      windowHours: clampInt(windowHours, 1, 24, 1),
    });
    reg[token].mintedBy = 'app';
    saveRegistry(reg);
    console.log(`[intent] guest pass minted from the app: ${nm} (${reg[token].perWindow}/${clampInt(windowHours, 1, 24, 1)}h, ${clampInt(days, 1, 90, 14)} days)`);
    return res.json({ ok: true, token, invite: inviteStatus(reg[token]) });
  });

  // Guest-pass status for the app's chip — never consumes a prompt.
  app.get('/api/intent/invite', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ ok: false });
    const token = req.get('x-loom-invite');
    if (!token) return res.status(400).json({ ok: false, reason: 'missing' });
    const s = inviteStatus(loadRegistry()[token]);
    return res.status(s.valid ? 200 : 404).json({ ok: s.valid, ...s });
  });

  // Funnel report for browser-direct (BYO-key) parses: the page already has
  // the result; it posts only the result here. No key ever arrives. Guest
  // passes send their token too, so demand gets attributed to a name.
  app.post('/api/intent/log', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ ok: false });
    const { app: clientApp, utterance, intent, usage, context, image } = req.body ?? {};   // image = { attached, width, height } — pixel size only, never bytes
    if (typeof utterance !== 'string' || !intent || typeof intent !== 'object') {
      return res.status(400).json({ ok: false });
    }
    const token = req.get('x-loom-invite');
    const invite = token ? loadRegistry()[token]?.name : undefined;
    const queryId = appendFunnel({ source: 'browser', app: clientApp, invite, utterance, intent, usage, context, image });
    return res.json({ ok: true, queryId });
  });

  console.log('[intent] /api/intent/step + /api/intent/loom (+ /job, DELETE /job/:id) + /api/intent/invite (GET status, POST mint) + /api/intent/log mounted' + (readKey() ? '' : ' (no server key — proxy answers 503; BYO-key still works)'));
}
