// Generic shapes from SVG path syntax — the FORM-level source that frees
// the catalog from enumerating outlines. A shape is authored as one SVG
// path "d" string (the one 2D outline language the model already speaks
// fluently: ellipses are two A arcs, an n-pointed star is 2n line
// segments, a heart is four béziers). This module lowers it
// deterministically to the same {outer, holes} regions every strategy
// consumes: parse → flatten curves → scale/center/y-flip to shop
// coordinates → weld under the NONZERO fill rule so self-intersections
// and overlaps come out as clean solid geometry.
//
// The trust boundary holds: the LLM authors a DESCRIPTION (a path
// string, parameters); everything from here down — flattening, offsets,
// motion, verification — is deterministic code. A badly drawn path makes
// a badly shaped part in the preview, never unverified motion.
//
// DOM-free: runs in Node (gauntlet) and the browser unchanged.

import ClipperLib from '../vendor/clipper.js';

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
};
const ccw = (ring) => (ringArea(ring) > 0 ? ring : [...ring].reverse());

// Weld raw contours into clean {outer, holes} regions under the NONZERO
// fill rule (moved here from catalog.mjs so font outlines and svg paths
// share one cleaner). Contours arrive AS AUTHORED: nonzero keeps
// self-crossing strokes filled (a pentagram's core stays solid), welds
// overlaps, and classifies opposite-winding subpaths as holes. Output
// normalized to the downstream convention (outers CCW, holes CCW).
const CLIP_SCALE = 1e6;
export function weldContours(contours) {
  if (!contours.length) return { regions: [], merged: false };
  const toClip = ring => ring.map(q => ({ X: Math.round(q.x * CLIP_SCALE), Y: Math.round(q.y * CLIP_SCALE) }));
  const fromClip = path => path.map(q => ({ x: q.X / CLIP_SCALE, y: q.Y / CLIP_SCALE }));
  const c = new ClipperLib.Clipper();
  for (const ring of contours) {
    c.AddPath(toClip(ring), ClipperLib.PolyType.ptSubject, true);
  }
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree);
  const regions = ex
    .filter(e => e.outer?.length >= 3)
    .map(e => ({ outer: ccw(fromClip(e.outer)), holes: (e.holes ?? []).map(h => ccw(fromClip(h))) }));
  // merged = the weld changed the ring structure (fused joins, absorbed
  // overlaps). Cleanly nested input maps 1:1: ring counts match.
  const outRings = regions.reduce((n, r) => n + 1 + r.holes.length, 0);
  return { regions, merged: outRings !== contours.length };
}

// ---------------------------------------------------------------------
// Parametric paths: {expressions} of control ids inside a template
// string, evaluated against the current control values at weave time.
// This is what makes a shape's INTERNAL geometry adjustable — an arch
// whose radius and band thickness are sliders is
//   M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {r-t} 0 A {r-t} {r-t} 0 0 0 {t-r} 0 Z
// re-lowered through parse→weld→verify on every slider move. The
// evaluator is a closed arithmetic grammar (numbers, control ids,
// + - * / and parens) — no eval, no ambient names, so a template stays
// data, exactly like the rest of the recipe.

