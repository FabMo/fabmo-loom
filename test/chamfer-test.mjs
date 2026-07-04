// Chamfer gauntlet — the edge-break strategy proven both ways it can cut.
//
// Every scenario builds its intended FINAL surface ANALYTICALLY in this
// file (signed distance to the edge chain — independent of the strategy's
// offset math and of imprintChamfer), declares it as the op's heightmap
// target, and then:
//   gouge     verifyJob's independent vee/ball constraint vs that surface
//   coverage  brute force here: every face sample must be reached by the
//             toolpath's swept cutter (cone flank / ball surface) within
//             tolerance — a chamfer that verifies but doesn't CUT the face
//             is useless
//   sabotage  a chain shifted into the material must FAIL verification
//   guards    wrong-angle V-bit refused; bit-capacity clamp warned
//
// Scenarios: closed square (vee + ballnose fallback), open straight edge
// (vee), circle (vee), each composed into a Job, verified, and posted.

import { generateChamfer, imprintChamfer, veeAngleFor } from '../strategies/chamfer.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

const W = 0.125;            // horizontal leg
const ANGLE = 45;           // face angle from horizontal
const V = W * Math.tan(ANGLE * Math.PI / 180);
const THICK = 0.6;
const VEE = { kind: 'vee', diameter: 0.5, angleDeg: veeAngleFor(ANGLE) };  // 90°
const BALL = { kind: 'ball', diameter: 0.25 };
const SAFE = 0.5;

// ---- analytic intended surfaces (independent of the strategy) ----------

// build a heightmap over [x0,x1]×[y0,y1] from h(x,y)
function surfaceFrom(x0, y0, x1, y1, spacing, fn) {
  const cols = Math.round((x1 - x0) / spacing) + 1;
  const rows = Math.round((y1 - y0) / spacing) + 1;
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = fn(x0 + c * spacing, y0 + r * spacing);
    }
  }
  return { heights, cols, rows, dx: spacing, dy: spacing, originX: x0, originY: y0 };
}

// face height from distance-inside-the-part: 0 on the untouched top,
// linear down the band, off-part is no-material
const faceFromInside = dIn =>
  dIn < 0 ? -THICK : dIn >= W ? 0 : -V * ((W - dIn) / W);

// square part [0,2]²
const sqInside = (x, y) => Math.min(x, 2 - x, y, 2 - y);
const squareSurface = () => surfaceFrom(-0.2, -0.2, 2.2, 2.2, 0.01, (x, y) => faceFromInside(sqInside(x, y)));
const squareChain = { points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], closed: true }; // CCW, material inside

// disk part r=0.8 at (1,1)
const N_CIRC = 96;
const circleChain = {
  points: Array.from({ length: N_CIRC }, (_, i) => ({
    x: 1 + 0.8 * Math.cos((2 * Math.PI * i) / N_CIRC),
    y: 1 + 0.8 * Math.sin((2 * Math.PI * i) / N_CIRC),
  })),
  closed: true,
};
const diskSurface = () => surfaceFrom(-0.2, -0.2, 2.2, 2.2, 0.01,
  (x, y) => faceFromInside(0.8 - Math.hypot(x - 1, y - 1)));

// square part, chamfer ONLY the y=0 side (open chain, material above)
const openChain = { points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false };
const distToSeg = (x, y) => {
  const t = Math.max(0, Math.min(2, x));
  return Math.hypot(x - t, y);
};
const openSurface = () => surfaceFrom(-0.2, -0.2, 2.2, 2.2, 0.01, (x, y) => {
  const dIn = sqInside(x, y);
  if (dIn < 0) return -THICK;
  const d = distToSeg(x, y);
  return d >= W ? 0 : -V * ((W - d) / W);
});

// ---- swept-cutter coverage (brute force, independent) ------------------

function cutSamples(moves, step = 0.01) {
  const out = [];
  let pos = { x: 0, y: 0, z: SAFE };
  for (const m of moves) {
    if (m.type === 'comment') continue;
    const next = {
      x: m.x !== undefined ? m.x : pos.x,
      y: m.y !== undefined ? m.y : pos.y,
      z: m.z !== undefined ? m.z : pos.z,
    };
    if (m.type === 'linear' && (next.z < -1e-9 || pos.z < -1e-9)) {
      const len = Math.hypot(next.x - pos.x, next.y - pos.y, next.z - pos.z);
      const n = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        out.push({
          x: pos.x + t * (next.x - pos.x),
          y: pos.y + t * (next.y - pos.y),
          z: pos.z + t * (next.z - pos.z),
        });
      }
    }
    pos = next;
  }
  return out;
}

// lowest surface the swept cutter leaves at plan point p
function sweptHeightAt(p, samples, tool) {
  const R = tool.diameter / 2;
  const tanB = tool.kind === 'vee' ? Math.tan((tool.angleDeg / 2) * Math.PI / 180) : null;
  let lowest = Infinity;
  for (const q of samples) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > R) continue;
    const h = tool.kind === 'vee'
      ? q.z + d / tanB
      : (q.z + R) - Math.sqrt(R * R - d * d);
    if (h < lowest) lowest = h;
  }
  return lowest;
}

