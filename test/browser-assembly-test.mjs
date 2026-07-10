// Browser validation of the assembled view — the part the gauntlet can't
// reach: the furniture guest mounted via guests.local.mjs weaving a live
// bench, the Assemble scrub appearing on the 3D pane, and the panels
// actually MOVING from the machined board to the standing piece.
//
// NOT part of npm test (needs the production server up + a deployment
// whose guests.local.mjs mounts the furniture guest):
//   node test/browser-assembly-test.mjs [url]
//
// Writes screenshots to test/out/browser-assembly-*.png.

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

// the bench, as the intent layer would author it
const RECIPE = {
  version: 2,
  name: 'Simple bench',
  stock: { thickness: 0.75 },
  margin: 0.375,
  controls: [
    { id: 'w', type: 'number', label: 'Width', default: 36, min: 18, max: 60, step: 1 },
    { id: 'h', type: 'number', label: 'Height', default: 16, min: 10, max: 24, step: 0.5 },
    { id: 'd', type: 'number', label: 'Depth', default: 11, min: 8, max: 18, step: 0.5 },
  ],
  derived: [], shapes: [], assets: [], terrains: [],
  pipeline: [{
    id: 'bench', strategy: 'furniture_design', params: {
      design: {
        version: 2, units: 'in', box: ['w', 'h', 'd'], thickness: 0.75,
        joinery: { style: 'through_mortise_tenon', tenon_width: 1.5, tenon_spacing: 6, edge_margin: 2 },
        panels: [
          { id: 'seat', axis: 'y', at: 'h - t/2', x: [0, 'w'], z: [0, 'd'] },
          { id: 'leg_l', axis: 'x', at: 't/2', y: [0, 'h - t/2'], z: [0, 'd'] },
          { id: 'leg_r', axis: 'x', at: 'w - t/2', y: [0, 'h - t/2'], z: [0, 'd'] },
          { id: 'rail', axis: 'z', at: 'd/2', x: ['t/2', 'w - t/2'], y: ['h - t - 5', 'h - t'] },
        ],
      },
      tabs: true,
    },
  }, {
    // engraving on a panel: rides the seat through nesting + the verify gate
    id: 'engrave', strategy: 'vcarve_text',
    params: { text: 'EMMA', letterHeight: 2.5, font: 'serif' },
    frame: 'seat',
  }],
};

