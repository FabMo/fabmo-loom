// Browser validation of multi-sheet pieces — the parts the gauntlet can't
// reach: the sheet picker appearing in the Cut step for a cabinet whose
// panels need two sheets, the assembled view holding EVERY panel (the
// other sheet's ghosted), and clicking "Sheet 2" re-weaving to the other
// panels with the export filename following.
//
// NOT part of npm test (needs the production server up + a deployment
// whose guests.local.mjs mounts the furniture compiler guest):
//   node test/browser-sheets-test.mjs [url]
//
// Writes screenshots to test/out/browser-sheets-*.png.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

// the cabinet box exactly as the model authored it live (funnel row
// q_d41764f9, 2026-10-07): 7 panels that need two 4×8 sheets
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cabinet-two-sheets.recipe.json'), 'utf8'));

console.log(`=== browser multi-sheet validation: ${URL} ===\n`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  // resource 404s surface as console errors without a URL — track them by
  // URL instead and ignore the dev server's missing /version endpoint
  const bad404 = [];
  page.on('response', (r) => { if (r.status() >= 400 && !/\/version$/.test(r.url())) bad404.push(`${r.status()} ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 160)); });

  await page.evaluateOnNewDocument((r) => {
    localStorage.setItem('loom:recipe', JSON.stringify(r));
    localStorage.setItem('loom:view', '3d');
  }, RECIPE);

  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  resp.ok() ? pass(`page loaded (${resp.status()})`) : fail(`page load status ${resp.status()}`);

  const badge = async () => page.$eval('#badge', (el) => el.textContent);
  const waitVerified = async (ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const b = await badge();
      if (b === 'VERIFIED' || b === 'REJECTED') return b;
      await sleep(300);
    }
    return await badge();
  };
  // post-weave the 3D view starves waitForFunction under software GL —
  // poll with evaluate (see browser-why-test)
  const pollUntil = async (fn, ms = 15000) => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < ms) { v = await page.evaluate(fn); if (v) return v; await sleep(250); }
    return v;
  };

  let b = await waitVerified();
  if (b === 'VERIFIED') pass('cabinet wove through the mounted compiler guest and VERIFIED');
  else fail(`badge ended "${b}" — is the furniture compiler guest mounted on this deployment?`);

  // the picker: two sheets, sheet 1 current
  const pick = await pollUntil(() => {
    const el = document.getElementById('sheetPick');
    if (!el || getComputedStyle(el).display === 'none') return null;
    const btns = [...el.querySelectorAll('button[data-sheet]')];
    return { n: btns.length, labels: btns.map((x) => x.textContent), text: el.textContent, ghost: btns.map((x) => x.classList.contains('ghost')) };
  });
  if (pick?.n === 2 && /sheet 1 of 2/.test(pick.text)) pass(`sheet picker shows ${pick.n} sheets: ${pick.labels.join(' | ')}`);
  else fail(`sheet picker wrong: ${JSON.stringify(pick)}`);
  if (pick && pick.ghost[0] === false && pick.ghost[1] === true) pass('sheet 1 is the highlighted (current) button');
  else fail(`button highlight wrong: ${JSON.stringify(pick?.ghost)}`);

  // the assembled view holds the WHOLE cabinet: 7 panels, 3 ghosted
  const layer = await pollUntil(() => {
    const l = window.loomAssembly?.layer;
    return l ? { count: l.count, active: l.activeCount, ghost: l.ghostCount, ids: l.parts.map((p) => `${p.id}:${p.active ? 'cut' : 'ghost'}`) } : null;
  });
  if (layer?.count === 7 && layer.active === 4 && layer.ghost === 3) pass(`assembly layer holds all 7 panels (4 in this board, 3 ghosted): ${layer.ids.join(', ')}`);
  else fail(`layer counts wrong: ${JSON.stringify(layer)}`);
  const note = await page.$eval('#assembleNote', (el) => el.textContent);
  if (/sheet 1 of 2/.test(note) && /faded/.test(note)) pass(`assemble scrub says: "${note}"`);
  else fail(`assemble note wrong: "${note}"`);
  const stem1 = await page.evaluate(() => window.loomSheets.stem());
  if (/-sheet1of2$/.test(stem1)) pass(`export filename stem "${stem1}"`);
  else fail(`export stem wrong: "${stem1}"`);

  // the dadoes are blind: a side panel is MORE than one slab (pocket layers)
  const slabs = await page.evaluate(() => window.loomAssembly.layer.parts.map((p) => `${p.id}=${p.node.children.length}`));
  const sideSlabs = await page.evaluate(() => window.loomAssembly.layer.parts.find((p) => p.id === 'side_l')?.node.children.length);
  if (sideSlabs >= 2) pass(`dadoed side renders as ${sideSlabs} slabs (pockets, not through slots): ${slabs.join(', ')}`);
  else fail(`side_l slabs ${sideSlabs}: ${slabs.join(', ')}`);

  // assembled pose, screenshot with the ghosts in
  await page.$eval('#assembleSlider', (el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  await page.screenshot({ path: path.join(out, 'browser-sheets-1-assembled.png') });

  // click Sheet 2 → re-weave → the OTHER panels cut, the first four ghost
  await page.click('#sheetPick button[data-sheet="2"]');
  await sleep(400);
  b = await waitVerified();
  if (b === 'VERIFIED') pass('sheet 2 re-wove and VERIFIED');
  else fail(`sheet 2 badge "${b}"`);
  const layer2 = await pollUntil(() => {
    const l = window.loomAssembly?.layer;
    if (!l || l.parts.find((p) => p.id === 'bottom')?.active !== true) return null;
    return { count: l.count, active: l.activeCount, ghost: l.ghostCount, cut: l.parts.filter((p) => p.active).map((p) => p.id) };
  });
  if (layer2?.count === 7 && layer2.active === 3 && layer2.cut.includes('bottom') && layer2.cut.includes('kickboard') && layer2.cut.includes('shelf_1')) {
    pass(`sheet 2 cuts ${layer2.cut.join(', ')}; the sides/top/back now ghost`);
  } else fail(`sheet 2 layer wrong: ${JSON.stringify(layer2)}`);
  const pick2 = await page.evaluate(() => ({
    text: document.getElementById('sheetPick').textContent,
    ghost: [...document.querySelectorAll('#sheetPick button[data-sheet]')].map((x) => x.classList.contains('ghost')),
  }));
  if (/sheet 2 of 2/.test(pick2.text) && pick2.ghost[1] === false) pass('picker now highlights sheet 2');
  else fail(`picker after click: ${JSON.stringify(pick2)}`);
  const stem2 = await page.evaluate(() => window.loomSheets.stem());
  if (/-sheet2of2$/.test(stem2)) pass(`export filename stem "${stem2}"`);
  else fail(`export stem wrong: "${stem2}"`);
  const setupParam = await page.evaluate(() => JSON.parse(localStorage.getItem('loom:recipe')).pipeline[0].params.setup);
  if (setupParam === 2) pass('the setup param persisted on the recipe (survives reload)');
  else fail(`setup param ${JSON.stringify(setupParam)}`);
  const blendKept = await page.$eval('#assembleSlider', (el) => parseFloat(el.value));
  if (Math.abs(blendKept - 1) < 1e-6) pass('assembled pose survives the sheet flip');
  else fail(`blend reset to ${blendKept}`);
  await sleep(300);
  await page.screenshot({ path: path.join(out, 'browser-sheets-2-assembled.png') });
  await page.$eval('#assembleSlider', (el) => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  await page.screenshot({ path: path.join(out, 'browser-sheets-2-flat.png') });
  pass('screenshots written: sheet 1 assembled / sheet 2 assembled / sheet 2 flat');

  if (consoleErrors.length || bad404.length) fail(`console errors: ${[...consoleErrors, ...bad404].slice(0, 3).join(' | ')}`);
  else pass('no console errors (the dev server\'s missing /version is ignored)');
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL BROWSER SHEET CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
