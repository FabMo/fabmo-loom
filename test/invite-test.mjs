// Guest-pass gauntlet — drives the invite window logic with an injected
// clock, both directions: valid passes meter correctly, and every refusal
// path (exhausted window, expiry, revocation, unknown) actually refuses.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newInvite, newToken, inviteStatus, consumeInvite, refundInvite, recordUsage, loadRegistry, saveRegistry, WINDOW_MS } from '../intent/invites.js';

let failures = 0;
function check(label, got, want) {
  const ok = Object.is(got, want);
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

const T0 = Date.parse('2026-07-20T09:00:00Z');   // fixed epoch — no wall clock in the gauntlet
const HOUR = 3600 * 1000;

console.log('fresh invite');
const inv = newInvite('Ted @ MIT', { days: 7, perWindow: 5 }, T0);
let s = inviteStatus(inv, T0);
check('valid', s.valid, true);
check('remaining = perWindow before first prompt', s.remaining, 5);
check('no reset time before first prompt', s.resetsAt, null);

console.log('window opens at first prompt, meters down');
let r = consumeInvite(inv, T0);
check('first consume ok', r.ok, true);
check('remaining after 1', r.remaining, 4);
check('resets 5h after FIRST prompt', r.resetsAt, T0 + WINDOW_MS);
consumeInvite(inv, T0 + 1 * HOUR);
consumeInvite(inv, T0 + 2 * HOUR);
r = consumeInvite(inv, T0 + 2 * HOUR);
check('mid-window consumes keep original reset time', r.resetsAt, T0 + WINDOW_MS);
check('remaining after 4', r.remaining, 1);

console.log('exhausted window refuses with the reset time');
consumeInvite(inv, T0 + 3 * HOUR);
r = consumeInvite(inv, T0 + 3 * HOUR);
check('6th prompt refused', r.ok, false);
check('refusal reason', r.reason, 'window');
check('refusal carries resetsAt', r.resetsAt, T0 + WINDOW_MS);
check('totals counted only granted prompts', inv.totalUsed, 5);

console.log('window lapses — full quota again, nothing accumulated');
s = inviteStatus(inv, T0 + WINDOW_MS + 1);
check('status shows full quota after lapse', s.remaining, 5);
r = consumeInvite(inv, T0 + 6 * HOUR);
check('consume ok in new window', r.ok, true);
check('new window remaining', r.remaining, 4);
check('new window resets 5h after ITS first prompt', r.resetsAt, T0 + 6 * HOUR + WINDOW_MS);

console.log('refund gives the prompt back');
refundInvite(inv);
s = inviteStatus(inv, T0 + 6 * HOUR);
check('remaining after refund', s.remaining, 5);
check('total after refund', inv.totalUsed, 5);

console.log('expiry and revocation refuse');
s = inviteStatus(inv, T0 + 8 * 24 * HOUR);
check('expired pass invalid', s.valid, false);
check('expired reason', s.reason, 'expired');
r = consumeInvite(inv, T0 + 8 * 24 * HOUR);
check('expired consume refused', r.ok, false);
const rev = newInvite('Mallory', { days: 7 }, T0);
rev.revoked = true;
check('revoked consume refused', consumeInvite(rev, T0).ok, false);
check('revoked reason', consumeInvite(rev, T0).reason, 'revoked');
check('unknown token invalid', inviteStatus(undefined, T0).valid, false);

console.log('usage totals accumulate');
recordUsage(inv, { input: 3200, output: 410 });
recordUsage(inv, { input: 2800, output: 390 });
check('input tokens', inv.totalTokens.input, 6000);
check('output tokens', inv.totalTokens.output, 800);

console.log('registry file roundtrip preserves state');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'invite-registry.json');
const tok = newToken();
check('token shape', /^lk_[A-Za-z0-9_-]{16}$/.test(tok), true);
saveRegistry({ [tok]: inv }, file);
const back = loadRegistry(file)[tok];
check('roundtrip name', back.name, 'Ted @ MIT');
check('roundtrip windowUsed', back.windowUsed, inv.windowUsed);
check('roundtrip total tokens', back.totalTokens.input, 6000);
check('missing file loads empty', Object.keys(loadRegistry(file + '.nope')).length, 0);
fs.rmSync(file);

if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
console.log('\nall invite checks passed');
