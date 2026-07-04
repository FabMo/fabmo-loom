// Pocket primitive validation — measured, adversarial, old-vs-new.
//
// The claim under test: strategies/pocket.js (Clipper-backed, from-original
// insets) clears complex regions that break the apps' hand-rolled offset
// engine (vendor/pocket_strategy_legacy/pocket-gen.js, frozen 2026-06-09).
//
// Every check is a measured number, in the verifier's spirit:
//   gouges    cutting-move sample points outside the legal tool-center
//             region (region inset by bitRadius − tol). One gouge = the
//             tool cuts a wall or an island. Hard-fail for the new engine.
//   coverage  area of (machinable region − swept area), where swept area is
//             the toolpath dilated by bitRadius and the machinable region is
//             the morphological opening of the region by the tool. Residual
//             > 1% = visibly uncut floor. Hard-fail for the new engine.
//   simple    output contours must be simple polygons (a self-intersecting
//             contour is a malformed toolpath even when it dodges the gouge
//             sampler).
// The legacy engine runs the same gauntlet for the side-by-side numbers; it
// is expected to fail shapes — that is the point — so its results are
// reported, not asserted.
//
// Finally the new engine's moves are composed into a Job and must pass
// verifyJob, and one open-edge case checks the spillover semantics.
//
// Usage: node test/pocket-test.mjs

import ClipperLib from '../vendor/clipper.js';
import { generatePocket, insetRegion, toClipper, fromClipper, SCALE, signedArea } from '../strategies/pocket.js';
import { generateContourPocket as legacyContourPocket } from '../vendor/pocket_strategy_legacy/pocket-gen.js';
// the LIVE app engine (offset core now Clipper-backed) — asserted like the primitive
import { generateContourPocket as liveContourPocket, generateRasterPocket as liveRasterPocket } from '../../pocket_strategy/modules/pocket-gen.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

const TOOL = { diameter: 0.25, feedRate: 100, plungeRate: 30 };
const BIT_R = TOOL.diameter / 2;
const PARAMS = { stepoverPct: 40, totalDepth: 0.25, depthPerPass: 0.125, safeZ: 0.25, feedRate: 100, plungeRate: 30 };
const GOUGE_TOL = 2e-3; // sampler tolerance: integer grid + arc tessellation slack

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------- shapes

// deterministic RNG so the blob is reproducible
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function circle(cx, cy, r, n = 96) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return ring;
}

function star(cx, cy, rOuter, rInner, points) {
  const ring = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2;
    const r = i % 2 === 0 ? rOuter : rInner;
    ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return ring;
}

// rectangle with `n` thin slots cut down from the top edge — every slot
// mouth makes the inward offset self-intersect
function comb(n = 10, slotW = 0.45, slotDepth = 3.0) {
  const x0 = 0.5, y0 = 0.5, w = 11, h = 4;
  const ring = [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }];
  const pitch = w / (n + 1);
  for (let i = n; i >= 1; i--) {
    const cx = x0 + i * pitch;
    ring.push({ x: cx + slotW / 2, y: y0 + h });
    ring.push({ x: cx + slotW / 2, y: y0 + h - slotDepth });
    ring.push({ x: cx - slotW / 2, y: y0 + h - slotDepth });
    ring.push({ x: cx - slotW / 2, y: y0 + h });
  }
  ring.push({ x: x0, y: y0 + h });
  return ring;
}

function gear(cx, cy, rRoot, rTip, teeth) {
  const ring = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    ring.push({ x: cx + rRoot * Math.cos(a), y: cy + rRoot * Math.sin(a) });
    ring.push({ x: cx + rTip * Math.cos(a + step * 0.25), y: cy + rTip * Math.sin(a + step * 0.25) });
    ring.push({ x: cx + rTip * Math.cos(a + step * 0.5), y: cy + rTip * Math.sin(a + step * 0.5) });
    ring.push({ x: cx + rRoot * Math.cos(a + step * 0.75), y: cy + rRoot * Math.sin(a + step * 0.75) });
  }
  return ring;
}

// serpentine slot of constant width — barely wider than the tool
function serpentine(width = 0.32) {
  const center = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    center.push({ x: 1 + 9 * t, y: 5 + 2.2 * Math.sin(3 * Math.PI * t) });
  }
  const left = [], right = [];
  for (let i = 0; i < center.length; i++) {
    const a = center[Math.max(0, i - 1)], b = center[Math.min(center.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    left.push({ x: center[i].x + nx * width / 2, y: center[i].y + ny * width / 2 });
    right.push({ x: center[i].x - nx * width / 2, y: center[i].y - ny * width / 2 });
  }
  return [...left, ...right.reverse()];
}

function blob(seed = 42, n = 240) {
  const rnd = mulberry32(seed);
  const harmonics = [];
  for (let k = 2; k <= 9; k++) harmonics.push({ k, amp: (rnd() - 0.5) * 1.1, ph: rnd() * 2 * Math.PI });
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    let r = 3.2;
    for (const h of harmonics) r += h.amp * Math.sin(h.k * a + h.ph);
    ring.push({ x: 5.5 + r * Math.cos(a), y: 5.5 + r * Math.sin(a) });
  }
  return ring;
}

