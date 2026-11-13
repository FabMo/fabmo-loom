// Browser validation of "Download nested vectors" in the full app for a
// furniture layout on a DECLARED material sheet (the step-stool field
// report, 2026-11-13): the parts nest on the 36 × 24 sheet as declared,
// the DXF's SHEET outline IS that sheet, every part is in the file — and
// on a sheet too small for one setup, every setup's parts are in the file.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-dxf-sheet-test.mjs [url]

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDxfEntities } from '../app/dxf.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
const RECIPE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'step-stool-recipe.json'), 'utf8');
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const ok = (cond, m) => (cond ? console.log(`  ✓ ${m}`) : fail(m));
const box = (e) => { const xs = e.points.map(p => p.x), ys = e.points.map(p => p.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };

console.log(`=== browser DXF-on-the-declared-sheet validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
async function dxfFor(material) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument((recipe, mat) => {
    localStorage.clear();
    localStorage.setItem('loom:introSeen', '1');
    localStorage.setItem('loom:recipe', recipe);
    localStorage.setItem('loom:shop', JSON.stringify({ machineW: 0, machineH: 0, materialW: mat.w, materialH: mat.h, material: '', holdDown: '' }));
    // the download is a blob behind an <a>: keep its text
    window.__files = [];
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { b.text?.().then(t => window.__files.push(t)); return real(b); };
  }, RECIPE, material);
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => /VERIFIED|REFUSED|NOT/.test(document.getElementById('badge').textContent) && !document.getElementById('dlDxf').disabled, { timeout: 120000 });
  const badge = await page.evaluate(() => document.getElementById('badge').textContent);
  await page.click('#dlDxf');
  await page.waitForFunction(() => window.__files.length >= 1, { timeout: 120000 });
  const dxf = await page.evaluate(() => window.__files[0]);
  const picker = await page.evaluate(() => document.getElementById('sheetPick').textContent);
  await page.close();
  return { badge, dxf, picker, ents: parseDxfEntities(dxf) };
}
try {
  console.log('--- a 36 × 24 sheet: one setup, on the sheet as declared ---');
  {
    const { badge, ents, picker } = await dxfFor({ w: 36, h: 24 });
    const sheets = ents.filter(e => e.layer === 'SHEET').map(box), parts = ents.filter(e => e.layer === 'PROFILE').map(box);
    ok(/VERIFIED/.test(badge), `the stool verifies (${badge})`);
    ok(!/sheet 1 of/.test(picker), 'all five parts share ONE setup (the row packer alone needed two)');
    ok(sheets.length === 1 && sheets[0].x1 - sheets[0].x0 === 36 && sheets[0].y1 - sheets[0].y0 === 24, `the SHEET outline is the declared 36 × 24 (${sheets.map(s => `${s.x1 - s.x0} × ${s.y1 - s.y0}`).join(', ')})`);
    ok(parts.length === 5 && parts.every(p => p.x0 >= 0 && p.y0 >= 0 && p.x1 <= 36 && p.y1 <= 24), `all 5 parts lie inside it (${parts.length} profiles)`);
    const overlap = parts.some((a, i) => parts.some((b, j) => j > i && a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6));
    ok(!overlap, 'no two parts overlap');
  }
  console.log('\n--- a 24 × 24 sheet: two setups, both in the file ---');
  {
    const { ents, picker } = await dxfFor({ w: 24, h: 24 });
    const sheets = ents.filter(e => e.layer === 'SHEET').map(box), parts = ents.filter(e => e.layer === 'PROFILE').map(box);
    ok(/sheet 1 of 2/.test(picker), 'the layout needs two sheets');
    ok(sheets.length === 2 && sheets.every(s => s.x1 - s.x0 === 24 && s.y1 - s.y0 === 24) && sheets[1].x0 === 26, 'the DXF draws both 24 × 24 sheets, side by side');
    ok(parts.length === 5 && parts.every(p => sheets.some(s => p.x0 >= s.x0 && p.x1 <= s.x1 && p.y0 >= 0 && p.y1 <= 24)), `all 5 parts are in the file, each inside a sheet (${parts.length} profiles)`);
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall DXF sheet checks passed');
process.exit(failures ? 1 : 0);
