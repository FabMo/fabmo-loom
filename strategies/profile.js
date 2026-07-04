// Profile strategy — "cut the part free." The degenerate pocket: a single
// offset contour rather than a full clearing.
//
//   outside  → tool centre rides one radius OUTSIDE the part   (cut it free)
//   inside   → one radius INSIDE   (open a hole/window to size)
//   on       → on the line         (scribe)
//
// The offset kernel is the same Clipper inset the pocket strategy uses, so the
// round joins give the physically-correct fillet where a tool of radius R
// rounds a convex part corner. Output is on the canonical moves rail and honours
// the operation contract (begin with a rapid XY positioning move, Z-only
// plunges, retract to safeZ between passes).
//
// Moves are emitted FACETED (line segments) — the verifier checks true geometry
// against the part. Cleaning consecutive segments into CG arcs is a post-time
// concern (ir/arc-fit.js), applied after verification within a bounded tol.
//
// Entry modes:
//   'plunge' — vertical Z plunge at the start of each depth pass (default).
//   'ramp'   — a continuous descending spiral down the contour (for a circular
//              bore this IS a helix). The tool never plunges straight in: it
//              ramps down at a bounded angle, one stepover of Z per loop, then a
//              flat finish loop cleans the bottom. Far gentler on the tool.

import { insetRegion, fromClipper, generateDepths, signedArea } from './pocket.js';

const ringPerimeter = (ring) => {
  let L = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; L += Math.hypot(b.x - a.x, b.y - a.y); }
  return L;
};

// Vertical-plunge depth passes (the classic profile entry).
function plungePasses(moves, ring, depths, safeZ) {
  const start = ring[0];
  for (const depth of depths) {
    moves.push({ type: 'rapid', x: start.x, y: start.y }); // position at safeZ
    moves.push({ type: 'linear', z: -depth });             // plunge (Z-only)
    for (let i = 1; i < ring.length; i++) moves.push({ type: 'linear', x: ring[i].x, y: ring[i].y });
    moves.push({ type: 'linear', x: start.x, y: start.y }); // close the contour
    moves.push({ type: 'rapid', z: safeZ });                // retract between passes
  }
}

// Continuous descending spiral down the contour (helical for a circular bore).
function rampDescend(moves, ring, totalDepth, depthPerPass, safeZ, rampDeg) {
  const P = ringPerimeter(ring);
  if (P < 1e-6) return;
  // descend no more than a stepover per loop AND no steeper than rampDeg
  const pitch = Math.min(depthPerPass, Math.max(1e-4, P * Math.tan((rampDeg * Math.PI) / 180)));
  const loops = Math.max(1, Math.ceil(totalDepth / pitch));
  const descentLen = loops * P;
  const start = ring[0];
  moves.push({ type: 'rapid', x: start.x, y: start.y });
  moves.push({ type: 'rapid', z: 0 }); // down to the stock top (not yet cutting)

  let acc = 0, prev = start;
  for (let loop = 0; loop < loops; loop++) {
    for (let i = 1; i <= ring.length; i++) {
      const p = ring[i % ring.length];
      acc += Math.hypot(p.x - prev.x, p.y - prev.y);
      moves.push({ type: 'linear', x: p.x, y: p.y, z: -totalDepth * (acc / descentLen) }); // 3D ramp move
      prev = p;
    }
  }
  // flat finish loop at full depth — z omitted (sticky at -totalDepth) so the
  // post can arc-fit it back to a clean CG circle.
  for (let i = 1; i <= ring.length; i++) { const p = ring[i % ring.length]; moves.push({ type: 'linear', x: p.x, y: p.y }); }
  moves.push({ type: 'rapid', z: safeZ });
}

// ------------------------------------------------------------- 3D tabs
//
// A tab is a short stretch of the profile where the final pass(es) ramp up
// to a peak and straight back down, leaving a bridge with a TRIANGULAR
// cross-section that keeps the cut piece attached to the sheet — for when
// vacuum alone can't hold it (no vacuum table, or the piece is too small).
// Triangular tabs break out by hand and dress off with a roundover bit on
// a router table, so the bias is MANY SMALL tabs over a few big ones.
//
// Placement rules (shop practice): stay away from concave profile features
// — corners are hard to reach for cleanup (weighted 3x) — and prefer
// straight or gently curving open stretches; guarantee a tab roughly at
// each cardinal point (N, E, S, W) of the ring so the piece is supported
// all around, then fill to the spacing target on the best-scoring spots.

