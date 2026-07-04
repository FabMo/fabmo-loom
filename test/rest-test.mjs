// Rest-machining validation — measured, adversarial, independent.
//
// strategies/rest.js claims: after a bulk bit, a rest bit cuts ONLY the
// missed blobs, gouge-free, and the union of the two swept footprints
// equals what the small bit could reach alone — at a fraction of the
// cutting length. Checks:
//
//   blobs      a rectangle's four sharp corners are four disjoint rest
//              regions; a fully-covered region yields none
//   gouge      every rest tool-center vertex lies inside the real region's
//              R-inset (checked against Clipper directly, not the
//              generator's own machinery)
//   coverage   area(reach(small) − (swept(bulk) ∪ swept(rest))) ≈ 0
//   economy    rest cutting length << full small-bit recut length
//   compose    bulk + rest ops verify as a Job (rest declares allowOverlap
//              for the blend band; its region target still protects)
//
// Usage: node test/rest-test.mjs

import ClipperLib from '../vendor/clipper.js';
import { generatePocket, insetRegion, regionToPaths, toClipper, SCALE } from '../strategies/pocket.js';
import { reachablePaths, pickChain, coverageCurve, regionArea, KNEE_DEFAULTS } from '../strategies/tool-select.js';
import { restRegions, generateRestPocket } from '../strategies/rest.js';
import { composeJob } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

const rect = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
const pathsArea = paths => paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);
const union = (a, b) => {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
};
const difference = (a, b) => {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
};
const sweptOf = r => r.target.rings.map(toClipper);
const cutXY = moves => {
  let x = 0, y = 0, len = 0, started = false;
  for (const m of moves) {
    if (m.type !== 'linear' && m.type !== 'rapid') continue;
    const nx = m.x ?? x, ny = m.y ?? y;
    if (m.type === 'linear' && started) len += Math.hypot(nx - x, ny - y);
    x = nx; y = ny; started = true;
  }
  return len;
};
// independent containment: vertex inside any of the given clipper paths
// (nonzero: outers minus holes handled by winding accumulation)
const insideInset = (moves, insetPaths) => {
  let bad = 0;
  for (const m of moves) {
    if (m.type !== 'linear' || m.x === undefined) continue;
    const pt = { X: Math.round(m.x * SCALE), Y: Math.round(m.y * SCALE) };
    let winding = 0;
    for (const p of insetPaths) {
      const pip = ClipperLib.Clipper.PointInPolygon(pt, p);
      if (pip === -1) { winding = 1; break; } // on boundary: legal
      if (pip === 1) winding += ClipperLib.Clipper.Orientation(p) ? 1 : -1;
    }
    if (winding === 0) bad++;
  }
  return bad;
};

const BULK = 0.25, REST = 0.125;
const PARAMS = { stepoverPct: 40, totalDepth: 0.4, depthPerPass: 0.125, safeZ: 0.5, feedRate: 100, plungeRate: 30 };

// ------------------------------------------------ rectangle: four corners

console.log('=== rest machining: 2x1.5 rectangle, 1/4" bulk → 1/8" rest ===\n');
{
  const region = { outer: rect(0, 0, 2, 1.5) };

  const blobs = restRegions(region, BULK, REST);
  if (blobs.length === 4) pass('four corner blobs');
  else fail(`expected 4 corner blobs, got ${blobs.length}`);

  const bulk = generatePocket(region, { diameter: BULK }, PARAMS);
  const restR = generateRestPocket(region, BULK, { diameter: REST }, PARAMS);
  if (restR.moves.length > 0) pass(`rest pass emits moves (${restR.moves.length})`);
  else fail('rest pass emitted nothing');

  // gouge: rest centers confined to the region's own R-inset (allow the
  // inset's arc tolerance as slack)
  const allowed = insetRegion(region, REST / 2 - 0.002, REST / 2);
  const bad = insideInset(restR.moves, allowed);
  if (bad === 0) pass('all rest tool-center vertices inside the R-inset (gouge-free)');
  else fail(`${bad} rest vertices outside the R-inset`);

  // coverage: bulk ∪ rest ≡ what the small bit could reach alone
  const reachSmall = reachablePaths(region, REST);
  const combined = union(sweptOf(bulk), sweptOf(restR));
  const missed = pathsArea(difference(reachSmall, combined));
  if (missed < 1e-3) pass(`combined sweep covers reach(1/8) (missed ${missed.toFixed(5)} sq in)`);
  else fail(`combined sweep misses ${missed.toFixed(4)} sq in of reach(1/8)`);

  // economy: rest cutting is a fraction of recutting the pocket with the 1/8
  const recut = generatePocket(region, { diameter: REST }, PARAMS);
  const restLen = cutXY(restR.moves), recutLen = cutXY(recut.moves);
  if (restLen < 0.35 * recutLen) pass(`rest cuts ${restLen.toFixed(1)}" vs ${recutLen.toFixed(1)}" full recut (${Math.round(100 * restLen / recutLen)}%)`);
  else fail(`rest pass not economical: ${restLen.toFixed(1)}" vs recut ${recutLen.toFixed(1)}"`);

  // compose + verify: the pair passes the admission gate
  const job = {
    units: 'in',
    stock: { w: 2, h: 1.5, thickness: 0.75 },
    safeZ: PARAMS.safeZ, spindleSpeed: 18000,
    tools: {
      1: { name: '1/4" endmill', diameter: BULK, kind: 'flat' },
      3: { name: '1/8" endmill', diameter: REST, kind: 'flat' },
    },
    operations: [
      { name: 'bulk pocket', tool: 1, feedRate: 100, plungeRate: 30, moves: bulk.moves, target: bulk.target },
      { name: 'rest corners', tool: 3, feedRate: 100, plungeRate: 30, moves: restR.moves, target: restR.target, allowOverlap: true },
    ],
  };
  const report = verifyJob(job, composeJob(job));
  if (report.errors.length === 0) pass(`bulk+rest job verifies (${report.stats.toolchangeCount} toolchanges)`);
  else fail(`verify errors: ${report.errors.join('; ')}`);
}