const SHAPES = [
  { name: 'rect 4x3', region: { outer: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 1, y: 4 }] } },
  { name: 'L-shape', region: { outer: [{ x: 0.5, y: 0.5 }, { x: 6.5, y: 0.5 }, { x: 6.5, y: 2.5 }, { x: 2.5, y: 2.5 }, { x: 2.5, y: 6.5 }, { x: 0.5, y: 6.5 }] } },
  { name: 'star-8 (acute)', region: { outer: star(5.5, 5.5, 4.5, 1.4, 8) } },
  { name: 'comb-10 slots', region: { outer: comb(10) } },
  { name: 'gear-20', region: { outer: gear(5.5, 5.5, 3.4, 4.4, 20) } },
  { name: 'serpentine slot', region: { outer: serpentine() } },
  { name: 'donut (island)', region: { outer: circle(5.5, 5.5, 4.0), holes: [circle(5.5, 5.5, 1.6)] } },
  { name: 'blob-240pt', region: { outer: blob() } },
];

// ------------------------------------------------------- measurement rig

// resolve sticky coords; return cutting segments [{a,b}] (segments at z<0)
function cuttingSegments(moves) {
  const segs = [];
  let pos = { x: 0, y: 0, z: 0.25 };
  for (const m of moves) {
    if (m.type === 'comment' || m.type === 'feed' || m.type === 'toolchange') continue;
    const next = {
      x: m.x !== undefined ? m.x : pos.x,
      y: m.y !== undefined ? m.y : pos.y,
      z: m.z !== undefined ? m.z : pos.z,
    };
    if (m.type === 'linear' && next.z < -1e-9 && pos.z < -1e-9 &&
        (next.x !== pos.x || next.y !== pos.y)) {
      segs.push({ a: { x: pos.x, y: pos.y }, b: { x: next.x, y: next.y } });
    } else if (m.type === 'linear' && next.z < -1e-9 && m.x === undefined && m.y === undefined) {
      segs.push({ a: { x: pos.x, y: pos.y }, b: { x: pos.x, y: pos.y } }); // plunge point
    }
    pos = next;
  }
  return segs;
}

function pathsArea(paths) {
  let a = 0;
  for (const p of paths) a += ClipperLib.Clipper.Area(p);
  return a / (SCALE * SCALE);
}

function pointInPathsWinding(x, y, paths) {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let w = 0;
  for (const path of paths) {
    const r = ClipperLib.Clipper.PointInPolygon(pt, path);
    if (r === -1) return true;
    if (r === 1) w += ClipperLib.Clipper.Orientation(path) ? 1 : -1;
  }
  return w > 0;
}

// gouge count: cutting samples outside region inset by (bitRadius − tol)
function measureGouges(segs, region) {
  const legal = insetRegion(region, BIT_R - GOUGE_TOL, 0);
  let gouges = 0, samples = 0;
  for (const { a, b } of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.min(64, Math.max(1, Math.ceil(len / (BIT_R / 4))));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      samples++;
      if (!pointInPathsWinding(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), legal)) gouges++;
    }
  }
  return { gouges, samples };
}

