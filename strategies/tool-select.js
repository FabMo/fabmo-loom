// Tool selection — which bit machines which feature, and when a smaller
// one earns its toolchange.
//
// For a candidate bit, the machinable footprint of a region is its
// morphological OPENING: inset by the bit radius (where the tool center may
// go), then dilate back by the radius (what the periphery sweeps). The
// fraction of the region's area that opening covers is the bit's COVERAGE
// of the feature. Coverage across a bit library, largest to smallest, is a
// monotone curve — e.g. a part whose narrow ring reads
//   1/4": 0%   1/8": 25%   1/16": 85%   1/32": 95%
// should be cut with the 1/16: the knee of the curve, where going smaller
// stops paying for itself. pickKnee encodes that: walk the curve from the
// largest bit and accept a smaller one only while the marginal coverage
// gain clears a relative OR absolute threshold. A sharp corner's last few
// thousandths of a square inch never justify pulling out the 1/64.
//
// Coverage honors the same SLOT_GRAZE as generatePocket: a groove nominally
// AT the bit width counts as reachable (centerline slot pass).

import ClipperLib from '../vendor/clipper.js';
import { insetRegion, regionToPaths, fromClipper, SCALE, SLOT_GRAZE } from './pocket.js';

const ARC_TOL = 0.0005 * SCALE;

// Marginal-gain thresholds for going one bit smaller: accept when the extra
// coverage is at least MIN_GAIN_FRAC of the feature area OR at least
// MIN_GAIN_AREA square units outright (a big pocket's 5% is still real
// material). Stop entirely once coverage reaches DONE_AT. A bit with no
// declared max cutting depth is assumed good for DEPTH_RATIO x diameter.
export const KNEE_DEFAULTS = {
  minGainFrac: 0.15,
  minGainArea: 0.10,
  doneAt: 0.98,
  depthRatio: 4,
  // rest-pass economics differ from reassignment: a rest bit only cuts
  // what the bulk bit missed, so the cost is a toolchange + a few corner
  // blobs, not a full recut. Any marginal area at least this big earns the
  // pass — ~3 sharp corners left by a 1/4" bit. doneAt does NOT stop a
  // chain: 99.5% coverage of a big pocket still has visibly round corners.
  restMinGainArea: 0.008,
};

const pathsArea = paths =>
  paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);

// area of the region proper (outer minus holes), no open-edge spillover
export function regionArea(region) {
  return pathsArea(regionToPaths(region, 0));
}

/**
 * The footprint a flat bit of `diameter` can machine inside `region`
 * (polygon-with-holes + edgeTypes, as generatePocket takes it), measured
 * against the region proper. Returns clipper-free rings.
 */
export function reachablePaths(region, diameter) {
  const R = diameter / 2;
  let inset = insetRegion(region, R, R);
  if (!inset.length) inset = insetRegion(region, R - SLOT_GRAZE, R);
  if (!inset.length) return [];
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL);
  co.AddPaths(inset, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const swept = new ClipperLib.Paths();
  co.Execute(swept, R * SCALE);
  const c = new ClipperLib.Clipper();
  c.AddPaths(swept, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(regionToPaths(region, 0), ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctIntersection, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.Clipper.CleanPolygons(out, ARC_TOL).filter(p => p.length >= 3);
}

/**
 * Coverage of one feature across a bit library.
 *
 * bits: [{ diameter, maxDepth? }] — any order; evaluated largest-first.
 * Returns [{ diameter, maxDepth, frac, area, excluded? }] sorted by
 * descending diameter. excluded: 'depth' when the bit can't cut this deep
 * (maxDepth defaults to depthRatio x diameter).
 */
export function coverageCurve(region, depth, bits, opts = {}) {
  const o = { ...KNEE_DEFAULTS, ...opts };
  const total = regionArea(region);
  return [...bits]
    .sort((a, b) => b.diameter - a.diameter)
    .map(bit => {
      const maxDepth = bit.maxDepth ?? o.depthRatio * bit.diameter;
      if (depth > maxDepth + 1e-9) {
        return { diameter: bit.diameter, maxDepth, frac: 0, area: 0, excluded: 'depth' };
      }
      const area = total > 0 ? pathsArea(reachablePaths(region, bit.diameter)) : 0;
      return {
        diameter: bit.diameter, maxDepth,
        frac: total > 0 ? Math.min(1, area / total) : 0,
        area,
      };
    });
}

/**
 * The knee of a coverage curve: index of the bit worth using, or -1 when
 * no bit earns a cut at all. Entries with `excluded` set are skipped —
 * callers can pre-mark vetoed bits (e.g. 'vetoed') the same way depth
 * exclusion does.
 */
export function pickKnee(curve, areaTotal, opts = {}) {
  const o = { ...KNEE_DEFAULTS, ...opts };
  const earns = gainFrac =>
    gainFrac >= o.minGainFrac || gainFrac * areaTotal >= o.minGainArea;
  let cur = -1;
  for (let i = 0; i < curve.length; i++) {
    const c = curve[i];
    if (c.excluded) continue;
    if (cur >= 0 && curve[cur].frac >= o.doneAt) break;
    const gain = c.frac - (cur >= 0 ? curve[cur].frac : 0);
    if (earns(gain)) cur = i;
  }
  return cur;
}

/**
 * Rest-machining chain: indices of the bits worth using IN SEQUENCE, or []
 * when nothing earns a cut. The first (bulk) bit is picked by the same
 * earns() rule as pickKnee — the largest bit whose coverage clears the
 * thresholds. Each SUBSEQUENT bit is a rest pass: it cuts only its marginal
 * area (reachable(it) − reachable(previous)), so it joins the chain on the
 * cheaper restMinGainArea threshold alone. Monotonicity (a smaller bit
 * reaches a superset) makes each bit's rest region exactly the difference
 * against the bit before it in the chain.
 */
export function pickChain(curve, areaTotal, opts = {}) {
  const o = { ...KNEE_DEFAULTS, ...opts };
  const chain = [];
  let covered = 0;
  for (let i = 0; i < curve.length; i++) {
    const c = curve[i];
    if (c.excluded) continue;
    const gain = c.frac - covered;
    const earns = chain.length === 0
      ? (gain >= o.minGainFrac || gain * areaTotal >= o.minGainArea)
      : gain * areaTotal >= o.restMinGainArea;
    if (earns) { chain.push(i); covered = c.frac; }
  }
  return chain;
}

// 0.125 → '1/8"' — bits are named the way the shop talks about them
export function formatDiameter(d) {
  if (Number.isInteger(d)) return `${d}"`;
  for (const den of [2, 4, 8, 16, 32, 64]) {
    const num = d * den;
    if (Math.abs(num - Math.round(num)) < 1e-6 && Math.round(num) >= 1) {
      return `${Math.round(num)}/${den}"`;
    }
  }
  return `${d}"`;
}

export { fromClipper };
