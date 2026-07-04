// Modeled-chamfer detection + end-to-end routing test.
//
// Builds a synthetic chamfered box mesh (2 x 2 x 0.6, 45° x 0.125 chamfer
// around the top rim, mitered corners — the canonical CAD chamfer), then:
//   1. detectChamferFeatures must find exactly ONE closed 45°/0.125 chain
//      riding the outer rim, material to the left of travel
//   2. buildJob must route it to the chamfer strategy: V-bit op when the
//      tool library has a 90° bit, ballnose-sim op when it doesn't
//   3. both jobs must compose, VERIFY (against the real raycast heightmap —
//      the modeled face is already in the geometry), and post
//
// Same import scheme as step-real-test.mjs (app modules through the
// node_modules symlink).

import * as THREE from 'three';
import { detectChamferFeatures } from '../../step_toolpath_app/modules/chamfer-detection.js';
import { raycastDepthGrid, detectProfileFromDepthGrid } from '../../step_toolpath_app/modules/depth-map.js';
import { buildJob } from '../../step_toolpath_app/modules/job-builder.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

// ---- synthetic chamfered box -------------------------------------------
// Three.js coords: Y up. Box [0,2]x[0,2] plan, 0.6 thick, top at y=0.6.
// 45° chamfer, 0.125 legs: top face inset to [0.125,1.875]², band from the
// inset rim down to the outer rim at y=0.475, walls below, bottom face.
function chamferedBox() {
  const T = 0.6, W = 0.125, YB = T - W;   // band bottom height
  const tris = [];
  // outward winding matters: raycastDepthGrid intersects front faces only
  // (real STEP meshes arrive consistently wound; this one must match)
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };

  // top (inset square), +y normal
  quad([0.125, T, 0.125], [0.125, T, 1.875], [1.875, T, 1.875], [1.875, T, 0.125]);
  // chamfer band: 4 mitered trapezoids — bottom edge runs CCW around the
  // part, then up to the inset top edge (outward up-tilted normals)
  const rim = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const ins = [[0.125, 0.125], [1.875, 0.125], [1.875, 1.875], [0.125, 1.875]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad([rim[i][0], YB, rim[i][1]], [ins[i][0], T, ins[i][1]],
         [ins[j][0], T, ins[j][1]], [rim[j][0], YB, rim[j][1]]);
    // walls below, outward normals
    quad([rim[i][0], 0, rim[i][1]], [rim[i][0], YB, rim[i][1]],
         [rim[j][0], YB, rim[j][1]], [rim[j][0], 0, rim[j][1]]);
  }
  // bottom, −y normal
  quad([0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]);

  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, k) => pos.set(v, i * 9 + k * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo));
  group.updateMatrixWorld(true);
  return group;
}

console.log('\n=== modeled chamfer: detection ===\n');
const mesh = chamferedBox();
const depthGrid = raycastDepthGrid(mesh);
const chamfers = detectChamferFeatures(mesh, depthGrid);

if (chamfers.length === 1) pass('exactly one chamfer feature detected');
else fail(`expected 1 chamfer feature, got ${chamfers.length}: ${chamfers.map(c => c.label).join(', ')}`);

const cf = chamfers[0];
if (cf) {
  if (cf.edge.closed) pass('chain is closed');
  else fail('chain not closed');
  if (Math.abs(cf.width - 0.125) < 0.005) pass(`width ${cf.width}`);
  else fail(`width ${cf.width} != 0.125`);
  if (Math.abs(cf.angleDeg - 45) < 1) pass(`face angle ${cf.angleDeg}°`);
  else fail(`angle ${cf.angleDeg} != 45`);
  // chain must ride the OUTER rim (the original corner line in plan)
  const onRim = cf.edge.points.every(p =>
    Math.min(Math.abs(p.x), Math.abs(p.x - 2), Math.abs(p.y), Math.abs(p.y - 2)) < 0.01);
  if (onRim) pass(`chain rides the outer rim (${cf.edge.points.length} pts after simplify)`);
  else fail(`chain strays off the rim: ${JSON.stringify(cf.edge.points.slice(0, 4))}`);
  // material left of travel ⇒ CCW for an outer rim
  let area = 0;
  const pts = cf.edge.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  if (area > 0) pass('chain oriented CCW (material left)');
  else fail('chain wound CW — material side wrong');
}

// ---- e2e: detection → buildJob → verify, both tool modes ---------------
const profile = detectProfileFromDepthGrid(depthGrid, mesh);
const features = [
  ...chamfers.map(c => ({ ...c, selected: true, autoDetected: true })),
  ...(profile ? [{ type: 'profile', ...profile, selected: true, autoDetected: true }] : []),
];
const PARAMS = {
  diameter: 0.25, depthPerPass: 0.125, feedRate: 100, plungeRate: 30,
  rpm: 18000, safeZ: 0.5, stockThickness: 0.6, stepoverPct: 40,
};

for (const [mode, toolLibrary] of [
  ['90° V-bit', { veeBits: [{ angleDeg: 90, diameter: 0.5 }] }],
  ['ballnose fallback', { veeBits: [] }],
]) {
  console.log(`\n=== modeled chamfer e2e: ${mode} ===\n`);
  const built = buildJob(features, depthGrid, { ...PARAMS, toolLibrary });
  for (const w of built.warnings) console.log(`  warning: ${w}`);
  if (!built.job) { fail(`buildJob produced no job (${mode})`); continue; }
  if (built.info.chamferOps === 1) pass('one chamfer op emitted');
  else fail(`expected 1 chamfer op, got ${built.info.chamferOps}`);
  const op = built.job.operations.find(o => o.name.includes('(chamfer'));
  const expectVee = toolLibrary.veeBits.length > 0;
  if (expectVee ? /V-bit/.test(op.name) : /ballnose sim/.test(op.name)) pass(`tool selection: ${op.name}`);
  else fail(`wrong tool mode: ${op.name}`);
  if (expectVee) {
    const t = built.job.tools[op.tool];
    if (t?.kind === 'vee' && t.angleDeg === 90) pass(`tool table has T${op.tool}: ${t.name}`);
    else fail(`tool table entry wrong: ${JSON.stringify(t)}`);
  }
  const lastOp = built.job.operations[built.job.operations.length - 1];
  if (/profile/i.test(lastOp.name)) pass('profile still last');
  else fail(`last op is ${lastOp.name}`);

  const composed = composeJob(built.job);
  const report = verifyJob(built.job, composed);
  for (const e of report.errors) console.log(`  verify error: ${e}`);
  if (report.ok) pass(`VERIFIED (${report.stats.targets.length} targets, ${report.stats.toolchangeCount} toolchanges)`);
  else fail(`verification failed (${mode})`);
  if (report.ok) {
    const sbp = postJobToSbp(built.job, composed, { title: `chamfer e2e ${mode}` });
    if (sbp.includes('M3')) pass(`SBP posted: ${sbp.split('\n').length} lines`);
    else fail('SBP has no motion');
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
