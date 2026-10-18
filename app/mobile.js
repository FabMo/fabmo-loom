// Loom mobile — the photo-to-cut lane with the options trimmed off.
//
// One screen: take or choose a photo, add a line of text (sizes, material,
// changes), Build. The same intent loop as the full app (app/intent.mjs:
// parse → apply → weave → the model checks its own weave) runs against the
// same weave worker and the same 3D view; what comes back is the verified
// piece rising out of its board, three size sliders bound to the
// assembly's overall box, and the .sbp. Follow-up text re-enters the loop
// with the recipe (and the picture) still in view, so "make the shelves
// adjustable" edits rather than restarts. Sliders never call the model —
// they re-weave locally, exactly like the full app's control panel.
//
// Shares the full app's browser state on purpose: the guest pass / API key
// (loom:invite / loom:apiKey) and the shared tool rack (shopbot:tools), so
// a pass scanned on the phone works in both. Its own recipe lives under
// loom:mobile so the two screens never clobber each other's work.

import { EMPTY_RECIPE, runRecipe, controlDefaults, migrateRecipe } from './runtime.mjs';
import { runIntentLoop, actionList, DEFAULT_MODEL, promptRecipeView, isKnownModel } from './intent.mjs';
import { registerCatalogEntries } from './catalog.mjs';
import { FONTS } from './fonts.mjs';
import { createView3D } from './view3d.mjs';
import { buildAssemblyLayer } from './assembly3d.mjs';
import { simulateJob } from './sim.mjs';
import { startWeave, LOGO_PALETTE } from './weave.mjs';
import { encodePhoto, kb, relayFailureMessage, directFailureMessage, networkFailureMessage } from './photo.mjs';
import { loadToolLibrary } from '../ir/tools.js';
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const STATE_KEY = 'loom:mobile';
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ state
let recipe = structuredClone(EMPTY_RECIPE);
let controlValues = {};
let result = null;
let lastSim = null;
let busy = false;
let promptImage = null;      // { media_type, data, previewUrl, width, height } | null
let LOADED_FONTS = null;
let view3d = null;
let assemblyLayer = null;
let assemblyBlend = 0;
let introRaf = 0;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
    if (s?.recipe) {
      recipe = migrateRecipe(s.recipe);
      controlValues = { ...controlDefaults(recipe), ...(s.values ?? {}) };
      assemblyBlend = typeof s.blend === 'number' ? s.blend : 1;
      return true;
    }
  } catch { /* fresh start */ }
  return false;
}
function persist() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ recipe, values: controlValues, blend: assemblyBlend })); } catch {}
}
const shopForRun = () => ({ toolLibrary: loadToolLibrary() });
function currentModel() {
  const v = localStorage.getItem('loom:model');
  return isKnownModel(v) ? v : DEFAULT_MODEL;
}

// ------------------------------------------------------------------ auth
// Same two paths as the full app: a guest-pass token (from a ?invite= link,
// stored once) relayed by the server, or a BYO key straight to Anthropic.
const urlInvite = new URLSearchParams(location.search).get('invite');
if (urlInvite) {
  localStorage.setItem('loom:invite', urlInvite);
  const clean = new URL(location.href);
  clean.searchParams.delete('invite');
  history.replaceState(null, '', clean);
}
function haveAuth() { return !!(localStorage.getItem('loom:apiKey') || localStorage.getItem('loom:invite')); }
function showAuth(show) { $('auth').style.display = show ? 'block' : 'none'; }
$('saveKey').addEventListener('click', () => {
  const v = $('apiKey').value.trim();
  if (!v) return;
  localStorage.setItem('loom:apiKey', v);
  $('apiKey').value = '';
  showAuth(false);
  setMsg('');
});

