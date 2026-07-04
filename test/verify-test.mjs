// Verifier v1 validation — every check proven in BOTH directions.
//
// For each new capability: a clean case the verifier must accept, and a
// sabotage the verifier must reject with a measured number. Plus the
// false-rejection proof: two interlocking L ops whose bboxes overlap but
// whose true swept areas are disjoint — v0's bbox check rejected this
// legitimate composition; v1's polygon footprints must accept it (and the
// bbox fallback, still used when a tool has no diameter, must still
// reject it, preserving v0 behavior for under-specified jobs).
//
// Usage: node test/verify-test.mjs

import { generatePocket } from '../strategies/pocket.js';
import { generateSurfaceRaster } from '../strategies/surface-raster.js';
import { composeJob } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

const rect = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];

const baseJob = ops => ({
  units: 'in',
  stock: { w: 12, h: 12, thickness: 0.75 },
  safeZ: 0.25,
  spindleSpeed: 12000,
  tools: {
    1: { name: '1/4in endmill', diameter: 0.25, kind: 'flat' },
    2: { name: '1/4in ballnose', diameter: 0.25, kind: 'ball' },
  },
  operations: ops,
});

const run = job => verifyJob(job, composeJob(job));

// hand-built op: trace a polyline at depth (op contract: rapid XY first)
function traceOp(name, tool, pts, z) {
  const moves = [{ type: 'rapid', x: pts[0].x, y: pts[0].y }, { type: 'linear', z }];
  for (let i = 1; i < pts.length; i++) moves.push({ type: 'linear', x: pts[i].x, y: pts[i].y, z });
  moves.push({ type: 'rapid', z: 0.25 });
  return { name, tool, feedRate: 100, plungeRate: 30, moves };
}

// ---------------- 1. interlocking Ls: the v0 false rejection, fixed ----------------

console.log('--- interlocking L ops (overlapping bboxes, disjoint swept areas) ---');
{
  // A: an L along the left and bottom of (1..5, 1..5); B: a bar in the
  // upper-right interior. Bboxes overlap massively; swept areas don't.
  const opA = traceOp('L-bar', 1, [{ x: 5, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 5 }], -0.1);
  const opB = traceOp('inner bar', 2, [{ x: 3, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 5 }], -0.1);

  const report = run(baseJob([opA, opB]));
  if (report.ok) pass('v1 accepts the interlocking composition (true footprints disjoint)');
  else fail(`v1 falsely rejected interlocking Ls: ${report.errors[0]}`);
  if (report.stats.footprints.every(f => f.method === 'polygon' && f.area > 0)) {
    pass(`polygon footprints measured: ${report.stats.footprints.map(f => f.area).join(', ')} sq in`);
  } else fail('footprints not computed as polygons');

  // same ops, tools without diameters: bbox fallback must reject (v0 behavior)
  const noDia = baseJob([opA, opB]);
  noDia.tools = { 1: { name: 'endmill' }, 2: { name: 'ballnose' } };
  const fallback = run(noDia);
  if (!fallback.ok && fallback.errors.some(e => e.includes('bbox precision'))) {
    pass('without diameters, bbox fallback still rejects (v0-compatible)');
  } else fail('bbox fallback did not engage for diameter-less tools');

  // shift B so it actually crosses A's vertical bar: must reject with area
  const opB2 = traceOp('crossing bar', 2, [{ x: 0.5, y: 3 }, { x: 5, y: 3 }], -0.1);
  const crossing = run(baseJob([opA, opB2]));
  if (!crossing.ok && crossing.errors.some(e => e.includes('sq units'))) {
    pass(`real overlap rejected with measured area: ${crossing.errors.find(e => e.includes('sq units'))}`);
  } else fail('real footprint overlap not caught');
}
console.log('');

// ---------------- 2. region target (pocket) ----------------

