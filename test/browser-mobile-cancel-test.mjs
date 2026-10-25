// Browser validation of "a new photo starts over" on the phone page
// (app/mobile.js): a build that never finishes — the guest job stays
// 'running', or the BYO model never answers — is cancelled the moment a
// new photo is picked, the server is told to stop the job (it refunds the
// prompt), the design is cleared, and the page is ready to build again.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-mobile-cancel-test.mjs [url]

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/mobile.html';
const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'wingback-phone.png');
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`  ✓ ${m}`) : fail(m));

// a quick model for the "design already on the page" case
const ANSWER = [
  { summary: 'Built a nameplate with a v-carved name.', actions: [
    { kind: 'set_name', name: 'Nameplate' },
    { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Name', default: 'Ada' } },
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1 } } },
  ], declined: [], suggest: [] },
  { summary: 'Nameplate: the name v-carved, verified.', actions: [], declined: [], suggest: [] },
];

console.log(`=== browser phone-page cancel validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, isMobile: true });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  if (process.env.VERBOSE === '1') page.on('console', m => console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`));

  // The scripted server/model lives INSIDE the page as a fetch stub (network
  // interception stalls the weave worker's imports). Mode is read per call:
  //   'guest' — the job API: POST starts lj_N, GET says running forever, DELETE is recorded
  //   'hang'  — BYO: api.anthropic.com never answers
  //   'answer'— BYO: api.anthropic.com plays ANSWER
  await page.evaluateOnNewDocument((answer) => {
    if (!localStorage.getItem('test:init')) {   // first load only — the BYO section reloads with its own settings
      localStorage.clear();
      localStorage.setItem('test:init', '1');
      localStorage.setItem('loom:invite', 'lk_testpass000000000');
    }
    window.__posts = 0; window.__deleted = []; window.__calls = 0;
    const realFetch = window.fetch.bind(window);
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, init = {}) => {
      const u = typeof url === 'string' ? url : url?.url ?? String(url);
      const m = init.method ?? 'GET';
      if (u.includes('/api/intent/loom/job')) {
        if (m === 'POST') { window.__posts++; return json({ ok: true, job: `lj_${window.__posts}`, invite: { name: 'test', remaining: 3 } }, 202); }
        if (m === 'DELETE') { window.__deleted.push(u.split('/').pop()); return json({ ok: true, cancelled: true }); }
        return json({ ok: true, id: u.split('/').pop(), status: 'running', stage: 'thinking…' });
      }
      if (u.startsWith('https://api.anthropic.com/v1/messages')) {
        window.__calls++;
        if (localStorage.getItem('test:mode') !== 'answer') return new Promise(() => {});   // hang
        const p = answer[Math.min(window.__calls - 1, answer.length - 1)];
        return json({ stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'tool_use', id: `tu_${window.__calls}`, name: 'apply_recipe_actions', input: p }] });
      }
      if (u.endsWith('/api/intent/log')) return json({ ok: true, queryId: 'q_test' });
      return realFetch(url, init);
    };
  }, ANSWER);

  const state = () => page.evaluate(() => ({
    busy: window.loomMobile.busy, label: document.getElementById('build').textContent, disabled: document.getElementById('build').disabled,
    msg: document.getElementById('msg').textContent, result: document.getElementById('result').style.display,
    thumb: document.getElementById('thumbWrap').style.display, job: localStorage.getItem('loom:job'),
    pipeline: window.loomMobile.recipe.pipeline.length, posts: window.__posts, deleted: window.__deleted, calls: window.__calls,
  }));
  const pickPhoto = async () => { const input = await page.$('#fileLib'); await input.uploadFile(PHOTO); };
  const waitBusy = (want, timeout = 15000) => page.waitForFunction((w) => window.loomMobile?.busy === w, { timeout }, want);

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.loomMobile?.ready, { timeout: 30000 });

  console.log('guest pass: the job never finishes');
  await pickPhoto();
  await page.waitForFunction(() => document.getElementById('thumbWrap').style.display === 'flex', { timeout: 15000 });
  await page.click('#build');
  await waitBusy(true);
  let s = await state();
  ok(s.posts === 1 && s.disabled && s.job?.includes('lj_1'), `the build is running as job lj_1 and the button is held (${s.label})`);
  await new Promise(r => setTimeout(r, 600));
  await pickPhoto();
  await waitBusy(false);
  await page.waitForFunction(() => document.getElementById('thumbWrap').style.display === 'flex', { timeout: 15000 });
  s = await state();
  ok(s.deleted.includes('lj_1'), 'the server was told to stop lj_1');
  ok(!s.disabled && s.label === 'Build it', `the page is free at once: "${s.label}"`);
  ok(/Stopped/.test(s.msg), `the message says so: "${s.msg}"`);
  ok(s.result === 'none' && s.job === null && s.pipeline === 0, 'no design, no remembered job');
  ok(s.thumb === 'flex', 'the new photo is attached');

  console.log('and building again works');
  await page.click('#build');
  await waitBusy(true);
  s = await state();
  ok(s.posts === 2 && s.job?.includes('lj_2'), 'a second build starts as lj_2');
  await page.click('#reset');
  await waitBusy(false);
  s = await state();
  ok(s.deleted.includes('lj_2') && s.job === null && s.thumb === 'none', 'Start over stops it too (and drops the photo)');

  console.log('BYO key: the model never answers');
  await page.evaluate(() => { localStorage.removeItem('loom:invite'); localStorage.setItem('loom:apiKey', 'sk-ant-test-not-real'); localStorage.setItem('test:mode', 'hang'); });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.loomMobile?.ready, { timeout: 30000 });
  await pickPhoto();
  await page.waitForFunction(() => document.getElementById('thumbWrap').style.display === 'flex', { timeout: 15000 });
  await page.click('#build');
  await waitBusy(true);
  await page.waitForFunction(() => window.__calls >= 1, { timeout: 15000 });
  const deletedBefore = (await state()).deleted.length;
  await pickPhoto();
  await waitBusy(false);
  s = await state();
  ok(!s.disabled && s.label === 'Build it' && /Stopped/.test(s.msg), 'the hung model call is abandoned and the page is free');
  ok(s.deleted.length === deletedBefore, 'no server job to stop on the BYO path');

  console.log('a finished design: a new photo starts over');
  await page.evaluate(() => { localStorage.setItem('test:mode', 'answer'); window.__calls = 0; });
  await page.evaluate(() => { document.getElementById('prompt').value = 'a nameplate for Ada'; });
  await page.click('#build');
  await waitBusy(true);
  await waitBusy(false, 60000);
  s = await state();
  ok(s.pipeline === 1 && s.label === 'Apply change' && s.result === 'block', `the model's build landed (${s.pipeline} op, "${s.label}")`);
  await pickPhoto();
  await page.waitForFunction(() => document.getElementById('build').textContent === 'Build it', { timeout: 15000 });
  s = await state();
  ok(s.pipeline === 0 && s.result === 'none' && s.thumb === 'flex' && s.msg === '', 'the design is cleared, the new photo is in, nothing to report');
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall phone-page cancel checks passed');
process.exit(failures ? 1 : 0);
