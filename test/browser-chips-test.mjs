// Browser validation of the suggested-prompt chips — the teaching-aid
// behavior that only exists in a live document: chip click POPULATES the
// prompt (never submits) with the first ___ blank selected, Tab hops to
// the next blank, Generate refuses unfilled blanks, and the chip set
// swaps from starter grammar to state-aware refinements once the recipe
// has pipeline ops.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-chips-test.mjs [url]
//
// Writes screenshots to test/out/browser-chips-*.png.

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

const BLANK = '___';

// a recipe as the intent layer would leave it after a first weave
const VCARVE_RECIPE = {
  version: 2,
  name: 'Nameplate',
  stock: { thickness: 0.5 },
  margin: 0.375,
  controls: [{ id: 'who', type: 'text', label: 'Name', default: 'Ada' }],
  derived: [], shapes: [], assets: [],
  pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: { ctrl: 'who' }, letterHeight: 1 } },
  ],
};
const WITH_CUTOUT = structuredClone(VCARVE_RECIPE);
WITH_CUTOUT.pipeline.push({ id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } });

console.log(`=== browser chips validation: ${URL} ===\n`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const requests = [];
  page.on('request', (r) => { if (r.url().includes('api.anthropic.com')) requests.push(r.url()); });

  // ---- 1. fresh state: starter chips, full sentences with blanks ----
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chips button');

  const starters = await page.$$eval('#chips button', (bs) => bs.map((b) => b.textContent));
  if (starters.length === 4) pass(`fresh state shows 4 starter chips`);
  else fail(`expected 4 starter chips, got ${starters.length}: ${JSON.stringify(starters)}`);
  if (starters.every((t) => t.includes('___'))) pass('every starter chip carries a ___ blank');
  else fail(`starter chip without a blank: ${JSON.stringify(starters)}`);

  // ---- 2. click populates verbatim, selects first blank, never submits ----
  await page.click('#chips button');
  const st = await page.evaluate(() => {
    const box = document.getElementById('prompt');
    return {
      value: box.value,
      selStart: box.selectionStart,
      selEnd: box.selectionEnd,
      focused: document.activeElement === box,
      genLabel: document.getElementById('generate').textContent,
      turns: document.getElementById('history').children.length,
    };
  });
  if (st.value === starters[0]) pass('chip click puts its exact visible text in the prompt (no hidden payload)');
  else fail(`prompt value "${st.value}" != chip text "${starters[0]}"`);
  const firstBlank = starters[0].indexOf(BLANK);
  if (st.focused && st.selStart === firstBlank && st.selEnd === firstBlank + BLANK.length) {
    pass(`first blank selected (chars ${st.selStart}–${st.selEnd}), box focused`);
  } else fail(`selection ${st.selStart}–${st.selEnd} (focused=${st.focused}), expected ${firstBlank}–${firstBlank + BLANK.length}`);
  if (st.genLabel === 'Generate' && st.turns === 0 && requests.length === 0) pass('no auto-submit on chip click');
  else fail(`auto-submit suspected: label="${st.genLabel}" turns=${st.turns} apiCalls=${requests.length}`);

  // ---- 3. type over blank, Tab hops to the next one ----
  await page.keyboard.type('WELCOME');
  await page.keyboard.press('Tab');
  const tab = await page.evaluate(() => {
    const box = document.getElementById('prompt');
    return { value: box.value, sel: box.value.slice(box.selectionStart, box.selectionEnd), focused: document.activeElement === box };
  });
  if (tab.value.includes('WELCOME') && tab.sel === BLANK && tab.focused) pass(`typing replaced blank 1; Tab selected blank 2 ("${tab.value}")`);
  else fail(`after type+Tab: value="${tab.value}" selected="${tab.sel}" focused=${tab.focused}`);

  // ---- 4. Generate refuses unfilled blanks ----
  await page.evaluate(() => localStorage.setItem('loom:apiKey', 'sk-ant-fake'));
  await page.click('#generate');
  await new Promise((r) => setTimeout(r, 300));
  const guard = await page.evaluate(() => document.getElementById('history').textContent);
  if (guard.includes('Fill in the blanks') && requests.length === 0) pass('Generate with an unfilled ___ warns instead of calling the API');
  else fail(`blank guard missed: history="${guard.slice(0, 80)}" apiCalls=${requests.length}`);
  await page.screenshot({ path: path.join(out, 'browser-chips-starter.png') });

  // ---- 5. state-aware refinement chips: vcarve, no cutout ----
  await page.evaluateOnNewDocument((r) => {
    localStorage.clear();
    localStorage.setItem('loom:recipe', JSON.stringify(r));
  }, VCARVE_RECIPE);
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chips button');
  const refine = await page.$$eval('#chips button', (bs) => bs.map((b) => b.textContent));
  const expects = [
    ['style toggle', (t) => t === 'make the letters outlined instead of v-carved'],
    ['cutout suggestion', (t) => t.startsWith('cut it out with a')],
    ['texture suggestion', (t) => t.includes('hammered texture')],
    ['slider suggestion', (t) => t.includes('with a slider')],
  ];
  for (const [name, test] of expects) {
    if (refine.some(test)) pass(`refinement set has the ${name}`);
    else fail(`refinement set missing ${name}: ${JSON.stringify(refine)}`);
  }

  // ---- 6. cutout present → cutout chip retires, spatial chip appears ----
  await page.evaluateOnNewDocument((r) => {
    localStorage.clear();
    localStorage.setItem('loom:recipe', JSON.stringify(r));
  }, WITH_CUTOUT);
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#chips button');
  const refine2 = await page.$$eval('#chips button', (bs) => bs.map((b) => b.textContent));
  if (!refine2.some((t) => t.startsWith('cut it out with a'))) pass('cutout chip retired once a cutout op exists');
  else fail(`cutout chip still offered: ${JSON.stringify(refine2)}`);
  if (refine2.some((t) => t.startsWith('move the'))) pass('spatial refinement chip appears in its place');
  else fail(`no spatial chip: ${JSON.stringify(refine2)}`);
  await page.screenshot({ path: path.join(out, 'browser-chips-refine.png') });
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHIP CHECKS PASSED');
process.exit(failures ? 1 : 0);
