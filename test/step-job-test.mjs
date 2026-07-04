// Step-app job pipeline — headless validation of the residual integration.
//
// Synthetic part (6 x 4 x 0.75): a flat-floor rectangular pocket (what
// feature detection recognizes and the pocket strategy claims), a freeform
// gaussian dish (what detection CANNOT classify — the residual), and the
// outer profile. buildJob must emit pocket + residual-surface + profile
// ops, the surface op must cut ONLY in the dish (not the flat top, not the
// claimed pocket), and the composed program must pass verifier v1 against
// both declared targets. Sabotages: thin stock must be rejected; a feature
// whose depth disagrees with the heightmap must produce the alignment
// warning.
//
// Imports the REAL app module (step_toolpath_app/modules/job-builder.js,
// three-free by design) through its seams symlinks.
//
// Usage: node test/step-job-test.mjs

import { buildJob, depthGridToHeightmap } from '../../step_toolpath_app/modules/job-builder.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

// ---- synthetic part: mimics raycastDepthGrid output (depths positive down)
const SP = 0.02;
const W = 6, H = 4;
const POCKET = { x1: 1, y1: 1, x2: 2.5, y2: 3, depth: 0.25 };
const DISH = { cx: 4.5, cy: 2, r: 1.2, depth: 0.3 };

function partDepth(x, y) {
  if (x >= POCKET.x1 && x <= POCKET.x2 && y >= POCKET.y1 && y <= POCKET.y2) return POCKET.depth;
  const d = Math.hypot(x - DISH.cx, y - DISH.cy);
  if (d < DISH.r) return DISH.depth * Math.exp(-(d * d) / (2 * 0.45 * 0.45));
  return 0;
}

const gridW = Math.round(W / SP) + 1;
const gridH = Math.round(H / SP) + 1;
const depths = new Float32Array(gridW * gridH);
for (let r = 0; r < gridH; r++) {
  for (let c = 0; c < gridW; c++) {
    depths[r * gridW + c] = partDepth(c * SP, r * SP);
  }
}
const depthGrid = {
  depths, gridW, gridH, spacing: SP,
  min: { x: 0, y: 0, z: 0 }, max: { x: W, y: 0.75, z: H },
  topY: 0.75, depthRange: 0.75,
};

const rectRing = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
const FEATURES = [
  { type: 'pocket', contour: rectRing(POCKET.x1, POCKET.y1, POCKET.x2, POCKET.y2), depth: POCKET.depth, selected: true, label: 'flat pocket' },
  { type: 'profile', contour: rectRing(0, 0, W, H), depth: 0.75, selected: true, label: 'outer profile' },
];
const PARAMS = {
  diameter: 0.25, depthPerPass: 0.125, feedRate: 100, plungeRate: 30,
  safeZ: 0.5, rpm: 18000, stockThickness: 0.75, stepoverPct: 40,
};

console.log('=== step-app job pipeline: pocket + residual dish + profile ===\n');

const built = buildJob(FEATURES, depthGrid, PARAMS);
for (const w of built.warnings) console.log(`  warning: ${w}`);

// ---- op inventory
{
  const { info } = built;
  if (built.job && info.pocketOps === 1 && info.surfaceOps === 1 && info.profileOps === 1) {
    pass(`3 ops emitted: ${info.pocketOps} pocket, ${info.surfaceOps} residual surface, ${info.profileOps} profile`);
  } else {
    fail(`wrong op inventory: ${JSON.stringify(info)}`);
  }
  // residual = footprint (24) − claimed pocket (3)
  if (info.residualArea > 20.5 && info.residualArea < 21.5) {
    pass(`residual area ${info.residualArea} sq in ≈ footprint 24 − claimed 3`);
  } else {
    fail(`residual area ${info.residualArea}, expected ≈ 21`);
  }
}

