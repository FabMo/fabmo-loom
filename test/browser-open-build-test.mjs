// Browser validation of FREE (open) builds in the full app (app/main.js):
// with no API key and no guest pass, Generate runs the turn on the server
// as a job — the same path and the same daily allowance as the phone page.
//
//   1. a real open build end to end (spends one free build and a few cents)
//   2. a reload mid-build picks the saved ticket up
//   3. the allowance running out says so and opens the key box
//   4. a new picture mid-build stops the job on the server
//
// NOT part of npm test (needs the production server up, and step 1 calls
// the model on the shop key):
//   node test/browser-open-build-test.mjs [url] [--no-live]

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const LIVE = !args.includes('--no-live');
const URL = args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'wingback-phone.png');
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`  ✓ ${m}`) : fail(m));

console.log(`=== browser open-build validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
async function open(setup = () => {}, arg = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('loom:introSeen', '1'); });
  await page.evaluateOnNewDocument(setup, arg);
  await page.goto(URL, { waitUntil: 'networkidle2' });
  return page;
}
const ask = async (page, text) => {
  await page.evaluate((t) => { document.getElementById('prompt').value = t; }, text);
  await page.click('#generate');
};
const state = (page) => page.evaluate(() => ({
  did: document.querySelector('#history .turn .did')?.textContent ?? '',
  errs: [...document.querySelectorAll('#history .turn.err')].map(t => t.textContent),
  bar: document.getElementById('inviteBar').textContent,
  barShown: document.getElementById('inviteBar').style.display !== 'none',
  keyBox: document.getElementById('keyBox').open,
  ticket: localStorage.getItem('loom:job:desktop'),
  label: document.getElementById('generate').textContent,
  disabled: document.getElementById('generate').disabled,
  ops: JSON.parse(localStorage.getItem('loom:recipe') ?? 'null')?.pipeline?.length ?? null,
}));

try {
  let ticket = null;
  if (LIVE) {
    console.log('--- 1. a real free build, no key and no pass ---');
    const page = await open();
    let posted = null;
    page.on('response', async (r) => {
      if (r.url().endsWith('/api/intent/loom/job') && r.request().method() === 'POST') posted = { status: r.status(), body: await r.json().catch(() => ({})), sent: JSON.parse(r.request().postData() ?? '{}') };
    });
    await ask(page, 'a nameplate that says ADA, about 8 inches wide');
    await page.waitForFunction(() => document.getElementById('generate').disabled, { timeout: 15000 });
    await page.waitForFunction(() => !!localStorage.getItem('loom:job:desktop') || !document.getElementById('generate').disabled, { timeout: 30000 });
    const mid = await state(page);
    ok(posted?.status === 202 && /^op_/.test(posted.body.pass ?? ''), `the server took it as an open build (HTTP ${posted?.status}, allowance ${JSON.stringify(posted?.body.allowance)})`);
    ok(posted?.sent.client === undefined, 'no phone flag rides along (the sketch dialog exists here)');
    ok(!!mid.ticket, 'the ticket is saved while the build runs');
    await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 420000 });
    const s = await state(page);
    ok(s.errs.length === 0, `no error turn ${s.errs.join(' | ')}`);
    ok(s.did.length > 0, `the turn landed: "${s.did.slice(0, 90)}"`);
    const verdict = await page.evaluate(() => document.getElementById('badge').textContent + ' ' + document.getElementById('verdictText').textContent);
    console.log(`    verdict: ${verdict.trim().slice(0, 80)}`);
    ok(s.barShown && /Free build|last free build/.test(s.bar), `the allowance chip shows: "${s.bar}"`);
    ok(s.ticket === null, 'the ticket is cleared once the build lands');
    ok(s.label === 'Generate', 'the page is free again');
    ticket = { id: posted.body.job, pass: posted.body.pass, utterance: 'a nameplate that says ADA, about 8 inches wide', startedAt: Date.now() };
    await page.close();
  }

  console.log('\n--- 2. a reload picks a saved build up ---');
  if (ticket) {
    const page = await open((t) => { localStorage.setItem('loom:job:desktop', JSON.stringify(t)); }, ticket);
    await page.waitForFunction(() => document.querySelector('#history .turn .did') || document.querySelector('#history .turn.err'), { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 60000 });
    const s = await state(page);
    ok(s.errs.length === 0 && s.did.length > 0, `the finished build was picked up from the server ${s.errs.join(' | ')}`);
    ok(s.ops > 0, `its design is on the page (${s.ops} ops)`);
    ok(s.ticket === null, 'the ticket is cleared');
    await page.close();
  } else console.log('    (skipped: needs the live build from step 1)');
  {
    // a ticket the server no longer has: one plain message, ticket dropped
    const page = await open(() => { localStorage.setItem('loom:job:desktop', JSON.stringify({ id: 'nope', pass: 'op_nope', utterance: 'a lost build' })); });
    await page.waitForFunction(() => document.querySelector('#history .turn.err'), { timeout: 30000 });
    const s = await state(page);
    ok(/no longer on the server/.test(s.errs[0] ?? ''), `a build the server lost says so: "${(s.errs[0] ?? '').slice(0, 100)}"`);
    ok(s.ticket === null && !s.disabled, 'ticket dropped, page free');
    await page.close();
  }

  console.log('\n--- 3. the allowance is used up ---');
  {
    const page = await open(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, init = {}) => {
        const u = typeof url === 'string' ? url : url?.url ?? String(url);
        if (u.endsWith('/api/intent/loom/job')) return Promise.resolve(new Response(JSON.stringify({ ok: false, reason: 'ip', resetsAt: new Date(Date.now() + 3600e3).toISOString(), error: 'used up' }), { status: 429, headers: { 'content-type': 'application/json' } }));
        return realFetch(url, init);
      };
    });
    await ask(page, 'a nameplate for Ada');
    await page.waitForFunction(() => document.querySelector('#history .turn.err'), { timeout: 15000 });
    const s = await state(page);
    ok(/free builds from this network are used up/.test(s.errs[0] ?? ''), `it says why: "${(s.errs[0] ?? '').slice(0, 140)}"`);
    ok(s.keyBox, 'the key box opens — the remedy');
    ok(!s.disabled && s.ticket === null, 'the page is free, no ticket');
    await page.close();
  }

  console.log('\n--- 4. a new picture stops the build on the server ---');
  {
    const page = await open(() => {
      window.__deleted = []; window.__polls = 0;
      const realFetch = window.fetch.bind(window);
      const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
      window.fetch = (url, init = {}) => {
        const u = typeof url === 'string' ? url : url?.url ?? String(url);
        if (u.endsWith('/api/intent/loom/job')) return json({ ok: true, job: 'j1', pass: 'op_test', allowance: { scope: 'open', remaining: 2 } }, 202);
        if (u.includes('/api/intent/loom/job/')) {
          if (init.method === 'DELETE') { window.__deleted.push([u, init.headers['x-loom-invite']]); return json({ ok: true, cancelled: true }); }
          window.__polls++;
          return json({ ok: true, status: 'running', note: 'Choosing a plaque with a pocketed name.' });
        }
        return realFetch(url, init);
      };
    });
    await ask(page, 'a nameplate for Ada');
    await page.waitForFunction(() => window.__polls >= 1, { timeout: 15000 });
    const mid = await state(page);
    ok(/2 more today/.test(mid.bar), `the chip counts down: "${mid.bar}"`);
    const overlayText = await page.evaluate(() => document.getElementById('appPanel').textContent);
    ok(/Choosing a plaque/.test(overlayText) || /Choosing a plaque/.test(mid.label), "the model's own progress line shows while it works");
    const input = await page.$('#promptImageFile');
    await input.uploadFile(PHOTO);
    await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 15000 });
    const s = await state(page);
    const del = await page.evaluate(() => window.__deleted);
    ok(del.length === 1 && del[0][0].endsWith('/job/j1') && del[0][1] === 'op_test', 'the job was stopped on the server with its own pass');
    ok(s.ticket === null && s.errs.length === 0, 'ticket dropped, no error turn');
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall open-build checks passed');
process.exit(failures ? 1 : 0);