console.log(`=== browser assembled-view validation: ${URL} ===\n`);

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
    // deliberately 2D: the first assembled weave must switch to 3D itself
    localStorage.setItem('loom:view', '2d');
  }, RECIPE);

  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  resp.ok() ? pass(`page loaded (${resp.status()})`) : fail(`page load status ${resp.status()}`);

  const badge = async () => page.$eval('#badge', (el) => el.textContent);
  const t0 = Date.now();
  let final = '';
  while (Date.now() - t0 < 60000) {
    const b = await badge();
    if (b === 'VERIFIED' || b === 'REJECTED') { final = b; break; }
    await new Promise((res) => setTimeout(res, 300));
  }
  if (final === 'VERIFIED') pass('bench wove through the mounted guest and VERIFIED');
  else fail(`badge ended "${final || await badge()}" — is the furniture guest mounted on this deployment?`);

  const wrapShown = await page.$eval('#assembleWrap', (el) => getComputedStyle(el).display !== 'none');
  if (wrapShown) pass('Assemble scrub appears on the 3D pane');
  else fail('assembleWrap hidden after a furniture weave');

  const count = await page.evaluate(() => window.loomAssembly?.layer?.count);
  if (count === 4) pass('assembly layer holds all 4 bench panels');
  else fail(`panel count ${count}`);

  // the reveal: first assembled weave auto-switches 2D → 3D and plays the
  // intro to fully assembled without anyone touching the scrub
  const on3d = await page.evaluate(() =>
    getComputedStyle(document.getElementById('preview3d')).display !== 'none' &&
    getComputedStyle(document.getElementById('preview')).display === 'none');
  if (on3d) pass('first assembled weave auto-switched the 2D view to 3D');
  else fail('view stayed 2D after the first assembled weave');
  const ti = Date.now();
  let introBlend = 0;
  while (Date.now() - ti < 10000) {
    introBlend = await page.evaluate(() => window.loomAssembly.blend());
    if (introBlend >= 0.999) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  if (introBlend >= 0.999) pass('intro played itself to the assembled pose (blend → 1)');
  else fail(`intro never finished: blend ${introBlend}`);

  // ...and only once: park the scrub mid-way, tweak a size, re-weave — the
  // pose must hold exactly where the user left it, no replay
  await page.$eval('#assembleSlider', (el) => {
    el.value = '0.3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    const inp = document.querySelector('#controls input');
    inp.value = '34';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const tr = Date.now();
  while (Date.now() - tr < 30000) {
    if ((await badge()) === 'VERIFIED') break;
    await new Promise((res) => setTimeout(res, 300));
  }
  await new Promise((res) => setTimeout(res, 1500));   // a replay would be mid-tween now
  const noReplay = await page.evaluate(() => ({
    blend: window.loomAssembly.blend(), playing: window.loomAssembly.introPlaying(),
  }));
  if (Math.abs(noReplay.blend - 0.3) < 1e-6 && !noReplay.playing) {
    pass('tweak re-weave does NOT replay the intro (blend held at 0.3)');
  } else fail(`intro replayed on tweak: ${JSON.stringify(noReplay)}`);

  // positions at blend 0 vs blend 1 — the panels must MOVE
  const posAt = async (t) => page.evaluate((tv) => {
    const layer = window.loomAssembly.layer;
    layer.setBlend(tv);
    window.loomView3d.render();
    return layer.group.children.map((m) => {
      const e = m.matrix.elements;
      return [e[12], e[13], e[14]];
    });
  }, t);

  const setSlider = async (v) => page.$eval('#assembleSlider', (el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);

  await setSlider(0);
  await page.screenshot({ path: path.join(out, 'browser-assembly-flat.png') });
  const flat = await posAt(0);
  const done = await posAt(1);
  const moved = flat.map((p, i) => Math.hypot(...p.map((c, k) => c - done[i][k])));
  if (moved.every((d) => d > 1)) pass(`every panel travels (${moved.map((d) => d.toFixed(1)).join('", ')}")`);
  else fail(`a panel never moved: ${moved.map((d) => d.toFixed(2)).join(', ')}`);
  // panel 0 has no stagger lead; at global t where its own blend is 0.5
  // (t = 0.5 / 1.35) its z must ride ABOVE the straight flat→assembled line
  const mid = await posAt(0.5 / 1.35);
  const lineZ = (flat[0][2] + done[0][2]) / 2;
  if (mid[0][2] > lineZ + 0.5) pass(`panels arc upward mid-flight (+${(mid[0][2] - lineZ).toFixed(2)}" over the straight line)`);
  else fail(`no lift: z ${mid[0][2].toFixed(2)} vs line ${lineZ.toFixed(2)}`);

  await setSlider(0.55);
  await page.screenshot({ path: path.join(out, 'browser-assembly-mid.png') });
  await setSlider(1);
  await page.screenshot({ path: path.join(out, 'browser-assembly-assembled.png') });
  pass('screenshots written: flat / mid / assembled');

  // the blend survives a slider-driven re-weave (geometry rebuilds, pose keeps)
  await page.evaluate(() => {
    const inp = document.querySelector('#controls input');
    inp.value = '20';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    if ((await badge()) === 'VERIFIED') break;
    await new Promise((res) => setTimeout(res, 300));
  }
  const keptBlend = await page.$eval('#assembleSlider', (el) => parseFloat(el.value));
  if (Math.abs(keptBlend - 1) < 1e-6) pass('re-weave keeps the assembled pose (blend survives slider drags)');
  else fail(`blend reset on re-weave: ${keptBlend}`);

  if (consoleErrors.length) fail(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
  else pass('no console errors');
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL BROWSER ASSEMBLY CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