async function parseDirect(req, key) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(req),
    });
  } catch (e) { throw new Error(networkFailureMessage(e)); }
  if (!res.ok) throw new Error(directFailureMessage(res.status, await res.text().catch(() => '')));
  return res.json();
}
async function parseViaGuestPass(req, invite) {
  let res;
  try {
    res = await fetch('/api/intent/loom', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-invite': invite },
      body: JSON.stringify({ req }),
    });
  } catch (e) { throw new Error(networkFailureMessage(e)); }
  // the relay answers JSON; nginx's own refusals (413 body too large, 502,
  // 504) are HTML — those are the ones that used to read "request failed"
  const payload = await res.clone().json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429 && payload.reason === 'window') {
      throw new Error(`Your guest pass is out of prompts — it refills at ${new Date(payload.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
    }
    if (res.status === 401 || res.status === 403) showAuth(true);
    throw new Error(relayFailureMessage(res.status, payload, { imageBytes: promptImage?.bytes ?? 0 }));
  }
  return payload.data;
}

// ------------------------------------------------------------------ photo
// Encoded to a byte BUDGET (app/photo.mjs: ≤1568px, JPEG quality and size
// stepping down until the base64 fits under the relay's request cap),
// held in memory for the session, never persisted.
async function takePhoto(file) {
  if (!file) return;
  try {
    promptImage = await encodePhoto(file);
    $('thumb').src = promptImage.previewUrl;
    $('thumbMeta').textContent = `${promptImage.width}×${promptImage.height} · ${kb(promptImage.bytes)} · the picture decides the shape, your text decides the numbers`;
    $('thumbWrap').style.display = 'flex';
    setMsg('');
    updateBuildLabel();
  } catch (e) {
    setMsg(/hei[cf]/i.test(file.type + file.name) ? 'HEIC photos can\'t be read by the browser — export it as JPEG first.' : e.message);
  }
}
$('takePhoto').addEventListener('click', () => $('fileCam').click());
$('choosePhoto').addEventListener('click', () => $('fileLib').click());
for (const id of ['fileCam', 'fileLib']) {
  $(id).addEventListener('change', (e) => { takePhoto(e.target.files?.[0]); e.target.value = ''; });
}
$('clearPhoto').addEventListener('click', () => {
  promptImage = null;
  $('thumbWrap').style.display = 'none';
  $('thumb').src = '';
  updateBuildLabel();
});

function setMsg(text) { $('msg').textContent = text; }
function hasDesign() { return (recipe.pipeline ?? []).length > 0; }
function updateBuildLabel() {
  if (busy) return;
  $('build').textContent = hasDesign() ? 'Apply change' : 'Build it';
  $('promptLabel').textContent = hasDesign()
    ? 'Change something (or take a new photo and start over)'
    : 'Size, material, anything to add (optional)';
  $('prompt').placeholder = hasDesign()
    ? 'e.g. "add a back panel" · "make it 30 wide" · "two shelves, not three"'
    : 'e.g. "36 wide, 72 tall, 12 deep — 3/4 plywood"';
}

// ------------------------------------------------------------------ weave
// app/weave-worker.mjs off the main thread (sync fallback on this thread).
let weaveWorker = null;
let weaveMsgId = 0;
const weavePending = new Map();

function syncWeave(p) {
  const r = quiet(() => runRecipe(p.recipe, p.values, LOADED_FONTS, {}, p.shop));
  let sim = null;
  if (r.ok && r.preview?.built?.length) {
    sim = simulateJob(r.preview.built, r.preview.placement ?? { x: 0, y: 0 }, r.preview.stock, { analyticVee: true });
  }
  return { result: r, sim };
}
function initWeaveWorker(guestUrls) {
  let w;
  try { w = new Worker(new URL('./weave-worker.mjs', import.meta.url), { type: 'module' }); }
  catch { return; }
  w.onmessage = (e) => {
    const m = e.data;
    if (m.kind !== 'wove' && m.kind !== 'error') return;
    const p = weavePending.get(m.id);
    if (!p) return;
    weavePending.delete(m.id);
    p.resolve(m.kind === 'wove' ? { result: m.result, sim: m.sim } : syncWeave(p.payload));
  };
  w.onerror = (err) => {
    console.warn('weave worker failed — weaving on the main thread from here on', err);
    weaveWorker = null;
    const pending = [...weavePending.values()];
    weavePending.clear();
    for (const p of pending) p.resolve(syncWeave(p.payload));
  };
  w.postMessage({ kind: 'init', fonts: LOADED_FONTS, guestUrls });
  weaveWorker = w;
}
function weave(payload) {
  if (!weaveWorker) return nextPaint().then(() => syncWeave(payload));
  const id = ++weaveMsgId;
  return new Promise((resolve) => {
    weavePending.set(id, { resolve, payload });
    try { weaveWorker.postMessage({ kind: 'weave', id, ...payload }); }
    catch { weavePending.delete(id); resolve(syncWeave(payload)); }
  });
}

let weaveSeq = 0;
async function runAndRender() {
  if (!LOADED_FONTS || !hasDesign()) return;
  const seq = ++weaveSeq;
  setBadge('wait', 'computing…');
  $('weaveOverlay').classList.add('on');
  const { result: r, sim } = await weave({ recipe, values: controlValues, terrains: {}, shop: shopForRun() });
  if (seq !== weaveSeq) return;   // a newer slider move superseded this one
  result = r; lastSim = sim;
  render();
}

// --------------------------------------------------------------- the view
function setBadge(cls, text) { const b = $('badge'); b.className = `badge ${cls}`; b.textContent = text; }

function featureDepthOf(sim, stock) {
  if (!sim) return 0;
  const BINS = 100, zTh = 0.9 * stock.thickness, hist = new Uint32Array(BINS);
  let cut = 0;
  for (const z of sim.grid) {
    if (z >= -1e-6) continue;
    cut++;
    if (z > -zTh) hist[Math.min(BINS - 1, Math.floor((-z / zTh) * BINS))]++;
  }
  const minMass = Math.max(50, cut * 0.005);
  for (let b = BINS - 1; b >= 0; b--) if (hist[b] >= minMass) return -((b + 1) / BINS) * zTh;
  return sim.minZ;
}

function render() {
  const r = result;
  $('result').style.display = 'block';
  $('weaveOverlay').classList.remove('on');
  const pre = r?.preview;
  if (r?.ok) {
    const stats = r.report?.stats ?? {};
    const st = pre?.stock;
    const bits = [];
    if (st) bits.push(`board ${fmt(st.w)}″ × ${fmt(st.h)}″ · ${fmt(st.thickness)}″ thick`);
    if (stats.estRunTimeMin != null) bits.push(`≈ ${Math.round(stats.estRunTimeMin)} min on the machine`);
    if (stats.toolchangeCount > 1) bits.push(`${stats.toolchangeCount} tool mounts`);
    if (pre?.setups?.[0]?.count > 1) bits.push(`sheet ${pre.setups[0].current} of ${pre.setups[0].count}`);
    setBadge('ok', 'VERIFIED');
    $('numbers').textContent = bits.join(' · ');
  } else {
    const nothing = pre?.empty && r?.errors?.[0]?.includes('no operations');
    setBadge('bad', nothing ? 'EMPTY' : 'REJECTED');
    $('numbers').textContent = nothing ? 'nothing built yet' : 'the verifier refused this state';
  }
  $('errors').textContent = (r?.ok || !r) ? '' : (r.errors ?? []).join('\n');
  $('dlSbp').disabled = !r?.ok;
  const su = pre?.setups?.[0];
  $('dlSbp').textContent = su && su.count > 1 ? `Download .sbp (${su.current} of ${su.count})` : 'Download .sbp';
  renderSheetPicker();

  // the 3D view — a refused weave still shows whatever built, on the board
  view3d ??= createView3D($('view3d'), { width: 1000, height: 1000 });
  const stock = pre?.stock ?? { w: 8, h: 2.5, thickness: recipe.stock?.thickness ?? 0.5 };
  const sim = lastSim ?? (pre?.built?.length ? simulateJob(pre.built, pre.placement ?? { x: 0, y: 0 }, stock, { analyticVee: true }) : null);
  const fd = featureDepthOf(sim, stock);
  view3d.update(sim, stock, 1, fd ? -fd : null);
  syncAssembly(pre, stock);
}
const fmt = (n) => (Math.round(n * 100) / 100).toString();

function syncAssembly(pre, stock) {
  if (assemblyLayer) { view3d.scene.remove(assemblyLayer.group); assemblyLayer.dispose(); assemblyLayer = null; }
  const asms = pre?.assemblies ?? [];
  $('assembleWrap').style.display = asms.length ? 'block' : 'none';
  if (!asms.length) { fitCamera(); return; }
  assemblyLayer = buildAssemblyLayer(asms, pre.placement ?? { x: 0, y: 0 }, stock);
  view3d.scene.add(assemblyLayer.group);
  $('assemble').value = String(assemblyBlend);
  assemblyLayer.setBlend(assemblyBlend);
  fitCamera();
  window.loomAssembly = { layer: assemblyLayer, blend: () => assemblyBlend };   // test handle
}
// Fit the camera to what is on screen — the board plus the piece at its
// current assembly blend — keeping the user's viewing direction. The full
// app frames the BOARD and lets the mouse do the rest; on a phone a 30"
// desk standing on a 29" board would leave the frame.
function fitCamera() {
  if (!view3d) return;
  const box = new THREE.Box3();
  view3d.scene.traverse((o) => { if (o.isMesh && o.visible && o.geometry) box.expandByObject(o); });
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
  const dir = view3d.camera.position.clone().sub(view3d.controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(0, -1, 0.8);
  dir.normalize();
  const fov = (view3d.camera.fov * Math.PI) / 180;
  const dist = (radius / Math.sin(fov / 2)) * 1.08;
  view3d.controls.target.copy(center);
  view3d.camera.position.copy(center).addScaledVector(dir, dist);
  view3d.camera.near = Math.max(0.01, dist / 200);
  view3d.camera.far = dist * 20;
  view3d.camera.updateProjectionMatrix();
  view3d.controls.update();
  view3d.render();
}

$('assemble').addEventListener('input', () => {
  cancelIntro();
  assemblyBlend = parseFloat($('assemble').value);
  if (assemblyLayer) { assemblyLayer.setBlend(assemblyBlend); view3d.render(); }
  persist();
});
$('assemble').addEventListener('change', fitCamera);   // scrub released: take in where the piece ended up
function cancelIntro() { if (introRaf) { cancelAnimationFrame(introRaf); introRaf = 0; } }
// the reveal after every model turn: a short hold flat, then the piece rises
function playIntro() {
  if (!assemblyLayer) return;
  cancelIntro();
  const HOLD = 400, RISE = 2200;
  let start = null;
  const step = (ts) => {
    start ??= ts;
    const t = Math.min(1, Math.max(0, (ts - start - HOLD) / RISE));
    assemblyBlend = t * t * (3 - 2 * t);
    $('assemble').value = String(assemblyBlend);
    if (assemblyLayer && view3d) { assemblyLayer.setBlend(assemblyBlend); view3d.render(); }
    introRaf = t < 1 ? requestAnimationFrame(step) : 0;
    if (t >= 1) { fitCamera(); persist(); }
  };
  assemblyBlend = 0;
  introRaf = requestAnimationFrame(step);
}

// ------------------------------------------------------------- sliders
// The three overall sizes. An assembly declares its box as [W, H, D]
// expressions; when those are bare control ids the sliders ARE those
// controls (same min/max/step the model chose). Otherwise fall back to
// the controls whose names say width / height / depth. Anything else the
// model exposed stays at its default — the full app has the whole panel.
const AXES = [
  { key: 'W', re: /width|wide|length|long/i },
  { key: 'H', re: /height|tall|high/i },
  { key: 'D', re: /depth|deep/i },
];
// Counts the model exposed — drawers, cubbies, columns, rows, shelves —
// are the integer-step controls (every count the model has authored so
// far is step 1; every size is fractional). The sheet-to-cut control is
// its own thing: a picker, not a slider (see sheetControl).
function countControls(rec, exclude = new Set()) {
  return (rec.controls ?? []).filter(c => c.type === 'number' && !exclude.has(c.id)
    && c.id !== sheetControl(rec)?.id && Number(c.step) === 1 && Number.isInteger(Number(c.default ?? 0)));
}
// the control bound to a pipeline op's `setup` param (the sheet to cut when
// a layout needs several), or a control plainly named setup
function sheetControl(rec) {
  for (const op of rec.pipeline ?? []) {
    const b = op.params?.setup;
    const id = b && typeof b === 'object' ? b.ctrl : (typeof b === 'string' ? b : null);
    const c = id && (rec.controls ?? []).find(c => c.id === id);
    if (c) return c;
  }
  return (rec.controls ?? []).find(c => c.id === 'setup') ?? null;
}

function sizeControls(rec) {
  const numeric = (rec.controls ?? []).filter(c => c.type === 'number');
  const byId = Object.fromEntries(numeric.map(c => [c.id, c]));
  const picked = [];
  const used = new Set();
  const box = rec.pipeline?.map(op => op.params?.assembly?.box ?? op.params?.design?.box).find(Array.isArray);
  if (box) {
    box.slice(0, 3).forEach((expr, i) => {
      const id = typeof expr === 'string' ? expr.trim() : null;
      if (id && byId[id] && !used.has(id)) { picked[i] = byId[id]; used.add(id); }
    });
  }
  AXES.forEach((ax, i) => {
    if (picked[i]) return;
    const c = numeric.find(c => !used.has(c.id) && (ax.re.test(c.label ?? '') || new RegExp(`^${ax.key}$`, 'i').test(c.id)));
    if (c) { picked[i] = c; used.add(c.id); }
  });
  return picked.filter(Boolean);
}
let sliderTimer = 0;
function renderSliders() {
  const wrap = $('sliders');
  wrap.innerHTML = '';
  const sizes = sizeControls(recipe);
  const counts = countControls(recipe, new Set(sizes.map(c => c.id)));
  const slider = (c, cls = '') => {
    const v = controlValues[c.id] ?? c.default ?? 0;
    const min = c.min ?? Math.max(0.5, v / 2), max = c.max ?? v * 2, step = c.step ?? 0.25;
    const div = document.createElement('div');
    div.className = `slider ${cls}`.trim();
    div.innerHTML = `<div class="top"><span>${escapeHtml(c.label ?? c.id)}</span><b data-for="${escapeHtml(c.id)}">${fmt(v)}</b></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-id="${escapeHtml(c.id)}" aria-label="${escapeHtml(c.label ?? c.id)}">`;
    wrap.appendChild(div);
  };
  sizes.forEach(c => slider(c));
  if (counts.length) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = 'counts';
    wrap.appendChild(h);
    counts.forEach(c => slider(c, 'count'));
  }
  wrap.oninput = (e) => {
    const inp = e.target.closest('input[type=range]');
    if (!inp) return;
    const id = inp.dataset.id;
    controlValues[id] = parseFloat(inp.value);
    wrap.querySelector(`b[data-for="${CSS.escape(id)}"]`).textContent = fmt(controlValues[id]);
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { persist(); runAndRender(); }, 120);
  };
}

// ---------------------------------------------------------- sheet picker
// A piece that needs several sheets exports ONE fixturing at a time (the
// guest contract). The model's "Sheet / setup to cut" control picks which;
// the summary tells people to use it, so it has to be on the screen.
function renderSheetPicker() {
  const wrap = $('sheets');
  const s = result?.preview?.setups?.[0];
  const ctl = sheetControl(recipe);
  if (!s || !(s.count > 1) || !ctl) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'block';
  const cur = Number(controlValues[ctl.id] ?? s.current);
  wrap.innerHTML = `<div class="top"><span>sheet to cut</span><span class="muted">${s.count} sheets · the file holds one</span></div>
    <div class="seg">${Array.from({ length: s.count }, (_, i) => `<button type="button" data-sheet="${i + 1}" class="${i + 1 === cur ? 'on' : ''}">${i + 1}</button>`).join('')}</div>`;
  wrap.onclick = (e) => {
    const b = e.target.closest('button[data-sheet]');
    if (!b) return;
    controlValues[ctl.id] = Number(b.dataset.sheet);
    persist();
    runAndRender();
  };
}
function exportStem() {
  const s = result?.preview?.setups?.[0];
  return slug(recipe.name) + (s && s.count > 1 ? `-sheet${s.current}of${s.count}` : '');
}

// --------------------------------------------------------------- build
async function generate() {
  const typed = $('prompt').value.trim();
  const image = promptImage ? { media_type: promptImage.media_type, data: promptImage.data } : null;
  const utterance = typed || (image ? 'Build what is in this picture.' : '');
  if (busy) return;
  if (!utterance) { setMsg('Take a photo, or say what to build.'); return; }
  if (!haveAuth()) { showAuth(true); setMsg('Add an API key below, or open this page from a guest-pass link.'); return; }
  const key = localStorage.getItem('loom:apiKey');
  const invite = localStorage.getItem('loom:invite');
  busy = true;
  setMsg('');
  $('build').disabled = true;
  const firstLabel = image && !hasDesign() ? 'reading the picture…' : 'weaving…';
  $('build').textContent = firstLabel;
  $('result').style.display = 'block';
  setBadge('wait', 'thinking…');
  // the loom at work, over the view, for as long as the model turn runs
  const stopWeave = startWeave($('view3d'), firstLabel, LOGO_PALETTE);
  const stage = (s) => { $('build').textContent = s; stopWeave.setLabel?.(s); };
  try {
    const parseContext = structuredClone(promptRecipeView(recipe));
    const send = (req) => (key ? parseDirect(req, key) : parseViaGuestPass(req, invite));
    let calls = 0;
    const out = await runIntentLoop({
      recipe, utterance, shop: {}, model: currentModel(), image,
      call: (req) => { if (calls++ > 0) stage(calls === 2 ? 'checking the weave…' : 'checking again…'); return send(req); },
      weave: async (rec) => {
        stage('weaving…');
        const values = { ...controlDefaults(rec), ...pickExisting(controlValues, rec) };
        if (rec.terrains?.length) return { ok: false, errors: ['terrain references are not available on the phone version — use the full app'], warnings: [], preview: { empty: true } };
        const w = await weave({ recipe: rec, values, terrains: {}, shop: shopForRun() });
        return w.result;
      },
    });
    recipe = out.recipe;
    if (out.summary?.trim()) recipe.about = out.summary.trim();
    controlValues = { ...controlDefaults(recipe), ...pickExisting(controlValues, recipe) };
    $('about').textContent = out.summary ?? '';
    $('declined').innerHTML = out.declined?.length
      ? `declined: ${out.declined.map(d => `${escapeHtml(d.what)} — ${escapeHtml(d.why)}`).join('; ')}` : '';
    $('aboutWrap').open = true;
    $('prompt').value = '';
    renderSliders();
    const seq = ++weaveSeq;
    const { result: r, sim } = await weave({ recipe, values: controlValues, terrains: {}, shop: shopForRun() });
    if (seq === weaveSeq) { result = r; lastSim = sim; render(); if (r.ok && assemblyLayer) playIntro(); }
    persist();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });

    // demand signal, same funnel as the full app; the picture itself is never sent
    fetch('/api/intent/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(invite ? { 'x-loom-invite': invite } : {}) },
      body: JSON.stringify({
        app: 'loom', utterance,
        intent: { summary: out.summary, actions: actionList(out.turns[0].payload), declined: out.declined, suggest: out.suggest, surface: 'mobile',
          loop: { turns: out.turns.length, fixes: out.fixes, firstSummary: out.firstSummary, rolledBack: out.rolledBack } },
        usage: { input: out.usage.input_tokens, output: out.usage.output_tokens, calls: out.usage.calls },
        context: parseContext,
        ...(promptImage ? { image: { attached: true, width: promptImage.width, height: promptImage.height } } : {}),
      }),
    }).catch(() => {});
  } catch (e) {
    setMsg(e.message ?? String(e));
    if (!hasDesign()) $('result').style.display = 'none';
    else render();
  } finally {
    stopWeave();
    busy = false;
    $('build').disabled = false;
    updateBuildLabel();
  }
}
function pickExisting(values, rec) {
  const keep = {};
  for (const c of rec.controls ?? []) if (c.id in values) keep[c.id] = values[c.id];
  return keep;
}
$('build').addEventListener('click', generate);
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } });

// ------------------------------------------------------------- export
function download(name, content, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const slug = (t) => (t ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24) || 'loom';
$('dlSbp').addEventListener('click', () => result?.ok && download(`${exportStem()}.sbp`, result.sbp));
$('reset').addEventListener('click', () => {
  cancelIntro();
  recipe = structuredClone(EMPTY_RECIPE);
  controlValues = {};
  result = null; lastSim = null; assemblyBlend = 0;
  try { localStorage.removeItem(STATE_KEY); } catch {}
  $('result').style.display = 'none';
  $('sliders').innerHTML = '';
  $('sheets').innerHTML = ''; $('sheets').style.display = 'none';
  $('about').textContent = ''; $('declined').innerHTML = '';
  $('clearPhoto').click();
  updateBuildLabel();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// --------------------------------------------------------------- boot
async function loadGuests() {
  let list = [];
  try { list = (await import('./guests.local.mjs')).default ?? []; } catch { return []; }
  for (const url of list) {
    try { registerCatalogEntries((await import(url)).entries); }
    catch (e) { console.warn(`guest ${url} failed to load:`, e); }
  }
  return list;
}
(async function boot() {
  const restored = loadState();
  updateBuildLabel();
  if (!haveAuth()) showAuth(true);
  const loaded = {};
  await Promise.all(FONTS.map(async (f) => {
    const res = await fetch(f.file);
    if (!res.ok) throw new Error(`font "${f.id}" failed to load: ${res.status}`);
    loaded[f.id] = await res.arrayBuffer();
  }));
  LOADED_FONTS = loaded;
  const guestUrls = await loadGuests();
  initWeaveWorker(guestUrls);
  if (restored && hasDesign()) {
    $('about').textContent = recipe.about ?? '';
    renderSliders();
    await runAndRender();
  }
  window.loomMobile = { get recipe() { return recipe; }, get result() { return result; }, get values() { return controlValues; }, ready: true };   // test handle
})();
