// Browser validation of step_toolpath_app — the part the headless pipeline
// tests can't reach: module loading via importmap CDN, occt WASM init in a
// real document, the Three.js preview, feature-list UI, status flow, and
// the verifier-gated export buttons. Drives the LIVE dev route
// (production.js auto-discovers /c/<user>/<app>/) in headless Chromium.
//
// NOT part of npm test (needs the production server up + CDN access):
//   node test/browser-step-test.mjs [url] [step-file]
//
// Writes screenshots to test/out/browser-*.png.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/step_toolpath_app/';
const STEP = process.argv[3] || '/var/opt/apps/contributors/brian.o/step_toolpath_app/test_parts/Test Part V2.stp';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

console.log(`=== browser validation: ${URL} ===\n`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    if (process.env.VERBOSE) console.log(`  [console.${m.type()}] ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => consoleErrors.push(`requestfailed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));

  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (resp.ok()) pass(`page loaded (${resp.status()})`);
  else fail(`page load status ${resp.status()}`);

  // app shell up?
  await page.waitForSelector('#fileInput', { timeout: 10000 });
  // module graph loaded? main.js sets window.toggleFeature at the end —
  // proves the importmap CDN three.js + all app modules resolved
  try {
    await page.waitForFunction(() => typeof window.toggleFeature === 'function', { timeout: 45000 });
    pass('main.js module graph loaded (CDN imports resolved)');
  } catch {
    for (const e of consoleErrors.slice(0, 8)) console.log(`  console error: ${e}`);
    fail('main.js never initialized — module/CDN load failure');
    throw new Error('app did not initialize');
  }
  const status0 = await page.$eval('#statusText', el => el.textContent);
  pass(`app initialized, status: "${status0.trim()}"`);
  await page.screenshot({ path: path.join(out, 'browser-1-loaded.png') });

  // upload the STEP file — handleFile runs the whole flow:
  // occt parse → detect → auto-generate verified job
  const input = await page.$('#fileInput');
  await input.uploadFile(STEP);

  // wait for the generate flow to land (status mentions Verified or an
  // error). Polled via Runtime.evaluate, with progress echoed — a stalled
  // echo means the page's main thread is pegged.
  {
    const deadline = Date.now() + 180000;
    let landed = false, lastSeen = '';
    while (Date.now() < deadline) {
      const t = await Promise.race([
        page.evaluate(() => ({
          status: document.getElementById('statusText')?.textContent || '',
          loading: document.getElementById('loadingOverlay')?.classList?.contains('hidden') === false
            ? document.getElementById('loadingText')?.textContent || 'loading...' : null,
        })),
        new Promise(r => setTimeout(() => r({ status: '(main thread busy)', loading: null }), 5000)),
      ]);
      const seen = `${t.status} | ${t.loading}`;
      if (seen !== lastSeen) { console.log(`  [poll] status="${t.status}" loading="${t.loading}"`); lastSeen = seen; }
      // handleFile ends with "Loaded: <file> (dims)" — the verifier verdict
      // lives in #jobVerdict (Features section), checked below
      if (t.loading === null && /loaded:|verified|error|failed|nothing machinable/i.test(t.status)) { landed = true; break; }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!landed) {
      await page.screenshot({ path: path.join(out, 'browser-hang.png') }).catch(() => {});
      throw new Error('generate flow never landed (see browser-hang.png)');
    }
  }
  const status1 = (await page.$eval('#statusText', el => el.textContent)).trim();
  console.log(`  status after load: "${status1}"`);
  if (/^Loaded:/i.test(status1)) pass('file loaded through the full generate flow');
  else fail(`unexpected status: "${status1}"`);

  // feature list populated?
  const features = await page.$$eval('#featureList .feature-item', els =>
    els.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
  console.log(`  features: ${features.join(' | ')}`);
  if (features.length >= 2) pass(`${features.length} features in the list`);
  else fail(`expected ≥2 features, got ${features.length}`);

  // verifier verdict shown in the job summary?
  const stats = await page.$eval('#jobVerdict', el => el.textContent);
  if (/✓\s*Verified/.test(stats)) pass('job summary shows ✓ Verified verdict');
  else fail(`no verified verdict in summary: "${stats.replace(/\s+/g, ' ').slice(0, 200)}"`);

  // preview actually rendered? (toolpath lines exist in the scene = the
  // canvas has non-background pixels; cheap proxy: scene object present)
  const previewOk = await page.evaluate(() => {
    const c = document.getElementById('threeCanvas');
    return !!c && c.width > 0;
  });
  if (previewOk) pass('three.js canvas present and sized');
  else fail('three.js canvas missing');
  await page.screenshot({ path: path.join(out, 'browser-2-generated.png') });

  // export: must succeed (job verified) and report the verified export
  await page.click('#exportSbp');
  await new Promise(r => setTimeout(r, 1500));
  const status2 = (await page.$eval('#statusText', el => el.textContent)).trim();
  if (/SBP exported/i.test(status2)) pass(`export allowed: "${status2}"`);
  else fail(`export status: "${status2}"`);

  // export gate: sabotage the in-memory job (overlapping duplicate op with
  // the placement cleared) and confirm export is BLOCKED
  await page.evaluate(() => {
    const { state } = window.__stepAppState || {};
    if (!state?.job) return;
    const dup = JSON.parse(JSON.stringify(state.job.operations[0]));
    dup.name = 'sabotage duplicate';
    dup.allowOverlap = false;
    state.job.operations.push(dup);
  });
  const sabotaged = await page.evaluate(() => !!window.__stepAppState?.state?.job);
  if (sabotaged) {
    await page.click('#exportSbp');
    await new Promise(r => setTimeout(r, 1500));
    const status3 = (await page.$eval('#statusText', el => el.textContent)).trim();
    if (/blocked/i.test(status3)) pass(`export gate works: "${status3.slice(0, 120)}"`);
    else fail(`sabotaged job not blocked: "${status3.slice(0, 120)}"`);
  } else {
    console.log('  (state not exposed on window — skipping sabotage check)');
  }

  // console errors — CDN/wasm load failures would land here
  const real = consoleErrors.filter(e => !/favicon/i.test(e));
  if (real.length === 0) pass('no console errors');
  else { for (const e of real.slice(0, 5)) console.log(`  console error: ${e}`); fail(`${real.length} console error(s)`); }

  await page.screenshot({ path: path.join(out, 'browser-3-final.png') });
  console.log(`  screenshots in ${out}/browser-*.png`);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
