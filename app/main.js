// Loom — the mother app. Prompts and sliders edit the same recipe
// document; every state runs the full pipeline through the verifier.
// The LLM (user's own key browser-direct, or a metered guest pass
// relayed by the server) emits recipe actions only — no code, no
// motion. See intent.mjs for the trust boundary.

import { EMPTY_RECIPE, runRecipe, controlDefaults, migrateRecipe, makeEvalNumber, buildVars } from './runtime.mjs';
import { registerCatalogEntries, CATALOG } from './catalog.mjs';
import { svgAssetToRegions } from './svg.mjs';
import { openDraw, initDraw } from './draw.mjs';
import { sheetActive, placeOnSheet, sheetFreePct, recordCut, clearCuts } from './ledger.mjs';
import { buildParseRequest, applyActions, promptRecipeView } from './intent.mjs';
import { walkMoves } from '../ir/moves.js';
import { loadToolLibrary, saveToolLibrary, describeTool, parseInches, formatInches, MATERIALS } from '../ir/tools.js';
import { startWeave } from './weave.mjs';
import { resolveTerrains } from './terrain-fetch.mjs';
import { simulateJob } from './sim.mjs';
import { createView3D } from './view3d.mjs';
import { buildAssemblyLayer } from './assembly3d.mjs';
import { FONTS } from './fonts.mjs';
import { probe, machineName, machineStatus, scanSubnet, submitJob, submitAndRun, lanDiagnosis } from './fabmo.mjs';
import { EXAMPLES } from './examples.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

let LOADED_FONTS = null;   // id → ArrayBuffer, the whole shelf
let viewMode = localStorage.getItem('loom:view') ?? '3d';
let view3d = null;
let recipe = loadRecipe();
let controlValues = controlDefaults(recipe);
let shop = loadShop();
let toolLib = loadToolLibrary();   // the SHARED shopbot:tools drawer
let sheet = loadSheet();
let lastTerrains = {};   // last resolved terrains, reused for sheet-positioned re-runs
let result = null;
let lastSim = null;      // the worker's simulateJob output for `result` (3D surface)
let busy = false;
let modelChips = [];     // suggested next prompts from the last intent turn (ephemeral)

const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

function loadRecipe() {
  try {
    const s = localStorage.getItem('loom:recipe');
    if (s) return migrateRecipe(JSON.parse(s));
  } catch { /* fresh start */ }
  return structuredClone(EMPTY_RECIPE);
}
// Shop settings — the machine's cutting area and the material sheets on
// hand. Physical facts about the shop, so they live at APP level (like
// the theme and the key), never in the recipe: changing designs doesn't
// change the machine. 0 / blank = no limit, which keeps the feature
// purely additive for anyone who never opens the fields.
function loadShop() {
  // material: a MATERIALS key ('' = keep each strategy's own feeds) —
  // with the shared tool rack it derives feeds/rpm by chipload at weave
  const base = { machineW: 0, machineH: 0, materialW: 0, materialH: 0, material: '' };
  try { return { ...base, ...JSON.parse(localStorage.getItem('loom:shop') ?? '{}') }; }
  catch { return base; }
}
function persistShop() {
  try { localStorage.setItem('loom:shop', JSON.stringify(shop)); } catch {}
}
// what the runtime sees: the persisted shop facts plus the shared tool
// rack (its own localStorage key — shopbot:tools — never inside loom:shop)
const shopForRun = () => ({ ...shop, toolLibrary: toolLib });

// The sheet ledger — a specific piece of stock the operator keeps cutting from,
// with the footprints already taken from it. App-level and persistent (outlives
// every recipe, like the shop settings): flipping to a new design must not
// forget what's already been cut. w/h = 0 → the ledger is off (purely additive).
function loadSheet() {
  const base = { w: 0, h: 0, thickness: 0.5, occupied: [] };
  try {
    const s = { ...base, ...JSON.parse(localStorage.getItem('loom:sheet') ?? '{}') };
    if (!Array.isArray(s.occupied)) s.occupied = [];
    return s;
  } catch { return base; }
}
function persistSheet() {
  try { localStorage.setItem('loom:sheet', JSON.stringify(sheet)); } catch {}
}

// The status chip: "Board: 24×12 — 83% free · 2 parts cut · this design fits ✓".
// Record is enabled only when the sheet is on, the design verifies, and its
// footprint actually fits the remaining space.
// One line under the Board & material summary keeping the tucked-away
// facts visible while the controls stay hidden.
function updateSetupSummary() {
  const st = result?.preview?.stock;
  const parts = [`${recipe.stock.thickness}" thick`];
  if (recipe.stock.width > 0 && recipe.stock.height > 0) {
    parts.push(`blank ${recipe.stock.width}" × ${recipe.stock.height}"`);
  } else if (st?.w > 0 && st?.h > 0) {
    parts.push(`blank auto (${st.w}" × ${st.h}")`);
  } else {
    parts.push('blank auto');
  }
  if (sheetActive(sheet)) parts.push(`board ${sheet.w}×${sheet.h} · ${sheetFreePct(sheet)}% free`);
  $('setupSummary').textContent = parts.join(' · ');
}

function updateSheetChip(st) {
  updateSetupSummary();
  const chip = $('sheetChip'), rec = $('sheetRecord');
  if (!sheetActive(sheet)) { chip.textContent = ''; rec.disabled = true; return; }
  let text = `Board: ${sheet.w}" × ${sheet.h}" — ${sheetFreePct(sheet)}% free`;
  const cuts = sheet.occupied.length;
  if (cuts) text += ` · ${cuts} part${cuts > 1 ? 's' : ''} cut`;
  let fits = false;
  if (st && st.w > 0 && st.h > 0) {
    fits = !!placeOnSheet(sheet, st.w, st.h);
    text += fits ? ' · this design fits ✓' : ' · won’t fit ✗';
  }
  // a board BIGGER than the declared material sheet is a trap: designs
  // still nest to the ⚙ Material sheet limit, and "I set the sheet to
  // 96×48" (the board) reads as ignored. Say so where the user looks.
  if (shop.materialW > 0 && shop.materialH > 0) {
    const [bl, bs] = [Math.max(sheet.w, sheet.h), Math.min(sheet.w, sheet.h)];
    const [ml, ms] = [Math.max(shop.materialW, shop.materialH), Math.min(shop.materialW, shop.materialH)];
    if (bl > ml + 1e-9 || bs > ms + 1e-9) {
      text += ` · designs still nest to the ${shop.materialW}×${shop.materialH} Material sheet (⚙) — update it if this board is your stock`;
    }
  }
  chip.textContent = text;
  rec.disabled = !(fits && result?.ok);
}

function persist() {
  try {
    localStorage.setItem('loom:recipe', JSON.stringify(recipe));
  } catch {
    // embedded assets can outgrow localStorage — the recipe still works,
    // it just won't survive a reload unless saved to a file
    addTurn('This recipe is too large for browser auto-save (embedded assets) — use "Save recipe" to keep it.', true);
  }
}

// ------------------------------------------------------------ controls UI

function renderControls() {
  $('appName').textContent = recipe.name;
  $('thickness').value = recipe.stock.thickness;
  $('blankW').value = recipe.stock.width > 0 ? recipe.stock.width : '';
  $('blankH').value = recipe.stock.height > 0 ? recipe.stock.height : '';
  const host = $('controls'), more = $('controlsMore');
  host.innerHTML = '';
  more.innerHTML = '';
  // Text controls are the step itself ("type your name") — everything else
  // tucks under "More adjustments" so the visitor flow shows a minimum of
  // controls. A recipe with no text keeps all its controls in the open (a
  // slider-driven design IS its sliders).
  const hasText = recipe.controls.some((c) => c.type === 'text');
  for (const c of recipe.controls) {
    const wrap = document.createElement('div');
    if (c.type === 'text') wrap.className = 'ctl-text';
    const label = document.createElement('label');
    label.textContent = c.label ?? c.id;
    let input;
    if (c.type === 'choice') {
      input = document.createElement('select');
      for (const o of c.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label ?? o.value;
        input.append(opt);
      }
    } else {
      input = document.createElement('input');
      input.type = c.type === 'number' ? 'number' : 'text';
      if (c.type === 'number') {
        if (c.min !== undefined) input.min = c.min;
        if (c.max !== undefined) input.max = c.max;
        input.step = c.step ?? 0.125;
      }
    }
    input.value = controlValues[c.id] ?? c.default ?? '';
    input.addEventListener('input', () => {
      controlValues[c.id] = c.type === 'number'
        ? (isNaN(parseFloat(input.value)) ? c.default : parseFloat(input.value))
        : input.value;
      debounceRun();
    });
    wrap.append(label, input);
    (hasText && c.type !== 'text' ? more : host).append(wrap);
  }
  $('moreCtls').style.display = more.children.length ? '' : 'none';
  $('stepType').style.display = recipe.controls.length ? '' : 'none';
  $('stepTypeLabel').textContent = hasText ? 'Type it in' : 'Adjust the design';
  renderAssets();
  renderChips();
  // the debug view elides asset payloads the same way the LLM prompt does
  $('recipeJson').textContent = JSON.stringify(promptRecipeView(recipe), null, 2);
}

// ------------------------------------------------------------- assets
// Uploaded images/graphics live IN the recipe document (self-contained,
// survives save/open). SVG files are consumable: the shapes section
// lowers their filled artwork to cuttable geometry ({asset: {of, width}}).
// Raster images are intake-only until the image strategies arrive.

function renderAssets() {
  const host = $('assets');
  host.innerHTML = '';
  for (const a of recipe.assets ?? []) {
    const chip = document.createElement('span');
    chip.className = 'asset-chip';
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.data;
      img.alt = '';
      chip.append(img);
    }
    const name = document.createElement('span');
    name.textContent = a.kind === 'svg' ? `⬡ ${a.name}` : a.name;
    chip.append(name);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'remove';
    x.addEventListener('click', () => {
      const usedBy = (recipe.shapes ?? []).filter(s => s.asset && (s.asset.of === a.id || s.asset.of === a.name));
      if (usedBy.length) {
        addTurn(`"${escapeHtml(a.name)}" is still used by shape${usedBy.length > 1 ? 's' : ''} ${usedBy.map(s => `"${s.id}"`).join(', ')} — remove that first (ask, or edit the recipe).`, true);
        return;
      }
      recipe.assets = recipe.assets.filter(z => z.id !== a.id);
      persist();
      renderAssets();
    });
    chip.append(x);
    host.append(chip);
  }
  renderDrawControls();
}

// Drawing inputs, rendered at the TOP of the design flow: every set_shape
// draw in the recipe gets its own control — a loud primary button while
// the outline is missing (the weave is visibly incomplete without it), a
// quiet redraw once it exists. Field report 2026-07-26: the generic
// "Draw a shape…" button lives down in the export row, which is not where
// a person designing "draw a tag, then type the name" ever looks — the
// drawing belongs BEFORE the typing. Hooked off renderAssets so every
// path that changes drawings (intent turn, draw, redraw, remove) refreshes it.
function renderDrawControls() {
  const host = $('drawControls');
  host.innerHTML = '';
  let count = 0;
  for (const s of recipe.shapes ?? []) {
    const name = s.draw?.of;
    if (!name) continue;
    count++;
    const drawn = (recipe.assets ?? []).some((a) => a.id === name || a.name === name);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; margin:8px 0; flex-wrap:wrap';
    const btn = document.createElement('button');
    if (drawn) { btn.className = 'ghost'; btn.textContent = `↻ Redraw “${name}”`; }
    else { btn.className = 'big'; btn.textContent = `✏ Draw “${name}”`; }
    btn.addEventListener('click', () => openDrawDialog(name));
    const note = document.createElement('span');
    note.className = 'keynote';
    note.style.marginTop = '0';
    note.textContent = drawn
      ? 'redrawing re-weaves everything that uses it'
      : 'the design is waiting on this outline — sketch it to complete the cut';
    row.append(btn, note);
    host.append(row);
  }
  $('stepDraw').style.display = count ? '' : 'none';
  renumberSteps();
}

