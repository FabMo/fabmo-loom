// Browser validation of the FIRST DRAFT on the phone page (app/mobile.js):
// while a build runs, the first woven state is shown as soon as it exists —
// the loom overlay comes down, the design renders under a "FIRST DRAFT"
// badge with Download shut, the button carries the model's own progress
// line while it thinks — and the final result replaces it. Both paths:
// the guest job (the server posts `draft` / `note` on the poll) and a BYO
// key (runIntentLoop's onDraft, in the page).
//
// NOT part of npm test (needs the production server up):
//   node test/browser-mobile-draft-test.mjs [url]

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/mobile.html';
const PHOTO = path.join(HERE, '..', 'examples', 'wingback-phone.png');
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`  ✓ ${m}`) : fail(m));

// the model's two turns, and the recipe they leave behind (built here with
// the real applyActions so the page weaves exactly what a job would send)
const { EMPTY_RECIPE } = await import('../app/runtime.mjs');
const { applyActions } = await import('../app/intent.mjs');
const BUILD = { summary: 'Built a nameplate with a v-carved name.', actions: [
  { kind: 'set_name', name: 'Nameplate' },
  { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Name', default: 'Ada' } },
  { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1 } } },
], declined: [], suggest: [] };
const FINAL = { summary: 'Nameplate: the name v-carved, verified.', actions: [], declined: [], suggest: [] };
const RECIPE = applyActions(structuredClone(EMPTY_RECIPE), BUILD).recipe;
const DRAFT = { turn: 0, recipe: RECIPE, summary: BUILD.summary, declined: [], ok: true, errors: [] };
const RESULT = {
  recipe: RECIPE, summary: FINAL.summary, firstSummary: BUILD.summary, declined: [], suggest: [], stance: null,
  usage: { calls: 2, input_tokens: 2000, output_tokens: 300 }, revised: true, fixes: 0, rolledBack: null, claimIssues: [], claimsCaught: false,
  turns: [
    { payload: BUILD, applied: ['set_name', 'add_control', 'add_operation'], skipped: [], declined: [], summary: BUILD.summary, observation: { ok: true, errors: [], warnings: [], pieces: 1 } },
    { payload: FINAL, applied: [], skipped: [], declined: [], summary: FINAL.summary, observation: null },
  ],
};
const NOTE = 'Choosing a plain rectangular plate with the name centred.';
const localStorage_get = (v) => v ?? 'null';

