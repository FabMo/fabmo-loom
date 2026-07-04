// Surface-raster validation — measured, independent, adversarial.
//
// strategies/surface-raster.js claims: ballnose-compensated raster over a
// heightmap, gouge-free, mask-respecting, depth-capped, finish within
// scallop theory. Every claim is checked by a DIFFERENT code path than the
// generator: the gouge check brute-force scans the raw height grid (no
// shared kernel code), finish quality is judged against the REACHABLE
// surface (morphological closing of the heightmap by the ball, restricted
// to the mask) so walls, rims, and corner fillets are physics, not failures.
//
//   gouge     at every motion vertex (cuts, plunges, links), the ball at
//             (x, y, ztip) must not penetrate any grid sample within R.
//             Hard-fail. Mid-segment penetration is also sampled; asserted
//             for smooth surfaces, reported for cliff/rim geometry where
//             chordal error at a near-vertical face is grid-resolution
//             physics, not a generator bug.
//   scallop   every machinable cell must be finished to within theoretical
//             scallop * slope factor * 1.5 + tol of the REACHABLE surface.
//             Catches missed regions and systematically-high paths.
//   mask      no cutting vertex outside the mask (boundary counts inside).
//   depth     within pass k no vertex below the pass floor (parsed from
//             the generator's pass comments).
//
// Capped by the hybrid composition: endmill pocket op + ballnose surface op
// on shared stock -> composeJob -> verifyJob (toolchange, disjoint
// footprints) -> SBP, plus a sabotage case the verifier must reject.
//
// Usage: node test/surface-raster-test.mjs

import { generateSurfaceRaster } from '../strategies/surface-raster.js';
import { generatePocket } from '../strategies/pocket.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

const TOOL = { diameter: 0.25 };
const R = TOOL.diameter / 2;
const PARAMS = { stepoverPct: 40, depthPerPass: 0.15, safeZ: 0.25, feedRate: 80, plungeRate: 25 };
const STEPOVER = TOOL.diameter * (PARAMS.stepoverPct / 100);
const SCALLOP = R - Math.sqrt(R * R - (STEPOVER / 2) ** 2); // theoretical cusp height
const SP = 0.02; // grid spacing — R/SP = 6.25 cells per tool radius

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

// ------------------------------------------------------------- surfaces

function makeHeightmap(fn, x0, y0, w, h, spacing) {
  const cols = Math.round(w / spacing) + 1;
  const rows = Math.round(h / spacing) + 1;
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = fn(x0 + c * spacing, y0 + r * spacing);
    }
  }
  return { heights, cols, rows, dx: spacing, dy: spacing, originX: x0, originY: y0 };
}

const rect = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
const circleRing = (cx, cy, r, n = 64) =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) }));

const SURFACES = [
  { name: 'sloped plane', fn: (x, y) => -0.05 - 0.06 * x - 0.02 * y, smooth: true },
  {
    name: 'gaussian bump in valley',
    fn: (x, y) => -0.4 + 0.35 * Math.exp(-((x - 2) ** 2 + (y - 2) ** 2) / (2 * 0.8 * 0.8)),
    smooth: true,
  },
  { name: 'crossed waves', fn: (x, y) => -0.25 + 0.08 * Math.sin(2.2 * x) * Math.cos(1.8 * y), smooth: true },
  {
    name: 'hemisphere boss',
    fn: (x, y) => {
      const rsq = (x - 2) ** 2 + (y - 2) ** 2;
      return -0.5 + (rsq < 0.45 * 0.45 ? Math.sqrt(0.45 * 0.45 - rsq) : 0);
    },
    smooth: false, // rim is tangent-vertical: chordal mid-segment error is resolution physics
  },
  { name: 'cliff plateau', fn: (x, y) => (x < 2 ? -0.05 : -0.45), smooth: false },
];

// ------------------------------------------------------- measurement rig

