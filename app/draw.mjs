// The Draw modality — sketch a shape by hand (mouse / finger / pen).
//
// Captures pointer strokes, smooths them with the shared sketch kernel
// (adapters/sketch.js — Jonathan Ward's SmoothSketch, RDP + Chaikin), and hands
// back an SVG the recipe stores as an ASSET. From there a drawn shape is just
// "an SVG you drew instead of uploaded": the model references it with
// set_shape asset {of, width} and composes cutouts / pockets / holes around it.
// The escape hatch for shapes the model can't freehand (a bull, a logo): draw
// it yourself.
//
// This owns the UI + screen→SVG mapping only; the smoothing math lives in the
// pure kernel. Credit: Jonathan Ward (FabMo SmoothSketch); simplify.js © 2015
// Vladimir Agafonkin.

import { smoothSketch, joinStrokes } from '../adapters/sketch.js';

const $ = (id) => document.getElementById(id);

/**
 * Pure: a smoothed CLOSED outline (canvas px, {x,y}) → an SVG whose filled path
 * lowers through svgAssetToRegions. The longest side maps to `maxInches`, so a
 * no-width "cut out my drawing" makes a sensible tag; a set_shape width overrides.
 * Returns null for a degenerate outline (< 3 points or zero area).
 */
export function outlineToSvg(points, { maxInches = 4 } = {}) {
  if (!points || points.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return null;
  const s = maxInches / Math.max(w, h);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(p.x - minX).toFixed(2)} ${(p.y - minY).toFixed(2)}`).join(' ') + ' Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(w * s).toFixed(3)}in" height="${(h * s).toFixed(3)}in" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}"><path d="${d}" fill="#000"/></svg>`;
}

// ---- capture state ----
let strokes = [];      // [[{x,y}...], ...] raw pointer samples, in canvas px
let current = null;    // the stroke being drawn
let smoothed = null;   // last smoothSketch() result
let cv = null, ctx = null, onAcceptCb = null;

// smoothness slider (0..10) → kernel opts. Higher = simpler + rounder.
// close:true because cutouts / holes / cookie cutters are closed; a nearly-
// closed loop welds shut. (Open curves are a later addition.)
function opts() {
  const s = +$('drawSmooth').value;
  return { tolerance: 1 + s * 0.8, iterations: Math.max(0, Math.min(6, 2 + Math.round(s / 2))), close: true };
}

function recompute() {
  const joined = joinStrokes(strokes, 24);
  smoothed = joined.length >= 3 ? smoothSketch(joined, opts()) : null;
  render();
  $('drawUse').disabled = !(smoothed && smoothed.points.length >= 3);
}

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // raw strokes, faint
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(130,130,150,.45)';
  for (const st of strokes) {
    if (st.length < 2) continue;
    ctx.beginPath();
    st.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  // smoothed outline, bold + tinted fill
  if (smoothed && smoothed.points.length > 1) {
    const P = smoothed.points;
    ctx.beginPath();
    P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (smoothed.closed) ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,.12)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#3b82f6'; ctx.stroke();
  }
}

function ptOf(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function onDown(e) {
  e.preventDefault();
  cv.setPointerCapture?.(e.pointerId);
  current = [ptOf(e)];
  strokes.push(current);
}
function onMove(e) {
  if (!current) return;
  current.push(ptOf(e));
  render();
}
function onUp() {
  if (!current) return;
  current = null;
  recompute();
}

function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width));
  cv.height = Math.max(1, Math.round(r.height));
  render();
}

function closeOverlay() {
  $('drawOverlay').style.display = 'none';
  strokes = []; current = null; smoothed = null;
}

// "Save as" target: replace an existing drawn shape (its cutout re-weaves with
// the new geometry — a per-person shape input) or make a fresh one. The name
// field only matters for a new shape.
function syncDrawName() {
  const sel = $('drawTarget'), nm = $('drawName');
  if (!sel || !nm) return;
  const replacing = !!sel.value;
  nm.disabled = replacing;
  nm.placeholder = replacing ? '(keeps its name)' : 'name (e.g. bull)';
}

/**
 * Open the overlay for a drawing. onAccept(svgText, name, targetId) fires on
 * "Use shape" — targetId is '' for a new shape, or an existing asset id to
 * REPLACE in place. `targets` = [{id,name}] of the drawn shapes that can be
 * replaced; the most recent is preselected so "redraw this tag" is one step.
 *
 * `wanted` = names the recipe already asks for but nobody has drawn yet (a
 * set_shape draw with no artwork behind it). The first one preselects "New
 * shape" and pre-fills the name box, so a recipe authored around a drawing
 * the user has not made yet is finished by drawing it — no name to retype
 * and no way to misspell the link.
 *
 * `select` = an asset id from `targets` to preselect for replacement — the
 * per-shape "Redraw" control opens the dialog aimed at exactly that shape
 * (it wins over both the wanted-preselect and the most-recent default).
 */
export function openDraw({ onAccept, targets = [], wanted = [], select = '' }) {
  onAcceptCb = onAccept;
  strokes = []; current = null; smoothed = null;
  const sel = $('drawTarget');
  if (sel) {
    sel.innerHTML = '<option value="">New shape</option>';
    for (const t of targets) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = `Replace: ${t.name}`;
      sel.appendChild(o);
    }
    // an explicit select wins; otherwise an outstanding request wins over
    // "redraw the last one": the recipe is visibly incomplete until drawn
    sel.value = select || (wanted.length ? '' : (targets.length ? targets[targets.length - 1].id : ''));
    syncDrawName();
    if (!select && wanted.length) $('drawName').value = wanted[0];
  }
  $('drawOverlay').style.display = 'flex';
  sizeCanvas();
  $('drawUse').disabled = true;
}

/** Wire the overlay's controls once, at boot. */
export function initDraw() {
  cv = $('drawCanvas');
  ctx = cv.getContext('2d');
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  $('drawSmooth').addEventListener('input', recompute);
  $('drawClear').addEventListener('click', () => { strokes = []; current = null; recompute(); });
  $('drawUndo').addEventListener('click', () => { strokes.pop(); recompute(); });
  $('drawCancel').addEventListener('click', closeOverlay);
  $('drawTarget').addEventListener('change', syncDrawName);
  $('drawUse').addEventListener('click', () => {
    if (!smoothed || smoothed.points.length < 3) return;
    const svg = outlineToSvg(smoothed.points, { maxInches: 4 });
    if (!svg) return;
    const targetId = $('drawTarget')?.value || '';   // '' = new shape, else replace this asset
    const name = ($('drawName').value || '').trim() || 'drawing';
    closeOverlay();
    onAcceptCb?.(svg, name, targetId);
  });
  window.addEventListener('resize', () => {
    if ($('drawOverlay').style.display !== 'none') sizeCanvas();
  });
}
