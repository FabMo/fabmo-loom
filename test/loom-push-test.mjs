// Web push for guest builds (intent/loom-push.js): keys are made once and
// reused, a subscription is accepted only in its real shape, the one
// message reads right for a finished / failed build. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadKeys, cleanSubscription, payloadFor, createPush } from '../intent/loom-push.js';

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; console.log(`  ✓ ${what}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-push-'));
const file = path.join(dir, 'keys.json');
const quiet = { log() {}, warn() {}, error() {} };

console.log('keys');
const k1 = loadKeys(file, quiet);
ok(typeof k1.publicKey === 'string' && k1.publicKey.length > 60 && typeof k1.privateKey === 'string', 'a key pair is generated on first use');
ok((fs.statSync(file).mode & 0o777) === 0o600, 'and saved root-only');
const k2 = loadKeys(file, quiet);
ok(k2.publicKey === k1.publicKey && k2.privateKey === k1.privateKey, 'the same pair comes back next time');
ok(createPush({ file, log: quiet }).publicKey === k1.publicKey, 'createPush serves that public key');

console.log('subscriptions');
const good = { endpoint: 'https://web.push.apple.com/QAbc123', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
const c = cleanSubscription({ subscription: good, page: '/c/brian.o/fabmo-loom/app/mobile.html' });
ok(c?.subscription.endpoint === good.endpoint && c.subscription.keys.auth === good.keys.auth && c.page === '/c/brian.o/fabmo-loom/app/mobile.html', 'a real subscription + page is kept');
ok(cleanSubscription(good)?.page === '', 'a bare subscription works too (no page)');
ok(cleanSubscription({ subscription: { ...good, endpoint: 'http://insecure' } }) === null, 'a non-https endpoint is refused');
ok(cleanSubscription({ subscription: { endpoint: good.endpoint, keys: { p256dh: 'x' } } }) === null, 'missing keys are refused');
ok(cleanSubscription({ subscription: good, page: 'https://evil.example/x' }).page === '', 'an off-site page is dropped (same-origin path only)');
ok(cleanSubscription({ subscription: good, page: '//evil.example/x' }).page === '', 'a protocol-relative page is dropped');
ok(cleanSubscription(null) === null && cleanSubscription('x') === null && cleanSubscription({}) === null, 'junk is null');

console.log('the message');
const done = payloadFor({ id: 'lj_1', status: 'done', push: { page: '/p/mobile.html' }, result: { summary: 'Built a 10" oval WELCOME sign with the letters V-carved, verified.', turns: [{ observation: { ok: true } }] } });
ok(done.title === 'Loom' && /^Your design is ready\. Built a 10" oval/.test(done.body) && done.tag === 'lj_1' && done.page === '/p/mobile.html', `done → "${done.body}"`);
const unverified = payloadFor({ id: 'lj_2', status: 'done', result: { summary: 'The plug still fails.', turns: [{ observation: { ok: false } }] } });
ok(/did not verify/.test(unverified.body), `done but refused → "${unverified.body}"`);
const failed = payloadFor({ id: 'lj_3', status: 'failed', error: 'The model took longer than 4 minutes to answer.' });
ok(/did not finish — The model took longer/.test(failed.body) && failed.page === '', `failed → "${failed.body}"`);
const long = payloadFor({ id: 'lj_4', status: 'done', result: { summary: 'word '.repeat(80), turns: [] } });
ok(long.body.length <= 180 && long.body.endsWith('…'), 'a long summary is trimmed to one notification');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nall ${pass} loom-push checks passed`);