function motionVertices(moves, safeZ) {
  const verts = [];
  let pos = { x: 0, y: 0, z: safeZ };
  let floor = -Infinity;
  for (const m of moves) {
    if (m.type === 'comment') {
      const match = /floor=(-?[\d.]+)/.exec(m.text);
      if (match) floor = parseFloat(match[1]);
      continue;
    }
    const next = {
      x: m.x !== undefined ? m.x : pos.x,
      y: m.y !== undefined ? m.y : pos.y,
      z: m.z !== undefined ? m.z : pos.z,
    };
    verts.push({ ...next, prev: pos, type: m.type, floor });
    pos = next;
  }
  return verts;
}

// disc offsets within R, with the ball-bottom rise at each offset
function discOffsets(spacing) {
  const k = Math.ceil(R / spacing);
  const offs = [];
  for (let dj = -k; dj <= k; dj++) {
    for (let di = -k; di <= k; di++) {
      const dsq = (di * spacing) ** 2 + (dj * spacing) ** 2;
      if (dsq <= R * R) offs.push({ di, dj, drop: Math.sqrt(R * R - dsq) - R, rise: R - Math.sqrt(R * R - dsq) });
    }
  }
  return offs;
}
const DISC = discOffsets(SP);

// brute-force ball-vs-grid tip constraint — INDEPENDENT of buildBallKernel
function constraintAt(hm, x, y) {
  const { heights, cols, rows, dx, dy, originX, originY } = hm;
  const c0 = Math.floor((x - R - originX) / dx), c1 = Math.ceil((x + R - originX) / dx);
  const r0 = Math.floor((y - R - originY) / dy), r1 = Math.ceil((y + R - originY) / dy);
  let zmin = -Infinity;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dsq = (originX + c * dx - x) ** 2 + (originY + r * dy - y) ** 2;
      if (dsq > R * R) continue;
      const h = (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : heights[r * cols + c];
      const tip = h + Math.sqrt(R * R - dsq) - R;
      if (tip > zmin) zmin = tip;
    }
  }
  return zmin;
}