// coverage residual: machinable area not swept by the dilated toolpath
function measureCoverage(segs, region) {
  // machinable region = opening(region, bitRadius) = dilate(inset(region, R), R)
  const inset = insetRegion(region, BIT_R, 0);
  const co1 = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
  co1.AddPaths(inset, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const machinable = new ClipperLib.Paths();
  co1.Execute(machinable, BIT_R * SCALE);

  // swept = toolpath segments dilated by bitRadius
  const polylines = segs
    .filter(s => s.a.x !== s.b.x || s.a.y !== s.b.y)
    .map(s => toClipper([s.a, s.b]));
  if (!polylines.length) return { machinableArea: pathsArea(machinable), residual: pathsArea(machinable), pct: 100 };
  const co2 = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
  co2.AddPaths(polylines, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const sweptRaw = new ClipperLib.Paths();
  co2.Execute(sweptRaw, BIT_R * SCALE);
  const swept = ClipperLib.Clipper.SimplifyPolygons(sweptRaw, ClipperLib.PolyFillType.pftNonZero);

  const c = new ClipperLib.Clipper();
  c.AddPaths(machinable, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(swept, ClipperLib.PolyType.ptClip, true);
  const resid = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, resid,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  const machinableArea = pathsArea(machinable);
  const residual = pathsArea(resid);
  return { machinableArea, residual, pct: machinableArea > 0 ? (100 * residual) / machinableArea : 0 };
}

function selfIntersectingContours(contours) {
  let bad = 0;
  for (const ring of contours) {
    const n = ring.length;
    let hit = false;
    for (let i = 0; i < n && !hit; i++) {
      const i2 = (i + 1) % n;
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const j2 = (j + 1) % n;
        const d = (ring[i].x - ring[i2].x) * (ring[j].y - ring[j2].y) - (ring[i].y - ring[i2].y) * (ring[j].x - ring[j2].x);
        if (Math.abs(d) < 1e-12) continue;
        const t = ((ring[i].x - ring[j].x) * (ring[j].y - ring[j2].y) - (ring[i].y - ring[j].y) * (ring[j].x - ring[j2].x)) / d;
        const u = -((ring[i].x - ring[i2].x) * (ring[i].y - ring[j].y) - (ring[i].y - ring[i2].y) * (ring[i].x - ring[j].x)) / d;
        if (t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8) { hit = true; break; }
      }
    }
    if (hit) bad++;
  }
  return bad;
}

// ------------------------------------------------------------ the gauntlet

console.log('=== pocket gauntlet: legacy (hand-rolled offsets) vs seams (Clipper) ===\n');
console.log('tool Ø0.25, stepover 40%, gouge tol ±0.002. legacy is reported, new is asserted.\n');

for (const { name, region } of SHAPES) {
  console.log(`--- ${name} (${region.outer.length} pts${region.holes ? `, ${region.holes.length} hole(s)` : ''}) ---`);

  // legacy: the app feeds it the outer ring only (holes are dropped at import)
  let legacyLine;
  try {
    const t0 = Date.now();
    const lr = legacyContourPocket(
      region.outer, null, TOOL, PARAMS.totalDepth, PARAMS.depthPerPass, PARAMS.stepoverPct, PARAMS.safeZ);
    const ms = Date.now() - t0;
    const segs = cuttingSegments(lr.moves);
    const g = measureGouges(segs, region);
    const cov = measureCoverage(segs, region);
    const si = selfIntersectingContours(lr.contours ?? []);
    legacyLine = `legacy: ${g.gouges}/${g.samples} gouge samples, ${cov.pct.toFixed(2)}% uncut, ` +
      `${si} self-intersecting contours, ${lr.failedOffsets?.length ?? 0} failed offsets, ${ms}ms`;
  } catch (e) {
    legacyLine = `legacy: THREW — ${e.message}`;
  }
  console.log(`  ${legacyLine}`);

  // live app engine: same call path the apps use. The app pipeline still
  // drops holes at import, so it is measured against the outer-only region
  // (island support arrives when the apps move to the seams primitive).
  {
    const outerOnly = { outer: region.outer };
    const t0 = Date.now();
    const lv = liveContourPocket(
      region.outer, null, TOOL, PARAMS.totalDepth, PARAMS.depthPerPass, PARAMS.stepoverPct, PARAMS.safeZ);
    const ms = Date.now() - t0;
    const segs = cuttingSegments(lv.moves);
    const g = measureGouges(segs, outerOnly);
    const cov = measureCoverage(segs, outerOnly);
    const si = selfIntersectingContours(lv.contours ?? []);
    const maxPts = Math.max(0, ...(lv.contours ?? []).map(c => c.length));
    console.log(`  live:   ${g.gouges}/${g.samples} gouge samples, ${cov.pct.toFixed(2)}% uncut, ` +
      `${si} self-intersecting contours, max ${maxPts} pts/ring, ${ms}ms` +
      (region.holes ? ' (outer-only: app drops holes)' : ''));
    if (g.gouges > 0) fail(`${name} (live app engine): ${g.gouges} gouge samples`);
    if (cov.pct > 1.0) fail(`${name} (live app engine): ${cov.pct.toFixed(2)}% uncut`);
    if (si > 0) fail(`${name} (live app engine): ${si} self-intersecting contours`);
    // tessellation-compounding guard: iterative offsetting must not balloon
    if (maxPts > 2000) fail(`${name} (live app engine): ${maxPts}-point ring (vertex explosion)`);
    if (ms > 5000) fail(`${name} (live app engine): ${ms}ms generation time`);
  }

  // new
  const t0 = Date.now();
  const nr = generatePocket(region, TOOL, PARAMS);
  const ms = Date.now() - t0;
  const segs = cuttingSegments(nr.moves);
  const g = measureGouges(segs, region);
  const cov = measureCoverage(segs, region);
  const si = selfIntersectingContours(nr.contours);
  console.log(`  seams:  ${g.gouges}/${g.samples} gouge samples, ${cov.pct.toFixed(2)}% uncut, ` +
    `${si} self-intersecting contours, ${nr.stats.levels} levels, ` +
    `${nr.stats.stayDownLinks}/${nr.stats.retractLinks} stay-down/retract links, ${ms}ms`);
  for (const w of nr.warnings) console.log(`  seams warning: ${w}`);

  if (g.gouges > 0) fail(`${name}: ${g.gouges} gouge samples (tool leaves legal region)`);
  else pass(`no gouges (${g.samples} samples)`);
  if (cov.pct > 1.0) fail(`${name}: ${cov.pct.toFixed(2)}% machinable area uncut`);
  else pass(`coverage residual ${cov.pct.toFixed(3)}% ≤ 1%`);
  if (si > 0) fail(`${name}: ${si} self-intersecting output contours`);
  else pass('all output contours simple');
  console.log('');
}

// ------------------------------------------------ open-edge spillover check

console.log('--- open-edge semantics (rect, +x edge open) ---');
{
  const outer = [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }, { x: 1, y: 3 }];
  const r = generatePocket({ outer, edgeTypes: ['wall', 'open', 'wall', 'wall'] }, TOOL, PARAMS);
  let maxX = -Infinity, maxY = -Infinity, minY = Infinity;
  for (const s of cuttingSegments(r.moves)) {
    for (const p of [s.a, s.b]) {
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); minY = Math.min(minY, p.y);
    }
  }
  // tool center must sweep past the open edge (x=4) by ~bitRadius, and stay
  // bitRadius clear of the walls
  if (maxX > 4 + BIT_R - 0.01 && maxX < 4 + BIT_R + 0.01) pass(`sweeps past open edge to x=${maxX.toFixed(3)} (edge 4 + R ${BIT_R})`);
  else fail(`open edge sweep maxX=${maxX.toFixed(3)}, expected ≈ ${4 + BIT_R}`);
  if (maxY <= 3 - BIT_R + 1e-6 && minY >= 1 + BIT_R - 1e-6) pass('walls still respected');
  else fail(`wall violated: y range ${minY.toFixed(3)}..${maxY.toFixed(3)}`);
}
console.log('');

