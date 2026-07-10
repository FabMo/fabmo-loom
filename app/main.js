// Loom — the mother app. Prompts and sliders edit the same recipe
// document; every state runs the full pipeline through the verifier.
// The LLM (user's own key, browser-direct) emits recipe actions only —
// no code, no motion. See intent.mjs for the trust boundary.

import { EMPTY_RECIPE, runRecipe, controlDefaults, migrateRecipe, makeEvalNumber, buildVars } from './runtime.mjs';
import { registerCatalogEntries, CATALOG } from './catalog.mjs';
import { svgAssetToRegions } from './svg.mjs';
import { buildParseRequest, applyActions, promptRecipeView } from './intent.mjs';
import { walkMoves } from '../ir/moves.js';
import { startWeave } from './weave.mjs';
import { resolveTerrains } from './terrain-fetch.mjs';
import { simulateJob } from './sim.mjs';
import { createView3D } from './view3d.mjs';
import { buildAssemblyLayer } from './assembly3d.mjs';
import { FONTS } from './fonts.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

let LOADED_FONTS = null;   // id → ArrayBuffer, the whole shelf
let viewMode = localStorage.getItem('loom:view') ?? '3d';
let view3d = null;
let recipe = loadRecipe();
let controlValues = controlDefaults(recipe);
let result = null;
let busy = false;

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
  const host = $('controls');
  host.innerHTML = '';
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
    host.append(wrap);
  }
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

async function addAssetFile(f) {
  const isSvg = f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg');
  let asset;
  if (isSvg) {
    if (f.size > 512 * 1024) throw new Error('SVG larger than 512 KB — simplify it first');
    const text = await f.text();
    if (!text.includes('<svg')) throw new Error('that file does not look like an SVG');
    asset = { kind: 'svg', data: text };
  } else {
    const { data, width, height } = await imageToDataUrl(f);
    if (data.length > 1.5e6) throw new Error('image still too large after downscaling — crop it and retry');
    asset = { kind: 'image', data, width, height };
  }
  recipe.assets ??= [];
  const id = `${f.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  let unique = id, n = 2;
  while (recipe.assets.some(a => a.id === unique)) unique = `${id}~${n++}`;
  recipe.assets.push({ id: unique, name: f.name, ...asset });
  persist();
  renderAssets();
  if (asset.kind === 'svg') {
    // parse it NOW so the user hears "ready" or the honest reason before
    // they ask for a cut — same lowering the weave will run
    const probe = svgAssetToRegions(asset.data, {});
    if (probe.error) {
      addTurn(`Added svg "${escapeHtml(f.name)}" to the recipe, but it won't lower to a shape yet: ${escapeHtml(probe.error)}`, true);
    } else {
      const pieces = probe.regions.length;
      const holes = probe.regions.reduce((n, r) => n + r.holes.length, 0);
      const notes = probe.warnings.length ? ` (${probe.warnings.map(escapeHtml).join('; ')})` : '';
      addTurn(`Added svg "${escapeHtml(f.name)}" — ${pieces} filled piece${pieces > 1 ? 's' : ''}${holes ? `, ${holes} hole${holes > 1 ? 's' : ''}` : ''}${notes}. Ask to use it: "cut out ${escapeHtml(f.name)} 4 inches wide", "pocket it 1/8 deep"…`);
    }
  } else {
    addTurn(`Added image "${escapeHtml(f.name)}" (${asset.width}×${asset.height}px) to the recipe. Raster carving isn't in the catalog yet — it is stored for when that arrives.`);
  }
}

// ---------------------------------------------------------------- run/draw

function setBadge(cls, text) { const b = $('badge'); b.className = `badge ${cls}`; b.textContent = text; }

let weaveSeq = 0;   // stale async weaves (terrain still fetching) must not clobber newer ones
function runAndRender() {
  if (!LOADED_FONTS) return;
  setBadge('wait', 'computing…');
  const seq = ++weaveSeq;
  requestAnimationFrame(() => setTimeout(async () => {
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
        render();
        return;
      }
    }
    if (seq !== weaveSeq) return;
    result = quiet(() => runRecipe(recipe, controlValues, LOADED_FONTS, terrains));
    render();
  }, 0));
}
let timer = null;
function debounceRun() { clearTimeout(timer); timer = setTimeout(runAndRender, 250); }

