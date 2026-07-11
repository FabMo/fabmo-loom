#!/usr/bin/env node
// Guest-pass admin — mint, inspect, and revoke invite links for the Loom
// relay (see invites.js for the model: N prompts per 5-hour window, hard
// expiry date). Run on the server as root or any user that can write the
// registry; changes are live immediately (the server re-reads the file on
// every request).
//
//   node intent/invite-cli.mjs add "Ted @ MIT" [--days 7] [--until 2026-08-01]
//                                  [--per-window 20] [--base URL]
//   node intent/invite-cli.mjs list
//   node intent/invite-cli.mjs revoke <token-or-name>

import fs from 'fs';
import { execFileSync } from 'child_process';
import { REGISTRY_FILE, loadRegistry, saveRegistry, newToken, newInvite, inviteStatus } from './invites.js';

const DEFAULT_BASE = 'https://labs.shopbottools.com/c/brian.o/fabmo-loom/app/';

const [cmd, ...rest] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

function save(reg) {
  const fresh = !fs.existsSync(REGISTRY_FILE);
  saveRegistry(reg);
  if (fresh && process.getuid?.() === 0) {
    // the intent server (nodeapp) must be able to write window counts
    try {
      execFileSync('chown', ['nodeapp:apps-contributors', REGISTRY_FILE]);
      fs.chmodSync(REGISTRY_FILE, 0o660);
    } catch (e) {
      console.error(`WARN could not set ownership on ${REGISTRY_FILE}: ${e.message}`);
    }
  }
}

function fmtWhen(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

if (cmd === 'add') {
  const name = positional[0];
  if (!name) { console.error('usage: add "<name>" [--days N] [--until DATE] [--per-window N] [--base URL]'); process.exit(1); }
  const reg = loadRegistry();
  const token = newToken();
  reg[token] = newInvite(name, {
    days: flags.days ? Number(flags.days) : undefined,
    until: flags.until,
    perWindow: flags['per-window'] ? Number(flags['per-window']) : undefined,
  });
  save(reg);
  const e = reg[token];
  console.log(`minted guest pass for ${e.name}`);
  console.log(`  ${e.perWindow} prompts per 5-hour window · expires ${new Date(e.expires).toLocaleString()}`);
  console.log(`  ${(flags.base ?? DEFAULT_BASE)}?invite=${token}`);
} else if (cmd === 'list') {
  const reg = loadRegistry();
  const tokens = Object.keys(reg);
  if (!tokens.length) { console.log(`no invites (registry: ${REGISTRY_FILE})`); process.exit(0); }
  for (const t of tokens) {
    const e = reg[t];
    const s = inviteStatus(e);
    const state = s.valid ? `${s.remaining}/${e.perWindow} left${s.resetsAt ? `, resets ${fmtWhen(s.resetsAt)}` : ''}` : s.reason.toUpperCase();
    console.log(`${e.name}  [${t}]`);
    console.log(`  ${state} · ${e.totalUsed} prompts total · ${e.totalTokens.input}in/${e.totalTokens.output}out tokens · expires ${new Date(e.expires).toLocaleDateString()}`);
  }
} else if (cmd === 'revoke') {
  const who = positional[0];
  if (!who) { console.error('usage: revoke <token-or-name>'); process.exit(1); }
  const reg = loadRegistry();
  const matches = Object.keys(reg).filter(t => t === who || reg[t].name === who);
  if (!matches.length) { console.error(`no invite matches "${who}"`); process.exit(1); }
  if (matches.length > 1 && !reg[who]) { console.error(`"${who}" matches ${matches.length} invites — revoke by token`); process.exit(1); }
  const t = reg[who] ? who : matches[0];
  reg[t].revoked = true;
  save(reg);
  console.log(`revoked ${reg[t].name} [${t}]`);
} else {
  console.error('commands: add | list | revoke   (see header of this file)');
  process.exit(1);
}