// The visitor flow's numbers stay honest as steps come and go: visible
// steps count 1..n, and a lone step drops its heading entirely (numbering
// a single step reads as a form, not a flow).
function renumberSteps() {
  const steps = ['stepDraw', 'stepType', 'stepCut'].map($).filter((el) => el.style.display !== 'none');
  steps.forEach((el, i) => { el.querySelector('.step-num').textContent = String(i + 1); });
  for (const el of steps) el.querySelector('.step-head').style.display = steps.length > 1 ? '' : 'none';
}

// raster uploads get downscaled client-side: carving heightmaps are ≤ a
// few hundred cells across, so 1024px keeps all the fidelity a bit can
// reproduce while staying inside localStorage budgets
async function imageToDataUrl(file, maxDim = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('that file did not decode as an image'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return { data: cv.toDataURL(type, 0.85), width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Add any prepared asset under a unique id; returns the stored entry.
function pushAsset(asset, displayName) {
  recipe.assets ??= [];
  const base = String(displayName).replace(/[^A-Za-z0-9._-]+/g, '_') || 'asset';
  let unique = base, n = 2;
  while (recipe.assets.some(a => a.id === unique)) unique = `${base}~${n++}`;
  const entry = { id: unique, name: displayName, ...asset };
  recipe.assets.push(entry);
  persist();
  renderAssets();
  return entry;
}

// Store an SVG — uploaded OR hand-drawn — as a shape-able asset, and report how
// it lowers so the user hears "ready" (or the honest reason) before asking for a
// cut. Shared by the file upload and the Draw modality; a drawn shape is just an
// SVG the user made by sketching instead of by picking a file.
function addSvgAsset(svgText, displayName) {
  if (!svgText || !svgText.includes('<svg')) throw new Error('that does not look like an SVG');
  const entry = pushAsset({ kind: 'svg', data: svgText }, displayName);
  const probe = svgAssetToRegions(svgText, {}); // same lowering the weave will run
  const nm = escapeHtml(entry.name);
  if (probe.error) {
    addTurn(`Added "${nm}" to the recipe, but it won't lower to a shape yet: ${escapeHtml(probe.error)}`, true);
  } else {
    const pieces = probe.regions.length;
    const holes = probe.regions.reduce((n, r) => n + r.holes.length, 0);
    const notes = probe.warnings.length ? ` (${probe.warnings.map(escapeHtml).join('; ')})` : '';
    addTurn(`Added "${nm}" — ${pieces} filled piece${pieces > 1 ? 's' : ''}${holes ? `, ${holes} hole${holes > 1 ? 's' : ''}` : ''}${notes}. Ask to use it: "cut out ${nm} 4 inches wide", "pocket it 1/8 deep"…`);
  }
  // a recipe may already be waiting on this asset by name (a set_shape
  // draw authored before anything was drawn) — re-weave so accepting the
  // drawing lights up the ops referencing it, not the next unrelated edit
  debounceRun();
  return entry;
}

// Replace an existing SVG asset's geometry IN PLACE (a redrawn shape): the id
// and name stay, so any cutout/pocket referencing it re-weaves with the new
// drawing — the per-person "redraw this tag" input, the way a text control retypes.
function replaceSvgAsset(id, svgText) {
  if (!svgText || !svgText.includes('<svg')) throw new Error('that does not look like an SVG');
  const a = (recipe.assets ?? []).find((z) => z.id === id);
  if (!a) return addSvgAsset(svgText, 'drawing');   // it vanished — just add a new one
  a.data = svgText;
  persist();
  renderAssets();
  const probe = svgAssetToRegions(svgText, {});
  addTurn(probe.error
    ? `Updated "${escapeHtml(a.name)}", but it won't lower yet: ${escapeHtml(probe.error)}`
    : `Updated the shape "${escapeHtml(a.name)}" — anything cutting it re-weaves with the new drawing.`);
  debounceRun();   // the referencing cutout re-lowers with the new geometry
  return a;
}

async function addAssetFile(f) {
  const isSvg = f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg');
  if (isSvg) {
    if (f.size > 512 * 1024) throw new Error('SVG larger than 512 KB — simplify it first');
    addSvgAsset(await f.text(), f.name);
    return;
  }
  const { data, width, height } = await imageToDataUrl(f);
  if (data.length > 1.5e6) throw new Error('image still too large after downscaling — crop it and retry');
  pushAsset({ kind: 'image', data, width, height }, f.name);
  addTurn(`Added image "${escapeHtml(f.name)}" (${width}×${height}px) to the recipe. Raster carving isn't in the catalog yet — it is stored for when that arrives.`);
}

// ---------------------------------------------------------------- run/draw

function setBadge(cls, text) { const b = $('badge'); b.className = `badge ${cls}`; b.textContent = text; }

// The weave overlay (index.html #weaveOverlay): shown before the
// synchronous weave blocks the thread, hidden when render() finishes.
// runAndRender's rAF→setTimeout structure guarantees one PAINT between
// the class flip and the block, so the compositor has the layer and keeps
// the shuttle moving while the page is frozen.
const showWeaveOverlay = () => $('weaveOverlay').classList.add('show');
const hideWeaveOverlay = () => $('weaveOverlay').classList.remove('show');
// yield one painted frame — for click handlers that weave synchronously
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---- the weave worker (app/weave-worker.mjs): runRecipe + simulateJob
// off the main thread, so typing and drawing stay responsive while a
// weave computes. Falls back to weaving on the main thread — same
// results, old lockups — when module workers are unavailable or the
// worker dies mid-session.
let weaveWorker = null;
let weaveMsgId = 0;
const weavePending = new Map();   // id → { resolve, payload }

function syncWeave(p) {
  const result = quiet(() => runRecipe(p.recipe, p.values, LOADED_FONTS, p.terrains ?? {}, p.shop, p.placement));
  let sim = null;
  if (p.wantSim !== false && result.ok && result.preview?.built?.length) {
    sim = simulateJob(result.preview.built, result.preview.placement ?? { x: 0, y: 0 },
      result.preview.stock, { analyticVee: true });
  }
  return { result, sim };
}

function initWeaveWorker(guestUrls) {
  let w;
  try {
    w = new Worker(new URL('./weave-worker.mjs', import.meta.url), { type: 'module' });
  } catch {
    return;   // no module workers here — the sync fallback carries on
  }
  w.onmessage = (e) => {
    const m = e.data;
    if (m.kind !== 'wove' && m.kind !== 'error') return;
    const p = weavePending.get(m.id);
    if (!p) return;
    weavePending.delete(m.id);
    // an error reply is a worker-side throw or unclonable result — weave
    // honestly on this thread rather than showing nothing
    p.resolve(m.kind === 'wove' ? { result: m.result, sim: m.sim } : syncWeave(p.payload));
  };
  w.onerror = (err) => {
    // the worker is gone: finish everything in flight on the main thread
    // and stay there for the rest of the session
    console.warn('weave worker failed — weaving on the main thread from here on', err);
    weaveWorker = null;
    const pending = [...weavePending.values()];
    weavePending.clear();
    for (const p of pending) p.resolve(syncWeave(p.payload));
  };
  w.postMessage({ kind: 'init', fonts: LOADED_FONTS, guestUrls });
  weaveWorker = w;
  window.loomWeave = { workerActive: () => !!weaveWorker };   // test/debug handle
}

// weave a recipe state → Promise<{ result, sim }>, wherever it runs
function weave(payload) {
  // on-thread weaving blocks: let the overlay paint one frame first
  if (!weaveWorker) return nextPaint().then(() => syncWeave(payload));
  const id = ++weaveMsgId;
  return new Promise((resolve) => {
    weavePending.set(id, { resolve, payload });
    try {
      weaveWorker.postMessage({ kind: 'weave', id, ...payload });
    } catch (e) {
      // a payload that won't clone (should not happen — recipes are data)
      weavePending.delete(id);
      resolve(syncWeave(payload));
    }
  });
}

let weaveSeq = 0;   // stale async weaves must not clobber newer ones
async function runAndRender() {
  if (!LOADED_FONTS) return;
  setBadge('wait', 'computing…');
  showWeaveOverlay();
  const seq = ++weaveSeq;
  // terrain references resolve ABOVE the rail: geocode + public DEM
  // tiles fetched on the user's own connection, cached per region, the
  // resolved bbox/meta pinned back into the recipe. The weave below
  // stays a pure function of the returned grids.
  let terrains = {};
  if (recipe.terrains?.length) {
    try {
      terrains = await resolveTerrains(recipe, (msg) => setBadge('wait', msg));
      persist();   // keep the pinned bbox/meta
    } catch (e) {
      if (seq !== weaveSeq) return;
      result = { ok: false, errors: [`terrain: ${e.message}`], warnings: [], preview: { empty: true } };
      lastSim = null;
      render();
      return;
    }
  }
  if (seq !== weaveSeq) return;
  lastTerrains = terrains;
  const out = await weave({ recipe, values: controlValues, terrains, shop: shopForRun() });
  if (seq !== weaveSeq) return;   // a newer weave superseded this one
  result = out.result;
  lastSim = out.sim;
  render();
}
let timer = null;
function debounceRun() { clearTimeout(timer); timer = setTimeout(runAndRender, 250); }

// The per-target verify lines, folded for display: a pattern's instances
// ("squares bulk 7/32") group into ONE summed line, and the whole list
// tucks behind a "measurements" disclosure — a chessboard was printing 33
// lines of zeros and burying the headline (field report 2026-07-27). The
// numbers are all still there, one click away; the verdict badge and the
// machine-time line carry the message.
function targetGroups(targets) {
  const groups = new Map();
  for (const tt of targets) {
    // the instance counter sits mid-name: "squares bulk 7/32 (pocket_shape)"
    const base = tt.name.replace(/\s+\d+\/\d+(?=\s|$)/, '');
    const key = `${tt.type}|${base}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { type: tt.type, name: base, count: 0, samples: 0, gouges: 0, depthViolations: 0, intrusionArea: 0, maskViolations: 0 });
    g.count++;
    g.samples += tt.samples ?? 0;
    g.gouges += tt.gouges ?? 0;
    g.depthViolations += tt.depthViolations ?? 0;
    g.intrusionArea += tt.intrusionArea ?? 0;
    g.maskViolations += tt.maskViolations ?? 0;
  }
  return [...groups.values()];
}

function measurementsHtml(targets) {
  if (!targets.length) return '';
  const groups = targetGroups(targets);
  const line = (g) => {
    const name = `<i>${g.count > 1 ? `${g.count}× ` : ''}${g.name}</i>`;
    if (g.type === 'profile') {
      return `<b>${g.samples.toLocaleString()}</b> samples · <b>${Math.round(g.intrusionArea * 1000) / 1000}</b> sq in intrusion · <b>${g.depthViolations}</b> depth violations — ${name}`;
    }
    if (g.type === 'heightmap') {
      return `<b>${g.samples.toLocaleString()}</b> samples · <b>${g.gouges}</b> gouges · <b>${g.maskViolations}</b> mask escapes — ${name}`;
    }
    return `<b>${g.samples.toLocaleString()}</b> samples · <b>${g.gouges}</b> gouges · <b>${g.depthViolations}</b> depth violations — ${name}`;
  };
  const totalSamples = groups.reduce((n, g) => n + g.samples, 0);
  return `<details><summary>the measurements — ${targets.length} target${targets.length > 1 ? 's' : ''} · ${totalSamples.toLocaleString()} samples</summary>${groups.map(line).join('<br>')}</details>`;
}

// The decision record, folded like the measurements: why each bit, rpm,
// and feed is what it is. The runtime accumulates the evidence
// (result.rationale — auto-tool coverage curves, chipload derivations
// with their binding constraint, rack matches) and this renders it
// verbatim. Written to be read over a student's shoulder: every number
// shown is the number in the exported file, derived by code — the one
// model-narrated line is the recipe's own summary, labeled as such.
const FEED_BINDING_TEXT = {
  'preferred-rpm': 'rpm at the 18,000 wood-cutting sweet spot',
  'material-rpm-cap': 'rpm capped for this material (it melts or chatters at higher speed)',
  'machine-rpm-cap': "rpm at the spindle's top speed",
  'feed-cap': "the machine's feed cap bound first, so rpm came DOWN to keep the chipload — a rubbing bit dulls faster than a cutting one",
};

function whyToolLine(t, ra) {
  const bits = [`<b>tool ${t.number}</b> — <i>${escapeHtml(t.name)}</i>`];
  if (t.rackMatch) bits.push(`your rack's &amp;Tool ${t.number}`);
  if (t.synthetic) bits.push('not in your rack — synthetic number, load this bit before running');
  const f = t.feeds;
  if (f) {
    bits.push(`${f.rpm.toLocaleString()} rpm · feed ${f.feedRate} in/min · plunge ${f.plungeRate} in/min`);
    bits.push(`feed = rpm × ${f.flutes} flutes × ${f.chipload}"/tooth chipload in ${escapeHtml(ra.materialLabel ?? ra.material)}; ${FEED_BINDING_TEXT[f.binding] ?? escapeHtml(f.binding)}`);
  }
  return bits.join(' · ');
}

function whyCurveLine(curve) {
  const cell = (e) => e.excluded
    ? `${e.label} (${e.excluded === 'depth' ? 'flutes too short for this depth' : e.excluded})`
    : `${e.label} ${e.pct}%${e.picked ? ' ✓' : ''}`;
  return `coverage over the drawer: ${curve.map(cell).join(' · ')} — ✓ marks the knee, where a smaller bit stops earning its toolchange`;
}

function whyHtml(r) {
  const ra = r.rationale;
  if (!ra?.ops?.length) return '';
  const lines = [];
  if (recipe.about) lines.push(`<i>${escapeHtml(recipe.about)}</i> <small>(the design plan, in the model's words — everything below is measured, not narrated)</small>`);
  for (const t of ra.tools) lines.push(whyToolLine(t, ra));
  if (!ra.material) lines.push('feeds are each strategy\'s stock numbers — declare a material in ⚙ Machine &amp; tools to derive them from chipload');
  // ops fold like the measurements: a pattern's instances ("squares bulk
  // 7/32") collapse to one line, why-strings unioned across the group
  const groups = new Map();
  for (const o of ra.ops) {
    const base = o.name.replace(/\s+\d+\/\d+(?=\s|$)/, '');
    let g = groups.get(base);
    if (!g) groups.set(base, g = { name: base, tool: o.tool, why: new Set(), curve: null });
    for (const w of o.why) g.why.add(w);
    if (o.toolCurve) g.curve ??= o.toolCurve;
  }
  for (const g of groups.values()) {
    const why = [...g.why].map(w => `<br>&nbsp;&nbsp;· ${escapeHtml(w)}`).join('');
    const curve = g.curve ? `<br>&nbsp;&nbsp;· ${escapeHtml(whyCurveLine(g.curve))}` : '';
    lines.push(`<i>${escapeHtml(g.name)}</i> — tool ${g.tool}${why}${curve}`);
  }
  return `<details><summary>why these choices — ${ra.tools.length} tool${ra.tools.length > 1 ? 's' : ''} · ${groups.size} cut${groups.size > 1 ? 's' : ''}</summary>${lines.join('<br>')}</details>`;
}

function render() {
  const r = result;
  const measurements = measurementsHtml(r.report?.stats.targets ?? []);

  if (r.ok) {
    setBadge('ok', 'VERIFIED');
    // machine time is the headline number a person plans around — the
    // wall-clock estimate (plunge-aware cutting + jogs + toolchanges)
    // rides next to the badge, the breakdown stays in the numbers line
    const runMin = r.report.stats.estRunTimeMin;
    const runTxt = runMin >= 90 ? `${(runMin / 60).toFixed(1)} hr` : `${Math.max(1, Math.round(runMin))} min`;
    $('verdictText').textContent = `this exact motion was measured, not assumed · ≈ ${runTxt} on the machine`;
    $('numbers').innerHTML = `<b>${r.report.stats.moveCount.toLocaleString()}</b> moves · <b>${r.report.stats.cutLength}"</b> of cut · ≈ <b>${r.report.stats.estCutTimeMin} min</b> cutting + <b>${r.report.stats.rapidLength}"</b> of jog` +
      (r.report.stats.toolchangeCount > 1 ? ` · <b>${r.report.stats.toolchangeCount}</b> tool mounts` : '') + measurements + whyHtml(r);
    const st = r.preview?.stock;
    // sheet-fit tag: the user's declared material wins; 4×8 (96×48, the
    // standard full-size sheet) is the fallback once the board outgrows
    // scrap size. Machine-area fit rides the weave's own warnings.
    const declared = shop.materialW > 0 && shop.materialH > 0;
    const mat = declared
      ? { w: shop.materialW, h: shop.materialH, name: `your ${shop.materialW}×${shop.materialH} sheet` }
      : { w: 96, h: 48, name: 'one 4×8 sheet' };
    const fitsMat = st && ((st.w <= mat.w + 0.01 && st.h <= mat.h + 0.01) || (st.w <= mat.h + 0.01 && st.h <= mat.w + 0.01));
    const sheetTag = st && (declared || Math.max(st.w, st.h) > 24)
      ? (fitsMat ? ` — fits ${mat.name} ✓` : ` — does NOT fit ${mat.name}`)
      : '';
    $('minStock').textContent = st ? `${st.pinned ? 'blank' : 'minimum stock'}: ${st.w}" × ${st.h}" × ${st.thickness}"${sheetTag}` : '';
  } else {
    // EMPTY is only the nothing-here state; every real failure is
    // REJECTED with its reason — a fit conflict must never read as
    // "empty app"
    const nothingYet = r.preview?.empty && r.errors[0]?.includes('no operations');
    setBadge('bad', nothingYet ? 'EMPTY' : 'REJECTED');
    $('verdictText').textContent = nothingYet ? 'describe an app to begin' : 'the verifier refused this state';
    // a refused job's decision record still teaches — show it when built
    $('numbers').innerHTML = measurements + whyHtml(r);
    $('minStock').textContent = '';
  }
  $('errors').textContent = (r.preview?.empty && r.errors[0]?.includes('no operations')) ? '' : r.errors.join('\n');
  $('warnings').textContent = r.warnings.join('\n');
  updateSheetChip(r.preview?.stock);
  $('dlSbp').disabled = !r.ok;
  $('dlNc').disabled = !r.ok;
  $('stepCut').style.display = (recipe.pipeline ?? []).length ? '' : 'none';
  renumberSteps();
  updateFabmoSend();
  renderHandoffs();
  // the reveal: the first VERIFIED weave of the session that carries an
  // assembly jumps to 3D and plays the piece rising out of the board.
  // Once per session — tweak prompts and slider drags re-weave with the
  // assembly still present, and a mid-edit rejected weave must not re-arm
  // it, so the flag never resets. The in-memory viewMode flip deliberately
  // skips localStorage: an automation shouldn't rewrite the user's choice.
  const introNow = !assemblyIntroShown && r.ok && (r.preview?.assemblies?.length ?? 0) > 0;
  if (introNow) { assemblyIntroShown = true; viewMode = '3d'; }
  refreshPreview();
  if (introNow) playAssemblyIntro();
  hideWeaveOverlay();
}

// "Continue in <app>" — a catalog entry may declare a `handoff` hook
// (guest apps use it to carry the authored document back into their own
// app for hand-editing). Loom stays generic: it supplies evalNumber (so
// the document resolves at the CURRENT slider values) and the recipe
// name; the entry does the storing and says where to go. Deliberately
// not gated on r.ok — a design can be worth continuing even when this
// weave's motion was refused (wrong bit, stock mismatch); the target app
// re-verifies everything at its own export gate.
function renderHandoffs() {
  const wrap = $('handoffs');
  wrap.innerHTML = '';
  const seen = new Set();
  for (const op of recipe.pipeline ?? []) {
    const entry = CATALOG[op.strategy];
    if (!entry?.handoff?.carry || seen.has(op.strategy)) continue;
    seen.add(op.strategy);
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = `${entry.handoff.label ?? 'Continue in app'} →`;
    btn.addEventListener('click', () => {
      const bv = buildVars(recipe, controlValues);
      if (bv.error) { $('errors').textContent = `handoff: ${bv.error}`; return; }
      let res;
      try {
        res = entry.handoff.carry(op.params, { evalNumber: makeEvalNumber(bv.vars), vars: bv.vars, recipeName: recipe.name });
      } catch (e) {
        res = { error: e?.message ?? String(e) };
      }
      if (res?.error) { $('errors').textContent = `handoff: ${res.error}`; return; }
      if (res?.url) window.open(res.url, '_blank');
    });
    wrap.appendChild(btn);
  }
}

function refreshPreview() {
  // a failed weave shows the 2D diagnostic (dashed shape outlines +
  // whatever built) regardless of the chosen mode — the 3D view has
  // nothing useful to say about a refused state
  const is3d = viewMode === '3d' && !result?.preview?.failed;
  $('preview').style.display = is3d ? 'none' : 'block';
  $('preview3d').style.display = is3d ? 'block' : 'none';
  $('btn3d').className = is3d ? 'small' : 'small ghost';
  $('btn2d').className = is3d ? 'small ghost' : 'small';
  if (is3d) {
    view3d ??= createView3D($('preview3d'));
    syncView3dTheme();            // match the scene backdrop to the current theme
    window.loomView3d = view3d;   // debug/test handle for deterministic camera poses
    const pre = result?.preview;
    const stock = pre?.stock ?? { w: 8, h: 2.5, thickness: recipe.stock.thickness ?? 0.5 };
    // display surface: vee ops render their ideal analytic V-surface (smooth
    // groove walls). Everything is drawn at TRUE scale — no depth exaggeration.
    // The worker computes it alongside every weave (lastSim), so 2D↔3D
    // toggles are instant; the on-demand compute is the workerless fallback.
    const sim = lastSim ?? (pre?.built?.length
      ? simulateJob(pre.built, pre.placement, stock, { analyticVee: true })
      : null);
    // feature depth (deepest cut that is NOT a through cut) normalizes the
    // depth TINT so an engraving next to a through cutout still uses the whole
    // color scale — a tag's kerf must not swallow the carve it surrounds.
    let featureDepth = 0;
    if (sim) {
      const BINS = 100;
      const zTh = 0.9 * stock.thickness;
      const hist = new Uint32Array(BINS);
      let cut = 0;
      for (const z of sim.grid) {
        if (z >= -1e-6) continue;
        cut++;
        if (z > -zTh) hist[Math.min(BINS - 1, Math.floor((-z / zTh) * BINS))]++;
      }
      const minMass = Math.max(50, cut * 0.005);
      for (let b = BINS - 1; b >= 0; b--) {
        if (hist[b] >= minMass) { featureDepth = -((b + 1) / BINS) * zTh; break; }
      }
      if (featureDepth === 0) featureDepth = sim.minZ;   // pure through job
    }
    window.loomZx = { zx: 1, featureDepth, minZ: sim?.minZ };   // debug handle
    view3d.update(sim, stock, 1, featureDepth ? -featureDepth : null);
    syncAssembly(pre, stock);
  } else {
    cancelAssemblyIntro();
    $('assembleWrap').style.display = 'none';
    draw();
  }
}

// ---- assembled view: ops that returned assembly data (guest furniture)
// blend between flat-in-the-board and standing assembled. The layer is
// rebuilt every weave (geometry rides the sliders); the blend position
// persists so dragging a size slider doesn't collapse the piece.
let assemblyLayer = null;
let assemblyBlend = 0;
let assemblyIntroShown = false;   // the reveal plays once per session
let assemblyIntroRaf = 0;

function cancelAssemblyIntro() {
  if (assemblyIntroRaf) { cancelAnimationFrame(assemblyIntroRaf); assemblyIntroRaf = 0; }
}

// scrub the Assemble slider 0 → 1 on the app's behalf: a short hold on the
// flat board (the cut has to register before the parts leave it), then a
// smoothstep rise. Reads assemblyLayer fresh each frame so a re-weave
// mid-flight (geometry rebuilt) keeps animating the new layer.
function playAssemblyIntro() {
  if (!assemblyLayer) return;
  cancelAssemblyIntro();
  const HOLD = 500, RISE = 2600;
  let start = null;
  const step = (ts) => {
    start ??= ts;
    const t = Math.min(1, Math.max(0, (ts - start - HOLD) / RISE));
    assemblyBlend = t * t * (3 - 2 * t);
    $('assembleSlider').value = String(assemblyBlend);
    if (assemblyLayer && view3d) { assemblyLayer.setBlend(assemblyBlend); view3d.render(); }
    assemblyIntroRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  assemblyIntroRaf = requestAnimationFrame(step);
}

function syncAssembly(pre, stock) {
  if (assemblyLayer) {
    view3d.scene.remove(assemblyLayer.group);
    assemblyLayer.dispose();
    assemblyLayer = null;
  }
  const asms = pre?.assemblies ?? [];
  $('assembleWrap').style.display = asms.length ? 'flex' : 'none';
  if (!asms.length) { assemblyBlend = 0; $('assembleSlider').value = '0'; return; }
  assemblyLayer = buildAssemblyLayer(asms, pre.placement ?? { x: 0, y: 0 }, stock);
  view3d.scene.add(assemblyLayer.group);
  $('assembleSlider').value = String(assemblyBlend);
  assemblyLayer.setBlend(assemblyBlend);
  window.loomAssembly = { layer: assemblyLayer, blend: () => assemblyBlend, introPlaying: () => assemblyIntroRaf !== 0 };   // test handle
  view3d.render();
}

$('assembleSlider').addEventListener('input', () => {
  cancelAssemblyIntro();   // the user's hand on the scrub outranks the show
  assemblyBlend = parseFloat($('assembleSlider').value);
  if (assemblyLayer && view3d) {
    assemblyLayer.setBlend(assemblyBlend);
    view3d.render();
  }
});

// the 2D board mapping, shared by draw() and the drag-to-place pointer
// handlers so a grabbed point and a drawn point can never disagree
function viewTransform() {
  const stock = result?.preview?.stock ?? { w: 8, h: 2.5 };
  const pad = 28;
  const s = Math.min((canvas.width - 2 * pad) / stock.w, (canvas.height - 2 * pad) / stock.h);
  const ox = (canvas.width - stock.w * s) / 2, oy = (canvas.height + stock.h * s) / 2;
  return { stock, s, ox, oy, place: result?.preview?.placement ?? { x: 0, y: 0 } };
}

// ------------------------------------------------ drag-to-place (2D view)
// Direct manipulation for the ops that already understand absolute
// placement: any UNFRAMED pipeline op whose entry takes posX/posY (the
// text verbs, pocket_shape) can be grabbed in the 2D view and dragged to
// a new spot. A drag is nothing more than a hands-on way of authoring
// those two params — the drop writes posX/posY into the recipe and the
// ordinary re-weave (and the verifier gate) takes it from there, so a
// dragged state carries exactly the guarantees a typed one does.
// Excluded: framed ops (the delta would need the inverse frame rotation
// — a later move) and edgeTreatment bands (they hug their cutout's edge
// by construction; posX/posY docs forbid positioning them).

function ringsOf(r) {
  if (r.previewRegions) return r.previewRegions.flatMap((g) => [g.outer, ...g.holes]);
  if (r.target?.rings) return r.target.rings;
  return [];
}

// built sub-ops grouped per draggable pipeline op: grab-box + ghost rings.
// Cached per weave result — hover hit-tests run on every pointer move.
let dragOpsFor = null;
let dragOpsCache = [];
function dragOps() {
  if (dragOpsFor === result) return dragOpsCache;
  dragOpsFor = result;
  const byId = new Map();
  for (const { op, r } of result?.preview?.built ?? []) {
    const entry = CATALOG[op.strategy];
    if (!entry?.params?.posX || !entry?.params?.posY || op.frame) continue;
    // wrappers (tag/disc/shape_cutout) are positionable but NOT grabbable:
    // their outline contains everything, so they would shadow every grab
    // aimed at the content on them — and with auto board placement, moving
    // the whole part is meaningless anyway. Dragging content pins them.
    if (entry.wrapsContent) continue;
    if (op.params?.edgeTreatment === true || op.params?.edgeTreatment === 'true') continue;
    let g = byId.get(op.id);
    if (!g) byId.set(op.id, g = { opId: op.id, rings: [], bbox: null });
    const rings = ringsOf(r);
    g.rings.push(...rings);
    // a single-result op carries its block bbox (the exact point posX/posY
    // positions); multi-sub verbs (bulk + rest) union their sub geometry
    const pts = r.bbox
      ? [{ x: r.bbox.minX, y: r.bbox.minY }, { x: r.bbox.maxX, y: r.bbox.maxY }]
      : rings.flat();
    for (const q of pts) {
      g.bbox = g.bbox
        ? {
            minX: Math.min(g.bbox.minX, q.x), minY: Math.min(g.bbox.minY, q.y),
            maxX: Math.max(g.bbox.maxX, q.x), maxY: Math.max(g.bbox.maxY, q.y),
          }
        : { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
    }
  }
  dragOpsCache = [...byId.values()].filter((g) => g.bbox);
  return dragOpsCache;
}

let drag = null;   // { g, sx, sy, dx, dy, moved } — deltas in board inches

// pointer event → recipe-local inches (the frame posX/posY live in)
function previewPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * canvas.width / rect.width;
  const cy = (e.clientY - rect.top) * canvas.height / rect.height;
  const { s, ox, oy, place } = viewTransform();
  return { x: (cx - ox) / s - place.x, y: (oy - cy) / s - place.y, s };
}

function hitDragOp(p) {
  const ops = dragOps();
  const pad = 6 / p.s;   // ~6px of grab slack, in inches
  for (let i = ops.length - 1; i >= 0; i--) {   // topmost = latest in the pipeline
    const b = ops[i].bbox;
    if (p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad) return ops[i];
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !result) return;
  const p = previewPoint(e);
  const g = hitDragOp(p);
  if (!g) return;
  drag = { g, sx: p.x, sy: p.y, dx: 0, dy: 0, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (result) canvas.style.cursor = hitDragOp(previewPoint(e)) ? 'grab' : '';
    return;
  }
  const p = previewPoint(e);
  drag.dx = p.x - drag.sx;
  drag.dy = p.y - drag.sy;
  // a real drag, not a jittery click: ~3px of travel arms the ghost
  if (!drag.moved && Math.hypot(drag.dx, drag.dy) * p.s > 3) drag.moved = true;
  if (drag.moved) draw();
});

const endDrag = (commit) => (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.style.cursor = '';
  if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const op = commit && d.moved ? (recipe.pipeline ?? []).find((o) => o.id === d.g.opId) : null;
  if (!op) { draw(); return; }
  // posX/posY position the op's bbox CENTER, and 0 means "unset — leave
  // to place", so a drop landing exactly on an axis nudges to 0.001"
  // (invisible at cut scale) instead of silently reverting the op to
  // its automatic placement
  const rnd = (v) => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0.001 : r; };
  op.params ??= {};
  op.params.posX = rnd((d.g.bbox.minX + d.g.bbox.maxX) / 2 + d.dx);
  op.params.posY = rnd((d.g.bbox.minY + d.g.bbox.maxY) / 2 + d.dy);
  // a self-sizing cutout AFTER the dragged op would chase the content and
  // re-center it (a tag_cutout badge re-wraps the moved name — the drag
  // reads as a no-op). Pin every such wrapper at its CURRENT geometry, so
  // the part outline stays put and the content moves ON it; overflow past
  // the pinned edge is then the entry's own honest refusal.
  const idx = recipe.pipeline.indexOf(op);
  for (const w of recipe.pipeline.slice(idx + 1)) {
    const entry = CATALOG[w.strategy];
    if (!entry?.wrapsContent || w.frame) continue;
    // a shapes-section REFERENCE is anchored — it holds still by
    // construction, so it needs no pin. And a content-derived one (an
    // around-rect unioned with a drawn badge) must keep FOLLOWING the
    // name it wraps: pinning it would recenter the outline off the text
    // and turn the next edit into a false "pokes outside" refusal
    if (w.params?.shape) continue;
    const unset = (k) => { const v = w.params?.[k]; return v === undefined || v === null || v === 0 || v === ''; };
    if (!unset('posX') || !unset('posY')) continue;   // already pinned or authored
    const bb = builtRingBBox(w.id);
    if (!bb) continue;
    w.params ??= {};
    w.params.posX = rnd((bb.minX + bb.maxX) / 2);
    w.params.posY = rnd((bb.minY + bb.maxY) / 2);
    if (entry.wrapsContent === 'sized') {   // tag_cutout also self-SIZES
      // ceil, not round: a pinned tag must never come out a half-thou
      // SMALLER than the content it was wrapping when pinned
      if (unset('width')) w.params.width = Math.ceil((bb.maxX - bb.minX) * 1000) / 1000;
      if (unset('height')) w.params.height = Math.ceil((bb.maxY - bb.minY) * 1000) / 1000;
    }
  }
  persist();
  renderControls();   // the recipe debug view shows the new coordinates
  runAndRender();
};

// a wrapper op's cut outline as-built: previewRing is the authoritative
// profile (target rings can include chamfer bands that slightly differ)
function builtRingBBox(opId) {
  let bb = null;
  const grow = (q) => {
    bb = bb
      ? {
          minX: Math.min(bb.minX, q.x), minY: Math.min(bb.minY, q.y),
          maxX: Math.max(bb.maxX, q.x), maxY: Math.max(bb.maxY, q.y),
        }
      : { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
  };
  for (const { op, r } of result?.preview?.built ?? []) {
    if (op.id === opId && r.previewRing) r.previewRing.forEach(grow);
  }
  if (bb) return bb;
  for (const { op, r } of result?.preview?.built ?? []) {
    if (op.id === opId) for (const ring of r.target?.rings ?? []) ring.forEach(grow);
  }
  return bb;
}
canvas.addEventListener('pointerup', endDrag(true));
canvas.addEventListener('pointercancel', endDrag(false));

// test/debug handle: what's grabbable, and board-inch → client-pixel
// mapping so a browser test can aim a synthetic drag
window.loomDrag = {
  ops: () => dragOps().map((g) => ({ opId: g.opId, bbox: g.bbox })),
  ringBBoxOf: (opId) => builtRingBBox(opId),
  clientOf: (x, y) => {
    const rect = canvas.getBoundingClientRect();
    const { s, ox, oy, place } = viewTransform();
    return {
      x: rect.left + (ox + (x + place.x) * s) * rect.width / canvas.width,
      y: rect.top + (oy - (y + place.y) * s) * rect.height / canvas.height,
    };
  },
};

function draw() {
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  const { stock, s, ox, oy } = viewTransform();
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;

  ctx.fillStyle = '#f3ead8';
  ctx.strokeStyle = '#c9a86a';
  ctx.lineWidth = 1.5;
  ctx.fillRect(X(0), Y(stock.h), stock.w * s, stock.h * s);
  ctx.strokeRect(X(0), Y(stock.h), stock.w * s, stock.h * s);

  const pre = result?.preview;
  if (!pre || (!pre.built?.length && !pre.shapeOutlines?.length)) return;
  const place = pre.placement ?? { x: 0, y: 0 };

  // construction geometry (the shapes section), faint and dashed —
  // drawn even when the weave FAILED so a fit conflict shows where the
  // shape and the content disagree instead of a blank board
  if (pre.shapeOutlines?.length) {
    ctx.strokeStyle = pre.failed ? 'rgba(179,38,30,0.55)' : 'rgba(123,163,212,0.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    for (const so of pre.shapeOutlines) {
      for (const ring of so.rings) {
        ctx.beginPath();
        ring.forEach((pt, i) => {
          const px = X(pt.x + place.x), py = Y(pt.y + place.y);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        if (!so.open) ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  for (const { r } of (pre.built ?? [])) {
    if (r.previewRegions) {
      ctx.beginPath();
      for (const g of r.previewRegions) {
        for (const ring of [g.outer, ...g.holes]) {
          ring.forEach((pt, i) => {
            const px = X(pt.x + place.x), py = Y(pt.y + place.y);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          });
          ctx.closePath();
        }
      }
      ctx.fillStyle = 'rgba(120,120,125,0.16)';
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(90,90,100,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (r.previewRing) {
      ctx.beginPath();
      r.previewRing.forEach((pt, i) => {
        const px = X(pt.x + place.x), py = Y(pt.y + place.y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.strokeStyle = 'rgba(140,100,40,0.85)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (r.previewHoles?.length) {
      ctx.strokeStyle = 'rgba(90,90,100,0.7)';
      ctx.fillStyle = 'rgba(120,120,125,0.16)';
      ctx.lineWidth = 1;
      for (const h of r.previewHoles) {
        ctx.beginPath();
        ctx.arc(X(h.x + place.x), Y(h.y + place.y), h.r * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (r.previewTabs?.length) {
      ctx.fillStyle = '#c9a86a';
      for (const tb of r.previewTabs) {
        ctx.beginPath();
        ctx.arc(X(tb.x + place.x), Y(tb.y + place.y), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const maxD = r.target?.depth ?? 0.2;
    const isCut = !!r.previewRing;
    walkMoves(r.moves, (state, move) => {
      if (move.type !== 'linear') return;
      const from = state.prev, to = state;
      if (from.z > -1e-9 && to.z > -1e-9) return;
      if (Math.abs(to.x - from.x) < 1e-12 && Math.abs(to.y - from.y) < 1e-12) return;
      if (isCut) {
        ctx.strokeStyle = 'rgba(204,34,41,0.45)';
        ctx.lineWidth = 2.4;
      } else {
        const d = Math.min(1, Math.abs((from.z + to.z) / 2) / maxD);
        ctx.strokeStyle = `rgba(27,42,107,${0.35 + 0.6 * d})`;
        ctx.lineWidth = 0.8 + 2.2 * d;
      }
      ctx.beginPath();
      ctx.moveTo(X(from.x + place.x), Y(from.y + place.y));
      ctx.lineTo(X(to.x + place.x), Y(to.y + place.y));
      ctx.stroke();
    });
  }

  // the drag ghost: the grabbed op's outlines at the pointer's offset —
  // the op itself stays put until the drop re-weaves
  if (drag?.moved) {
    const gx = place.x + drag.dx, gy = place.y + drag.dy;
    ctx.strokeStyle = 'rgba(123,163,212,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    for (const ring of drag.g.rings) {
      ctx.beginPath();
      ring.forEach((pt, i) => {
        const px = X(pt.x + gx), py = Y(pt.y + gy);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    const b = drag.g.bbox;
    ctx.strokeStyle = 'rgba(123,163,212,0.5)';
    ctx.strokeRect(X(b.minX + gx), Y(b.maxY + gy), (b.maxX - b.minX) * s, (b.maxY - b.minY) * s);
    ctx.setLineDash([]);
  }
}

// ------------------------------------------------------------- the prompt

function addTurn(html, isErr = false) {
  const div = document.createElement('div');
  div.className = 'turn' + (isErr ? ' err' : '');
  div.innerHTML = html;
  $('history').prepend(div);
  return div;
}

// BYO-key path: straight to Anthropic from the page — the key never
// touches our server.
async function parseDirect(req, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(res.status === 401 ? 'that API key was rejected (401)' : `API error ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

// Guest-pass path: the server relays the same request on the shop key,
// metered Claude-style — N prompts per 5-hour window, refills, never
// accumulates. Running out is the moment the key box earns its keep.
async function parseViaGuestPass(req, invite) {
  const res = await fetch('/api/intent/loom', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loom-invite': invite },
    body: JSON.stringify({ req }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('keyBox').open = true;
    if (res.status === 429 && payload.reason === 'window') {
      renderInviteBar({ valid: true, remaining: 0, resetsAt: payload.resetsAt });
      throw new Error(`your guest pass is out of prompts — it refills at ${fmtTime(payload.resetsAt)}. Add your own API key below for uninterrupted use.`);
    }
    if (res.status === 403) renderInviteBar({ valid: false, reason: payload.reason });
    throw new Error(payload.error ?? `guest-pass request failed (${res.status})`);
  }
  renderInviteBar({ valid: true, ...payload.invite });
  return payload.data;
}

async function generate() {
  const utterance = $('prompt').value.trim();
  if (!utterance || busy) return;
  if (utterance.includes(BLANK)) {
    selectBlank();
    addTurn('Fill in the blanks (___) first — Tab jumps to the next one.', true);
    return;
  }
  const key = localStorage.getItem('loom:apiKey');
  const invite = localStorage.getItem('loom:invite');
  if (!key && !invite) {
    $('keyBox').open = true;
    addTurn('Add your Anthropic API key first — it stays in this browser. (Opening Loom from a guest-pass link works too.)', true);
    return;
  }
  busy = true;
  $('generate').disabled = true;
  $('generate').textContent = 'weaving…';
  const stopWeave = startWeave($('appPanel'));
  try {
    const req = buildParseRequest(recipe, utterance, { shop });
    // what the model SAW — captured before applyActions mutates the recipe
    // (cloned: with no assets promptRecipeView returns the live object).
    // Rides along to the funnel so intent/replay.mjs can reproduce the parse.
    const parseContext = structuredClone(promptRecipeView(recipe));
    // own key wins when both exist: unlimited beats metered
    const data = key ? await parseDirect(req, key) : await parseViaGuestPass(req, invite);
    const toolUse = data.content?.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('the model returned no actions');
    // a response cut off at the token ceiling arrives as a PARTIAL action
    // list that would half-build silently — refuse the whole thing instead
    if (data.stop_reason === 'max_tokens') {
      throw new Error('that answer overran its budget mid-build, so nothing was applied — ask for it in smaller pieces (and describe repeated layouts as a pattern rather than listing every piece)');
    }
    // an empty payload (no actions, no declines, no summary) is a stall,
    // not a result — surface it as retryable rather than a blank turn
    const p0 = toolUse.input ?? {};
    if (!p0.actions?.length && !p0.declined?.length && !p0.summary?.trim()) {
      throw new Error('the model came back empty-handed — nothing was applied; hit Generate again');
    }

    const out = applyActions(recipe, toolUse.input);
    recipe = out.recipe;
    modelChips = out.suggest;   // this turn's targeted chips (renderControls → renderChips shows them)
    // the model's own account of what it built rides on the recipe (not
    // just the chat log) — the why-these-choices panel opens with it as
    // the one narrated line above the deterministic decision record
    if (out.summary?.trim()) recipe.about = out.summary.trim();
    controlValues = { ...controlDefaults(recipe), ...pickExisting(controlValues, recipe) };
    persist();
    renderControls();
    runAndRender();

    // the funnel / gap report — declines are the catalog's backlog and
    // parses its pricing data. Fire-and-forget: the weave never depends
    // on logging, and a checkout without the endpoint just no-ops.
    const logPromise = fetch('/api/intent/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(invite ? { 'x-loom-invite': invite } : {}) },
      body: JSON.stringify({
        app: 'loom',
        utterance,
        intent: { summary: out.summary, actions: toolUse.input.actions ?? [], declined: out.declined, suggest: out.suggest },
        usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
        context: parseContext,
      }),
    });

    const declined = out.declined.length
      ? `<div class="declined">declined: ${out.declined.map(d => `${escapeHtml(d.what)} — ${escapeHtml(d.why)}`).join('; ')} <i>(logged as a gap report)</i></div>` : '';
    const skipped = out.skipped.length ? `<div class="declined">skipped: ${out.skipped.map(escapeHtml).join('; ')}</div>` : '';
    const turnEl = addTurn(`<div class="you">» ${escapeHtml(utterance)}</div><div class="did">${escapeHtml(out.summary)}</div>${declined}${skipped}`);

    // the funnel's query id, pinned to the turn: "quote this when something
    // came out wrong" — replayable server-side with intent/replay.mjs
    logPromise.then(r => r.json()).then(d => {
      if (!d?.queryId) return;
      const chip = document.createElement('div');
      chip.className = 'qid';
      chip.textContent = d.queryId;
      chip.title = 'click to copy — quote this id when reporting a problem with this result';
      chip.addEventListener('click', () => {
        navigator.clipboard?.writeText(d.queryId);
        chip.textContent = `${d.queryId} ✓ copied`;
        setTimeout(() => { chip.textContent = d.queryId; }, 1200);
      });
      turnEl.append(chip);
    }).catch(() => {});
    $('prompt').value = '';
  } catch (e) {
    addTurn(`<div class="you">» ${escapeHtml(utterance)}</div><div>${escapeHtml(e.message)}</div>`, true);
  } finally {
    stopWeave();
    busy = false;
    $('generate').disabled = false;
    $('generate').textContent = 'Generate';
  }
}

function pickExisting(values, rec) {
  const keep = {};
  for (const c of rec.controls) if (c.id in values) keep[c.id] = values[c.id];
  return keep;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ------------------------------------------------------------------ chips
// Suggested prompts are teaching aids: every chip is the FULL sentence it
// puts in the box (what you see is what the model gets), with ___ blanks
// the user completes — clicking never submits, so the last step of every
// chip is typing. Empty recipe → one chip per kind of thing you can SAY
// (create / style / material constraint / ask for a slider); once the
// pipeline has ops → refinements aimed at THIS recipe. Targeted chips
// come from the intent turn itself (the model returns `suggest` alongside
// its actions — same call, no extra request; it knows what it just built,
// including design moves the user didn't ask for, which MUST surface here
// as an adjust-or-remove chip). Rule-based strategy chips fill the
// remaining slots so there is always something sensible with or without
// a model turn.

const BLANK = '___';

const STARTER_CHIPS = [
  `make me a sign that says ${BLANK}, about ${BLANK} inches wide`,
  `a round coaster with the initials ${BLANK} v-carved in the middle`,
  `a nameplate for ${BLANK} with a slider for the letter height`,
  `engrave ${BLANK} in outlined letters, sized to fit the ${BLANK}-inch board I have`,
];

const TEXT_STRATEGIES = new Set(['vcarve_text', 'outline_text', 'pocket_text', 'texture_text']);
const CUTOUT_STRATEGIES = new Set(['disc_cutout', 'shape_cutout', 'tag_cutout']);
const TEXTURE_STRATEGIES = new Set(['texture_field', 'texture_text']);

function refinementChips(rec) {
  const strategies = new Set((rec.pipeline ?? []).map((op) => op.strategy));
  const any = (set) => [...strategies].some((s) => set.has(s));
  const chips = [];
  if (strategies.has('vcarve_text')) chips.push('make the letters outlined instead of v-carved');
  else if (strategies.has('outline_text')) chips.push('make the letters v-carved instead of outlined');
  if (!any(CUTOUT_STRATEGIES)) chips.push(`cut it out with a ${BLANK} inch border and holding tabs`);
  if (!any(TEXTURE_STRATEGIES) && any(TEXT_STRATEGIES)) chips.push(`add a hammered texture around the ${BLANK}`);
  chips.push(`let me adjust the ${BLANK} with a slider`);
  chips.push(`move the ${BLANK} toward the ${BLANK}`);
  return chips.slice(0, 4);
}

function renderChips() {
  const host = $('chips');
  host.innerHTML = '';
  const base = (recipe.pipeline ?? []).length ? refinementChips(recipe) : STARTER_CHIPS;
  const list = [...modelChips, ...base]
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 4);
  for (const text of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    host.append(b);
  }
}

// Select the next ___ in the prompt box (from `from`), so typing replaces it.
function selectBlank(from = 0) {
  const box = $('prompt');
  const i = box.value.indexOf(BLANK, from);
  if (i === -1) return false;
  box.focus();
  box.setSelectionRange(i, i + BLANK.length);
  return true;
}

// ------------------------------------------------------------------ files

function download(name, content, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const slug = (t) => t.trim().replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24) || 'loom';

// ------------------------------------------------------------------ wire

$('generate').addEventListener('click', generate);
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); });
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('prompt').value = b.textContent;
  if (!selectBlank()) {
    const box = $('prompt');
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
});
// Tab hops to the next blank while any remain; otherwise Tab keeps its default
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && $('prompt').value.includes(BLANK)) {
    const from = $('prompt').selectionEnd ?? 0;
    if (selectBlank(from) || selectBlank(0)) e.preventDefault();
  }
});
$('btn3d').addEventListener('click', () => { viewMode = '3d'; localStorage.setItem('loom:view', '3d'); refreshPreview(); });
$('btn2d').addEventListener('click', () => { viewMode = '2d'; localStorage.setItem('loom:view', '2d'); refreshPreview(); });
$('reset').addEventListener('click', () => {
  recipe = structuredClone(EMPTY_RECIPE);
  modelChips = [];
  controlValues = controlDefaults(recipe);
  persist();
  $('history').innerHTML = '';
  renderControls();
  runAndRender();
});
$('saveKey').addEventListener('click', () => {
  const v = $('apiKey').value.trim();
  if (v) { localStorage.setItem('loom:apiKey', v); addTurn('Key saved to this browser.'); }
});
$('dlSbp').addEventListener('click', () => result?.ok && download(`${slug(recipe.name)}.sbp`, result.sbp));
$('dlNc').addEventListener('click', () => result?.ok && download(`${slug(recipe.name)}.nc`, result.gcode));
$('addAsset').addEventListener('click', () => $('assetFile').click());
// Open the draw dialog. `prefer` aims it at one recipe drawing: its name
// pre-filled while undrawn, its asset preselected for replacement once
// drawn. Without `prefer` (the generic button) the old behavior holds —
// outstanding requests first, then "redraw the most recent".
function openDrawDialog(prefer = null) {
  const findAsset = (of) => (recipe.assets ?? []).find((a) => a.id === of || a.name === of);
  const targets = (recipe.assets ?? []).filter((a) => a.kind === 'svg').map((a) => ({ id: a.id, name: a.name }));
  // shapes the recipe asks the user to draw that have no artwork yet — the
  // ops referencing them are skipping until one of these gets sketched
  let wanted = (recipe.shapes ?? [])
    .filter((s) => s.draw?.of && !findAsset(s.draw.of))
    .map((s) => s.draw.of);
  let select = '';
  if (prefer) {
    const a = findAsset(prefer);
    if (a) { select = a.id; wanted = []; }
    else wanted = [prefer, ...wanted.filter((w) => w !== prefer)];
  }
  openDraw({
    targets,
    wanted,
    select,
    onAccept: (svg, name, targetId) => {
      try { targetId ? replaceSvgAsset(targetId, svg) : addSvgAsset(svg, name); }
      catch (e) { addTurn(escapeHtml(e.message), true); }
    },
  });
}
$('drawShape').addEventListener('click', () => openDrawDialog());
initDraw();
$('assetFile').addEventListener('change', async () => {
  const f = $('assetFile').files[0];
  $('assetFile').value = '';
  if (!f) return;
  try {
    await addAssetFile(f);
  } catch (e) {
    addTurn(escapeHtml(e.message), true);
  }
});
$('saveRecipe').addEventListener('click', () => download(`${slug(recipe.name)}.loom.json`, JSON.stringify(recipe, null, 2), 'application/json'));
$('openRecipe').addEventListener('click', () => $('openFile').click());
$('openFile').addEventListener('change', async () => {
  const f = $('openFile').files[0];
  if (!f) return;
  try {
    recipe = migrateRecipe(JSON.parse(await f.text()));
    modelChips = [];
    controlValues = controlDefaults(recipe);
    persist();
    renderControls();
    runAndRender();
    addTurn(`Opened recipe "${escapeHtml(recipe.name)}".`);
  } catch { addTurn('That file is not a Loom recipe.', true); }
});

if (localStorage.getItem('loom:apiKey')) $('apiKey').value = '••••••••••••';

// ---------------------------------------------------------- guest pass
// A shared invite link lands with ?invite=lk_… — move the token out of
// the URL (history and screenshots shouldn't leak it) into localStorage,
// then keep the chip honest: prompts left, when the window refills.
const urlInvite = new URLSearchParams(location.search).get('invite');
if (urlInvite) {
  localStorage.setItem('loom:invite', urlInvite);
  const clean = new URL(location.href);
  clean.searchParams.delete('invite');
  history.replaceState(null, '', clean);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderInviteBar(s) {
  const bar = $('inviteBar');
  if (!s?.valid) {
    if (s?.reason === 'expired' || s?.reason === 'revoked') {
      bar.style.display = '';
      bar.textContent = `Your guest pass ${s.reason === 'expired' ? 'has expired' : 'was turned off'} — add your own API key below to keep prompting.`;
    } else {
      bar.style.display = 'none';
    }
    return;
  }
  bar.style.display = '';
  const refill = s.resetsAt ? ` · refills ${fmtTime(s.resetsAt)}` : '';
  bar.textContent = `Guest pass${s.name ? ` — ${s.name}` : ''}: ${s.remaining} prompt${s.remaining === 1 ? '' : 's'} left this window${refill}`
    + (s.remaining === 0 ? ' — or add your own key below for uninterrupted use' : '');
}

(async function refreshInviteBar() {
  const invite = localStorage.getItem('loom:invite');
  if (!invite) return;
  try {
    const res = await fetch('/api/intent/invite', { headers: { 'x-loom-invite': invite } });
    renderInviteBar(await res.json());
  } catch { /* no server (offline copy) — the chip just stays hidden */ }
})();

$('thickness').addEventListener('input', () => {
  const v = parseFloat($('thickness').value);
  if (!isNaN(v) && v > 0) {
    recipe.stock.thickness = v;
    persist();
    debounceRun();
  }
});

// blank W×H: pin the board to a real piece the design must fit within. Blank
// (or ≤0) clears it and the board auto-sizes to the content again. Per-recipe
// (saves with the design), NOT a shop-level default.
for (const [id, key] of [['blankW', 'width'], ['blankH', 'height']]) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    if (isNaN(v) || v <= 0) delete recipe.stock[key];
    else recipe.stock[key] = v;
    persist();
    debounceRun();
  });
}

// shop settings inputs: typing a size IS the "re-nest to fit" action —
// every edit re-weaves, so a layout reflows to the machine the moment
// the machine is declared, with no separate button to remember
for (const [id, key] of [
  ['shopMachineW', 'machineW'], ['shopMachineH', 'machineH'],
  ['shopMaterialW', 'materialW'], ['shopMaterialH', 'materialH'],
]) {
  const el = $(id);
  el.value = shop[key] > 0 ? shop[key] : '';
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    shop[key] = isNaN(v) || v <= 0 ? 0 : v;
    persistShop();
    debounceRun();
  });
}

// sheet-ledger inputs: app-level, so set once and persist on edit. No re-weave —
// the ledger tracks the material, it doesn't change the cut. Record stamps the
// current verified design's footprint onto the sheet; New sheet forgets history.
$('sheetW').value = sheet.w > 0 ? sheet.w : '';
$('sheetH').value = sheet.h > 0 ? sheet.h : '';
for (const [id, key] of [['sheetW', 'w'], ['sheetH', 'h']]) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    sheet[key] = isNaN(v) || v <= 0 ? 0 : v;
    persistSheet();
    updateSheetChip(result?.preview?.stock);
  });
}
$('sheetClear').addEventListener('click', () => {
  sheet = clearCuts(sheet);
  // a fresh board defaults to the shop's material sheet size — but only
  // when the ledger has no size yet: a typed size means THIS board is an
  // offcut, and flipping it must not stomp that
  if (!(sheet.w > 0 && sheet.h > 0) && shop.materialW > 0 && shop.materialH > 0) {
    sheet.w = shop.materialW; sheet.h = shop.materialH;
    $('sheetW').value = sheet.w; $('sheetH').value = sheet.h;
  }
  persistSheet();
  updateSheetChip(result?.preview?.stock);
  addTurn('New board — the cut history is cleared.');
});
// ---- What is this? (app/examples.mjs): the first-visit story + example
// recipes. Auto-opens ONCE when Loom is empty and never seen; the button
// reopens it any time. Loading an example is exactly "Open recipe" with
// a built-in file — same migrate, same weave, same verifier.
function closeIntro() {
  $('introOverlay').style.display = 'none';
  try { localStorage.setItem('loom:introSeen', '1'); } catch {}
}

function loadExample(ex) {
  recipe = migrateRecipe(structuredClone(ex.recipe));
  modelChips = [];
  controlValues = controlDefaults(recipe);
  persist();
  renderControls();
  runAndRender();
  addTurn(`Opened the example "${escapeHtml(ex.title)}". ${escapeHtml(ex.next)}`);
  closeIntro();
}

{
  const host = $('introExamples');
  for (const ex of EXAMPLES) {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex; align-items:center; gap:12px; border:1px solid var(--border); border-radius:10px; padding:8px 12px';
    const text = document.createElement('div');
    text.style.cssText = 'flex:1; min-width:0';
    text.innerHTML = `<b>${escapeHtml(ex.title)}</b><div class="keynote" style="margin-top:2px">${escapeHtml(ex.blurb)}</div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Open';
    btn.addEventListener('click', () => loadExample(ex));
    card.append(text, btn);
    host.append(card);
  }
}

$('whatBtn').addEventListener('click', () => { $('introOverlay').style.display = 'flex'; });
$('introClose').addEventListener('click', closeIntro);

// ---- Machine & tools (⚙): the system-facts menu. Machine reach, sheet
// size, spindle band, material, and the tool rack — set once, never part
// of a recipe. The rack is the SHARED shopbot:tools drawer (ir/tools.js):
// the same bits and real &Tool numbers every ShopBot Labs app reads.
$('shopBtn').addEventListener('click', () => { renderRack(); $('shopOverlay').style.display = 'flex'; });
$('shopClose').addEventListener('click', () => { $('shopOverlay').style.display = 'none'; });

// ---- FabMo on the network: send verified cuts straight to the tool's
// job queue over its local HTTP API (app/fabmo.mjs). The machine list is
// an app-level fact like the rack — never part of a recipe. Discovery is
// an HTTP probe: the engine's own UDP beacon is invisible to a browser.
function loadFabmo() {
  const base = { machines: [], selected: null };
  try { return { ...base, ...JSON.parse(localStorage.getItem('loom:fabmo') ?? '{}') }; }
  catch { return base; }
}
let fabmo = loadFabmo();
let fabmoState = null;   // last polled state; null = not answering
function persistFabmo() { try { localStorage.setItem('loom:fabmo', JSON.stringify(fabmo)); } catch {} }
const fabmoSelected = () => fabmo.machines.find((m) => m.host === fabmo.selected) ?? null;
const fabmoLabel = (m) => m.name ?? m.host;

function updateFabmoSend() {
  const sel = fabmoSelected();
  for (const id of ['sendFabmo', 'sendRunFabmo']) {
    $(id).style.display = sel ? '' : 'none';
    $(id).disabled = !sel || !result?.ok;
  }
  // with a machine connected, sending is the big button and the download
  // steps back; with none, the download IS the way a cut leaves the app
  $('dlSbp').className = sel ? 'ghost' : 'big';
  const chip = $('fabmoChip');
  chip.style.display = sel ? '' : 'none';
  if (sel) chip.textContent = `${fabmoLabel(sel)} — ${fabmoState ?? 'not answering'}`;
}

function renderFabmoMachines() {
  const box = $('fabmoMachines');
  box.innerHTML = '';
  if (!fabmo.machines.length) {
    box.innerHTML = '<span class="keynote">No machines yet — connect by address, or scan the shop network.</span>';
    return;
  }
  for (const m of fabmo.machines) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'fabmoPick';
    radio.checked = m.host === fabmo.selected;
    radio.addEventListener('change', () => { fabmo.selected = m.host; persistFabmo(); fabmoState = null; updateFabmoSend(); pollFabmo(); });
    const label = document.createElement('span');
    label.textContent = m.name ? `${m.name} (${m.host})` : m.host;
    const forget = document.createElement('button');
    forget.className = 'ghost small';
    forget.textContent = 'forget';
    forget.addEventListener('click', () => {
      fabmo.machines = fabmo.machines.filter((x) => x.host !== m.host);
      if (fabmo.selected === m.host) { fabmo.selected = fabmo.machines[0]?.host ?? null; fabmoState = null; }
      persistFabmo(); renderFabmoMachines(); updateFabmoSend();
    });
    row.append(radio, label, forget);
    box.append(row);
  }
}

async function pollFabmo() {
  const sel = fabmoSelected();
  if (!sel || document.hidden) return;
  try { fabmoState = (await machineStatus(sel.host))?.state ?? null; }
  catch { fabmoState = null; }
  updateFabmoSend();
}
setInterval(pollFabmo, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollFabmo(); });

async function adoptFabmo(hit) {
  const name = await machineName(hit.host);
  const existing = fabmo.machines.find((m) => m.host === hit.host);
  if (existing) existing.name = name ?? existing.name;
  else fabmo.machines.push({ host: hit.host, name });
  fabmo.selected = hit.host;
  persistFabmo();
  renderFabmoMachines();
  updateFabmoSend();
  pollFabmo();
}

// a failed probe on an https page: say WHICH wall was hit and its fix,
// not just "no answer" — a browser block and a dark address need
// opposite moves (see lanDiagnosis in app/fabmo.mjs)
async function fabmoFailNote(addr) {
  const d = await lanDiagnosis(addr);
  if (d?.kind === 'permission') {
    return `${addr} refused instantly — if the tool is on at that address, the browser is blocking it: allow "Local network access" for this site (the icon by the address bar, or Site settings → Local network access), then retry`;
  }
  if (d?.kind === 'mixed-content') {
    return `${addr} refused instantly — if the tool is on at that address, this browser is the wall: Safari/iPad cannot reach a plain-http machine from an https page (no exemption exists) — use Chrome on a computer, or open Loom over http for shop use`;
  }
  return `no FabMo answered at ${addr}`;
}

$('fabmoConnect').addEventListener('click', async () => {
  const note = $('fabmoScanNote');
  const addr = $('fabmoAddr').value.trim();
  if (!addr) { note.textContent = 'enter the machine address first'; return; }
  note.textContent = `looking for a FabMo at ${addr}…`;
  const hit = await probe(addr, { timeoutMs: 3000 });
  if (!hit) { note.textContent = await fabmoFailNote(addr); return; }
  await adoptFabmo(hit);
  note.textContent = `connected — ${fabmoLabel(fabmoSelected())}`;
});

// One /24 sweep; the button doubles as Stop while a scan is in flight.
let fabmoScanStop = null;
$('fabmoScan').addEventListener('click', async () => {
  const note = $('fabmoScanNote');
  if (fabmoScanStop) { fabmoScanStop.aborted = true; return; }
  const sel = fabmoSelected();
  const base = $('fabmoSubnet').value.trim()
    || sel?.host.match(/^(\d+\.\d+\.\d+)\.\d+/)?.[1]
    || '192.168.1';
  fabmoScanStop = { aborted: false };
  $('fabmoScan').textContent = 'Stop';
  try {
    const found = await scanSubnet(base, {
      stop: fabmoScanStop,
      onFound: (hit) => { adoptFabmo(hit); },
      onProgress: (done, total) => { note.textContent = `scanning ${base}.0/24 — ${done}/${total}`; },
    });
    note.textContent = found.length
      ? `found ${found.length} machine${found.length > 1 ? 's' : ''}`
      : (await fabmoFailNote(`${base}.1`)).replace(`no FabMo answered at ${base}.1`, `no FabMo found on ${base}.0/24`);
  } catch (e) {
    note.textContent = e.message;
  }
  fabmoScanStop = null;
  $('fabmoScan').textContent = 'Scan network';
});

function fabmoJobFile() {
  return {
    content: result.sbp,
    filename: `${slug(recipe.name)}.sbp`,
    name: recipe.name,
    description: 'Woven and verified by FabMo Loom',
  };
}

// With a Current board active, EVERY path to the machine goes through it:
// nest into the board's free space, re-weave with the sheet as the stock,
// and stamp the footprint only once the file is actually delivered —
// otherwise each successive send would recut the same origin corner.
// Resolves { file, at, commit } or { error } (already user-worded).
async function weavePositionedOnBoard() {
  const st = result?.preview?.stock;
  if (!st) return { error: 'Nothing woven yet.' };
  const rec = recordCut(sheet, st.w, st.h, recipe.name, { allowRotate: false });
  if (rec.error) return { error: rec.error };
  const p = rec.placement;
  const placed = (await weave({
    recipe, values: controlValues, terrains: lastTerrains, shop: shopForRun(),
    placement: { x: p.x, y: p.y, sheetW: sheet.w, sheetH: sheet.h }, wantSim: false,
  })).result;
  if (!placed.ok) return { error: 'Could not position this cut on the board — ' + (placed.errors[0] ?? 'the verifier refused it') };
  const at = `${p.x.toFixed(1)}", ${p.y.toFixed(1)}"`;
  return {
    at,
    file: {
      content: placed.sbp,
      filename: `${slug(recipe.name)}-on-sheet.sbp`,
      name: `${recipe.name} @ ${at}`,
      description: 'Positioned on the current board — woven and verified by FabMo Loom',
    },
    commit() {
      sheet = rec.sheet;
      persistSheet();
      updateSheetChip(st);
    },
  };
}

const boardStatus = () => `${sheetFreePct(sheet)}% of the board free, ${sheet.occupied.length} part${sheet.occupied.length > 1 ? 's' : ''} cut`;
const noBoardHint = ' (No board set up, so it cuts at the machine origin — start a Current board in ⚙ and each send lands in fresh material.)';

$('sendFabmo').addEventListener('click', async () => {
  const sel = fabmoSelected();
  if (!sel || !result?.ok) return;
  const label = escapeHtml(fabmoLabel(sel));
  if (!sheetActive(sheet)) {
    try {
      const job = await submitJob(sel.host, fabmoJobFile());
      addTurn(`Sent "${escapeHtml(recipe.name)}" to ${label} — job #${job._id} is queued on the tool; start it there when the deck is clear.${noBoardHint}`);
    } catch (e) {
      addTurn(`Could not send to ${label}: ${escapeHtml(e.message)}`, true);
    }
    return;
  }
  showWeaveOverlay();
  await nextPaint();
  try {
    const w = await weavePositionedOnBoard();
    if (w.error) { addTurn(escapeHtml(w.error), true); return; }
    const job = await submitJob(sel.host, w.file);
    w.commit();
    addTurn(`Sent "${escapeHtml(recipe.name)}" to ${label} placed at ${w.at} on the board — job #${job._id} is queued; start it there when the deck is clear. ${boardStatus()}.`);
  } catch (e) {
    addTurn(`Could not send to ${label}: ${escapeHtml(e.message)}`, true);
  } finally {
    hideWeaveOverlay();
  }
});

$('sendRunFabmo').addEventListener('click', async () => {
  const sel = fabmoSelected();
  if (!sel || !result?.ok) return;
  const label = fabmoLabel(sel);
  // Loom verified the file; the physical setup it cannot see. Make the
  // person say so before remote motion starts.
  if (!confirm(`Start cutting on ${label} right now?\n\nBit loaded, Z zeroed, material fixtured, deck clear.`)) return;
  const esc = escapeHtml(label);
  if (!sheetActive(sheet)) {
    try {
      const r = await submitAndRun(sel.host, fabmoJobFile());
      addTurn(r.ran
        ? `Job #${r.job._id} is cutting on ${esc}.${noBoardHint}`
        : `Job #${r.job._id} queued on ${esc}, not started — ${escapeHtml(r.reason)}.`, !r.ran);
    } catch (e) {
      addTurn(`Could not start on ${esc}: ${escapeHtml(e.message)}`, true);
    }
    return;
  }
  showWeaveOverlay();
  await nextPaint();
  try {
    const w = await weavePositionedOnBoard();
    if (w.error) { addTurn(escapeHtml(w.error), true); return; }
    const r = await submitAndRun(sel.host, w.file);
    w.commit();  // queued on the tool = it will cut at that spot either way
    addTurn(r.ran
      ? `Job #${r.job._id} is cutting on ${esc} at ${w.at} on the board — ${boardStatus()}.`
      : `Job #${r.job._id} queued on ${esc} at ${w.at}, not started — ${escapeHtml(r.reason)}. ${boardStatus()}.`, !r.ran);
  } catch (e) {
    addTurn(`Could not start on ${esc}: ${escapeHtml(e.message)}`, true);
  } finally {
    hideWeaveOverlay();
  }
});

if (location.protocol !== 'https:') $('fabmoHttpsHint').style.display = 'none';
renderFabmoMachines();
updateFabmoSend();
pollFabmo();

// Running ON the tool (an .fma install, or any same-origin serve): the
// page's own host IS a FabMo — adopt it without asking. Same-origin
// fetches cross no browser wall, so this is the zero-config path every
// device (iPad included) can take. http-only: on https labs the origin
// is the labs server, never a machine.
if (location.protocol === 'http:') {
  probe(location.host).then((hit) => {
    if (!hit) return;
    adoptFabmo(hit);
    // already ON the tool — the install link would be pointing at itself
    $('fmaGet').style.display = 'none';
  });
}

// material select: '' = keep each strategy's own feeds (the pre-rack behavior)
{
  const sel = $('shopMaterial');
  sel.innerHTML = '<option value="">— keep app feeds —</option>' +
    Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
  sel.value = shop.material && MATERIALS[shop.material] ? shop.material : '';
  sel.addEventListener('change', () => {
    shop.material = sel.value;
    persistShop();
    debounceRun();
  });
}

// spindle band + feed cap: clamp inputs for the chipload engine
for (const [id, key] of [['rackMinRPM', 'minRPM'], ['rackMaxRPM', 'maxRPM'], ['rackMaxFeed', 'maxFeed']]) {
  const el = $(id);
  el.value = toolLib.machine[key];
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!isNaN(v) && v > 0) { toolLib.machine[key] = v; saveToolLibrary(toolLib); debounceRun(); }
  });
}

function renderRack() {
  const tb = $('rackBody');
  tb.innerHTML = '';
  for (const t of [...toolLib.tools].sort((a, b) => a.number - b.number)) {
    const tr = document.createElement('tr');
    const kindLabel = { flat: 'endmill', ball: 'ballnose', vee: 'V-bit' }[t.kind] ?? t.kind;
    tr.innerHTML = `
      <td style="padding:4px 6px"><b>${t.number}</b></td>
      <td style="padding:4px 6px">${kindLabel}</td>
      <td style="padding:4px 6px">${formatInches(t.diameter)}</td>
      <td style="padding:4px 6px">${t.flutes}</td>
      <td style="padding:4px 6px">${t.kind === 'vee' ? (t.angleDeg ?? '') : ''}</td>
      <td style="padding:4px 6px">${escapeHtml(describeTool(t))}</td>
      <td style="padding:4px 6px"><input type="checkbox" ${t.available !== false ? 'checked' : ''} title="Unchecked = not on the machine today; jobs won't assign it"></td>
      <td style="padding:4px 6px"><button class="ghost small">✕</button></td>`;
    tr.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      t.available = e.target.checked ? undefined : false;
      saveToolLibrary(toolLib);
      debounceRun();
    });
    tr.querySelector('button').addEventListener('click', () => {
      toolLib.tools = toolLib.tools.filter(x => x !== t);
      saveToolLibrary(toolLib);
      renderRack();
      debounceRun();
    });
    tb.appendChild(tr);
  }
}

$('rackAdd').addEventListener('click', () => {
  const number = parseInt($('rackNumber').value, 10);
  const kind = $('rackKind').value;
  const diameter = parseInches($('rackDia').value);
  const flutes = parseInt($('rackFlutes').value, 10);
  const angleDeg = parseFloat($('rackAngle').value);
  const name = $('rackName').value.trim();
  if (!(number > 0)) { addTurn('A bit needs its real &Tool number — the one your machine answers to.', true); return; }
  if (!(diameter > 0)) { addTurn('A bit needs a diameter — fractions like 1/4 work.', true); return; }
  if (kind === 'vee' && !(angleDeg > 0)) { addTurn('A V-bit needs its included angle (60, 90…).', true); return; }
  const tool = { number, kind, diameter, flutes: flutes > 0 ? flutes : 2 };
  if (kind === 'vee') tool.angleDeg = angleDeg;
  if (name) tool.name = name;
  // re-using a number replaces that slot — that is how a bit gets edited
  toolLib.tools = toolLib.tools.filter(t => t.number !== number).concat(tool);
  saveToolLibrary(toolLib);
  renderRack();
  for (const id of ['rackNumber', 'rackDia', 'rackAngle', 'rackName']) $(id).value = '';
  debounceRun();
});

$('sheetRecord').addEventListener('click', async () => {
  if (!result?.ok || !result?.preview?.stock) return;
  // the positioned re-weave blocks the thread like any weave — show the
  // overlay and let a frame paint before starting
  showWeaveOverlay();
  await nextPaint();
  try {
  // nest axis-aligned (rotation-baking is a follow-up), then re-weave with
  // the SHEET as the stock — the cut lands in free space, not at origin.
  const w = await weavePositionedOnBoard();
  if (w.error) { addTurn(escapeHtml(w.error), true); return; }
  // with a FabMo connected the positioned cut goes straight to the tool's
  // queue (the visitor flow: each badge lands in its own spot on the same
  // fixtured board); with none — or if the send fails — it downloads.
  let delivered = 'downloaded the positioned cut (.sbp)';
  const sel = fabmoSelected();
  let sent = false;
  if (sel) {
    try {
      const job = await submitJob(sel.host, w.file);
      delivered = `queued job #${job._id} on ${escapeHtml(fabmoLabel(sel))} — start it there`;
      sent = true;
    } catch (e) {
      addTurn(`Could not send to ${escapeHtml(fabmoLabel(sel))} (${escapeHtml(e.message)}) — downloading instead.`, true);
    }
  }
  if (!sent) download(w.file.filename, w.file.content);
  w.commit();
  addTurn(`Placed "${escapeHtml(recipe.name)}" at ${w.at} on the board and ${delivered} — ${boardStatus()}.`);
  } finally {
    hideWeaveOverlay();
  }
});

// ------------------------------------------------------------- theme
// The document theme is set before first paint by an inline script in
// index.html (stored choice, else OS preference). Here we wire the header
// toggle and keep the 3D scene backdrop in sync — the WebGL background is
// not a CSS surface, so it can't inherit --surround and must be pushed.
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function surroundColor() {
  // read the resolved --surround token so the 3D backdrop matches the 2D
  // canvas — from BODY, where the fleet theme bridge sets its overrides
  // (body inherits :root, so the native light/dark values still resolve)
  return getComputedStyle(document.body).getPropertyValue('--surround').trim();
}
function syncView3dTheme() {
  if (!view3d) return;
  // scene.background is a THREE.Color created in view3d.mjs — mutate it in place
  view3d.scene.background.set(surroundColor());
  view3d.domElement.style.borderColor =
    getComputedStyle(document.body).getPropertyValue('--border').trim();
  // rebuild the board under the new theme's mesh tokens (SB1 glow, SB
  // Light greyscale) — and the assembled panels, which live in their own
  // layer that update() doesn't touch
  view3d.retheme?.();
  const pre = result?.preview;
  if (pre?.assemblies?.length) {
    syncAssembly(pre, pre.stock ?? { w: 8, h: 2.5, thickness: recipe.stock.thickness ?? 0.5 });
  }
  view3d.render();
}
function updateThemeToggle() {
  // the icon shows what you'll switch TO
  $('themeToggle').textContent = currentTheme() === 'dark' ? '☀︎ Light' : '☾ Dark';
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('loom:theme', theme); } catch {}
  updateThemeToggle();
  syncView3dTheme();
}
updateThemeToggle();
$('themeToggle').addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

// ShopBot Labs fleet themes — a per-deployment mount, exactly like guest
// apps: when the shared theme system is served alongside (../..), mount
// the fleet picker; "AI-YA!" preserves Loom's original styling. In public
// clones the import 404s and the built-in light/dark toggle above stays
// the only theming (theme-bridge.css is inert without a theme class).
(async () => {
  // labs serves the shared themes alongside (../..); an .fma install
  // bundles a copy at ../ui/ (see fma-manifest.json) — try both
  for (const url of ['../../ui_testbed/themes/theme-picker.js', '../ui/themes/theme-picker.js']) {
    try {
      const { initThemePicker } = await import(url);
      initThemePicker(() => syncView3dTheme());
      return;
    } catch { /* not deployed at this path — try the next */ }
  }
  /* themes not deployed here — native toggle stands alone */
})();

// Guest apps: an optional, uncommitted guests.local.mjs lists module
// URLs; each module exports catalog `entries` (see AGENTS.md "Mounting a
// guest app"). Guests load BEFORE the first weave and before any prompt,
// so their verbs are indistinguishable from native ones. A public
// checkout has no guests file — the import fails quietly and Loom runs
// on the native catalog alone.
async function loadGuests() {
  let list;
  try {
    list = (await import('./guests.local.mjs')).default ?? [];
  } catch { return []; }
  for (const url of list) {
    try {
      const mod = await import(url);
      const added = registerCatalogEntries(mod.entries);
      if (added.length) console.log(`guest ${url}: registered ${added.join(', ')}`);
    } catch (e) {
      console.warn(`guest ${url} failed to load:`, e);
      addTurn(`A guest app failed to load (${escapeHtml(String(url))}) — its verbs are unavailable this session.`, true);
    }
  }
  return list;
}

(async function boot() {
  const loaded = {};
  await Promise.all(FONTS.map(async (f) => {
    const res = await fetch(f.file);
    if (!res.ok) throw new Error(`font "${f.id}" failed to load: ${res.status}`);
    loaded[f.id] = await res.arrayBuffer();
  }));
  LOADED_FONTS = loaded;
  // guests register on the page (docs, chips, handoffs) AND in the worker
  // (where the weave actually runs) — same modules, same contract
  const guestUrls = await loadGuests();
  initWeaveWorker(guestUrls);
  renderControls();
  runAndRender();
  // first visit, empty loom → open the story unprompted, exactly once
  if (!(recipe.pipeline ?? []).length && !localStorage.getItem('loom:introSeen')) {
    $('introOverlay').style.display = 'flex';
  }
})();
