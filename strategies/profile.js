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

import { insetRegion, fromClipper, generateDepths } from './pocket.js';

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

/**
 * @param {{outer, holes?}} region   part region (in)
 * @param {{diameter:number}} tool
 * @param {{ side?:'outside'|'inside'|'on', totalDepth:number, depthPerPass:number,
 *           safeZ:number, entry?:'plunge'|'ramp', rampDeg?:number }} params
 * @returns {{ moves:Array, rings:Array, depths:number[], warnings:string[] }}
 */
export function generateProfile(region, tool, params) {
  const { side = 'outside', totalDepth, depthPerPass, safeZ, entry = 'plunge', rampDeg = 15 } = params;
  const R = tool.diameter / 2;
  // insetRegion(region, d, R): d>0 shrinks inward, d<0 grows outward.
  const d = side === 'inside' ? R : side === 'outside' ? -R : 0;
  // A profile follows the OUTER boundary only — interior holes are their own ops.
  const rings = insetRegion({ outer: region.outer }, d, R).map(fromClipper).filter((r) => r.length >= 3);

  const warnings = [];
  if (!rings.length) {
    warnings.push(`profile produced no contour — part too small for a ${tool.diameter}" tool?`);
    return { moves: [], rings, depths: [], warnings };
  }

  const depths = generateDepths(totalDepth, depthPerPass);
  const moves = [];
  for (const ring of rings) {
    if (entry === 'ramp') rampDescend(moves, ring, totalDepth, depthPerPass, safeZ, rampDeg);
    else plungePasses(moves, ring, depths, safeZ);
  }
  return { moves, rings, depths, warnings };
}
