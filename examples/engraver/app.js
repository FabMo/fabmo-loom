// Engrave Anything — browser shell over the same pipeline the tests run.
// The UI holds no CAM logic: it collects parameters, calls buildEngraveJob,
// draws the preview, shows the verifier's numbers, and offers downloads
// ONLY for programs the verifier accepted.

import { buildEngraveJob } from './pipeline.mjs';
import { composeJob } from '../../ir/job.js';
import { verifyJob } from '../../ir/verify.js';
import { walkMoves } from '../../ir/moves.js';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

let FONT = null;
let result = null;      // last pipeline result
let sabotaged = false;

// the medial-axis kernel narrates to console.log; keep the console usable
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

async function loadFont() {
  const res = await fetch('assets/DejaVuSans-Bold.ttf');
  FONT = await res.arrayBuffer();
  rebuild();
}

function params() {
  const n = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
  return {
    text: $('text').value,
    letterHeight: n('letterHeight', 1),
    margin: n('margin', 0.375),
    stock: { w: n('stockW', 8), h: n('stockH', 2.5), thickness: n('stockT', 0.5) },
    vBit: { includedAngle: n('angle', 60), maxDepth: n('maxDepth', 0.2), tipDiameter: 0.002 },
    machine: { feedRate: n('feed', 60), plungeRate: 30, safeZ: 0.5, rpm: 14000 },
    cutout: { enabled: $('cutout').checked, buffer: n('buffer', 0.25), cornerRadius: n('cornerR', 0.5) },
  };
}

function setBadge(cls, text) { const b = $('badge'); b.className = `badge ${cls}`; b.textContent = text; }

function rebuild() {
  if (!FONT) return;
  sabotaged = false;
  $('sabNote').textContent = '';
  const p = params();
  setBadge('wait', 'computing…');
  // yield a frame so the badge paints before the sync compute
  requestAnimationFrame(() => setTimeout(() => {
    result = quiet(() => buildEngraveJob(FONT, p.text, p));
    render(p);
  }, 0));
}

function render(p) {
  const r = result;

  const targetLine = (tt) => tt.type === 'profile'
    ? `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.intrusionArea}</b> sq in intrusion · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`
    : `<b>${tt.samples.toLocaleString()}</b> samples · <b>${tt.gouges}</b> gouges · <b>${tt.depthViolations}</b> depth violations — <i>${tt.name}</i>`;
  const targetLines = (r.report?.stats.targets ?? []).map(targetLine).join('<br>');

  if (r.ok) {
    setBadge('ok', 'VERIFIED');
    $('verdictText').textContent = 'this exact motion was measured, not assumed';
    $('numbers').innerHTML = targetLines + `<br>` +
      `<b>${r.report.stats.moveCount.toLocaleString()}</b> moves · <b>${r.report.stats.cutLength}"</b> of cut · ` +
      `≈ <b>${r.report.stats.estCutTimeMin} min</b>` +
      (r.report.stats.toolchangeCount > 1 ? ` · <b>${r.report.stats.toolchangeCount}</b> tool mounts` : '');
  } else {
    setBadge('bad', 'REJECTED');
    $('verdictText').textContent = r.report ? 'the verifier refused this motion' : 'fix the setup first';
    $('numbers').innerHTML = targetLines;
  }
  $('errors').textContent = r.errors.join('\n');
  $('warnings').textContent = r.warnings.join('\n');
  $('dlSbp').disabled = !r.ok;
  $('dlNc').disabled = !r.ok;
  draw(p, r);
}

// ---------------------------------------------------------------- preview

