// Loom — the mother app. Prompts and sliders edit the same recipe
// document; every state runs the full pipeline through the verifier.
// The LLM (user's own key, browser-direct) emits recipe actions only —
// no code, no motion. See intent.mjs for the trust boundary.

import { EMPTY_RECIPE, runRecipe, controlDefaults } from './runtime.mjs';
import { buildParseRequest, applyActions } from './intent.mjs';
import { walkMoves } from '../ir/moves.js';
import { startWeave } from './weave.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

let FONT = null;
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
    if (s) return JSON.parse(s);
  } catch { /* fresh start */ }
  return structuredClone(EMPTY_RECIPE);
}
function persist() { localStorage.setItem('loom:recipe', JSON.stringify(recipe)); }

// ------------------------------------------------------------ controls UI

function renderControls() {
  $('appName').textContent = recipe.name;
  const host = $('controls');
  host.innerHTML = '';
  for (const c of recipe.controls) {
    const wrap = document.createElement('div');
    if (c.type === 'text') wrap.className = 'ctl-text';
    const label = document.createElement('label');
    label.textContent = c.label ?? c.id;
    const input = document.createElement('input');
    input.type = c.type === 'number' ? 'number' : 'text';
    if (c.type === 'number') {
      if (c.min !== undefined) input.min = c.min;
      if (c.max !== undefined) input.max = c.max;
      input.step = c.step ?? 0.125;
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
  $('recipeJson').textContent = JSON.stringify(recipe, null, 2);
}

// ---------------------------------------------------------------- run/draw

function setBadge(cls, text) { const b = $('badge'); b.className = `badge ${cls}`; b.textContent = text; }

function runAndRender() {
  if (!FONT) return;
  setBadge('wait', 'computing…');
  requestAnimationFrame(() => setTimeout(() => {
    result = quiet(() => runRecipe(recipe, controlValues, FONT));
    render();
  }, 0));
}
let timer = null;
function debounceRun() { clearTimeout(timer); timer = setTimeout(runAndRender, 250); }

function render() {
  const r = result;
  const targetLine = (tt) => tt.type === 'profile'
    ? `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.intrusionArea ?? 0}</b> sq in intrusion · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`
    : `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.gouges}</b> gouges · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`;
  const targetLines = (r.report?.stats.targets ?? []).map(targetLine).join('<br>');

  if (r.ok) {
    setBadge('ok', 'VERIFIED');
    $('verdictText').textContent = 'this exact motion was measured, not assumed';
    $('numbers').innerHTML = targetLines + `<br><b>${r.report.stats.moveCount.toLocaleString()}</b> moves · <b>${r.report.stats.cutLength}"</b> of cut · ≈ <b>${r.report.stats.estCutTimeMin} min</b>` +
      (r.report.stats.toolchangeCount > 1 ? ` · <b>${r.report.stats.toolchangeCount}</b> tool mounts` : '');
  } else {
    setBadge('bad', r.preview?.empty ? 'EMPTY' : 'REJECTED');
    $('verdictText').textContent = r.preview?.empty ? 'describe an app to begin' : 'the verifier refused this state';
    $('numbers').innerHTML = targetLines;
  }
  $('errors').textContent = r.preview?.empty ? '' : r.errors.join('\n');
  $('warnings').textContent = r.warnings.join('\n');
  $('dlSbp').disabled = !r.ok;
  $('dlNc').disabled = !r.ok;
  draw();
}

function draw() {
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  const stock = recipe.stock;
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
  if (!pre?.built?.length) return;
  const place = pre.placement ?? { x: 0, y: 0 };

  for (const { r } of pre.built) {
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
$('saveRecipe').addEventListener('click', () => download(`${slug(recipe.name)}.loom.json`, JSON.stringify(recipe, null, 2), 'application/json'));
$('openRecipe').addEventListener('click', () => $('openFile').click());
$('openFile').addEventListener('change', async () => {
  const f = $('openFile').files[0];
  if (!f) return;
  try {
    recipe = JSON.parse(await f.text());
    controlValues = controlDefaults(recipe);
    persist();
    renderControls();
    runAndRender();
    addTurn(`Opened recipe "${escapeHtml(recipe.name)}".`);
  } catch { addTurn('That file is not a Loom recipe.', true); }
});

if (localStorage.getItem('loom:apiKey')) $('apiKey').value = '••••••••••••';

(async function boot() {
  const res = await fetch('../examples/engraver/assets/DejaVuSans-Bold.ttf');
  FONT = await res.arrayBuffer();
  renderControls();
  runAndRender();
})();