console.log(`=== browser phone-page first-draft validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, isMobile: true });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  if (process.env.VERBOSE === '1') page.on('console', m => console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`));

  // The scripted server/model lives INSIDE the page as a fetch stub. The
  // guest job's GET walks through: thinking (with the model's note) → the
  // draft → done. The BYO model answers BUILD then FINAL at once.
  await page.evaluateOnNewDocument((draft, result, note, answers) => {
    if (!localStorage.getItem('test:init')) {
      localStorage.clear();
      localStorage.setItem('test:init', '1');
      localStorage.setItem('loom:invite', 'lk_testpass000000000');
    }
    window.__polls = 0; window.__calls = 0; window.__drafts = []; window.__tokens = [];
    const realFetch = window.fetch.bind(window);
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, init = {}) => {
      const u = typeof url === 'string' ? url : url?.url ?? String(url);
      const m = init.method ?? 'GET';
      if (u.includes('/api/intent/loom/job')) {
        const tok = init.headers?.['x-loom-invite'] ?? null;
        window.__tokens.push({ m, tok });
        if (m === 'POST') {
          // no pass → an open build with its own one-off token
          if (!tok) return json({ ok: true, job: 'lj_open', pass: 'op_test', allowance: { scope: 'open', remaining: 2, resetsAt: new Date(Date.now() + 86400e3).toISOString() } }, 202);
          return json({ ok: true, job: 'lj_1', invite: { name: 'test', remaining: 3 } }, 202);
        }
        if (m === 'DELETE') return json({ ok: true, cancelled: true });
        const n = ++window.__polls;
        if (n <= 2) return json({ ok: true, id: 'lj_1', status: 'running', stage: 'reading the picture…', note: n === 2 ? note : null, draft: null });
        if (n <= 5) return json({ ok: true, id: 'lj_1', status: 'running', stage: 'checking the weave…', note: null, draft });
        return json({ ok: true, id: 'lj_1', status: 'done', stage: null, note: null, draft, result });
      }
      if (u.startsWith('https://api.anthropic.com/v1/messages')) {
        const p = answers[Math.min(window.__calls++, answers.length - 1)];
        return json({ stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'tool_use', id: `tu_${window.__calls}`, name: 'apply_recipe_actions', input: p }] });
      }
      if (u.endsWith('/api/intent/log')) return json({ ok: true, queryId: 'q_test' });
      if (u.endsWith('/api/intent/loom/push/key')) return json({ ok: true, key: 'BNo_real_key_in_this_test' });
      return realFetch(url, init);
    };
  }, DRAFT, RESULT, NOTE, [BUILD, FINAL]);

  const state = () => page.evaluate(() => ({
    busy: window.loomMobile.busy, label: document.getElementById('build').textContent,
    badge: document.getElementById('badge').textContent, about: document.getElementById('about').textContent,
    dl: document.getElementById('dlSbp').disabled, result: document.getElementById('result').style.display,
    pipeline: window.loomMobile.recipe.pipeline.length, woven: !!window.loomMobile.result, ok: !!window.loomMobile.result?.ok,
    overlay: !!document.querySelector('#view3d > div[style*="z-index: 20"]'),
    polls: window.__polls, calls: window.__calls, drafts: window.__drafts, tokens: window.__tokens,
    msg: document.getElementById('msg').textContent, auth: document.getElementById('auth').style.display, ownKey: document.getElementById('ownKeyLine').style.display,
  }));
  const pickPhoto = async () => { const input = await page.$('#fileLib'); await input.uploadFile(PHOTO); };
  const waitBusy = (want, timeout = 20000) => page.waitForFunction((w) => window.loomMobile?.busy === w, { timeout }, want);

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.loomMobile?.ready, { timeout: 30000 });
  await page.evaluate(() => { window.loomMobile.onDraft = (d) => window.__drafts.push({ badge: document.getElementById('badge').textContent, dl: document.getElementById('dlSbp').disabled, about: document.getElementById('about').textContent, ok: d.ok }); });

  console.log('guest pass: the draft shows while the second look runs');
  await pickPhoto();
  await page.waitForFunction(() => document.getElementById('thumbWrap').style.display === 'flex', { timeout: 15000 });
  await page.click('#build');
  await waitBusy(true);
  // the model's note replaces the stage label on the button
  await page.waitForFunction(() => window.__polls >= 2, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 200));
  let s = await state();
  ok(s.label === NOTE, `while it thinks, the button carries the model's own line: "${s.label}"`);
  ok(s.overlay && !s.woven, 'the loom overlay is up, nothing rendered yet');
  // installable + push: the worker is registered, and with a guest build
  // running the page offers the ping (permission is still 'default' here)
  const sw = await page.evaluate(async () => ({ reg: !!(await navigator.serviceWorker.getRegistration()), scope: (await navigator.serviceWorker.getRegistration())?.scope ?? null, manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null, line: document.getElementById('pushLine').style.display, btn: document.getElementById('pushBtn').style.display, perm: Notification.permission }));
  ok(sw.reg && /\/app\/$/.test(sw.scope), `the service worker is registered at ${sw.scope}`);
  ok(sw.manifest === './manifest.webmanifest', 'the page links its manifest');
  ok(sw.line === 'block' && sw.btn !== 'none', `the "ping me" offer is up while the build runs (permission ${sw.perm})`);
  // the draft lands: overlay down, design rendered, badge says draft, download shut
  await page.waitForFunction(() => window.loomMobile.result, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 300));
  s = await state();
  ok(s.busy && s.ok && !s.overlay, 'the first draft is woven and on screen while the build is still running');
  ok(/FIRST DRAFT/.test(s.badge) && /verified/.test(s.badge), `the badge says so: "${s.badge}"`);
  ok(s.dl, 'Download is shut on a draft');
  ok(s.about === BUILD.summary, 'the first summary is shown with it');
  ok(/checking the weave/.test(s.label), `the button says what the second look is doing: "${s.label}"`);
  ok(s.pipeline === 0, 'the recipe itself is not committed yet');
  // the final replaces it
  await waitBusy(false, 40000);
  await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 20000 });
  s = await state();
  ok(s.pipeline === 1 && s.badge === 'VERIFIED' && !s.dl, `the final state landed: ${s.pipeline} op, ${s.badge}, Download open`);
  ok((await page.evaluate(() => document.getElementById('pushLine').style.display)) === 'none', 'the ping offer goes when the build ends');
  ok(s.about === FINAL.summary, 'the final summary replaced the first');
  ok(s.drafts.length === 1 && /FIRST DRAFT/.test(s.drafts[0].badge) && s.drafts[0].dl, 'the draft hook fired once, with the draft badge up and Download shut');

  console.log('no pass, no key: an open build on the shop key');
  await page.evaluate(() => { localStorage.removeItem('loom:invite'); localStorage.removeItem('loom:apiKey'); });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.loomMobile?.ready, { timeout: 30000 });
  s = await state();
  ok(s.auth === 'none' && s.ownKey === 'block', 'the key box stays closed; "Use my own API key" is offered instead');
  await page.evaluate(() => { window.__polls = 0; window.__tokens = []; });
  await page.click('#reset');
  await page.evaluate(() => { document.getElementById('prompt').value = 'a nameplate for Ada'; });
  await page.click('#build');
  await waitBusy(true);
  await page.waitForFunction(() => window.__polls >= 1, { timeout: 15000 });
  s = await state();
  const post = s.tokens.find(t => t.m === 'POST'), gets = s.tokens.filter(t => t.m === 'GET');
  ok(post && post.tok === null, 'the build is posted with no pass header');
  ok(gets.length && gets.every(t => t.tok === 'op_test'), `the job is polled with the one-off pass the server handed back (${gets[0]?.tok})`);
  ok(/2 more free builds today/.test(s.msg), `the allowance is shown: "${s.msg}"`);
  ok(JSON.parse(localStorage_get(await page.evaluate(() => localStorage.getItem('loom:job'))))?.pass === 'op_test', 'the pass is kept with the job for a reopen');
  await waitBusy(false, 40000);
  await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 20000 });
  ok((await state()).pipeline === 1, 'and the open build lands like any other');

  console.log('BYO key: the draft comes from the loop in the page');
  await page.evaluate(() => { localStorage.removeItem('loom:invite'); localStorage.setItem('loom:apiKey', 'sk-ant-test-not-real'); });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.loomMobile?.ready, { timeout: 30000 });
  await page.evaluate(() => { window.loomMobile.onDraft = (d) => window.__drafts.push({ badge: document.getElementById('badge').textContent, dl: document.getElementById('dlSbp').disabled, about: document.getElementById('about').textContent, ok: d.ok }); });
  await page.click('#reset');
  await page.evaluate(() => { document.getElementById('prompt').value = 'a nameplate for Ada'; });
  await page.click('#build');
  await waitBusy(true);
  await waitBusy(false, 60000);
  await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 20000 });
  s = await state();
  ok(s.calls === 2 && s.pipeline === 1 && s.badge === 'VERIFIED', `the two-call loop finished (${s.calls} calls, ${s.pipeline} op, ${s.badge})`);
  ok(s.drafts.length === 1 && /FIRST DRAFT/.test(s.drafts[0].badge) && s.drafts[0].dl && s.drafts[0].ok && s.drafts[0].about === BUILD.summary, `the draft showed between the calls (badge "${s.drafts[0]?.badge}", Download shut, first summary)`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall phone-page first-draft checks passed');
process.exit(failures ? 1 : 0);