// sample the declared face and require the swept cutter reaches it
function checkCoverage(name, chain, insideFn, moves, tool, tol) {
  const samples = cutSamples(moves);
  let checked = 0, misses = 0, worst = 0;
  // walk the chain, probe across the band at each station
  const pts = chain.points;
  const segCount = chain.closed ? pts.length : pts.length - 1;
  // a vertex is a CORNER (swept cutter rounds it Euclidean-style, which the
  // per-side probe doesn't model) only if the chain turns sharply there —
  // tessellated curves turn a few degrees per vertex and must NOT be skipped
  const sharp = pts.map((p, i) => {
    if (!chain.closed && (i === 0 || i === pts.length - 1)) return true;
    const prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
    const a1 = Math.atan2(p.y - prev.y, p.x - prev.x);
    const a2 = Math.atan2(next.y - p.y, next.x - p.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn > (20 * Math.PI) / 180;
  });
  for (let s = 0; s < segCount; s++) {
    const a = pts[s], b = pts[(s + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const lx = -(b.y - a.y) / len, ly = (b.x - a.x) / len;   // left = into material
    const stations = Math.max(2, Math.ceil(len / 0.08));
    for (let st = 0; st <= stations; st++) {
      const t = st / stations;
      const along = t * len;
      if (sharp[s] && along < W + 0.05) continue;
      if (sharp[(s + 1) % pts.length] && len - along < W + 0.05) continue;
      for (let u = 0.1; u <= 0.95; u += 0.2) {
        const inset = W * (1 - u);
        const p = { x: a.x + (b.x - a.x) * t + lx * inset, y: a.y + (b.y - a.y) * t + ly * inset };
        const faceZ = -V * u;
        checked++;
        const cut = sweptHeightAt(p, samples, tool);
        const miss = cut - faceZ;
        if (miss > tol) { misses++; if (miss > worst) worst = miss; }
      }
    }
  }
  if (misses === 0) pass(`${name}: face fully covered (${checked} samples within ${tol})`);
  else fail(`${name}: ${misses}/${checked} face samples uncut, worst ${worst.toFixed(4)} above the face`);
}

// ---- compose + verify helper -------------------------------------------

function verifyAsJob(name, op, tool, expectOk = true) {
  const job = {
    units: 'in',
    stock: { w: 3, h: 3, thickness: THICK },
    safeZ: SAFE,
    spindleSpeed: 18000,
    tools: { 1: { name: 'chamfer tool', ...tool } },
    operations: [{ name, tool: 1, feedRate: 100, plungeRate: 30, placement: { x: 0.4, y: 0.4 }, ...op }],
  };
  const composed = composeJob(job);
  const report = verifyJob(job, composed);
  if (expectOk) {
    for (const e of report.errors) console.log(`    error: ${e}`);
    if (report.ok) pass(`${name}: VERIFIED (${report.stats.targets[0]?.samples ?? 0} target samples, worst pen ${report.stats.targets[0]?.worstPenetration ?? 0})`);
    else fail(`${name}: verification failed with ${report.errors.length} error(s)`);
    if (report.ok) {
      const sbp = postJobToSbp(job, composed, { title: name });
      if (/^MS,/m.test(sbp) && (sbp.includes('M3') || sbp.includes('J3'))) pass(`${name}: SBP posted (${sbp.split('\n').length} lines)`);
      else fail(`${name}: SBP post malformed`);
    }
  } else {
    if (!report.ok) pass(`${name}: correctly REJECTED (${report.errors[0]?.slice(0, 90)}…)`);
    else fail(`${name}: sabotage passed verification`);
  }
  return report;
}

// ======================== scenarios ======================================

console.log('\n=== chamfer: closed square, 90° V-bit ===\n');
{
  const surface = squareSurface();
  const r = generateChamfer(squareChain, VEE, {
    width: W, angleDeg: ANGLE, depthPerPass: 0.08, safeZ: SAFE,
    surface, outsideZ: -THICK,
  });
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  if (r.moves.length && r.stats.passes === 2) pass(`vee: ${r.stats.passes} depth passes, cut ${r.stats.cutLength}"`);
  else fail(`vee: expected 2 passes with moves, got ${r.stats.passes}`);
  if (r.band?.length) pass(`band declared: ${r.band.length} ring(s)`);
  else fail('no band returned');
  verifyAsJob('square vee chamfer', { moves: r.moves, target: r.target }, VEE);
  checkCoverage('square vee coverage', squareChain, sqInside, r.moves, VEE, 0.004);
}

console.log('\n=== chamfer: closed square, ballnose fallback ===\n');
{
  const surface = squareSurface();
  const r = generateChamfer(squareChain, BALL, {
    width: W, angleDeg: ANGLE, scallop: 0.003, safeZ: SAFE,
    surface, outsideZ: -THICK,
  });
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  if (r.stats.passes >= 5) pass(`ball: ${r.stats.passes} face passes, cut ${r.stats.cutLength}"`);
  else fail(`ball: expected ≥5 scallop passes, got ${r.stats.passes}`);
  verifyAsJob('square ball chamfer', { moves: r.moves, target: r.target }, BALL);
  // ball leaves scallops: coverage tolerance = scallop + sampling slack
  checkCoverage('square ball coverage', squareChain, sqInside, r.moves, BALL, 0.003 + 0.004);
}

console.log('\n=== chamfer: open straight edge, 90° V-bit ===\n');
{
  const surface = openSurface();
  const r = generateChamfer(openChain, VEE, {
    width: W, angleDeg: ANGLE, depthPerPass: 0.08, safeZ: SAFE,
    surface, outsideZ: -THICK,
  });
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  if (r.moves.length) pass(`open chain: ${r.stats.passes} passes`);
  else fail('open chain produced no moves');
  verifyAsJob('open edge vee chamfer', { moves: r.moves, target: r.target }, VEE);
  checkCoverage('open edge coverage', openChain, null, r.moves, VEE, 0.004);
}

console.log('\n=== chamfer: circle, 90° V-bit ===\n');
{
  const surface = diskSurface();
  const r = generateChamfer(circleChain, VEE, {
    width: W, angleDeg: ANGLE, depthPerPass: 0.2, safeZ: SAFE,
    surface, outsideZ: -THICK,
  });
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  verifyAsJob('circle vee chamfer', { moves: r.moves, target: r.target }, VEE);
  checkCoverage('circle coverage', circleChain, null, r.moves, VEE, 0.005);
}

console.log('\n=== chamfer: sabotage + guards ===\n');
{
  // chain shifted 0.02 INTO the material: cuts the wall where the intended
  // face is higher — the declared-target check must reject it
  const sabotaged = {
    points: [{ x: 0.02, y: 0.02 }, { x: 1.98, y: 0.02 }, { x: 1.98, y: 1.98 }, { x: 0.02, y: 1.98 }],
    closed: true,
  };
  const surface = squareSurface();   // intent: the TRUE square's chamfer
  const r = generateChamfer(sabotaged, VEE, {
    width: W, angleDeg: ANGLE, safeZ: SAFE, surface, outsideZ: -THICK,
  });
  verifyAsJob('shifted-chain sabotage', { moves: r.moves, target: r.target }, VEE, false);

  // wrong bit: 60° included cuts a 60° face, not 45° — must refuse
  const wrong = generateChamfer(squareChain, { kind: 'vee', diameter: 0.5, angleDeg: 60 }, {
    width: W, angleDeg: ANGLE, safeZ: SAFE,
  });
  if (!wrong.moves.length && wrong.warnings.some(w => /cannot cut/.test(w))) pass('60° bit for a 45° face refused');
  else fail(`wrong-angle bit not refused (${wrong.moves.length} moves; ${wrong.warnings.join(' | ')})`);

  // capacity: 0.2 leg needs 0.2 depth; a 0.25" 90° bit reaches 0.125 — warn+clamp
  const clamped = generateChamfer(squareChain, { kind: 'vee', diameter: 0.25, angleDeg: 90 }, {
    width: 0.2, angleDeg: 45, safeZ: SAFE,
  });
  if (clamped.warnings.some(w => /clamped/.test(w))) pass('over-capacity chamfer warned and clamped');
  else fail('no capacity warning for an oversized chamfer');
}

console.log('\n=== imprintChamfer: added-chamfer intent surface ===\n');
{
  // flat stock-top heightmap; imprint the square chamfer; probe the band
  const flat = surfaceFrom(-0.2, -0.2, 2.2, 2.2, 0.01, () => 0);
  const hm = imprintChamfer(flat, squareChain, W, ANGLE);
  const probe = (x, y) => {
    const c = Math.round((x - hm.originX) / hm.dx), r2 = Math.round((y - hm.originY) / hm.dy);
    return hm.heights[r2 * hm.cols + c];
  };
  // probe at the band cell nearest y = W/2, expecting the face value at the
  // SNAPPED grid coordinate (the imprint is exact per cell, not interpolated)
  const ySnap = hm.originY + Math.round((W / 2 - hm.originY) / hm.dy) * hm.dy;
  const mid = probe(1, W / 2);
  const expectMid = -V * ((W - ySnap) / W);
  if (Math.abs(mid - expectMid) < 1e-6) pass(`band mid-face imprinted to ${mid.toFixed(4)}`);
  else fail(`band mid-face ${mid} != ${expectMid}`);
  if (Math.abs(probe(1, 1)) < 1e-9) pass('part interior untouched');
  else fail(`interior lowered to ${probe(1, 1)}`);
  const corner = probe(0, 0);
  if (Math.abs(corner - -V) < 1e-6) pass(`corner vertex at band bottom ${corner.toFixed(4)}`);
  else fail(`corner ${corner} != ${-V}`);
  if (flat.heights[Math.round((1 + 0.2) / 0.01) * flat.cols] === 0) pass('input heightmap not mutated');
  else fail('imprintChamfer mutated its input');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
