// Arc fitting — a bounded POST transform on the moves rail.
//
// Strategies emit faceted line segments (the verifier checks true geometry on
// those). After verification, consecutive co-circular cutting segments are
// collapsed into single CG / G2-G3 arcs so the posted file is compact and the
// machine runs true arcs instead of hundreds of chords. The fit is bounded by
// `tol`: every retained arc lies within `tol` of the original vertices, so the
// arc'd path never deviates from the verified faceted path by more than tol
// (keep tol << the verifier's gouge tolerance).
//
// Only constant-Z XY cutting runs (`linear` moves with x,y and no z) are fitted;
// rapids, plunges (Z-only), feeds, comments and toolchanges pass through and
// break a run.

const FULL_SPLIT_DEG = 300; // a run sweeping ≥ this is split so no near-360° CG

// Circumcircle of three points; null if (near-)collinear.
function circleFrom3(p1, p2, p3) {
  const { x: ax, y: ay } = p1, { x: bx, y: by } = p2, { x: cx, y: cy } = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
}

// Sign of the turn from C→a to C→b (>0 CCW, <0 CW) around centre C.
const crossSign = (a, b, C) =>
  Math.sign((a.x - C.x) * (b.y - C.y) - (a.y - C.y) * (b.x - C.x));

const onCircle = (p, C, tol) => Math.abs(Math.hypot(p.x - C.x, p.y - C.y) - C.r) <= tol;

// Per-segment max chord as a fraction of the radius. A tessellated arc steps in
// tiny chords (chord ≈ 2r·sin(θ/2), small θ); a polygon edge spans a large
// fraction of the radius (a rectangle's 4 concyclic corners would otherwise be
// mistaken for an arc). 0.5 admits steps up to ~29° — far finer than any real
// chord, far coarser than any sane tessellation.
const MAX_CHORD_FRAC = 0.5;

// b continues the arc on circle C: b is on the circle AND the a→b chord is short
// relative to the radius (so it samples the curve, not a straight edge).
const stepOk = (a, b, C, tol) =>
  onCircle(b, C, tol) && Math.hypot(b.x - a.x, b.y - a.y) < MAX_CHORD_FRAC * C.r;

// Total swept angle (radians, unsigned) of points[i..j] around centre C.
function sweptAngle(points, i, j, C) {
  let sum = 0;
  for (let k = i; k < j; k++) {
    const a = points[k], b = points[k + 1];
    const a0 = Math.atan2(a.y - C.y, a.x - C.x);
    const a1 = Math.atan2(b.y - C.y, b.x - C.x);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    sum += Math.abs(da);
  }
  return sum;
}

function pushArc(segs, points, i, j, C) {
  // split a near-full sweep so we never emit an ambiguous ≥300° CG
  if ((sweptAngle(points, i, j, C) * 180) / Math.PI >= FULL_SPLIT_DEG) {
    const mid = Math.floor((i + j) / 2);
    pushArc(segs, points, i, mid, C);
    pushArc(segs, points, mid, j, C);
    return;
  }
  const cw = crossSign(points[i], points[i + 1], C) < 0;
  segs.push({ type: 'arc', from: points[i], to: points[j], center: { x: C.x, y: C.y }, cw });
}

/**
 * Fit a polyline (open sequence of points) into line + arc segments.
 * @returns {Array<{type:'line',from,to} | {type:'arc',from,to,center,cw}>}
 */
export function fitArcs(points, tol = 1e-3) {
  const segs = [];
  const n = points.length;
  let i = 0;
  while (i < n - 1) {
    let made = false;
    if (i + 2 <= n - 1) {
      const C = circleFrom3(points[i], points[i + 1], points[i + 2]);
      if (C && C.r < 1e5
          && stepOk(points[i], points[i + 1], C, tol)
          && stepOk(points[i + 1], points[i + 2], C, tol)) {
        const dir0 = crossSign(points[i], points[i + 1], C);
        let j = i + 2;
        while (j + 1 <= n - 1 && stepOk(points[j], points[j + 1], C, tol)
               && crossSign(points[j], points[j + 1], C) === dir0) {
          j++;
        }
        if (j - i >= 3) { // ≥3 segments / 4 points worth turning into an arc
          pushArc(segs, points, i, j, C);
          i = j;
          made = true;
        }
      }
    }
    if (!made) {
      segs.push({ type: 'line', from: points[i], to: points[i + 1] });
      i++;
    }
  }
  return segs;
}