// cumulative arc length per vertex of a closed ring
function arcTable(ring) {
  const cum = [0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { ring, cum, P: cum[ring.length] };
}

function pointAtArc(t, s) {
  const n = t.ring.length;
  const ss = ((s % t.P) + t.P) % t.P;
  let lo = 0, hi = n;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (t.cum[mid] <= ss) lo = mid; else hi = mid; }
  const a = t.ring[lo], b = t.ring[(lo + 1) % n];
  const seg = t.cum[lo + 1] - t.cum[lo];
  const f = seg > 1e-12 ? (ss - t.cum[lo]) / seg : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// sorted arc positions of the tab centers, or [] when the ring is too small
function placeTabs(ring, t, { length, spacing, minCount }) {
  const P = t.P;
  if (P < 4 * length) return [];
  const n = ring.length;
  const target = Math.max(minCount, Math.round(P / spacing));
  const orient = signedArea(ring) >= 0 ? 1 : -1;

  // every vertex is a potential corner: weight by how sharply the profile
  // turns there, concave (material-side) corners 3x — those are the ones a
  // roundover bit can't reach into
  const corners = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const turn = Math.atan2((v1x * v2y - v1y * v2x) / (l1 * l2),
      (v1x * v2x + v1y * v2y) / (l1 * l2)) * orient;
    corners.push({ s: t.cum[i], w: Math.abs(turn) * (turn < 0 ? 3 : 1) });
  }

  const circDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, P - d); };
  // score = total weighted turning within the cleanup window (tab base plus
  // roundover-bit access on both sides); low score = straight open stretch
  const W = length + 1.0;
  const step = Math.min(0.25, P / 64);
  const cds = [];
  for (let s = 0; s < P; s += step) {
    let score = 0;
    for (const c of corners) if (circDist(c.s, s) < W / 2) score += c.w;
    cds.push({ s, score });
  }

  const chosen = [];
  const gap = Math.max(1.0, Math.min(spacing / 2, P / (2 * target)));
  const take = cand => {
    if (cand && chosen.every(s => circDist(s, cand.s) >= gap)) chosen.push(cand.s);
  };
  // cardinal anchors first: the ring's N/E/S/W extremes each get the best
  // spot within an eighth of the perimeter
  const anchors = [
    ring.reduce((m, p, i) => (p.y > ring[m].y ? i : m), 0),
    ring.reduce((m, p, i) => (p.x > ring[m].x ? i : m), 0),
    ring.reduce((m, p, i) => (p.y < ring[m].y ? i : m), 0),
    ring.reduce((m, p, i) => (p.x < ring[m].x ? i : m), 0),
  ].map(i => t.cum[i]);
  for (const a of anchors) {
    const near = cds.filter(c => circDist(c.s, a) <= P / 8)
      .sort((x, y) => x.score - y.score || circDist(x.s, a) - circDist(y.s, a));
    take(near[0]);
  }
  // fill to the spacing target on the remaining best-scoring spots
  for (const c of [...cds].sort((x, y) => x.score - y.score)) {
    if (chosen.length >= target) break;
    take(c);
  }
  return chosen.sort((a, b) => a - b);
}

