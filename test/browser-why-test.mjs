// Browser validation of the why-these-choices panel — the decision record
// (runtime rationale) rendered in a live document: the disclosure sits
// next to the measurements, opens to the auto-tool coverage curve, the
// chipload feed derivation with its binding constraint, real rack &Tool
// numbers, rest-pass economics, and the recipe's model-written plan line
// labeled as narration.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-why-test.mjs [url]
//
// Writes screenshots to test/out/browser-why-*.png.

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

// a recipe as the intent layer would leave it: model summary on `about`,
// an auto-tool pocket (drawer knee + rest pass) and a cutout
const RECIPE = {
  version: 2,
  name: 'Serving Tray',
  about: 'Built a rectangular tray with a pocketed well and a cut-free outline.',
  stock: { thickness: 0.75 },
  margin: 0.375,
  controls: [],
  derived: [], shapes: [], assets: [],
  pipeline: [
    { id: 'well', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 5, height: 3, cornerRadius: 0, depth: 0.3, toolDiameter: 0 } },
    { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.5 } },
  ],
};
const SHOP = { machineW: 0, machineH: 0, materialW: 0, materialH: 0, material: 'plywood' };
const RACK = {
  version: 1,
  machine: { minRPM: 6000, maxRPM: 24000, maxFeed: 360 },
  tools: [
    { number: 2, kind: 'flat', diameter: 0.25, flutes: 2 },
    { number: 5, kind: 'flat', diameter: 0.0625, flutes: 1 },
  ],
};

console.log(`=== browser why-these-choices validation: ${URL} ===\n`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument((recipe, shop, rack) => {
    localStorage.clear();
    localStorage.setItem('loom:recipe', JSON.stringify(recipe));
    localStorage.setItem('loom:shop', JSON.stringify(shop));
    localStorage.setItem('shopbot:tools', JSON.stringify(rack));
  }, RECIPE, SHOP, RACK);
  await page.goto(URL, { waitUntil: 'networkidle2' });

  // the weave runs off-thread — wait for the verdict, then the panel.
  // AFTER the verdict, the 3D sim view saturates the main thread under
  // headless software WebGL, starving waitForFunction's injected polling
  // (even `() => true` times out) — plain evaluate() calls queue and DO
  // run, ~seconds late. So past the badge, poll with evaluate only.
  await page.waitForFunction(() => document.getElementById('badge')?.textContent === 'VERIFIED', { timeout: 30000 });
  pass('seeded recipe weaves to VERIFIED');

  let found = false;
  for (let tries = 0; tries < 5 && !found; tries++) {
    found = await page.evaluate(() => [...document.querySelectorAll('#numbers details')]
      .some(d => d.querySelector('summary')?.textContent.startsWith('why these choices')));
  }
  if (found) pass('why-these-choices disclosure present next to the measurements');
  else {
    const dump = await page.evaluate(() => document.getElementById('numbers')?.innerHTML.slice(0, 400));
    fail(`no why-these-choices disclosure in #numbers — content: ${dump}`);
    throw new Error('panel missing');
  }

  const text = await page.evaluate(() => {
    const d = [...document.querySelectorAll('#numbers details')]
      .find(x => x.querySelector('summary')?.textContent.startsWith('why these choices'));
    d.open = true;
    return { summary: d.querySelector('summary').textContent, body: d.textContent };
  });

  const checks = [
    ['model plan line, labeled as narration', /pocketed well.*measured, not narrated/s],
    ['rack &Tool numbers claimed', /your rack's &Tool 2/],
    ['chipload derivation with flutes and material', /2 flutes × 0\.011"\/tooth chipload in Plywood/],
    ['feed-cap binding narrated (shed rpm)', /rpm came DOWN to keep the chipload/],
    ['auto-tool knee note on the pocket', /auto tool: 1\/4"/],
    ['coverage curve with the knee marked', /coverage over the drawer: .*✓/],
    ['rest-pass economics', /rest pass: .*could not reach/],
  ];
  for (const [name, re] of checks) {
    if (re.test(text.body)) pass(name);
    else fail(`${name}: not found in panel body`);
  }

  // feeds shown must be the JOB's feeds — cross-check one number against
  // the exported record the same page holds (no second source of truth)
  const match = text.body.match(/feed (\d+) in\/min/);
  if (match && text.body.includes(`${match[1]} in/min`)) pass(`panel quotes a concrete feed (${match[1]} in/min)`);
  else fail('no concrete feed number in the panel');

  await page.screenshot({ path: path.join(out, 'browser-why-open.png') });
  console.log(`\nscreenshot: test/out/browser-why-open.png`);
} finally {
  await browser.close();
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL WHY-PANEL CHECKS PASSED');
