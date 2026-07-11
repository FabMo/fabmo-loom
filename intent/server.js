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
import Anthropic from '@anthropic-ai/sdk';
import { buildParseRequest } from './step-schema.js';
import { loadRegistry, saveRegistry, inviteStatus, consumeInvite, refundInvite, recordUsage } from './invites.js';

const ENV_FILE = '/var/opt/apps/.intent.env';
const FUNNEL_FILE = '/var/opt/apps/.intent-funnel.jsonl';
const MAX_UTTERANCE = 2000;       // chars; a shop request is a sentence or two
const MAX_CONTEXT_BYTES = 64 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 12 };  // per IP
const RELAY_MAX_TOKENS = 4000;    // ceiling on what a relayed request may ask for

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

// One JSONL line per parse. Never throws — logging must not break parsing.
function appendFunnel(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: entry.source,                       // 'server' | 'browser'
      app: KNOWN_APPS.has(entry.app) ? entry.app : 'step_toolpath',
      utterance: clip(entry.utterance, MAX_UTTERANCE),
      summary: clip(entry.intent?.summary, 500),
      actions: (entry.intent?.actions ?? []).slice(0, 50),
      declined: (entry.intent?.declined ?? []).slice(0, 20),
      usage: entry.usage ?? null,
      invite: clip(entry.invite, 100),            // guest-pass holder, if any
    }) + '\n';
    fs.appendFileSync(FUNNEL_FILE, line);
  } catch (err) {
    console.error('[intent] funnel append failed:', err?.message ?? err);
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
      appendFunnel({ source: 'server', utterance, intent, usage });
      return res.json({ ok: true, intent, usage });
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
        response = await client.messages.create(clamped);
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
      const status = err?.status >= 400 && err?.status < 600 ? 502 : 500;
      console.error('[intent] loom relay failed:', err?.message ?? err);
      return res.status(status).json({ ok: false, error: 'The AI call failed — your prompt was not counted. Try again.' });
    }
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
    const { app: clientApp, utterance, intent, usage } = req.body ?? {};
    if (typeof utterance !== 'string' || !intent || typeof intent !== 'object') {
      return res.status(400).json({ ok: false });
    }
    const token = req.get('x-loom-invite');
    const invite = token ? loadRegistry()[token]?.name : undefined;
    appendFunnel({ source: 'browser', app: clientApp, invite, utterance, intent, usage });
    return res.json({ ok: true });
  });

  console.log('[intent] /api/intent/step + /api/intent/loom + /api/intent/invite + /api/intent/log mounted' + (readKey() ? '' : ' (no server key — proxy answers 503; BYO-key still works)'));
}
