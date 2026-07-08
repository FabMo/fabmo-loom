// Browser validation of the terrain crossover — the part the gauntlet's
// synthetic fixture can't reach: the REAL resolver chain (Nominatim
// geocode → AWS Terrarium tiles → grid) running in a live document, the
// bbox/meta pin-back into the persisted recipe, and the verifier badge on
// the woven Grand Canyon plaque.
//
// NOT part of npm test (needs the production server up + internet):
//   node test/browser-terrain-test.mjs [url]
//
// Writes screenshots to test/out/browser-terrain-*.png.

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

// the prompt's job, as the intent layer would author it
const RECIPE = {
  version: 2,
  name: 'Grand Canyon Plaque',
  stock: { thickness: 0.75 },
  margin: 0.375,
  controls: [{ id: 'place', type: 'text', label: 'Place name', default: 'Grand Canyon' }],
  derived: [], shapes: [], assets: [],
  terrains: [{ id: 'land', query: 'Grand Canyon' }],
  pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: { ctrl: 'place' }, letterHeight: 0.35, posX: -3.0, posY: -2.0 } },
    { id: 'coords', strategy: 'vcarve_text', params: { text: '36.06N 112.14W', letterHeight: 0.25, place: 'below', gap: 0.15 } },
    { id: 'relief', strategy: 'terrain_relief', params: { terrain: 'land', width: 10, depth: 0.35 } },
    { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } },
  ],
};

console.log(`=== browser terrain validation: ${URL} ===\n`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  await page.evaluateOnNewDocument((r) => {
    localStorage.setItem('loom:recipe', JSON.stringify(r));
  }, RECIPE);

  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  resp.ok() ? pass(`page loaded (${resp.status()})`) : fail(`page load status ${resp.status()}`);

  // the badge walks: computing… → finding "Grand Canyon"… → fetching N
  // elevation tiles… → VERIFIED. Give the real network a generous window.
  const badge = async () => page.$eval('#badge', (el) => el.textContent);
  let saw = new Set();
  const t0 = Date.now();
  let final = '';
  while (Date.now() - t0 < 120000) {
    const b = await badge();
    saw.add(b);
    if (b === 'VERIFIED' || b === 'REJECTED') { final = b; break; }
    await new Promise((res) => setTimeout(res, 400));
  }
  if ([...saw].some((s) => /finding|fetching/.test(s))) pass(`resolver states surfaced: ${[...saw].filter((s) => /finding|fetching/.test(s)).join(' → ')}`);
  else fail(`no resolver states seen (saw: ${[...saw].join(', ')})`);
  if (final === 'VERIFIED') pass('Grand Canyon plaque wove and VERIFIED against the real DEM');
  else { fail(`badge ended "${final || await badge()}"`); console.log('  errors panel:', await page.$eval('#numbers', (el) => el.textContent).catch(() => '?')); }

  // the pin-back: the persisted recipe must now carry the resolved bbox/meta
  const pinned = await page.evaluate(() => JSON.parse(localStorage.getItem('loom:recipe')).terrains[0]);
  if (pinned.bbox && Number.isFinite(pinned.bbox.south) && pinned.zoom && pinned.meta?.centerLat) {
    pass(`resolution pinned into the recipe: bbox [${pinned.bbox.south.toFixed(2)}..${pinned.bbox.north.toFixed(2)}] z${pinned.zoom}, center ${pinned.meta.centerLat}, ${pinned.meta.centerLng}, elev ${pinned.meta.elevMinM}–${pinned.meta.elevMaxM} m`);
    if (Math.abs(pinned.meta.centerLat - 36.1) < 1.2 && Math.abs(pinned.meta.centerLng + 112.1) < 1.5) pass('pinned center is actually the Grand Canyon');
    else fail(`pinned center ${pinned.meta.centerLat}, ${pinned.meta.centerLng} is not the Grand Canyon`);
  } else fail(`no pinned resolution in recipe: ${JSON.stringify(pinned)}`);

  // verifier numbers on screen (heightmap target with 0 gouges)
  const numbers = await page.$eval('#numbers', (el) => el.textContent).catch(() => '');
  if (/0 gouges/.test(numbers)) pass('verifier numbers on screen include a 0-gouge heightmap target');
  else fail(`verifier numbers missing/gouged: "${numbers.slice(0, 200)}"`);

  await new Promise((res) => setTimeout(res, 1500));   // let the 3D view settle
  await page.screenshot({ path: path.join(out, 'browser-terrain-plaque.png') });
  pass('screenshot: test/out/browser-terrain-plaque.png');

  const real = consoleErrors.filter((e) => !/favicon/.test(e));
  if (!real.length) pass('no console errors');
  else fail(`console errors: ${real.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nBROWSER TERRAIN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
