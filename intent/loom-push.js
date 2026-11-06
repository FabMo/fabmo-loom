// Web push for guest builds: ONE notification when a server-side Loom job
// ends (intent/loom-jobs.js), so the guest can leave the phone page for
// another app — iOS suspends a backgrounded tab within a minute or two —
// and come back when the design is ready. The phone page (app/mobile.js +
// app/sw.js) subscribes after a build starts and attaches the subscription
// to that job; the job record carries it until the job finishes.
//
// VAPID keys are generated once and kept root-only beside the API key.
// The VAPID subject is the site, never a person's address (it is sent to
// Apple's and Google's push services with every message).

import fs from 'node:fs';
import webpush from 'web-push';

export const KEY_FILE = '/var/opt/apps/.loom-push.json';
export const SUBJECT = 'https://labs.shopbottools.com';
const MAX_ENDPOINT = 2048, MAX_PAGE = 512;

// the key pair, created on first use
export function loadKeys(file = KEY_FILE, log = console) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof k?.publicKey === 'string' && typeof k?.privateKey === 'string') return k;
  } catch { /* none yet */ }
  const k = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 }); }
  catch (e) { log.warn?.(`[loom-push] could not save keys to ${file}: ${e?.message ?? e} — pings will stop working at the next restart`); }
  return k;
}

// What the phone POSTs: a PushSubscription's JSON plus the page to reopen.
// Returns the cleaned record or null.
export function cleanSubscription(body) {
  const s = body?.subscription ?? body;
  if (!s || typeof s !== 'object') return null;
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint : '';
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > MAX_ENDPOINT) return null;
  const p256dh = s.keys?.p256dh, auth = s.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,100}$/.test(auth)) return null;
  // the page to reopen on tap: a same-origin PATH only
  let page = typeof body?.page === 'string' ? body.page : '';
  if (!/^\/[^\s]*$/.test(page) || page.startsWith('//') || page.length > MAX_PAGE) page = '';
  return { subscription: { endpoint, keys: { p256dh, auth } }, page };
}

// the one message, from the finished job record
export function payloadFor(job) {
  const trim = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
  let body;
  if (job.status === 'done') {
    const ok = job.result?.turns?.some(t => t.observation?.ok) ?? null;
    const summary = trim(job.result?.summary, 110);
    body = (ok === false ? 'The build finished but did not verify. ' : 'Your design is ready. ') + summary;
  } else {
    body = `The build did not finish — ${trim(job.error, 120) || 'ask again.'}`;
  }
  return { title: 'Loom', body: trim(body, 180), tag: job.id, page: job.push?.page || '' };
}

// send one notification; a gone subscription (404/410) is reported, not thrown
export async function send(keys, subscription, payload, { ttl = 3600 } = {}) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: ttl,
    });
    return { ok: true };
  } catch (e) {
    const status = e?.statusCode ?? null;
    return { ok: false, status, gone: status === 404 || status === 410, error: e?.body || e?.message || String(e) };
  }
}

// what server.js wires: keys loaded once, notify(job) for LoomJobs
export function createPush({ file = KEY_FILE, log = console } = {}) {
  const keys = loadKeys(file, log);
  return {
    keys,
    publicKey: keys.publicKey,
    async notify(job) {
      if (!job?.push?.subscription) return null;
      const r = await send(keys, job.push.subscription, payloadFor(job));
      if (r.ok) log.log?.(`[loom-push] ${job.id} pinged (${job.status})`);
      else log.warn?.(`[loom-push] ${job.id} ping failed${r.status ? ` (${r.status})` : ''}: ${String(r.error).slice(0, 200)}`);
      return r;
    },
  };
}
