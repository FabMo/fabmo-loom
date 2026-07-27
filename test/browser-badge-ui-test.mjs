// Browser validation of the visitor step flow (v0.68): a name-badge
// recipe through its three states — undrawn (step 1 is the loud draw
// button), the draw overlay aimed at the recipe's shape, and drawn +
// verified (step 3's big cut buttons live, and CRUCIALLY the cutout
// re-woven by the Accept itself — the regression this file exists for).
//
// NOT part of npm test (needs the production server up):
//   node test/browser-badge-ui-test.mjs [url]
//
// Writes screenshots to test/out/badge-ui-*.png.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const RECIPE = {
  version: 2,
  name: 'Name badges',
  stock: { thickness: 0.25 },
  margin: 0.375,
  controls: [
    { id: 'name', type: 'text', label: 'Name', default: 'Brian' },
    { id: 'letterH', type: 'number', label: 'Letter height', default: 0.6, min: 0.3, max: 1.2, step: 0.05 },
  ],
  derived: [],
  shapes: [
    { id: 'profile', draw: { of: 'profile', width: '3.5' } },
    { id: 'tag', fit: { of: 'profile', margin: 0.3 } },
  ],
  assets: [], terrains: [],
  pipeline: [
    { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: { ctrl: 'letterH' } } },
    { id: 'cutout', strategy: 'shape_cutout', params: { shape: 'tag' } },
  ],
};

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  await page.evaluateOnNewDocument((r) => {
    localStorage.setItem('loom:recipe', JSON.stringify(r));
    localStorage.setItem('loom:sheet', JSON.stringify({ w: 24, h: 12, thickness: 0.25, occupied: [] }));
    // 3D on purpose: the worker's simulateJob grid must reach the Three.js
    // surface — the heaviest path is the one under test
    localStorage.setItem('loom:view', '3d');
  }, RECIPE);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));

  // ---- state 1: undrawn — step 1 shows a big draw button
  const s1 = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return el && el.style.display !== 'none'; };
    const drawBtn = document.querySelector('#drawControls button');
    return {
      stepDraw: vis('stepDraw'), stepType: vis('stepType'), stepCut: vis('stepCut'),
      nums: [...document.querySelectorAll('.step-num')].filter((n) => n.offsetParent).map((n) => n.textContent),
      drawBtnBig: drawBtn?.className.includes('big'), drawBtnText: drawBtn?.textContent,
      moreCtlsShown: vis('moreCtls'),
      moreCount: document.getElementById('controlsMore').children.length,
      textInControls: !!document.querySelector('#controls .ctl-text input'),
      setupSummary: document.getElementById('setupSummary').textContent,
      setupOpen: document.getElementById('setupBox').open,
      badge: document.getElementById('badge').textContent,
      sheetChip: document.getElementById('sheetChip').textContent,
      dlSbpClass: document.getElementById('dlSbp').className,
    };
  });
  console.log(JSON.stringify(s1, null, 1));
  if (s1.stepDraw && s1.stepType && s1.stepCut) pass('all three steps visible');
  else fail(`steps: ${JSON.stringify(s1)}`);
  if (String(s1.nums) === '1,2,3') pass('numbered 1,2,3'); else fail(`nums=${s1.nums}`);
  if (s1.drawBtnBig) pass(`undrawn draw button is big: "${s1.drawBtnText}"`); else fail('draw button not big');
  if (s1.moreCtlsShown && s1.moreCount === 1 && s1.textInControls) pass('text control open, number tucked under More adjustments');
  else fail(`controls split wrong: more=${s1.moreCount} text=${s1.textInControls}`);
  if (!s1.setupOpen && s1.setupSummary.includes('thick')) pass(`setup tucked: "${s1.setupSummary}"`);
  else fail(`setup: open=${s1.setupOpen} "${s1.setupSummary}"`);
  await page.screenshot({ path: path.join(out, 'badge-ui-1-undrawn.png') });

  // ---- state 2: the draw overlay, aimed at "profile"
  await page.click('#drawControls button');
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await page.evaluate(() => ({
    title: document.getElementById('drawTitle').textContent,
    targetHidden: document.getElementById('drawTarget').style.display === 'none',
    nameHidden: document.getElementById('drawName').style.display === 'none',
    acceptBig: document.getElementById('drawUse').className.includes('big'),
    acceptText: document.getElementById('drawUse').textContent,
  }));
  if (s2.title.includes('profile') && s2.targetHidden && s2.nameHidden) pass(`overlay aimed: "${s2.title}", pickers hidden`);
  else fail(`overlay: ${JSON.stringify(s2)}`);
  if (s2.acceptBig) pass(`accept is big: "${s2.acceptText}"`); else fail('accept not big');
  const box = await (await page.$('#drawCanvas')).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // ---- state 2b: an OPEN arc — Accept gated off, "Close the gap" bridges it
  // with a tangent curve (210° of a circle; the gap is far beyond snap)
  await page.mouse.move(cx + 140 * Math.cos(Math.PI / 2), cy + 140 * Math.sin(Math.PI / 2));
  await page.mouse.down();
  for (let a = 90; a <= 300; a += 5) {
    const rad = (a * Math.PI) / 180;
    await page.mouse.move(cx + 140 * Math.cos(rad), cy + 140 * Math.sin(rad));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const g1 = await page.evaluate(() => ({
    closeVisible: document.getElementById('drawClose').style.display !== 'none',
    acceptDisabled: document.getElementById('drawUse').disabled,
  }));
  if (g1.closeVisible && g1.acceptDisabled) pass('open arc: Accept gated, Close the gap offered');
  else fail(`open-arc state wrong: ${JSON.stringify(g1)}`);
  await page.screenshot({ path: path.join(out, 'badge-ui-2b-gap.png') });
  await page.click('#drawClose');
  await new Promise((r) => setTimeout(r, 300));
  const g2 = await page.evaluate(() => ({
    closeHidden: document.getElementById('drawClose').style.display === 'none',
    acceptEnabled: !document.getElementById('drawUse').disabled,
  }));
  if (g2.closeHidden && g2.acceptEnabled) pass('gap closed tangentially — Accept lit, button gone');
  else fail(`close-gap failed: ${JSON.stringify(g2)}`);
  await page.screenshot({ path: path.join(out, 'badge-ui-2c-closed.png') });
  await page.click('#drawClear');
  await new Promise((r) => setTimeout(r, 200));

  // sketch a rounded blob with the mouse
  await page.mouse.move(cx - 150, cy - 80);
  await page.mouse.down();
  for (let a = 0; a <= 360; a += 10) {
    const rad = (a * Math.PI) / 180;
    await page.mouse.move(cx - 150 + 150 - 150 * Math.cos(rad) + 20 * Math.sin(3 * rad), cy - 80 + 80 * Math.sin(rad));
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(out, 'badge-ui-2-draw.png') });
  const accDisabled = await page.evaluate(() => document.getElementById('drawUse').disabled);
  if (!accDisabled) pass('sketch registered — Accept enabled'); else fail('Accept still disabled after sketch');
  await page.click('#drawUse');
  await new Promise((r) => setTimeout(r, 3000));

  // ---- state 3: drawn + verified — step 3 big buttons, board chip
  const s3 = await page.evaluate(() => {
    const drawBtn = document.querySelector('#drawControls button');
    return {
      badge: document.getElementById('badge').textContent,
      redraw: drawBtn?.textContent, redrawGhost: drawBtn?.className.includes('ghost'),
      dlSbp: { disabled: document.getElementById('dlSbp').disabled, cls: document.getElementById('dlSbp').className },
      addBoard: { disabled: document.getElementById('sheetRecord').disabled, text: document.getElementById('sheetRecord').textContent.replace(/\s+/g, ' ').trim(), cls: document.getElementById('sheetRecord').className },
      sheetChip: document.getElementById('sheetChip').textContent,
      setupSummary: document.getElementById('setupSummary').textContent,
      warnings: document.getElementById('warnings').textContent,
      targets: document.getElementById('numbers').textContent,
    };
  });
  console.log(JSON.stringify(s3, null, 1));
  if (s3.badge === 'VERIFIED') pass('drawn badge weave VERIFIED'); else fail(`badge=${s3.badge}`);
  if (!s3.warnings.includes('waiting on the drawing') && s3.targets.includes('cutout')) {
    pass('accepting the drawing re-wove: cutout target present, waiting-warning gone');
  } else fail(`cutout did not light up: warnings="${s3.warnings}" targets="${s3.targets.slice(0, 120)}"`);
  if (s3.redrawGhost) pass(`draw button demoted to redraw: "${s3.redraw}"`); else fail('redraw not ghost');
  if (!s3.dlSbp.disabled && s3.dlSbp.cls === 'big') pass('Download .sbp enabled and big (no machine connected)');
  else fail(`dlSbp: ${JSON.stringify(s3.dlSbp)}`);
  if (!s3.addBoard.disabled && s3.addBoard.cls.includes('big')) pass(`Add to board enabled+big: "${s3.addBoard.text}"`);
  else fail(`addBoard: ${JSON.stringify(s3.addBoard)}`);
  if (s3.sheetChip.includes('fits')) pass(`board chip: "${s3.sheetChip}"`); else fail(`chip: "${s3.sheetChip}"`);
  await page.screenshot({ path: path.join(out, 'badge-ui-3-verified.png') });
  await page.evaluate(() => document.getElementById('stepCut').scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(out, 'badge-ui-3b-cutstep.png') });

  // ---- state 3c: drag-to-place — grab the engraving in the 2D view and
  // drop it 1" right / 0.5" down; the drop must write posX/posY into the
  // recipe and the re-weave must come back VERIFIED
  await page.click('#btn2d');
  await new Promise((r) => setTimeout(r, 300));
  const di = await page.evaluate(() => {
    const ops = window.loomDrag?.ops() ?? [];
    const g = ops.find((o) => o.opId === 'engrave');
    if (!g) return { ops: ops.map((o) => o.opId) };
    const c = { x: (g.bbox.minX + g.bbox.maxX) / 2, y: (g.bbox.minY + g.bbox.maxY) / 2 };
    return { c, from: window.loomDrag.clientOf(c.x, c.y), to: window.loomDrag.clientOf(c.x + 1, c.y - 0.5) };
  });
  if (di.from) pass(`engrave op is grabbable (center ${di.c.x.toFixed(2)}, ${di.c.y.toFixed(2)})`);
  else fail(`engrave not in loomDrag.ops(): ${JSON.stringify(di.ops)}`);
  if (di.from) {
    await page.mouse.move(di.from.x, di.from.y);
    await new Promise((r) => setTimeout(r, 100));
    const hoverCursor = await page.evaluate(() => document.getElementById('preview').style.cursor);
    if (hoverCursor === 'grab') pass('hover over the engraving shows the grab cursor');
    else fail(`hover cursor = "${hoverCursor}"`);
    await page.mouse.down();
    await page.mouse.move(di.to.x, di.to.y, { steps: 8 });
    await new Promise((r) => setTimeout(r, 100));
    await page.screenshot({ path: path.join(out, 'badge-ui-3c-dragging.png') });
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 60000 });
    const dropped = await page.evaluate(() => {
      const r = JSON.parse(localStorage.getItem('loom:recipe'));
      return r.pipeline.find((o) => o.id === 'engrave').params;
    });
    const wantX = di.c.x + 1, wantY = di.c.y - 0.5;
    if (Math.abs(dropped.posX - wantX) < 0.05 && Math.abs(dropped.posY - wantY) < 0.05) {
      pass(`drop wrote posX/posY (${dropped.posX}, ${dropped.posY}) and re-wove VERIFIED`);
    } else fail(`posX/posY (${dropped.posX}, ${dropped.posY}) ≠ expected (${wantX.toFixed(3)}, ${wantY.toFixed(3)})`);
    await page.screenshot({ path: path.join(out, 'badge-ui-3d-dropped.png') });
  }
  await page.click('#btn3d');
  await new Promise((r) => setTimeout(r, 300));

  // ---- the weave overlay shows while a control edit re-weaves, then clears —
  // and with the weave in a worker, the page keeps PAINTING throughout
  const workerActive = await page.evaluate(() => window.loomWeave?.workerActive() ?? false);
  if (workerActive) pass('weave worker is live (not the main-thread fallback)');
  else fail('weave worker missing — weaves are blocking the page');
  await page.evaluate(() => {
    window.__woLog = [];
    const wo = document.getElementById('weaveOverlay');
    new MutationObserver(() => window.__woLog.push(wo.className)).observe(wo, { attributes: true });
    window.__frames = 0;
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.type('#controls .ctl-text input', 'na');
  // sample frames over a fixed early window (while the weave is surely in
  // flight), then wait out the weave for the lifecycle assertions
  await new Promise((r) => setTimeout(r, 2500));
  const frames = await page.evaluate(() => window.__frames);
  await new Promise((r) => setTimeout(r, 5000));
  const wo = await page.evaluate(() => ({
    log: window.__woLog,
    now: document.getElementById('weaveOverlay').className,
    badge: document.getElementById('badge').textContent,
    frames: 0,
  }));
  wo.frames = frames;
  if (wo.log.some((c) => c.includes('show')) && !wo.now.includes('show') && wo.badge === 'VERIFIED') {
    pass(`weave overlay showed during the re-weave and cleared (${wo.log.length} flips)`);
  } else fail(`overlay lifecycle wrong: ${JSON.stringify(wo)}`);
  // a blocked main thread paints a handful of frames in 2.5s; a live one
  // paints dozens even under swiftshader
  if (wo.frames > 40) pass(`page kept painting through the weave (${wo.frames} frames in 2.5s)`);
  else fail(`main thread starved during weave: only ${wo.frames} frames in 2.5s`);

  // ---- setup details opens with the full controls
  await page.click('#setupBox summary');
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(out, 'badge-ui-4-setup-open.png') });

  // ---- What is this?: overlay opens, an example loads and weaves
  await page.click('#whatBtn');
  await new Promise((r) => setTimeout(r, 200));
  const intro = await page.evaluate(() => ({
    open: document.getElementById('introOverlay').style.display !== 'none',
    cards: document.querySelectorAll('#introExamples button').length,
  }));
  if (intro.open && intro.cards >= 4) pass(`intro overlay opens with ${intro.cards} examples`);
  else fail(`intro wrong: ${JSON.stringify(intro)}`);
  await page.screenshot({ path: path.join(out, 'badge-ui-6-intro.png') });
  await page.evaluate(() => document.querySelectorAll('#introExamples button')[1].click());   // Welcome sign
  await new Promise((r) => setTimeout(r, 500));
  const loaded = await page.evaluate(() => ({
    closed: document.getElementById('introOverlay').style.display === 'none',
    name: document.getElementById('appName').textContent,
    seen: localStorage.getItem('loom:introSeen'),
  }));
  await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 60000 });
  if (loaded.closed && loaded.name === 'Welcome sign' && loaded.seen === '1') {
    pass('example loads: overlay closes, recipe swaps in, weaves VERIFIED');
  } else fail(`example load wrong: ${JSON.stringify(loaded)}`);
  await page.screenshot({ path: path.join(out, 'badge-ui-7-example.png') });

  // ---- drag on a tag_cutout badge (the welcome sign): the tag must PIN
  // where it stands and the name move ON it — field report 2026-07-27:
  // unpinned, the self-sizing tag chased the text and every drag re-woven
  // back to a centered name
  await page.click('#btn2d');
  await new Promise((r) => setTimeout(r, 300));
  const w1 = await page.evaluate(() => {
    const tag = window.loomDrag.ringBBoxOf('cutout');
    const grabbable = window.loomDrag.ops().map((o) => o.opId);
    const g = window.loomDrag.ops().find((o) => o.opId === 'carve');
    if (!tag || !g) return { grabbable };
    const c = { x: (g.bbox.minX + g.bbox.maxX) / 2, y: (g.bbox.minY + g.bbox.maxY) / 2 };
    return { tag, c, grabbable, from: window.loomDrag.clientOf(c.x, c.y), to: window.loomDrag.clientOf(c.x - 0.3, c.y + 0.3) };
  });
  if (w1.from && !w1.grabbable.includes('cutout')) pass('welcome sign: carve grabbable, tag itself is not');
  else fail(`grabbable wrong: ${JSON.stringify(w1.grabbable)}`);
  if (w1.from) {
    await page.mouse.move(w1.from.x, w1.from.y);
    await page.mouse.down();
    await page.mouse.move(w1.to.x, w1.to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('badge').textContent === 'VERIFIED', { timeout: 60000 });
    const w2 = await page.evaluate(() => {
      const r = JSON.parse(localStorage.getItem('loom:recipe'));
      return {
        carve: r.pipeline.find((o) => o.id === 'carve').params,
        cut: r.pipeline.find((o) => o.id === 'cutout').params,
        tagNow: window.loomDrag.ringBBoxOf('cutout'),
      };
    });
    const pinOk = [w2.cut.posX, w2.cut.posY, w2.cut.width, w2.cut.height].every(Number.isFinite);
    const tagHeld = Math.abs((w2.tagNow.minX + w2.tagNow.maxX) / 2 - (w1.tag.minX + w1.tag.maxX) / 2) < 0.02
      && Math.abs((w2.tagNow.maxX - w2.tagNow.minX) - (w1.tag.maxX - w1.tag.minX)) < 0.02;
    const textMoved = Math.abs(w2.carve.posX - (w1.c.x - 0.3)) < 0.05 && Math.abs(w2.carve.posY - (w1.c.y + 0.3)) < 0.05;
    if (pinOk && tagHeld && textMoved) {
      pass(`drag pinned the tag (${w2.cut.width}" × ${w2.cut.height}") and moved the name on it, VERIFIED`);
    } else fail(`tag pin wrong: pin=${pinOk} held=${tagHeld} moved=${textMoved} ${JSON.stringify(w2.cut)}`);
    await page.screenshot({ path: path.join(out, 'badge-ui-8-tag-pinned.png') });
  }
  await page.click('#btn3d');
  await new Promise((r) => setTimeout(r, 300));

  // ---- a brand-new visitor gets the intro unprompted, once — in an
  // INCOGNITO context: a plain newPage shares this profile's localStorage,
  // where the example-load above already stamped loom:introSeen
  const freshCtx = await browser.createBrowserContext();
  const fresh = await freshCtx.newPage();
  await fresh.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fresh.waitForFunction(() => document.getElementById('badge').textContent !== '…', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));
  const auto = await fresh.evaluate(() => document.getElementById('introOverlay').style.display !== 'none');
  if (auto) pass('fresh visitor: intro auto-opens'); else fail('intro did not auto-open on a fresh visit');
  await fresh.click('#introClose');
  await fresh.reload({ waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  const again = await fresh.evaluate(() => document.getElementById('introOverlay').style.display !== 'none');
  if (!again) pass('intro stays closed after being seen'); else fail('intro re-opened after close');
  await freshCtx.close();

  const pageErrs = errors.filter((e) => !e.includes('favicon') && !e.includes('intent/invite') && !e.includes('404'));
  if (!pageErrs.length) pass('no page errors'); else fail(`page errors: ${pageErrs.join(' | ')}`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
