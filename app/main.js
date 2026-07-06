// Loom — the mother app. Prompts and sliders edit the same recipe
// document; every state runs the full pipeline through the verifier.
// The LLM (user's own key, browser-direct) emits recipe actions only —
// no code, no motion. See intent.mjs for the trust boundary.

import { EMPTY_RECIPE, runRecipe, controlDefaults, migrateRecipe } from './runtime.mjs';
import { svgAssetToRegions } from './svg.mjs';
import { buildParseRequest, applyActions, promptRecipeView } from './intent.mjs';
import { walkMoves } from '../ir/moves.js';
import { startWeave } from './weave.mjs';
import { simulateJob } from './sim.mjs';
import { createView3D } from './view3d.mjs';
import { FONTS } from './fonts.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

let LOADED_FONTS = null;   // id → ArrayBuffer, the whole shelf
let viewMode = localStorage.getItem('loom:view') ?? '3d';
let view3d = null;
let zxAuto = true;   // 3D depth exaggeration: auto (labeled) vs true scale
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

function runAndRender() {
  if (!LOADED_FONTS) return;
  setBadge('wait', 'computing…');
  requestAnimationFrame(() => setTimeout(() => {
    result = quiet(() => runRecipe(recipe, controlValues, LOADED_FONTS));
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
    $('verdictText').textContent = 'this exact motion was measured, not assumed';
    $('numbers').innerHTML = targetLines + `<br><b>${r.report.stats.moveCount.toLocaleString()}</b> moves · <b>${r.report.stats.cutLength}"</b> of cut · ≈ <b>${r.report.stats.estCutTimeMin} min</b>` +
      (r.report.stats.toolchangeCount > 1 ? ` · <b>${r.report.stats.toolchangeCount}</b> tool mounts` : '');
    const st = r.preview?.stock;
    $('minStock').textContent = st ? `minimum stock: ${st.w}" × ${st.h}" × ${st.thickness}"` : '';
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
  refreshPreview();
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
    window.loomView3d = view3d;   // debug/test handle for deterministic camera poses
    const pre = result?.preview;
    const stock = pre?.stock ?? { w: 8, h: 2.5, thickness: recipe.stock.thickness ?? 0.5 };
    const sim = pre?.built?.length ? simulateJob(pre.built, pre.placement, stock) : null;
    // adaptive display exaggeration: an engraving is a few percent of the
    // board span and reads flat at true scale. Key on the deepest cut that
    // is NOT a through cut — a tag's kerf must not veto exaggerating the
    // carve it surrounds. Always labeled; the button toggles true scale.
    const span = Math.max(stock.w, stock.h);
    let shallowDeepest = 0;
    if (sim) {
      // depth histogram of cut cells above the through zone; the deepest
      // bin with real MASS is the feature depth. A bare minimum would key
      // on the cutout's ramp-entry cells, which pass through every depth.
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
        if (hist[b] >= minMass) { shallowDeepest = -((b + 1) / BINS) * zTh; break; }
      }
      if (shallowDeepest === 0) shallowDeepest = sim.minZ;   // pure through job
    }
    const auto = sim
      ? Math.min(5, Math.max(1, (0.08 * span) / Math.max(0.02, -shallowDeepest)))
      : 1;
    const zx = zxAuto ? auto : 1;
    window.loomZx = { auto, zx, shallowDeepest, minZ: sim?.minZ };   // debug handle
    view3d.update(sim, stock, zx, shallowDeepest ? -shallowDeepest : null);
    const zb = $('zxBtn');
    if (sim && auto > 1.05) {
      zb.style.display = 'block';
      zb.textContent = zx > 1.05 ? `depth ×${zx.toFixed(1)} (display)` : 'depth ×1 (true scale)';
    } else {
      zb.style.display = 'none';
    }
  } else {
    draw();
  }
}

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
  const p = e.target?.dataset?.p;
  if (p) { $('prompt').value = p; generate(); }
});
$('zxBtn').addEventListener('click', () => { zxAuto = !zxAuto; refreshPreview(); });
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

(async function boot() {
  const loaded = {};
  await Promise.all(FONTS.map(async (f) => {
    const res = await fetch(f.file);
    if (!res.ok) throw new Error(`font "${f.id}" failed to load: ${res.status}`);
    loaded[f.id] = await res.arrayBuffer();
  }));
  LOADED_FONTS = loaded;
  renderControls();
  runAndRender();
})();