// ---- the surface op cuts ONLY in the dish (active-run skipping + mask)
{
  const surf = built.job.operations.find(o => o.name.includes('residual surface'));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, cuts = 0;
  let pos = { x: 0, y: 0, z: PARAMS.safeZ };
  for (const m of surf.moves) {
    if (m.type === 'comment') continue;
    const next = { x: m.x ?? pos.x, y: m.y ?? pos.y, z: m.z ?? pos.z };
    if (m.type === 'linear' && (next.z < -1e-9 || pos.z < -1e-9)) {
      cuts++;
      for (const p of [pos, next]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    pos = next;
  }
  const slack = 0.25 / 2 + 2 * SP; // tool radius + grid slack
  const inDish = minX > DISH.cx - DISH.r - slack && maxX < DISH.cx + DISH.r + slack &&
                 minY > DISH.cy - DISH.r - slack && maxY < DISH.cy + DISH.r + slack;
  if (cuts > 0 && inDish) {
    pass(`surface op cuts only the dish: ${cuts} cutting moves in (${minX.toFixed(2)}..${maxX.toFixed(2)}, ${minY.toFixed(2)}..${maxY.toFixed(2)})`);
  } else {
    fail(`surface op strayed: bbox (${minX.toFixed(2)}..${maxX.toFixed(2)}, ${minY.toFixed(2)}..${maxY.toFixed(2)}), ${cuts} cuts (dish at ${DISH.cx}±${DISH.r}, ${DISH.cy}±${DISH.r})`);
  }
}

// ---- composed program passes verifier v1 against both targets
{
  const composed = composeJob(built.job);
  const report = verifyJob(built.job, composed);
  const pocketT = report.stats.targets.find(t => t.type === 'region');
  const surfT = report.stats.targets.find(t => t.type === 'heightmap');
  if (report.ok && pocketT?.gouges === 0 && surfT?.gouges === 0 && surfT?.maskViolations === 0) {
    pass(`verifyJob ok — ${report.stats.moveCount} moves, ` +
      `pocket 0/${pocketT.samples} gouges, surface 0/${surfT.samples} gouges, cut ${report.stats.cutLength}"`);
  } else {
    fail(`composed job rejected (ok=${report.ok})`);
    for (const e of report.errors.slice(0, 5)) console.log(`    ${e}`);
  }
  // T1 pocket → T2 surface → T1 profile: the cut-through profile must come
  // LAST (the part comes free), so the tool comes back — 3 changes is right
  if (report.stats.toolchangeCount === 3) pass('three toolchanges (T1 pockets → T2 surface → T1 profile-last)');
  else fail(`expected 3 toolchanges (profile last), got ${report.stats.toolchangeCount}`);

  const sbp = postJobToSbp(built.job, composed, { title: 'step-app residual integration test' });
  if (sbp.includes('&Tool = 2') && sbp.split('\n').length > 200) pass(`posts to SBP (${sbp.split('\n').length} lines)`);
  else fail('SBP post looks wrong');
}

// ---- positive frame: X0 Y0 at stock corner, preview shift returned
{
  const composed = composeJob(built.job);
  let minX = Infinity, minY = Infinity;
  let pos = { x: 0, y: 0, z: 0 };
  for (const m of composed) {
    if (m.x !== undefined) { pos.x = m.x; minX = Math.min(minX, pos.x); }
    if (m.y !== undefined) { pos.y = m.y; minY = Math.min(minY, pos.y); }
  }
  if (minX >= -1e-6 && minY >= -1e-6 && built.composedShift.x > 0) {
    pass(`job normalized to positive frame (min ${minX.toFixed(3)}, ${minY.toFixed(3)}; shift ${built.composedShift.x.toFixed(2)}, ${built.composedShift.y.toFixed(2)})`);
  } else {
    fail(`negative coordinates in composed program: ${minX.toFixed(3)}, ${minY.toFixed(3)}`);
  }
}

// ---- sabotage: stock thinner than the pocket — verifier must reject
{
  const thin = buildJob(FEATURES, depthGrid, { ...PARAMS, stockThickness: 0.2 });
  const report = verifyJob(thin.job, composeJob(thin.job));
  if (!report.ok && report.errors.some(e => e.includes('stock bottom'))) {
    pass(`thin stock rejected: ${report.errors.find(e => e.includes('stock bottom'))}`);
  } else {
    fail('thin stock NOT rejected');
  }
}

// ---- misaligned feature: declared depth disagrees with the heightmap
{
  const badFeatures = [
    { ...FEATURES[0], depth: 0.5, label: 'wrong-depth pocket' },
    FEATURES[1],
  ];
  const bad = buildJob(badFeatures, depthGrid, PARAMS);
  if (bad.warnings.some(w => w.includes('alignment') || w.includes('heightmap reads'))) {
    pass(`alignment self-check fired: ${bad.warnings.find(w => w.includes('heightmap reads'))}`);
  } else {
    fail('feature/heightmap depth mismatch NOT flagged');
  }
}

console.log(failures === 0 ? '\nALL STEP-JOB CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