function render() {
  const r = result;
  const targetLine = (tt) => tt.type === 'profile'
    ? `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.intrusionArea ?? 0}</b> sq in intrusion · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`
    : tt.type === 'heightmap'
    ? `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.gouges}</b> gouges · <b>${tt.maskViolations}</b> mask escapes — <i>${tt.name}</i>`
    : `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.gouges}</b> gouges · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`;
  const targetLines = (r.report?.stats.targets ?? []).map(targetLine).join('<br>');

  if (r.ok) {
    setBadge('ok', 'VERIFIED');
    // machine time is the headline number a person plans around — the
    // wall-clock estimate (plunge-aware cutting + jogs + toolchanges)
    // rides next to the badge, the breakdown stays in the numbers line
    const runMin = r.report.stats.estRunTimeMin;
    const runTxt = runMin >= 90 ? `${(runMin / 60).toFixed(1)} hr` : `${Math.max(1, Math.round(runMin))} min`;
    $('verdictText').textContent = `this exact motion was measured, not assumed · ≈ ${runTxt} on the machine`;
    $('numbers').innerHTML = targetLines + `<br><b>${r.report.stats.moveCount.toLocaleString()}</b> moves · <b>${r.report.stats.cutLength}"</b> of cut · ≈ <b>${r.report.stats.estCutTimeMin} min</b> cutting + <b>${r.report.stats.rapidLength}"</b> of jog` +
      (r.report.stats.toolchangeCount > 1 ? ` · <b>${r.report.stats.toolchangeCount}</b> tool mounts` : '');
    const st = r.preview?.stock;
    // sheet-fit tag: only meaningful once the board outgrows scrap size —
    // 4×8 (96×48) is the standard full-size ShopBot bed, either way around
    const fits48 = st && ((st.w <= 96.01 && st.h <= 48.01) || (st.w <= 48.01 && st.h <= 96.01));
    const sheetTag = st && Math.max(st.w, st.h) > 24
      ? (fits48 ? ' — fits one 4×8 sheet ✓' : ' — does NOT fit a 4×8 sheet')
      : '';
    $('minStock').textContent = st ? `minimum stock: ${st.w}" × ${st.h}" × ${st.thickness}"${sheetTag}` : '';
  } else {
    // EMPTY is only the nothing-here state; every real failure is
    // REJECTED with its reason — a fit conflict must never read as
    // "empty app"
    const nothingYet = r.preview?.empty && r.errors[0]?.includes('no operations');
    setBadge('bad', nothingYet ? 'EMPTY' : 'REJECTED');
    $('verdictText').textContent = nothingYet ? 'describe an app to begin' : 'the verifier refused this state';
    $('numbers').innerHTML = targetLines;
    $('minStock').textContent = '';
  }
  $('errors').textContent = (r.preview?.empty && r.errors[0]?.includes('no operations')) ? '' : r.errors.join('\n');
  $('warnings').textContent = r.warnings.join('\n');
  $('dlSbp').disabled = !r.ok;
  $('dlNc').disabled = !r.ok;
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
    const sim = pre?.built?.length ? simulateJob(pre.built, pre.placement, stock, { analyticVee: true }) : null;
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

function draw() {
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  const stock = result?.preview?.stock ?? { w: 8, h: 2.5 };
  const pad = 28;
  const s = Math.min((W - 2 * pad) / stock.w, (H - 2 * pad) / stock.h);
  const ox = (W - stock.w * s) / 2, oy = (H + stock.h * s) / 2;
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
}

// ------------------------------------------------------------- the prompt

function addTurn(html, isErr = false) {
  const div = document.createElement('div');
  div.className = 'turn' + (isErr ? ' err' : '');
  div.innerHTML = html;
  $('history').prepend(div);
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
  if (!key) {
    $('keyBox').open = true;
    addTurn('Add your Anthropic API key first — it stays in this browser.', true);
    return;
  }
  busy = true;
  $('generate').disabled = true;
  $('generate').textContent = 'weaving…';
  const stopWeave = startWeave($('appPanel'));
  try {
    const req = buildParseRequest(recipe, utterance);
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
    const data = await res.json();
    const toolUse = data.content?.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('the model returned no actions');

    const out = applyActions(recipe, toolUse.input);
    recipe = out.recipe;
    controlValues = { ...controlDefaults(recipe), ...pickExisting(controlValues, recipe) };
    persist();
    renderControls();
    runAndRender();

    // the funnel / gap report — declines are the catalog's backlog and
    // parses its pricing data. Fire-and-forget: the weave never depends
    // on logging, and a checkout without the endpoint just no-ops.
    fetch('/api/intent/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'loom',
        utterance,
        intent: { summary: out.summary, actions: toolUse.input.actions ?? [], declined: out.declined },
        usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
      }),
    }).catch(() => {});

    const declined = out.declined.length
      ? `<div class="declined">declined: ${out.declined.map(d => `${escapeHtml(d.what)} — ${escapeHtml(d.why)}`).join('; ')} <i>(logged as a gap report)</i></div>` : '';
    const skipped = out.skipped.length ? `<div class="declined">skipped: ${out.skipped.map(escapeHtml).join('; ')}</div>` : '';
    addTurn(`<div class="you">» ${escapeHtml(utterance)}</div><div class="did">${escapeHtml(out.summary)}</div>${declined}${skipped}`);
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
// pipeline has ops → refinements aimed at THIS recipe, picked rule-based
// from its strategies. No LLM call is involved in suggesting.

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
  const list = (recipe.pipeline ?? []).length ? refinementChips(recipe) : STARTER_CHIPS;
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
    controlValues = controlDefaults(recipe);
    persist();
    renderControls();
    runAndRender();
    addTurn(`Opened recipe "${escapeHtml(recipe.name)}".`);
  } catch { addTurn('That file is not a Loom recipe.', true); }
});

if (localStorage.getItem('loom:apiKey')) $('apiKey').value = '••••••••••••';

$('thickness').addEventListener('input', () => {
  const v = parseFloat($('thickness').value);
  if (!isNaN(v) && v > 0) {
    recipe.stock.thickness = v;
    persist();
    debounceRun();
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
  // read the resolved --surround token so the 3D backdrop matches the 2D canvas
  return getComputedStyle(document.documentElement).getPropertyValue('--surround').trim();
}
function syncView3dTheme() {
  if (!view3d) return;
  // scene.background is a THREE.Color created in view3d.mjs — mutate it in place
  view3d.scene.background.set(surroundColor());
  view3d.domElement.style.borderColor =
    getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
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
  } catch { return; }
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
}

(async function boot() {
  const loaded = {};
  await Promise.all(FONTS.map(async (f) => {
    const res = await fetch(f.file);
    if (!res.ok) throw new Error(`font "${f.id}" failed to load: ${res.status}`);
    loaded[f.id] = await res.arrayBuffer();
  }));
  LOADED_FONTS = loaded;
  await loadGuests();
  renderControls();
  runAndRender();
})();