// one depth pass with triangular Z bumps over the tabs. The plunge lands in
// the middle of the largest tab-free span, never on a tab.
function tabbedPass(moves, t, zPass, zPeak, tabs, halfLen, safeZ) {
  const P = t.P;
  let s0 = 0, span = -1;
  for (let i = 0; i < tabs.length; i++) {
    const a = tabs[i];
    const b = i + 1 === tabs.length ? tabs[0] + P : tabs[i + 1];
    if (b - a > span) { span = b - a; s0 = ((a + b) / 2) % P; }
  }
  const zAt = s => {
    for (const sc of tabs) {
      const d = Math.min(Math.abs(s - sc), P - Math.abs(s - sc));
      if (d < halfLen) return zPass + (1 - d / halfLen) * (zPeak - zPass);
    }
    return zPass;
  };
  // breakpoints: ring vertices plus each tab's ramp knots, walked from s0
  const knots = new Set([0]);
  for (const c of t.cum) knots.add((((c - s0) % P) + P) % P);
  for (const sc of tabs) {
    for (const s of [sc - halfLen, sc, sc + halfLen]) knots.add((((s - s0) % P) + P) % P);
  }
  const order = [...knots].sort((a, b) => a - b);
  const start = pointAtArc(t, s0);
  moves.push({ type: 'rapid', x: start.x, y: start.y }); // position at safeZ
  moves.push({ type: 'linear', z: zPass });              // plunge (Z-only)
  let zCur = zPass;
  for (let k = 1; k <= order.length; k++) {
    const s = (s0 + (k === order.length ? P : order[k])) % P;
    const p = pointAtArc(t, s);
    const z = zAt(s);
    const m = { type: 'linear', x: p.x, y: p.y };
    // z only on the ramps — flat stretches stay sticky-Z so the post can
    // still arc-fit them
    if (Math.abs(z - zCur) > 1e-9) { m.z = z; zCur = z; }
    moves.push(m);
  }
  moves.push({ type: 'rapid', z: safeZ });
}

/**
 * @param {{outer, holes?}} region   part region (in)
 * @param {{diameter:number}} tool
 * @param {{ side?:'outside'|'inside'|'on', totalDepth:number, depthPerPass:number,
 *           safeZ:number, entry?:'plunge'|'ramp', rampDeg?:number,
 *           tabs?:{height?:number, length?:number, spacing?:number, minCount?:number}|null }} params
 * @returns {{ moves:Array, rings:Array, depths:number[], warnings:string[], tabs:Array<{x,y}> }}
 */
export function generateProfile(region, tool, params) {
  const { side = 'outside', totalDepth, depthPerPass, safeZ, entry = 'plunge', rampDeg = 15, tabs = null } = params;
  const R = tool.diameter / 2;
  // insetRegion(region, d, R): d>0 shrinks inward, d<0 grows outward.
  const d = side === 'inside' ? R : side === 'outside' ? -R : 0;
  // A profile follows the OUTER boundary only — interior holes are their own ops.
  const rings = insetRegion({ outer: region.outer }, d, R).map(fromClipper).filter((r) => r.length >= 3);

  const warnings = [];
  if (!rings.length) {
    warnings.push(`profile produced no contour — part too small for a ${tool.diameter}" tool?`);
    return { moves: [], rings, depths: [], warnings, tabs: [] };
  }

  // tab defaults: many small tabs — hand-snappable, roundover-dressable.
  // length ≥ 2 x height keeps the ramps at or under 45°.
  let tabOpts = null;
  if (tabs) {
    const height = Math.min(tabs.height ?? 0.08, totalDepth / 2);
    tabOpts = {
      height,
      length: Math.max(tabs.length ?? 0.3, 2 * height),
      spacing: tabs.spacing ?? 6,
      minCount: tabs.minCount ?? 4,
    };
  }

  const depths = generateDepths(totalDepth, depthPerPass);
  const moves = [];
  const tabPoints = [];
  for (const ring of rings) {
    let ringTabs = [];
    let table = null;
    if (tabOpts) {
      table = arcTable(ring);
      ringTabs = placeTabs(ring, table, tabOpts);
      if (!ringTabs.length) warnings.push('profile ring too small for tabs — cut without');
      else if (entry === 'ramp') warnings.push('tabs use plunge passes — ramp entry ignored');
    }
    if (ringTabs.length) {
      tabPoints.push(...ringTabs.map(s => pointAtArc(table, s)));
      const zPeak = -(totalDepth - tabOpts.height);
      // passes at/above the tab peak don't feel the tabs at all
      const shallow = depths.filter(dep => -dep >= zPeak - 1e-9);
      if (shallow.length) plungePasses(moves, ring, shallow, safeZ);
      for (const dep of depths.filter(dep => -dep < zPeak - 1e-9)) {
        tabbedPass(moves, table, -dep, zPeak, ringTabs, tabOpts.length / 2, safeZ);
      }
    } else if (entry === 'ramp') {
      rampDescend(moves, ring, totalDepth, depthPerPass, safeZ, rampDeg);
    } else {
      plungePasses(moves, ring, depths, safeZ);
    }
  }
  return { moves, rings, depths, warnings, tabs: tabPoints };
}