/**
 * Fit using KNOWN candidate circles (centre + radius) instead of fitting circles
 * to the points. This is exact and robust: a profile derived from authored arcs
 * knows every arc centre (the source arc offset by ±R) and convex-corner fillet
 * centre (the source vertex, radius R), so each offset run is relabelled onto
 * its true circle — no circumcircle guessing, no concyclic-corner false matches.
 * @param {Array<{x,y,r}>} candidates
 */
export function fitArcsSeeded(points, candidates, tol = 2e-3) {
  const onCand = (p, c) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.r) <= tol;
  // same chord guard as the heuristic fit: a run step must sample the curve, not
  // span a chord — so a spurious large-radius candidate can't swallow a polygon edge.
  const stepCand = (a, b, c) => onCand(b, c) && Math.hypot(b.x - a.x, b.y - a.y) < MAX_CHORD_FRAC * c.r;
  const segs = [];
  const n = points.length;
  let i = 0;
  while (i < n - 1) {
    let best = null;
    for (const c of candidates) {
      if (!(onCand(points[i], c) && stepCand(points[i], points[i + 1], c))) continue;
      let j = i + 1;
      while (j + 1 <= n - 1 && stepCand(points[j], points[j + 1], c)) j++;
      if (!best || j - i > best.len) best = { c, j, len: j - i };
    }
    if (best && best.len >= 2) { pushArc(segs, points, i, best.j, best.c); i = best.j; }
    else { segs.push({ type: 'line', from: points[i], to: points[i + 1] }); i++; }
  }
  return segs;
}

/**
 * Collapse co-circular constant-Z cutting runs in a moves[] program into arcs.
 * @param {Array} moves - canonical rail moves
 * @param {number} tol  - max vertex deviation from a fitted arc (in)
 * @param {Array<{x,y,r}>} [candidates] - known arc circles; when given, runs are
 *   matched to these EXACTLY (seeded) instead of circle-fitted (heuristic).
 * @returns {Array} new moves (faceted input is never mutated)
 */
export function arcFitMoves(moves, tol = 1e-3, candidates = null) {
  const out = [];
  const pos = { x: 0, y: 0, z: 0 };
  let run = null; // { points: [...] } collecting constant-Z XY linear moves

  const minPts = candidates ? 3 : 4; // seeded arcs can be as short as a 3-pt fillet
  const flush = () => {
    if (!run) return;
    if (run.points.length >= minPts) {
      const segs = candidates ? fitArcsSeeded(run.points, candidates, tol) : fitArcs(run.points, tol);
      for (const s of segs) {
        if (s.type === 'line') out.push({ type: 'linear', x: s.to.x, y: s.to.y });
        else out.push({ type: 'arc', x: s.to.x, y: s.to.y, i: s.center.x - s.from.x, j: s.center.y - s.from.y, cw: s.cw });
      }
    } else {
      for (let k = 1; k < run.points.length; k++) out.push({ type: 'linear', x: run.points[k].x, y: run.points[k].y });
    }
    run = null;
  };

  for (const m of moves) {
    const isXYCut = m.type === 'linear' && m.x !== undefined && m.y !== undefined && m.z === undefined;
    if (isXYCut) {
      if (!run) run = { points: [{ x: pos.x, y: pos.y }] };
      run.points.push({ x: m.x, y: m.y });
      pos.x = m.x; pos.y = m.y;
    } else {
      flush();
      out.push(m);
      if (m.x !== undefined) pos.x = m.x;
      if (m.y !== undefined) pos.y = m.y;
      if (m.z !== undefined) pos.z = m.z;
    }
  }
  flush();
  return out;
}
