// Rest machining — after a big bit clears the bulk of a pocket, a smaller
// bit returns for ONLY what the big one couldn't reach (sharp corners,
// narrow necks) instead of recutting the whole pocket.
//
// Geometry, per rest bit of radius R after a previous bit:
//   prev  = reachablePaths(region, prevDiameter)    what's already swept
//   own   = reachablePaths(region, diameter)        what this bit could sweep
//   rest  = own − prev                              what it should ADD
//   need  = dilate(rest, R) ∩ insetRegion(region, R)   centers that reach it
//   synth = dilate(need, R)         a synthetic region whose R-inset is need
//
// generatePocket(synth) then contour-parallel fills the center space with
// all its usual machinery — depth passes, stay-down links, swept-footprint
// target — for free. Gouge-safety is by construction: need ⊆ the real
// region's R-inset, so synth ⊆ the region's closing under R and every
// center the generator derives stays legal. The swept flank blends up to
// one radius into the already-cleared floor (the op declares allowOverlap;
// its region target remains the real protection).
//
// Chains are exact by monotonicity: reachable(smaller) ⊇ reachable(bigger),
// so in 3/8 → 1/8 → 1/16 each bit's rest is the difference against the bit
// immediately before it — the union over the chain equals what the last
// bit could reach alone, at a fraction of the cutting.

import ClipperLib from '../vendor/clipper.js';
import { generatePocket, insetRegion, fromClipper, SCALE } from './pocket.js';
import { reachablePaths } from './tool-select.js';

const ARC_TOL = 0.0005 * SCALE;

const offset = (paths, delta) => {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return ClipperLib.Clipper.CleanPolygons(out, ARC_TOL).filter(p => p.length >= 3);
};

const boolOp = (type, subject, clip) => {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(type, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.Clipper.CleanPolygons(out, ARC_TOL).filter(p => p.length >= 3);
};

// clipper paths → [{outer, holes}] regions in {x,y}, holes attached to the
// outer that contains them
function pathsToRegions(paths) {
  const outers = paths.filter(p => ClipperLib.Clipper.Orientation(p));
  const holes = paths.filter(p => !ClipperLib.Clipper.Orientation(p));
  return outers.map(o => ({
    outer: fromClipper(o),
    holes: holes
      .filter(h => ClipperLib.Clipper.PointInPolygon(h[0], o) === 1)
      .map(fromClipper),
  }));
}

/**
 * The synthetic regions a rest bit should pocket: one per disjoint blob of
 * missed material it can actually reach. Empty when the previous bit
 * already covered everything this one could.
 */
// hairline-trim for the own−prev difference: along straight walls both
// sweeps land on the wall only to Clipper's arc/clean tolerance, leaving
// sub-thou threads that topologically CONNECT the real corner blobs — the
// dilation would then merge them into a full-wall strip and the rest pass
// would recut the entire wall. An opening (erode + re-dilate) this wide
// severs the threads; a real blob is (Rprev − R) across and survives.
const TRIM = 0.002;

export function restRegions(region, prevDiameter, diameter) {
  const R = diameter / 2;
  const own = reachablePaths(region, diameter);
  if (!own.length) return [];
  const prev = reachablePaths(region, prevDiameter);
  let rest = prev.length ? boolOp(ClipperLib.ClipType.ctDifference, own, prev) : own;
  if (prev.length && rest.length) rest = offset(offset(rest, -TRIM), TRIM);
  if (!rest.length) return [];
  const allowed = insetRegion(region, R, R);
  if (!allowed.length) return [];
  const need = boolOp(ClipperLib.ClipType.ctIntersection, offset(rest, R), allowed);
  if (!need.length) return [];
  return pathsToRegions(offset(need, R));
}

/**
 * generateRestPocket(region, prevDiameter, tool, params)
 *
 * Same tool/params contract as generatePocket. Returns { moves, warnings,
 * target, stats } — moves conform to the op contract (first move rapid XY,
 * explicit retracts between blobs: corner blobs are disjoint, a stay-down
 * link between them would drag through the wall between).
 */
export function generateRestPocket(region, prevDiameter, tool, params) {
  const regions = restRegions(region, prevDiameter, tool.diameter);
  const moves = [];
  const warnings = [];
  const rings = [];
  let blobs = 0;

  for (const r of regions) {
    const g = generatePocket(r, tool, { ...params, minRingArea: 0, slotSwapRatio: Infinity });
    if (!g.moves.length) continue;
    if (moves.length) moves.push({ type: 'rapid', z: params.safeZ });
    moves.push(...g.moves);
    warnings.push(...g.warnings);
    if (g.target) rings.push(...g.target.rings);
    blobs++;
  }

  return {
    moves,
    warnings,
    target: rings.length ? { type: 'region', rings, depth: params.totalDepth } : null,
    stats: { blobs, regions: regions.length },
  };
}