console.log('--- region target: pocket declares what it machines ---');
{
  const region = { outer: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 5 }, { x: 1, y: 5 }] };
  const p = generatePocket(region, { diameter: 0.25 },
    { stepoverPct: 40, totalDepth: 0.25, depthPerPass: 0.125, safeZ: 0.25 });
  const cleanOp = { name: 'L pocket', tool: 1, feedRate: 100, plungeRate: 30, moves: p.moves, target: p.target };

  const clean = run(baseJob([cleanOp]));
  const t = clean.stats.targets[0];
  if (clean.ok && t.gouges === 0 && t.depthViolations === 0) {
    pass(`clean pocket verified against its declaration: 0/${t.samples} gouge samples, coverage residual ${t.coverageResidualPct}%`);
  } else fail(`clean pocket rejected: ${clean.errors[0] ?? JSON.stringify(t)}`);

  // sabotage a: a stray cut outside the declared region
  const strayOp = { ...cleanOp, name: 'stray cut', moves: [...p.moves,
    { type: 'rapid', z: 0.25 }, { type: 'rapid', x: 7, y: 7 }, { type: 'linear', z: -0.1 }, { type: 'linear', x: 7.5, y: 7, z: -0.1 }, { type: 'rapid', z: 0.25 }] };
  const stray = run(baseJob([strayOp]));
  if (!stray.ok && stray.errors.some(e => e.includes('gouges outside its declared region'))) {
    pass(`stray cut caught: ${stray.errors.find(e => e.includes('declared region'))}`);
  } else fail('stray cut outside region NOT caught');

  // sabotage b: a cut below the declared depth, inside the region
  const deepOp = { ...cleanOp, name: 'too deep', moves: [...p.moves,
    { type: 'rapid', z: 0.25 }, { type: 'rapid', x: 2, y: 2 }, { type: 'linear', z: -0.4 }, { type: 'linear', x: 2.2, y: 2, z: -0.4 }, { type: 'rapid', z: 0.25 }] };
  const deep = run(baseJob([deepOp]));
  if (!deep.ok && deep.errors.some(e => e.includes('below its declared depth'))) {
    pass(`overdeep cut caught: ${deep.errors.find(e => e.includes('declared depth'))}`);
  } else fail('cut below declared depth NOT caught');

  // sabotage c: most of the pocket missing → coverage warning (quality, not error)
  const cutMoveIdx = p.moves.findIndex(m => m.type === 'comment' && /z=-0\.2500/.test(m.text));
  const halfOp = { ...cleanOp, name: 'half pocket', moves: p.moves.slice(0, Math.floor(cutMoveIdx / 3)) };
  const half = run(baseJob([halfOp]));
  const ht = half.stats.targets[0];
  if (half.ok && half.warnings.some(w => w.includes('uncut'))) {
    pass(`missing coverage warned, not errored: ${half.warnings.find(w => w.includes('uncut'))}`);
  } else fail(`coverage warning missing (ok=${half.ok}, residual=${ht?.coverageResidualPct}%)`);
}
console.log('');

// ---------------- 3. heightmap target (surface raster) ----------------

console.log('--- heightmap target: surface op declares its surface + mask ---');
{
  const SP = 0.02;
  const fn = (x, y) => -0.3 + 0.25 * Math.exp(-((x - 2) ** 2 + (y - 2) ** 2) / (2 * 0.7 * 0.7));
  const cols = Math.round(4 / SP) + 1, rows = cols;
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = fn(c * SP, r * SP);
  const hm = { heights, cols, rows, dx: SP, dy: SP, originX: 0, originY: 0 };
  const mask = { outer: rect(0.8, 0.8, 3.2, 3.2) };
  const s = generateSurfaceRaster(hm, { diameter: 0.25 },
    { stepoverPct: 40, depthPerPass: 0.15, safeZ: 0.25, mask });
  const cleanOp = { name: 'gaussian surface', tool: 2, feedRate: 80, plungeRate: 25, moves: s.moves, target: s.target };

  const clean = run(baseJob([cleanOp]));
  const t = clean.stats.targets[0];
  if (clean.ok && t.gouges === 0 && t.maskViolations === 0) {
    pass(`clean surface verified against its declaration: 0/${t.samples} gouge samples`);
  } else fail(`clean surface rejected: ${clean.errors[0] ?? JSON.stringify(t)}`);

  // sabotage: every motion 0.010 too deep — must be caught with measured depth
  const sunkOp = { ...cleanOp, name: 'sunk surface', moves: s.moves.map(m =>
    m.z !== undefined && m.z < 0.2 ? { ...m, z: m.z - 0.010 } : m) };
  const sunk = run(baseJob([sunkOp]));
  const st = sunk.stats.targets[0];
  if (!sunk.ok && sunk.errors.some(e => e.includes('gouges its declared surface')) && st.worstPenetration >= 0.009) {
    pass(`0.010 z-shift caught: worst penetration ${st.worstPenetration} over ${st.gouges} samples`);
  } else fail(`sunk surface NOT caught (worst=${st?.worstPenetration})`);

  // sabotage: op slides sideways out of its declared mask
  const slidOp = { ...cleanOp, name: 'slid surface', moves: s.moves.map(m =>
    m.x !== undefined ? { ...m, x: m.x + 0.6 } : m) };
  const slid = run(baseJob([slidOp]));
  if (!slid.ok && slid.errors.some(e => e.includes('outside its declared mask'))) {
    pass(`mask escape caught: ${slid.errors.find(e => e.includes('declared mask'))}`);
  } else fail('mask escape NOT caught');
}
console.log('');