// ------------------------------------- L-shape: concave inner corner too

console.log('\n=== rest machining: L-shape (concave corner) ===\n');
{
  const region = { outer: [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0.8 },
    { x: 0.8, y: 0.8 }, { x: 0.8, y: 2 }, { x: 0, y: 2 },
  ] };
  const blobs = restRegions(region, BULK, REST);
  // 5 sharp convex corners + the concave elbow fillet = at least 5 blobs
  // (adjacent ones may merge depending on the geometry)
  if (blobs.length >= 5) pass(`${blobs.length} rest blobs on the L`);
  else fail(`expected ≥5 rest blobs, got ${blobs.length}`);

  const bulk = generatePocket(region, { diameter: BULK }, PARAMS);
  const restR = generateRestPocket(region, BULK, { diameter: REST }, PARAMS);
  const reachSmall = reachablePaths(region, REST);
  const missed = pathsArea(difference(reachSmall, union(sweptOf(bulk), sweptOf(restR))));
  if (missed < 1e-3) pass(`combined sweep covers reach(1/8) (missed ${missed.toFixed(5)} sq in)`);
  else fail(`combined sweep misses ${missed.toFixed(4)} sq in`);

  const allowed = insetRegion(region, REST / 2 - 0.002, REST / 2);
  const bad = insideInset(restR.moves, allowed);
  if (bad === 0) pass('rest centers gouge-free on the L');
  else fail(`${bad} rest vertices outside the R-inset`);
}

// ------------------------------------------------- no rest when unneeded

console.log('\n=== degenerate cases ===\n');
{
  // circle: the bulk bit reaches everything a smaller one could (walls are
  // convex everywhere) — no rest blobs at all
  const circle = { outer: Array.from({ length: 96 }, (_, i) => ({
    x: 1 + 0.75 * Math.cos(2 * Math.PI * i / 96),
    y: 1 + 0.75 * Math.sin(2 * Math.PI * i / 96),
  })) };
  const blobs = restRegions(circle, BULK, REST);
  if (blobs.length === 0) pass('circle: no rest blobs (bulk reaches everything)');
  else fail(`circle: expected 0 blobs, got ${blobs.length}`);

  const r = generateRestPocket(circle, BULK, { diameter: REST }, PARAMS);
  if (r.moves.length === 0 && r.target === null) pass('circle: rest op empty, no target');
  else fail(`circle: expected empty rest op, got ${r.moves.length} moves`);
}

// ------------------------------------------------------- pickChain rules

console.log('\n=== pickChain: bulk + rest sequencing ===\n');
{
  const region = { outer: rect(0, 0, 2, 1.5) };
  const area = regionArea(region);
  // 1/16 declares reach 0.5 — the default 4x-diameter rule would depth-
  // exclude it at 0.4 deep and mask the threshold arithmetic under test
  const bits = [{ diameter: 0.25 }, { diameter: 0.125 }, { diameter: 0.0625, maxDepth: 0.5 }];
  const curve = coverageCurve(region, 0.4, bits);
  const chain = pickChain(curve, area);
  if (chain.length >= 2 && curve[chain[0]].diameter === 0.25 && curve[chain[1]].diameter === 0.125) {
    pass(`chain: 1/4 bulk + 1/8 rest (${chain.map(i => curve[i].diameter).join(', ')})`);
  } else {
    fail(`unexpected chain: ${chain.map(i => curve[i].diameter).join(', ')}`);
  }
  // the 1/16 after the 1/8 gains 4 corners x ~0.0025 sq in ≈ 0.010 — for a
  // rectangle this SHOULD still be over the default rest threshold; assert
  // whatever the geometry says matches the threshold arithmetic
  const gain16 = (curve[2].frac - curve[1].frac) * area;
  const expect16 = gain16 >= KNEE_DEFAULTS.restMinGainArea;
  if ((chain.length === 3) === expect16) pass(`1/16 rest ${expect16 ? 'joins' : 'skipped'} per threshold (marginal ${gain16.toFixed(4)} sq in)`);
  else fail(`chain length ${chain.length} disagrees with threshold arithmetic (marginal ${gain16.toFixed(4)})`);

  // vetoed rest bit is skipped, chain continues to the next
  const vetoed = curve.map(e => e.diameter === 0.125 ? { ...e, excluded: 'vetoed' } : e);
  const chain2 = pickChain(vetoed, area);
  if (!chain2.some(i => vetoed[i].diameter === 0.125)) pass('vetoed 1/8 skipped in chain');
  else fail('vetoed bit appeared in chain');

  // depth-excluded bit never chains
  const curve2 = coverageCurve(region, 0.4, [{ diameter: 0.25 }, { diameter: 0.0625, maxDepth: 0.2 }]);
  const chain3 = pickChain(curve2, area);
  if (chain3.every(i => curve2[i].diameter === 0.25)) pass('depth-excluded 1/16 never chains');
  else fail(`depth-excluded bit chained: ${chain3.map(i => curve2[i].diameter).join(', ')}`);
}

console.log(failures === 0 ? '\nALL REST-MACHINING CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
