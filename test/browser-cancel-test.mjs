// Browser validation of cancel-on-new-picture in the full app (app/main.js):
// a generation whose model never answers is stopped the moment another
// picture is attached, the page is free at once, the design is untouched,
// and the next Generate goes out clean.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-cancel-test.mjs [url]

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'wingback-phone.png');
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`  ✓ ${m}`) : fail(m));

console.log(`=== browser cancel validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  // the model lives inside the page as a fetch stub; it never answers
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.setItem('loom:apiKey', 'sk-ant-test-not-real');
    localStorage.setItem('loom:introSeen', '1');
    window.__calls = 0; window.__aborted = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, init = {}) => {
      const u = typeof url === 'string' ? url : url?.url ?? String(url);
      if (u.startsWith('https://api.anthropic.com/v1/messages')) {
        window.__calls++;
        return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => { window.__aborted++; reject(new DOMException('aborted', 'AbortError')); }); });
      }
      return realFetch(url, init);
    };
  });
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.querySelectorAll('#introOverlay').forEach(el => el.remove()));
  await page.evaluate(() => { document.getElementById('prompt').value = 'a nameplate for Ada'; });
  await page.click('#generate');
  await page.waitForFunction(() => window.__calls >= 1 && document.getElementById('generate').disabled, { timeout: 15000 });
  ok(true, 'the generation is out and the button is held');

  const input = await page.$('#promptImageFile');
  await input.uploadFile(PHOTO);
  await page.waitForFunction(() => !document.getElementById('generate').disabled, { timeout: 15000 });
  const s = await page.evaluate(() => ({
    aborted: window.__aborted, label: document.getElementById('generate').textContent,
    strip: document.getElementById('promptImageStrip').style.display,
    note: [...document.querySelectorAll('#history .turn')].map(t => t.textContent).find(t => /Stopped the generation/.test(t)) ?? '',
    err: document.querySelectorAll('#history .turn.err').length,
    prompt: document.getElementById('prompt').value,
  }));
  ok(s.aborted === 1, 'the hung model call was aborted');
  ok(s.label === 'Generate', `the page is free at once ("${s.label}")`);
  ok(/Stopped the generation/.test(s.note), 'a turn says the generation was stopped');
  ok(s.err === 0, 'no error turn — stopping is not a failure');
  ok(s.strip === 'flex' && s.prompt === 'a nameplate for Ada', 'the new picture is attached and the typed ask is kept');

  await page.click('#generate');
  await page.waitForFunction(() => window.__calls >= 2, { timeout: 15000 });
  ok(true, 'the next Generate goes out');
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall cancel checks passed');
process.exit(failures ? 1 : 0);