function checkSurface(name, hm, mask, smooth, result) {
  const { heights, cols, rows, dx, dy, originX, originY } = hm;
  const verts = motionVertices(result.moves, PARAMS.safeZ);

  // mask membership grid (boundary-inclusive within ~1e-7)
  const inMaskPt = (x, y) => {
    if (!mask) return true;
    let ins = false;
    for (const ring of [mask.outer, ...(mask.holes ?? [])]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if ((ring[i].y > y) !== (ring[j].y > y) &&
            x < ((ring[j].x - ring[i].x) * (y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) ins = !ins;
      }
    }
    return ins;
  };
  const inMaskTol = (x, y) =>
    inMaskPt(x, y) || inMaskPt(x - 1e-7, y) || inMaskPt(x + 1e-7, y) || inMaskPt(x, y - 1e-7) || inMaskPt(x, y + 1e-7);
  const maskGrid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      maskGrid[r * cols + c] = inMaskTol(originX + c * dx, originY + r * dy) ? 1 : 0;
    }
  }

  // constraint grid: legal tip height at every cell (independent brute force)
  const constGrid = new Float64Array(cols * rows).fill(NaN);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let zmin = -Infinity;
      for (const o of DISC) {
        const cc = c + o.di, rr = r + o.dj;
        const h = (cc < 0 || cc >= cols || rr < 0 || rr >= rows) ? 0 : heights[rr * cols + cc];
        const tip = h + o.drop;
        if (tip > zmin) zmin = tip;
      }
      constGrid[r * cols + c] = zmin;
    }
  }

  // reachable surface: lowest ball-bottom over mask-legal tip positions
  const reachAt = (r, c) => {
    let best = Infinity;
    for (const o of DISC) {
      const cc = c + o.di, rr = r + o.dj;
      if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
      if (!maskGrid[rr * cols + cc]) continue;
      const ballZ = constGrid[rr * cols + cc] + o.rise;
      if (ballZ < best) best = ballZ;
    }
    return best;
  };

  // ---- gouge at vertices (all motion: cuts, plunges, links)
  const VTOL = 1.5e-3;
  let vGouges = 0, vWorst = 0;
  for (const v of verts) {
    if (v.z >= 0) continue;
    const pen = constraintAt(hm, v.x, v.y) - v.z;
    if (pen > VTOL) { vGouges++; vWorst = Math.max(vWorst, pen); }
  }

  // ---- gouge mid-segment (sampled): chordal discretization error
  let mWorst = 0;
  for (const v of verts) {
    if (v.type !== 'linear') continue;
    const len = Math.hypot(v.x - v.prev.x, v.y - v.prev.y);
    if (len < 1e-9) continue;
    const n = Math.min(16, Math.max(2, Math.ceil(len / (SP / 2))));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const z = v.prev.z + t * (v.z - v.prev.z);
      if (z >= 0) continue;
      const pen = constraintAt(hm, v.prev.x + t * (v.x - v.prev.x), v.prev.y + t * (v.y - v.prev.y)) - z;
      if (pen > mWorst) mWorst = pen;
    }
  }

  // ---- mask containment (boundary-inclusive)
  let outside = 0;
  if (mask) {
    for (const v of verts) {
      if (v.z < -1e-6 && !inMaskTol(v.x, v.y)) outside++;
    }
  }

  // ---- depth caps
  let depthViolations = 0;
  for (const v of verts) {
    if (v.floor > -Infinity && v.z < v.floor - 1e-5) depthViolations++;
  }

  // ---- finish quality vs the REACHABLE surface
  // sample along cutting segments (decimated flat runs still count as swept)
  const cutSamples = [];
  for (const v of verts) {
    if (v.type !== 'linear') continue;
    if (v.z >= -1e-9 && v.prev.z >= -1e-9) continue;
    const len = Math.hypot(v.x - v.prev.x, v.y - v.prev.y);
    const n = Math.max(1, Math.ceil(len / SP));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      cutSamples.push({
        x: v.prev.x + t * (v.x - v.prev.x),
        y: v.prev.y + t * (v.y - v.prev.y),
        z: v.prev.z + t * (v.z - v.prev.z),
      });
    }
  }
  const byBand = new Map();
  for (const s of cutSamples) {
    const key = Math.round(s.y / STEPOVER);
    if (!byBand.has(key)) byBand.set(key, []);
    byBand.get(key).push(s);
  }

  // difficult-zone map: slopes over ~56 deg and concave fillets tighter
  // than ~4R radius, DILATED by R — a cell whose finishing tip positions
  // fall inside the difficult zone inherits its row-discretization, since
  // the ball acts at up to R distance. These regions are the strategy's
  // documented limitation (cross-raster / pencil passes), counted not
  // asserted.
  const difficult = [];
  {
    const rGrid = new Float64Array(cols * rows).fill(NaN);
    const rAt = (r, c) => {
      const i = r * cols + c;
      if (Number.isNaN(rGrid[i])) rGrid[i] = reachAt(r, c);
      return rGrid[i];
    };
    for (let r = 1; r < rows - 1; r += 2) {
      for (let c = 1; c < cols - 1; c += 2) {
        const v = rAt(r, c);
        if (!Number.isFinite(v)) continue;
        const xp = rAt(r, c + 1), xm = rAt(r, c - 1), yp = rAt(r + 1, c), ym = rAt(r - 1, c);
        if (![xp, xm, yp, ym].every(Number.isFinite)) continue;
        const grad = Math.hypot((xp - xm) / (2 * dx), (yp - ym) / (2 * dy));
        const lap = (xp + xm - 2 * v) / (dx * dx) + (yp + ym - 2 * v) / (dy * dy);
        if (grad > 1.5 || lap > 2) difficult.push({ x: originX + c * dx, y: originY + r * dy });
      }
    }
  }
  const nearDifficult = (x, y) => difficult.some(p => (p.x - x) ** 2 + (p.y - y) ** 2 <= R * R);

  let worstScallop = 0, worstExcess = -Infinity, cellsChecked = 0, uncovered = 0, steepSkipped = 0;
  const inset = R + STEPOVER;
  for (let r = 0; r < rows; r += 2) {
    const y = originY + r * dy;
    if (y < originY + inset || y > originY + (rows - 1) * dy - inset) continue;
    for (let c = 0; c < cols; c += 2) {
      const x = originX + c * dx;
      if (x < originX + inset || x > originX + (cols - 1) * dx - inset) continue;
      // assert finish only where the FULL tool disc fits in the mask — the
      // boundary band (and mask holes) are flank-finished by design and
      // belong to whichever op owns the neighboring region
      if (mask && !(inMaskTol(x, y) && inMaskTol(x - R, y) && inMaskTol(x + R, y) &&
                    inMaskTol(x, y - R) && inMaskTol(x, y + R))) continue;
      const reach = reachAt(r, c);
      if (reach === Infinity || reach > -1e-4) continue; // not machinable (stock top)
      cellsChecked++;
      let best = Infinity;
      const key = Math.round(y / STEPOVER);
      for (const k of [key - 2, key - 1, key, key + 1, key + 2]) {
        for (const s of byBand.get(k) ?? []) {
          const dsq = (s.x - x) ** 2 + (s.y - y) ** 2;
          if (dsq > R * R) continue;
          const ballZ = s.z + R - Math.sqrt(R * R - dsq);
          if (ballZ < best) best = ballZ;
        }
      }
      if (best === Infinity) { uncovered++; continue; }
      // slope factor from the reachable surface (vertical scallop inflates on slopes)
      const rxp = reachAt(r, Math.min(cols - 1, c + 1)), rxm = reachAt(r, Math.max(0, c - 1));
      const ryp = reachAt(Math.min(rows - 1, r + 1), c), rym = reachAt(Math.max(0, r - 1), c);
      const grad = (Number.isFinite(rxp) && Number.isFinite(rxm) && Number.isFinite(ryp) && Number.isFinite(rym))
        ? Math.hypot((rxp - rxm) / (2 * dx), (ryp - rym) / (2 * dy)) : 0;
      // a constant-XY-stepover raster stretches along-surface spacing by
      // sqrt(1+grad^2) on slopes — the per-cell theory limit grows with it
      if (nearDifficult(x, y)) { steepSkipped++; continue; }
      const sEff = (STEPOVER / 2) * Math.sqrt(1 + grad * grad);
      const cellTheory = R - Math.sqrt(R * R - sEff * sEff);
      const cellLimit = cellTheory * 1.5 + 2e-3;
      const residual = (best - reach) / Math.sqrt(1 + grad * grad);
      if (residual > worstScallop) worstScallop = residual;
      if (residual - cellLimit > worstExcess) worstExcess = residual - cellLimit;
    }
  }

  const scallopLimit = SCALLOP * 1.5 + 2e-3;
  console.log(`  gouge: ${vGouges} vertex violations (worst ${vWorst.toFixed(5)}), mid-segment worst ${mWorst.toFixed(5)}`);
  console.log(`  finish: worst residual ${worstScallop.toFixed(5)} vs reachable surface over ${cellsChecked} cells ` +
    `(flat theory ${SCALLOP.toFixed(5)}, limit slope-scaled per cell), ${uncovered} uncovered, ${steepSkipped} too-steep skipped`);
  console.log(`  stats: ${JSON.stringify(result.stats)}`);
  for (const w of result.warnings) console.log(`  warning: ${w}`);

  if (vGouges > 0) fail(`${name}: ${vGouges} gouging vertices (worst ${vWorst.toFixed(5)})`);
  else pass('no vertex gouges');
  if (smooth && mWorst > 5e-3) fail(`${name}: mid-segment penetration ${mWorst.toFixed(5)} on smooth surface`);
  else pass(`mid-segment penetration ${mWorst.toFixed(5)}${smooth ? ' ≤ 0.005' : ' (steep face: reported only)'}`);
  if (outside > 0) fail(`${name}: ${outside} cutting vertices outside mask`);
  else if (mask) pass('mask respected');
  if (depthViolations > 0) fail(`${name}: ${depthViolations} vertices below pass floor`);
  else pass('depth-pass floors respected');
  if (worstExcess > 0) fail(`${name}: residual exceeds slope-scaled scallop limit by ${worstExcess.toFixed(5)}`);
  else pass('finish within slope-scaled scallop theory (vs reachable surface)');
  if (uncovered > 0) fail(`${name}: ${uncovered} machinable cells never approached`);
  else pass('full coverage of machinable cells');
}