// -------------------------------- raster with islands (live app engine)

console.log('--- raster strategy with islands (donut, live app engine) ---');
{
  const region = { outer: circle(5.5, 5.5, 4.0), holes: [circle(5.5, 5.5, 1.6)] };
  const r = liveRasterPocket(
    region.outer, null, TOOL, PARAMS.totalDepth, PARAMS.depthPerPass,
    PARAMS.stepoverPct, PARAMS.safeZ, region.holes);
  const segs = cuttingSegments(r.moves);
  const g = measureGouges(segs, region);
  const cov = measureCoverage(segs, region);
  console.log(`  raster: ${g.gouges}/${g.samples} gouge samples, ${cov.pct.toFixed(2)}% uncut`);
  if (g.gouges > 0) fail(`raster donut: ${g.gouges} gouge samples (island violated)`);
  else pass(`no gouges (${g.samples} samples) — island respected`);
  // raster discretization leaves slivers between scanlines at curved edges;
  // allow more residual than contour-parallel but not visible-pocket amounts
  if (cov.pct > 2.0) fail(`raster donut: ${cov.pct.toFixed(2)}% machinable area uncut`);
  else pass(`coverage residual ${cov.pct.toFixed(3)}% ≤ 2%`);
}
console.log('');

// ------------------------------------------- compose + verify + post check

console.log('--- compose into a Job, verify, post ---');
{
  const region = { outer: comb(10) };
  const r = generatePocket(region, TOOL, PARAMS);
  const job = {
    units: 'in',
    stock: { w: 12, h: 12, thickness: 0.75 },
    safeZ: PARAMS.safeZ,
    spindleSpeed: 12000,
    tools: { 1: { name: '1/4in endmill' } },
    operations: [{
      name: 'comb pocket (seams/strategies/pocket.js)',
      tool: 1, feedRate: TOOL.feedRate, plungeRate: TOOL.plungeRate,
      moves: r.moves,
    }],
  };
  const composed = composeJob(job);
  const report = verifyJob(job, composed);
  if (report.ok) pass(`verifyJob ok — ${report.stats.moveCount} moves, cut ${report.stats.cutLength}", est ${report.stats.estCutTimeMin} min`);
  else { fail(`verifyJob rejected the pocket op`); for (const e of report.errors.slice(0, 5)) console.log(`    ${e}`); }
  const sbp = postJobToSbp(job, composed, { title: 'Pocket gauntlet — comb' });
  if (sbp.includes('MS,') && sbp.split('\n').length > 100) pass(`posted to SBP (${sbp.split('\n').length} lines)`);
  else fail('SBP post looks wrong');
}

console.log(failures === 0 ? '\nALL POCKET CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