// ---------------- 4. placement: targets travel with their op ----------------

console.log('--- placement: op-local target transformed to job coords ---');
{
  const region = { outer: rect(0, 0, 2, 2) };
  const p = generatePocket(region, { diameter: 0.25 },
    { stepoverPct: 40, totalDepth: 0.2, depthPerPass: 0.1, safeZ: 0.25 });
  const op = {
    name: 'placed pocket', tool: 1, feedRate: 100, plungeRate: 30,
    placement: { x: 7, y: 8 },
    moves: p.moves, target: p.target,
  };
  const report = run(baseJob([op]));
  const fpb = report.stats.footprints[0].bbox;
  if (report.ok && report.stats.targets[0].gouges === 0 && fpb.minX > 6.5 && fpb.minY > 7.5) {
    pass(`placed op verifies against its placed target (footprint at ${fpb.minX.toFixed(2)},${fpb.minY.toFixed(2)})`);
  } else fail(`placement transform broken (ok=${report.ok}, bbox=${JSON.stringify(fpb)})`);
}
console.log('');

// ---------------- 5. hybrid: both target types in one verified job ----------------

console.log('--- hybrid job: pocket + surface, both with declared targets ---');
{
  const p = generatePocket({ outer: rect(1, 1, 4, 4) }, { diameter: 0.25 },
    { stepoverPct: 40, totalDepth: 0.25, depthPerPass: 0.125, safeZ: 0.25 });

  const SP = 0.02;
  const fn = (x, y) => -0.3 + 0.25 * Math.exp(-((x - 8) ** 2 + (y - 8) ** 2) / (2 * 0.8 * 0.8));
  const cols = Math.round(5 / SP) + 1, rows = cols;
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = fn(5.5 + c * SP, 5.5 + r * SP);
  const hm = { heights, cols, rows, dx: SP, dy: SP, originX: 5.5, originY: 5.5 };
  const s = generateSurfaceRaster(hm, { diameter: 0.25 },
    { stepoverPct: 40, depthPerPass: 0.15, safeZ: 0.25, mask: { outer: rect(6, 6, 10, 10) } });

  const report = run(baseJob([
    { name: 'pocket', tool: 1, feedRate: 100, plungeRate: 30, moves: p.moves, target: p.target },
    { name: 'surface', tool: 2, feedRate: 80, plungeRate: 25, moves: s.moves, target: s.target },
  ]));
  const [t1, t2] = report.stats.targets;
  if (report.ok && report.stats.toolchangeCount === 2 &&
      report.stats.footprints.every(f => f.method === 'polygon') &&
      t1.gouges === 0 && t2.gouges === 0) {
    pass(`hybrid verified: 2 polygon footprints, region target 0/${t1.samples} gouges, surface target 0/${t2.samples} gouges`);
  } else {
    fail(`hybrid rejected (ok=${report.ok})`);
    for (const e of report.errors.slice(0, 4)) console.log(`    ${e}`);
  }
}

console.log(failures === 0 ? '\nALL VERIFIER V1 CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
