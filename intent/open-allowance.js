// Open builds on the shop's key — no guest pass, no API key — metered two
// ways: a few builds per day per IP address, and a ceiling on open builds
// per day for the whole app. "Adoption before lock-down" (2026-11-01): the
// per-IP count is the fairness rule, the app cap is the abuse bound that
// keeps a bad day affordable. Guest passes and BYO keys are not counted
// here — a workshop on one wifi still gets its pass, a pro their own key.
//
// Both windows ROLL (24 h from each build, not a calendar day), so there
// is no midnight to game and the "come back at" time is exact: the oldest
// build in the window plus 24 h. A build that fails is refunded by its id.
//
// Ledger: one small JSON file, read fresh on every call (the CLI and the
// server share it), written in place so the file keeps its ownership. The
// file must be WRITABLE BY THE SERVER'S USER (production runs as nodeapp,
// the apps directory is root's): the constructor probes it at startup and
// warns loudly, and a build whose entry could not be recorded reports no
// count (`remaining: null`, `metered: false`) rather than a made-up one —
// 2026-11-01 the page said "2 more builds" after every build because the
// ledger could not be created and each take() started from an empty list.
// All clock-dependent calls take `now` (ms) so the test drives the clock.

import fs from 'node:fs';

export const LEDGER_FILE = '/var/opt/apps/.intent-open.json';
export const DEFAULTS = { perIp: 3, perApp: 100, windowMs: 24 * 3600 * 1000 };

export function normalizeIp(ip) {
  const s = String(ip ?? '').trim().replace(/^::ffff:/i, '');
  return s || 'unknown';
}

export class OpenAllowance {
  constructor({ file = LEDGER_FILE, perIp = DEFAULTS.perIp, perApp = DEFAULTS.perApp, windowMs = DEFAULTS.windowMs, log = console } = {}) {
    this.file = file;
    this.perIp = perIp;
    this.perApp = perApp;
    this.windowMs = windowMs;
    this.log = log;
    if (!this.save(this.load())) this.log.warn?.(`[open-allowance] ${this.file} is not writable by this process — open builds will NOT be counted`);
  }

  // entries still inside the window, oldest first
  load(now = Date.now()) {
    let entries = [];
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(j?.entries)) entries = j.entries.filter(e => e && typeof e.id === 'string' && typeof e.ip === 'string' && Number.isFinite(e.at));
    } catch { /* none yet, or unreadable: start empty */ }
    return entries.filter(e => now - e.at < this.windowMs).sort((a, b) => a.at - b.at);
  }
  // true when the ledger was written
  save(entries) {
    try {
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '{"entries":[]}', { mode: 0o600 });
      fs.writeFileSync(this.file, JSON.stringify({ entries }));
      return true;
    } catch (e) { this.log.warn?.(`[open-allowance] could not save ${this.file}: ${e?.message ?? e}`); return false; }
  }

  status(ip, now = Date.now()) {
    const entries = this.load(now);
    const mine = entries.filter(e => e.ip === normalizeIp(ip));
    return {
      ipUsed: mine.length, ipRemaining: Math.max(0, this.perIp - mine.length), ipResetsAt: mine.length ? new Date(mine[0].at + this.windowMs).toISOString() : null,
      appUsed: entries.length, appRemaining: Math.max(0, this.perApp - entries.length), appResetsAt: entries.length ? new Date(entries[0].at + this.windowMs).toISOString() : null,
      perIp: this.perIp, perApp: this.perApp, windowMs: this.windowMs,
    };
  }

  // one build for this IP, now: { ok, id, remaining, resetsAt, metered } or
  // { ok: false, reason: 'ip' | 'app', resetsAt } (when a slot frees);
  // `remaining` is null when the entry could not be recorded (not metered)
  take(ip, now = Date.now()) {
    const addr = normalizeIp(ip);
    const entries = this.load(now);
    if (entries.length >= this.perApp) {
      return { ok: false, reason: 'app', resetsAt: new Date(entries[0].at + this.windowMs).toISOString() };
    }
    const mine = entries.filter(e => e.ip === addr);
    if (mine.length >= this.perIp) {
      return { ok: false, reason: 'ip', resetsAt: new Date(mine[0].at + this.windowMs).toISOString() };
    }
    const id = 'ob_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    entries.push({ id, ip: addr, at: now });
    const metered = this.save(entries);
    return { ok: true, id, metered, remaining: metered ? this.perIp - mine.length - 1 : null, resetsAt: new Date((mine[0]?.at ?? now) + this.windowMs).toISOString() };
  }

  // the build failed: give the slot back
  refund(id, now = Date.now()) {
    const entries = this.load(now);
    const keep = entries.filter(e => e.id !== id);
    if (keep.length === entries.length) return false;
    this.save(keep);
    return true;
  }
}