// ------------------------------------------------------------ the gauntlet

console.log('=== surface-raster gauntlet: ballnose Ø0.25, stepover 40%, grid 0.02 ===\n');

for (const { name, fn, smooth } of SURFACES) {
  console.log(`--- ${name} ---`);
  const hm = makeHeightmap(fn, 0, 0, 4, 4, SP);
  const r = generateSurfaceRaster(hm, TOOL, PARAMS);
  checkSurface(name, hm, null, smooth, r);
  console.log('');
}

console.log('--- masked gaussian (rect mask + circular island hole) ---');
{
  const fn = SURFACES[1].fn;
  const hm = makeHeightmap(fn, 0, 0, 4, 4, SP);
  const mask = { outer: rect(0.8, 0.8, 3.2, 3.2), holes: [circleRing(2, 2, 0.5)] };
  const r = generateSurfaceRaster(hm, TOOL, { ...PARAMS, mask });
  checkSurface('masked gaussian', hm, mask, true, r);
}
console.log('');

// ------------------------- run economy: whiskers skipped, real cuts kept

console.log('--- run economy: edge whiskers vs real material ---');
{
  const mask = { outer: rect(0.2, 0.2, 3.8, 0.8), holes: [] };

  // a 0.1"-wide, 0.015"-deep groove: the ball chord-dips ~0.010" for a
  // ~0.06"-long run per row — the indicator-light "grazes the edge and
  // jogs across the whole part at safe height" case. Not worth the motion.
  const whisker = makeHeightmap((x, y) => (x > 2 && x < 2.1 ? -0.015 : 0), 0, 0, 4, 1, SP);
  const r = generateSurfaceRaster(whisker, TOOL, { ...PARAMS, mask });
  if (r.moves.length === 0 && (r.stats.skimsSkipped ?? 0) > 0) {
    pass(`whisker groove: empty op, ${r.stats.skimsSkipped} skim run(s) skipped`);
  } else {
    fail(`whisker groove: expected empty op, got ${r.moves.length} moves (skimsSkipped=${r.stats.skimsSkipped})`);
  }
  if (r.warnings.some(w => /skim/.test(w))) pass('whisker groove: warning explains the skipped skims');
  else fail(`whisker groove: no skim warning: ${r.warnings.join('; ')}`);

  // same geometry with the filter disabled cuts — proves the run filter
  // (not minEngage) is what dropped it
  const r0 = generateSurfaceRaster(whisker, TOOL, { ...PARAMS, mask, minRunDepth: 0 });
  if (r0.moves.length > 0) pass('filter off: whisker is cut (geometry above minEngage, filter exercised)');
  else fail('filter off: still empty — test geometry below minEngage, run filter never exercised');

  // long shallow relief: same 0.015" depth over the whole mask — long runs
  // must survive on length even below the depth threshold
  const relief = makeHeightmap(() => -0.015, 0, 0, 4, 1, SP);
  const r1 = generateSurfaceRaster(relief, TOOL, { ...PARAMS, mask });
  if (r1.moves.length > 0 && r1.stats.skimsSkipped === 0) pass('long shallow relief: still cut (length keeps it)');
  else fail(`long shallow relief: moves=${r1.moves.length}, skimsSkipped=${r1.stats.skimsSkipped}`);

  // short deep dimple: 0.4" wide, 0.1" deep — short runs must survive on depth
  const dimple = makeHeightmap((x, y) => (Math.hypot(x - 2, y - 0.5) < 0.2 ? -0.1 : 0), 0, 0, 4, 1, SP);
  const r2 = generateSurfaceRaster(dimple, TOOL, { ...PARAMS, mask });
  if (r2.moves.length > 0 && Math.abs(r2.stats.minZ - -0.1) < 0.02) pass(`short deep dimple: still cut to ${r2.stats.minZ.toFixed(3)} (depth keeps it)`);
  else fail(`short deep dimple: moves=${r2.moves.length}, minZ=${r2.stats.minZ}`);
}
console.log('');