function evalExpr(src, vars) {
  let i = 0;
  const ws = () => { while (i < src.length && src[i] === ' ') i++; };
  const primary = () => {
    ws();
    if (src[i] === '(') {
      i++;
      const v = sum();
      ws();
      if (src[i] !== ')') throw new Error(`missing ")" in "${src}"`);
      i++;
      return v;
    }
    if (src[i] === '-') { i++; return -primary(); }
    if (src[i] === '+') { i++; return primary(); }
    const m = /^(?:\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (m) { i += m[0].length; return parseFloat(m[0]); }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      const v = vars[id[0]];
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (v === undefined) throw new Error(`unknown name "${id[0]}" (controls: ${Object.keys(vars).join(', ') || 'none'})`);
      if (!Number.isFinite(n)) throw new Error(`control "${id[0]}" is not a number`);
      return n;
    }
    throw new Error(`expected a number, name, or "(" at "${src.slice(i) || 'end'}" in "${src}"`);
  };
  const product = () => {
    let v = primary();
    for (ws(); src[i] === '*' || src[i] === '/'; ws()) {
      const op = src[i++];
      const r = primary();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    for (ws(); src[i] === '+' || src[i] === '-'; ws()) {
      const op = src[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  ws();
  if (i < src.length) throw new Error(`unexpected "${src.slice(i)}" in "${src}"`);
  if (!Number.isFinite(v)) throw new Error(`"${src}" does not evaluate to a finite number`);
  return v;
}

/** Expand {expr} placeholders in a template string. Returns {value}|{error}. */
export function expandTemplate(str, vars) {
  try {
    const value = String(str).replace(/\{([^{}]*)\}/g, (_, expr) => {
      const v = evalExpr(expr, vars ?? {});
      return String(Math.round(v * 1e6) / 1e6);
    });
    if (value.includes('{') || value.includes('}')) {
      throw new Error('unbalanced braces');
    }
    return { value };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------
// SVG path parsing. Full command set (MLHVCSQTAZ, absolute and
// relative), implicit repeats, S/T control-point reflection, W3C
// endpoint-to-center arc conversion. Curves flatten at fixed densities
// matched to the catalog's own rings (a full ellipse ≈ 96 points, the
// same as circleRing) — plenty for both preview and cut at plaque scale.

const CURVE_SEGS = 24;          // per cubic/quadratic bézier
const ARC_STEP = Math.PI / 48;  // radians per arc sample (96 per turn)

/** @returns {Array<Array<{x,y}>>} closed polylines in authored coords */
export function parseSvgPath(d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || !tokens.length) throw new Error('empty path');
  let i = 0;
  const num = () => {
    const v = parseFloat(tokens[i]);
    if (!Number.isFinite(v)) throw new Error(`expected a number after "${cmd}", got "${tokens[i] ?? 'end of path'}"`);
    i++;
    return v;
  };
  const moreNums = () => i < tokens.length && Number.isFinite(parseFloat(tokens[i]));

  const subpaths = [];
  let cur = null;                 // current subpath points
  let x = 0, y = 0;               // current point
  let sx = 0, sy = 0;             // subpath start
  let cmd = '';                   // current command letter
  let prevCubic = null, prevQuad = null;  // reflected control points

  const pt = (px, py) => {
    if (!cur) throw new Error('path must start with M');
    const last = cur[cur.length - 1];
    if (!last || Math.hypot(px - last.x, py - last.y) > 1e-12) cur.push({ x: px, y: py });
    x = px; y = py;
  };
  const flushSubpath = () => {
    if (cur && cur.length >= 3) subpaths.push(cur);
    cur = null;
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const x0 = x, y0 = y;
    for (let s = 1; s <= CURVE_SEGS; s++) {
      const t = s / CURVE_SEGS, u = 1 - t;
      pt(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
         u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
    prevCubic = { x: x2, y: y2 };
  };
  const quad = (x1, y1, x2, y2) => {
    const x0 = x, y0 = y;
    for (let s = 1; s <= CURVE_SEGS; s++) {
      const t = s / CURVE_SEGS, u = 1 - t;
      pt(u * u * x0 + 2 * u * t * x1 + t * t * x2,
         u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
    prevQuad = { x: x1, y: y1 };
  };
  // W3C SVG spec F.6.5: endpoint → center parameterization
  const arc = (rx, ry, rotDeg, largeArc, sweep, x2, y2) => {
    const x0 = x, y0 = y;
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < 1e-12 || ry < 1e-12 || (x0 === x2 && y0 === y2)) { pt(x2, y2); return; }
    const phi = (rotDeg * Math.PI) / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const dx = (x0 - x2) / 2, dy = (y0 - y2) / 2;
    const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const sign = largeArc !== sweep ? 1 : -1;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const rad = Math.max(0, (rx * rx * ry * ry - den) / den);
    const co = sign * Math.sqrt(rad);
    const cxp = co * (rx * y1p) / ry, cyp = co * -(ry * x1p) / rx;
    const cx = cosP * cxp - sinP * cyp + (x0 + x2) / 2;
    const cy = sinP * cxp + cosP * cyp + (y0 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dth > 0) dth -= 2 * Math.PI;
    if (sweep && dth < 0) dth += 2 * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(dth) / ARC_STEP));
    for (let s = 1; s <= n; s++) {
      const th = th1 + (dth * s) / n;
      const ex = rx * Math.cos(th), ey = ry * Math.sin(th);
      pt(cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy);
    }
    pt(x2, y2);
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(t)) { cmd = t; i++; }
    else if (!cmd) throw new Error(`path must start with a command, got "${t}"`);
    // implicit repeat: after M/m, extra pairs are L/l (per spec)
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';

    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        flushSubpath();
        const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        cur = [{ x: nx, y: ny }];
        x = nx; y = ny; sx = nx; sy = ny;
        prevCubic = prevQuad = null;
        break;
      }
      case 'L': pt(num() + (rel ? x : 0), num() + (rel ? y : 0)); prevCubic = prevQuad = null; break;
      case 'H': pt(num() + (rel ? x : 0), y); prevCubic = prevQuad = null; break;
      case 'V': pt(x, num() + (rel ? y : 0)); prevCubic = prevQuad = null; break;
      case 'C': {
        const ox = rel ? x : 0, oy = rel ? y : 0;
        cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
        prevQuad = null;
        break;
      }
      case 'S': {
        const ox = rel ? x : 0, oy = rel ? y : 0;
        const r1 = prevCubic ? { x: 2 * x - prevCubic.x, y: 2 * y - prevCubic.y } : { x, y };
        cubic(r1.x, r1.y, num() + ox, num() + oy, num() + ox, num() + oy);
        prevQuad = null;
        break;
      }
      case 'Q': {
        const ox = rel ? x : 0, oy = rel ? y : 0;
        quad(num() + ox, num() + oy, num() + ox, num() + oy);
        prevCubic = null;
        break;
      }
      case 'T': {
        const ox = rel ? x : 0, oy = rel ? y : 0;
        const r1 = prevQuad ? { x: 2 * x - prevQuad.x, y: 2 * y - prevQuad.y } : { x, y };
        quad(r1.x, r1.y, num() + ox, num() + oy);
        prevCubic = null;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
        arc(rx, ry, rot, la !== 0, sw !== 0, num() + (rel ? x : 0), num() + (rel ? y : 0));
        prevCubic = prevQuad = null;
        break;
      }
      case 'Z': {
        if (cur) { x = sx; y = sy; flushSubpath(); }
        prevCubic = prevQuad = null;
        // Z takes no numbers; a following number means a missing command
        if (moreNums()) throw new Error(`number after Z — a new subpath needs M`);
        break;
      }
      default: throw new Error(`unsupported path command "${cmd}"`);
    }
  }
  flushSubpath();  // an unclosed trailing subpath closes implicitly
  return subpaths;
}

/**
 * Lower an SVG path to shop-ready regions: flatten, scale to the
 * requested size, center at the origin, flip Y (SVG is y-down, the shop
 * is y-up), weld under nonzero fill.
 *
 * @param {string} d  SVG path data, any convenient coordinate box
 * @param {{width?:number, height?:number}} size  target size in inches.
 *   width only → uniform scale (aspect preserved); both → stretched to
 *   exactly width×height. NEITHER → anchored true-size mode: authored
 *   units are inches AND authored coordinates are kept verbatim (only
 *   the y-flip applies) — no recentering, so several parametric paths
 *   authored in one frame (an arch and the rabbet band on its edge)
 *   stay aligned by construction. `anchored: true` in the result tells
 *   the caller not to re-position the shape either.
 * @returns {{regions, w, h, merged, anchored} | {error}}
 */
export function pathToRegions(d, { width = 0, height = 0 } = {}) {
  let contours;
  try {
    contours = parseSvgPath(d);
  } catch (e) {
    return { error: `could not read that shape path: ${e.message}` };
  }
  contours = contours.filter(ring => Math.abs(ringArea(ring)) > 1e-12);
  if (!contours.length) return { error: 'that shape path contains no closed outline with area' };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of contours) {
    for (const q of ring) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
  }
  const bw = maxX - minX, bh = maxY - minY;
  if (bw < 1e-9 || bh < 1e-9) return { error: 'that shape path is degenerate (zero width or height)' };
  const anchored = !(width > 0) && !(height > 0);
  let sxs, sys;
  if (width > 0 && height > 0) { sxs = width / bw; sys = height / bh; }
  else if (width > 0) { sxs = sys = width / bw; }
  else if (height > 0) { sxs = sys = height / bh; }
  else { sxs = sys = 1; }
  const cx = anchored ? 0 : (minX + maxX) / 2;
  const cy = anchored ? 0 : (minY + maxY) / 2;
  const placed = contours.map(ring => ring.map(q => ({
    x: (q.x - cx) * sxs,
    y: (cy - q.y) * sys,   // y-flip: SVG y grows downward
  })));
  const { regions, merged } = weldContours(placed);
  if (!regions.length) return { error: 'that shape path welds to nothing solid' };
  return { regions, w: bw * sxs, h: bh * sys, merged, anchored };
}
