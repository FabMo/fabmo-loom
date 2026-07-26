// Lowering adapter: a hand-drawn sketch → a clean FORM-rail outline.
//
// Receives raw pointer/touch samples (mouse or finger) and returns a smooth
// polyline or closed polygon in the SAME { x, y } format seams regions use —
// so a drawn shape becomes a profile cutout, a hole, a pattern seed, a cookie
// cutter, whatever, by feeding it to the strategies like any other outline.
// This is the geometry kernel only: input capture and screen→inches placement
// live in the front-end (a canvas in an app, or Loom's draw modality).
//
// The pipeline is Jonathan Ward's, ported from the FabMo SmoothSketch app
// (https://github.com/fabmo/fabmo-smoothsketch-app, js/smooth.js) to a pure,
// dependency-light module:
//
//   raw points --> dedupe --> RDP simplify (vendor/simplify.js, mourner) -->
//   Chaikin corner-cutting --> smooth outline
//
// Chaikin's algorithm rounds a jagged polyline by repeatedly replacing every
// segment with two points at its 1/4 and 3/4 marks; each pass halves the
// remaining sharpness and converges to a quadratic B-spline. Because every
// output point is a convex blend of two inputs, the result never overshoots
// the drawn hull — a corner-cut is always inside the corner.
//
// Credit: Jonathan Ward (FabMo SmoothSketch). Simplification: simplify.js,
// © 2015 Vladimir Agafonkin (see vendor/simplify.js).

import simplify from '../vendor/simplify.js';

const sqDist = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Drop consecutive samples closer together than `eps` (capture jitter/dupes). */
function dedupe(points, eps = 1e-9) {
  const out = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (!out.length || sqDist(out[out.length - 1], p) > eps * eps) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function bboxOf(points) {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Chaikin corner-cutting. `iterations` passes of the 1/4–3/4 subdivision.
 * @param {{x,y}[]} pts
 * @param {number} iterations  clamped to [0, 8] (each pass ~doubles points)
 * @param {{closed?: boolean}} [opts]  closed = cyclic (cut every corner,
 *        keep no fixed endpoints); open = keep the two endpoints anchored.
 * @returns {{x,y}[]}
 */
export function chaikin(pts, iterations = 4, { closed = false } = {}) {
  const iters = Math.max(0, Math.min(8, iterations | 0));
  let out = pts.map(p => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iters; it++) {
    if (out.length < (closed ? 3 : 3)) break; // <3 points: nothing to round
    const next = [];
    if (closed) {
      const n = out.length;
      for (let i = 0; i < n; i++) {
        const p0 = out[i], p1 = out[(i + 1) % n];
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
    } else {
      next.push(out[0]); // endpoints stay pinned on an open curve
      for (let i = 0; i < out.length - 1; i++) {
        const p0 = out[i], p1 = out[i + 1];
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      next.push(out[out.length - 1]);
    }
    out = next;
  }
  return out;
}

/**
 * Smooth one raw stroke into a clean outline.
 *
 * @param {{x,y}[]} points  raw pointer samples (any units — px or inches)
 * @param {Object} [opts]
 * @param {number}  [opts.tolerance=2]     RDP tolerance, in the input's units
 * @param {number}  [opts.iterations=4]    Chaikin passes (0 = simplify only)
 * @param {boolean} [opts.highQuality=true] RDP only (skip the radial pre-pass)
 * @param {boolean|'auto'} [opts.close='auto']  'auto' closes when the ends land
 *        within snapDistance; true/false force it.
 * @param {number}  [opts.snapDistance=8]  end-to-end gap that auto-closes
 * @returns {{ points: {x,y}[], closed: boolean, bbox: Object|null }}
 *          A closed ring omits the duplicate final point (last connects to first).
 */
export function smoothSketch(points, opts = {}) {
  const { tolerance = 2, iterations = 4, highQuality = true, close = 'auto', snapDistance = 8 } = opts;
  let pts = dedupe(points ?? []);
  if (pts.length < 2) return { points: pts, closed: false, bbox: bboxOf(pts) };

  const endsGap = Math.sqrt(sqDist(pts[0], pts[pts.length - 1]));
  const closed = close === 'auto' ? endsGap <= snapDistance : !!close;

  if (closed) {
    // a ring is cyclic: drop a trailing point that just restates the start,
    // so Chaikin's wrap-around doesn't double-count the seam
    if (pts.length > 1 && sqDist(pts[0], pts[pts.length - 1]) <= snapDistance * snapDistance) {
      pts = pts.slice(0, -1);
    }
    // RDP wants endpoints it can pin; simplify the ring as an open run through
    // the seam, then smooth cyclically
    pts = simplify(pts, tolerance, highQuality);
    if (pts.length < 3) return { points: pts, closed: true, bbox: bboxOf(pts) };
    const smooth = chaikin(pts, iterations, { closed: true });
    return { points: smooth, closed: true, bbox: bboxOf(smooth) };
  }

  pts = simplify(pts, tolerance, highQuality);
  const smooth = chaikin(pts, iterations, { closed: false });
  return { points: smooth, closed: false, bbox: bboxOf(smooth) };
}

/**
 * Chain several raw strokes into one polyline by welding endpoints that land
 * within `snap` of each other (a shape drawn as separate pen-down strokes).
 * Greedy nearest-end joining, flipping strokes as needed — the messy part of
 * "receive a drawing" kept out of smoothSketch so smoothing stays pure.
 *
 * @param {{x,y}[][]} strokes
 * @param {number} [snap=12]
 * @returns {{x,y}[]}  one ordered polyline (feed to smoothSketch)
 */
export function joinStrokes(strokes, snap = 12) {
  const runs = (strokes ?? []).map(dedupe).filter(s => s.length);
  if (runs.length <= 1) return runs[0] ?? [];
  const snap2 = snap * snap;
  const chain = runs.shift().slice();
  while (runs.length) {
    const tail = chain[chain.length - 1];
    let best = -1, flip = false, bestD = Infinity;
    for (let i = 0; i < runs.length; i++) {
      const dHead = sqDist(tail, runs[i][0]);
      const dTail = sqDist(tail, runs[i][runs[i].length - 1]);
      if (dHead < bestD) { bestD = dHead; best = i; flip = false; }
      if (dTail < bestD) { bestD = dTail; best = i; flip = true; }
    }
    if (best < 0 || bestD > snap2) break; // no more strokes within reach
    const run = runs.splice(best, 1)[0];
    chain.push(...(flip ? run.reverse() : run));
  }
  return chain;
}