function draw(p, r) {
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  const stock = p.stock;
  const pad = 30;
  const s = Math.min((W - 2 * pad) / stock.w, (H - 2 * pad) / stock.h);
  const ox = (W - stock.w * s) / 2, oy = (H + stock.h * s) / 2; // y flips
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;

  // stock
  ctx.fillStyle = '#f3ead8';
  ctx.strokeStyle = '#c9a86a';
  ctx.lineWidth = 1.5;
  ctx.fillRect(X(0), Y(stock.h), stock.w * s, stock.h * s);
  ctx.strokeRect(X(0), Y(stock.h), stock.w * s, stock.h * s);

  const pre = r.preview;
  if (!pre?.regions?.length) return;
  const place = pre.placement ?? { x: 0, y: 0 };

  // letterforms (placed): outers filled, counters knocked out via evenodd
  ctx.beginPath();
  for (const g of pre.regions) {
    for (const ring of [g.outer, ...g.holes]) {
      ring.forEach((pt, i) => {
        const px = X(pt.x + place.x), py = Y(pt.y + place.y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
    }
  }
  ctx.fillStyle = 'rgba(120,120,125,0.18)';
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(90,90,100,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // toolpath, colored by depth (walkMoves resolves sticky coords; the
  // callback sees the position AFTER the move plus state.prev)
  if (pre.moves) {
    const maxD = p.vBit.maxDepth;
    walkMoves(pre.moves, (state, move) => {
      if (move.type !== 'linear') return;
      const from = state.prev, to = state;
      if (from.z > -1e-9 && to.z > -1e-9) return; // not cutting
      if (Math.abs(to.x - from.x) < 1e-12 && Math.abs(to.y - from.y) < 1e-12) return; // plunge
      const d = Math.min(1, Math.abs((from.z + to.z) / 2) / maxD);
      ctx.strokeStyle = `rgba(27,42,107,${0.35 + 0.6 * d})`;
      ctx.lineWidth = 0.8 + 2.2 * d;
      ctx.beginPath();
      ctx.moveTo(X(from.x + place.x), Y(from.y + place.y));
      ctx.lineTo(X(to.x + place.x), Y(to.y + place.y));
      ctx.stroke();
    });
  }

  // tag outline + cutout profile passes
  if (pre.tagRing) {
    ctx.beginPath();
    pre.tagRing.forEach((pt, i) => {
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
  if (pre.cutoutMoves) {
    walkMoves(pre.cutoutMoves, (state, move) => {
      if (move.type !== 'linear') return;
      const from = state.prev, to = state;
      if (from.z > -1e-9 && to.z > -1e-9) return;
      if (Math.abs(to.x - from.x) < 1e-12 && Math.abs(to.y - from.y) < 1e-12) return;
      ctx.strokeStyle = 'rgba(204,34,41,0.45)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(X(from.x + place.x), Y(from.y + place.y));
      ctx.lineTo(X(to.x + place.x), Y(to.y + place.y));
      ctx.stroke();
    });
  }

  if (sabotaged) {
    ctx.fillStyle = 'rgba(204,34,41,0.9)';
    ctx.font = 'bold 20px system-ui';
    ctx.fillText('⚠ sabotaged motion — rejected, exports locked', X(0) + 10, Y(stock.h) - 8);
  }
}

// ------------------------------------------------------------- downloads

function download(name, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const slug = (t) => t.trim().replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24) || 'engraving';
$('dlSbp').addEventListener('click', () => result?.ok && download(`engrave_${slug($('text').value)}.sbp`, result.sbp));
$('dlNc').addEventListener('click', () => result?.ok && download(`engrave_${slug($('text').value)}.nc`, result.gcode));

// ------------------------------------------------- the gate, on demand

$('sabotage').addEventListener('click', () => {
  if (!result?.job) return;
  const p = params();
  const op = result.job.operations[0];
  // stray cut near the stock's bottom-left corner: always ON stock (so the
  // envelope check stays silent) but outside the letterforms — the
  // rejection everyone sees is the region gouge, with coordinates.
  const place = op.placement ?? { x: 0, y: 0 };
  const sx = 0.15 - place.x, sy = 0.15 - place.y;
  const sab = {
    ...result.job,
    operations: [{
      ...op,
      moves: [...op.moves,
        { type: 'rapid', x: sx, y: sy },
        { type: 'linear', z: -0.05 },
        { type: 'linear', x: sx + 0.4, y: sy },
      ],
    }],
  };
  const report = quiet(() => verifyJob(sab, composeJob(sab), { coverageWarnPct: 100 }));
  sabotaged = true;
  setBadge('bad', 'REJECTED');
  $('verdictText').textContent = 'one stray cut appended — the gate slammed shut';
  const t = report.stats.targets?.[0];
  $('numbers').innerHTML = t
    ? `<b>${t.samples.toLocaleString()}</b> samples · <b>${t.gouges}</b> gouges · first at measured coordinates below`
    : '';
  $('errors').textContent = report.errors.join('\n');
  $('warnings').textContent = '';
  $('dlSbp').disabled = true;
  $('dlNc').disabled = true;
  $('sabNote').textContent = ' — type anything to reset';
  draw(p, result);
});

// ------------------------------------------------------------------ wire

let timer = null;
const debounce = () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); };
for (const id of ['text', 'letterHeight', 'margin', 'stockW', 'stockH', 'stockT', 'angle', 'maxDepth', 'feed', 'cutout', 'buffer', 'cornerR']) {
  $(id).addEventListener('input', debounce);
}
loadFont();
