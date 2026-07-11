// Guest-pass invites — metered access to the shop's Anthropic key.
//
// An invite is a random token handed out as a link (?invite=lk_…). Each
// token gets `perWindow` prompts per 5-hour window, Claude-style: the
// window opens at the first prompt and unused prompts never accumulate.
// The window cap is the abuse bound; `expires` is the social contract
// (end of a workshop, end of a trial).
//
// Registry: one JSON file, read fresh on every request (adds and
// revocations take effect without a restart), written in place so the
// file keeps its ownership (the server runs as nodeapp; the CLI often
// runs as root — a tmp+rename here would silently flip the owner and
// lock the server out).
//
// All clock-dependent functions take `now` (ms) so the gauntlet can
// drive the clock.

import fs from 'fs';
import crypto from 'crypto';

export const REGISTRY_FILE = '/var/opt/apps/.intent-invites.json';
export const WINDOW_MS = 5 * 3600 * 1000;

export function newToken() {
  return 'lk_' + crypto.randomBytes(12).toString('base64url');
}

export function newInvite(name, { days = 7, until, perWindow = 20 } = {}, now = Date.now()) {
  const expires = until ? Date.parse(until) : now + days * 24 * 3600 * 1000;
  if (isNaN(expires)) throw new Error(`bad expiry date: ${until}`);
  return {
    name,
    created: new Date(now).toISOString(),
    expires: new Date(expires).toISOString(),
    perWindow,
    revoked: false,
    windowStart: null,   // ms epoch of the window-opening prompt
    windowUsed: 0,
    totalUsed: 0,
    totalTokens: { input: 0, output: 0 },
  };
}

export function loadRegistry(file = REGISTRY_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveRegistry(reg, file = REGISTRY_FILE) {
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
}

function windowState(entry, now) {
  const open = entry.windowStart != null && now - entry.windowStart < WINDOW_MS;
  return {
    open,
    used: open ? entry.windowUsed : 0,
    resetsAt: open && entry.windowUsed > 0 ? entry.windowStart + WINDOW_MS : null,
  };
}

// Status without consuming — feeds the app's guest-pass chip.
export function inviteStatus(entry, now = Date.now()) {
  if (!entry) return { valid: false, reason: 'unknown' };
  if (entry.revoked) return { valid: false, reason: 'revoked' };
  if (now > Date.parse(entry.expires)) return { valid: false, reason: 'expired', expires: entry.expires };
  const w = windowState(entry, now);
  return {
    valid: true,
    name: entry.name,
    perWindow: entry.perWindow,
    remaining: Math.max(0, entry.perWindow - w.used),
    resetsAt: w.resetsAt,
    expires: entry.expires,
  };
}

// Take one prompt from the window (opening a fresh window if the old one
// has lapsed). Mutates the entry; caller persists the registry.
export function consumeInvite(entry, now = Date.now()) {
  const s = inviteStatus(entry, now);
  if (!s.valid) return { ok: false, reason: s.reason, expires: s.expires };
  if (s.remaining <= 0) return { ok: false, reason: 'window', resetsAt: s.resetsAt };
  if (!windowState(entry, now).open) {
    entry.windowStart = now;
    entry.windowUsed = 0;
  }
  entry.windowUsed += 1;
  entry.totalUsed += 1;
  const after = inviteStatus(entry, now);
  return { ok: true, remaining: after.remaining, resetsAt: after.resetsAt };
}

// Undo one consume — used when the upstream API call itself fails, so a
// run of overload errors doesn't eat a guest's window.
export function refundInvite(entry) {
  entry.windowUsed = Math.max(0, entry.windowUsed - 1);
  entry.totalUsed = Math.max(0, entry.totalUsed - 1);
}

export function recordUsage(entry, usage) {
  entry.totalTokens.input += usage?.input ?? 0;
  entry.totalTokens.output += usage?.output ?? 0;
}