// ------------------------- hybrid composition: pocket ⊕ surface raster

console.log('--- hybrid Job: endmill pocket + ballnose surface, two tools ---');
{
  const pocketOp = (() => {
    const r = generatePocket(
      { outer: rect(1, 1, 4, 4) },
      { diameter: 0.25 },
      { stepoverPct: 40, totalDepth: 0.25, depthPerPass: 0.125, safeZ: 0.25 });
    return { name: 'flat pocket (strategies/pocket.js)', tool: 1, feedRate: 100, plungeRate: 30, moves: r.moves };
  })();

  const makeSurfaceOp = (gridX0, gridY0, maskRect) => {
    const fn = (x, y) => -0.35 + 0.3 * Math.exp(-((x - gridX0 - 2.5) ** 2 + (y - gridY0 - 2.5) ** 2) / (2 * 0.9 * 0.9));
    const hm = makeHeightmap(fn, gridX0, gridY0, 5, 5, SP);
    const r = generateSurfaceRaster(hm, TOOL, { ...PARAMS, mask: { outer: maskRect } });
    return { name: 'freeform surface (strategies/surface-raster.js)', tool: 2, feedRate: 80, plungeRate: 25, moves: r.moves };
  };

  const job = {
    units: 'in',
    stock: { w: 12, h: 12, thickness: 0.75 },
    safeZ: 0.25,
    spindleSpeed: 14000,
    tools: { 1: { name: '1/4in endmill' }, 2: { name: '1/4in ballnose' } },
    operations: [pocketOp, makeSurfaceOp(5.5, 5.5, rect(6, 6, 10, 10))],
  };
  const composed = composeJob(job);
  const report = verifyJob(job, composed);
  if (report.ok && report.stats.toolchangeCount === 2) {
    pass(`verifyJob ok — ${report.stats.moveCount} moves, 2 toolchanges, cut ${report.stats.cutLength}", est ${report.stats.estCutTimeMin} min`);
  } else {
    fail(`hybrid job rejected or wrong toolchanges (${report.stats.toolchangeCount})`);
    for (const e of report.errors.slice(0, 5)) console.log(`    ${e}`);
  }
  const sbp = postJobToSbp(job, composed, { title: 'Hybrid pocket + surface raster' });
  if (sbp.includes('&Tool = 2') && sbp.includes('C9')) pass(`SBP posts with toolchange (${sbp.split('\n').length} lines)`);
  else fail('SBP missing toolchange');

  // sabotage: surface grid+mask shifted onto the pocket — footprints overlap
  const badJob = { ...job, operations: [pocketOp, makeSurfaceOp(1.5, 1.5, rect(2, 2, 6, 6))] };
  const badReport = verifyJob(badJob, composeJob(badJob));
  if (!badReport.ok && badReport.errors.some(e => e.includes('footprints overlap'))) {
    pass(`sabotage caught: ${badReport.errors.find(e => e.includes('footprints overlap'))}`);
  } else {
    fail('verifier MISSED overlapping pocket/surface footprints');
  }
}

console.log(failures === 0 ? '\nALL SURFACE-RASTER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
