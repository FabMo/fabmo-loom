// Open builds (intent/open-allowance.js): 3 a day per IP, 100 a day for
// the app, both rolling 24 h windows; a failed build is refunded; the
// ledger survives a restart. The clock is driven by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OpenAllowance, normalizeIp } from '../intent/open-allowance.js';

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; console.log(`  ✓ ${what}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-allowance-'));
const file = path.join(dir, 'open.json');
const quiet = { warn() {} };
const H = 3600_000, DAY = 24 * H;
// a few hours ago by the REAL clock: the constructor prunes the ledger with
// Date.now(), so a fixed date goes stale a day after it is written
const T0 = Math.floor(Date.now() / 1000) * 1000 - 6 * H;

console.log('per IP');
const open = new OpenAllowance({ file, perIp: 3, perApp: 100, log: quiet });
ok(normalizeIp('::ffff:203.0.113.9') === '203.0.113.9' && normalizeIp('') === 'unknown', 'IPv4-mapped addresses are plain, empty is "unknown"');
const a1 = open.take('203.0.113.9', T0), a2 = open.take('203.0.113.9', T0 + H), a3 = open.take('203.0.113.9', T0 + 2 * H);
ok(a1.ok && a1.remaining === 2 && a2.ok && a2.remaining === 1 && a3.ok && a3.remaining === 0, 'three builds in a day go through (remaining 2, 1, 0)');
const a4 = open.take('203.0.113.9', T0 + 3 * H);
ok(!a4.ok && a4.reason === 'ip' && a4.resetsAt === new Date(T0 + DAY).toISOString(), `the fourth is refused until the oldest ages out (${a4.resetsAt})`);
ok(open.take('198.51.100.7', T0 + 3 * H).ok, 'another address is unaffected');
ok(open.status('203.0.113.9', T0 + 3 * H).ipRemaining === 0 && open.status('198.51.100.7', T0 + 3 * H).ipRemaining === 2, 'status reads per address');
ok(open.take('203.0.113.9', T0 + DAY + 1).ok, 'a slot frees 24 h after the first build (rolling, no midnight)');

console.log('refunds');
const r = open.take('192.0.2.1', T0), r2 = open.take('192.0.2.1', T0), r3 = open.take('192.0.2.1', T0);
ok(r.ok && r2.ok && r3.ok && !open.take('192.0.2.1', T0).ok, 'an address is at its limit');
ok(open.refund(r2.id, T0) === true, 'a failed build is refunded by id');
ok(open.take('192.0.2.1', T0).ok, 'and the slot is usable again');
ok(open.refund('ob_nope', T0) === false, 'an unknown id refunds nothing');

console.log('the app cap');
const capped = new OpenAllowance({ file: path.join(dir, 'cap.json'), perIp: 3, perApp: 5, log: quiet });
for (let i = 0; i < 5; i++) ok(capped.take(`10.0.0.${i}`, T0 + i).ok, `open build ${i + 1} of 5 from a fresh address`);
const over = capped.take('10.0.0.99', T0 + 10);
ok(!over.ok && over.reason === 'app' && over.resetsAt === new Date(T0 + DAY).toISOString(), 'the sixth is refused for the whole app, until the oldest ages out');
ok(capped.status('10.0.0.99', T0 + 10).appRemaining === 0, 'status says the app is full');
ok(capped.take('10.0.0.99', T0 + DAY + 1).ok, 'a day after the first build the app has room again');

console.log('persistence');
const again = new OpenAllowance({ file, perIp: 3, perApp: 100, log: quiet });
ok(again.status('192.0.2.1', T0).ipRemaining === 0, 'a new instance on the same file sees the counts (restart-safe)');
ok((fs.statSync(file).mode & 0o777) === 0o600, 'the ledger is created root-only');
fs.writeFileSync(file, 'not json');
ok(new OpenAllowance({ file, log: quiet }).take('192.0.2.1', T0).ok, 'a damaged ledger starts over instead of blocking builds');
const warned = [];
const stuck = new OpenAllowance({ file: dir, log: { warn: (m) => warned.push(m) } });   // a directory: never writable as a file
ok(warned.some(m => /not writable/.test(m)), 'an unwritable ledger is warned about at startup');
const un = stuck.take('192.0.2.1', T0);
ok(un.ok && un.metered === false && un.remaining === null, 'a build it cannot record still runs, but reports no count (nothing is made up)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nall ${pass} open-allowance checks passed`);
