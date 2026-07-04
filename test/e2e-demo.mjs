// End-to-end seam demo: terrain_carver ⊕ v_engraver → one verified program.
//
// This is the composition the initiative is named for, in its smallest real
// form:
//   - relief op:  REAL terrain_carver kernel output (heightmap → ballnose
//                 raster, kernel/src/toolpath.rs) lowered via passesToMoves
//   - label op:   REAL v_engraver pipeline (computeMedialAxis →
//                 generateVEngraveToolpath) run headless in Node
//   - composed at the moves rail: one program, two tools, one toolchange,
//     placement transforms giving each op a home on shared stock
//   - verified: measured envelope/depth/boundary/footprint checks
//
// Also runs three sabotage cases the verifier MUST catch — the admission
// gate is only credible if it demonstrably rejects bad compositions.
//
// Usage: node test/e2e-demo.mjs   (after: cd test/diff && cargo run --release -- relief)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { passesToMoves, terrainOpInfo } from '../adapters/terrain.js';
import { composeJob, postJobToSbp, postJobToGcode } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

// Real v_engraver modules, via vendor/ symlinks. The symlinks exist because
// v_engraver's package.json says "type":"commonjs" (its modules only ever ran
// in the browser); under seams' package.json they parse as the ESM they are,
// and the bare 'd3-delaunay' specifier resolves from seams/node_modules.
import { computeMedialAxis } from '../vendor/v_engraver/medial-axis.js';
import { generateVEngraveToolpath } from '../vendor/v_engraver/toolpath-gen.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');
mkdirSync(outDir, { recursive: true });

// ---------- operation 1: topo relief (terrain_carver) ----------

const reliefJson = JSON.parse(readFileSync(join(here, 'diff', 'out', 'relief.json'), 'utf8'));
const reliefInfo = terrainOpInfo(reliefJson);

const reliefOp = {
  name: 'topo relief (terrain_carver kernel)',
  tool: 1,
  feedRate: reliefInfo.feedRate,
  plungeRate: reliefInfo.plungeRate,
  units: reliefInfo.units,
  placement: { x: 1.0, y: 1.0 }, // relief's 6x4 work area → (1..7, 1..5) on stock
  moves: passesToMoves(reliefJson),
};

// ---------- operation 2: margin label (v_engraver) ----------
// A lozenge with a diamond hole — real medial-axis V-carve work, op-local
// coords spanning x 0..2, y 0..0.5.

const lozenge = {
  outer: [
    { x: 0.0, y: 0.25 },
    { x: 0.35, y: 0.0 },
    { x: 1.65, y: 0.0 },
    { x: 2.0, y: 0.25 },
    { x: 1.65, y: 0.5 },
    { x: 0.35, y: 0.5 },
  ],
  holes: [
    [
      { x: 0.9, y: 0.25 },
      { x: 1.0, y: 0.15 },
      { x: 1.1, y: 0.25 },
      { x: 1.0, y: 0.35 },
    ],
  ],
};

const vBit = { includedAngle: 90, maxDepth: 0.25 };
const labelMachine = { feedRate: 60, plungeRate: 30, safeZ: 0.5, rpm: 14000 };
const medialAxis = computeMedialAxis([lozenge], {});
const labelMoves = generateVEngraveToolpath(medialAxis, vBit, labelMachine);

const labelOp = {
  name: 'margin label (v_engraver medial-axis V-carve)',
  tool: 2,
  feedRate: labelMachine.feedRate,
  plungeRate: labelMachine.plungeRate,
  placement: { x: 3.0, y: 0.25 }, // bottom margin band, under the relief
  moves: labelMoves,
};

// ---------- the Job ----------

const job = {
  units: 'in',
  stock: { w: 8, h: 6, thickness: 0.75 },
  safeZ: 0.5,
  spindleSpeed: 14000,
  tools: {
    1: { name: '1/4" ballnose' },
    2: { name: '90 deg V-bit' },
  },
  operations: [reliefOp, labelOp],
};

const composed = composeJob(job);
const report = verifyJob(job, composed);

console.log('=== Composed job: topo relief + margin label ===');
console.log(`relief: ${reliefJson.passes.length} passes from real terrain kernel`);
console.log(`label:  ${medialAxis.branches.length} medial-axis branches, ${labelMoves.length} moves from real v_engraver pipeline`);
console.log(`composed: ${composed.length} moves, ${report.stats.toolchangeCount} toolchange(s)`);
console.log('');
console.log('--- Verifier report (measured) ---');
console.log(`ok: ${report.ok}`);
console.log(`bbox: X ${report.stats.bbox.minX.toFixed(3)}..${report.stats.bbox.maxX.toFixed(3)}  Y ${report.stats.bbox.minY.toFixed(3)}..${report.stats.bbox.maxY.toFixed(3)} (stock ${job.stock.w} x ${job.stock.h})`);
console.log(`Z range: ${report.stats.zRange.min.toFixed(3)}..${report.stats.zRange.max.toFixed(3)} (stock bottom ${-job.stock.thickness}, safeZ ${job.safeZ})`);
console.log(`cut length: ${report.stats.cutLength} in   rapid length: ${report.stats.rapidLength} in   est cut time: ${report.stats.estCutTimeMin} min`);
for (const fp of report.stats.footprints) {
  console.log(`footprint [${fp.name}]: ${fp.cuts ? `X ${fp.bbox.minX.toFixed(2)}..${fp.bbox.maxX.toFixed(2)} Y ${fp.bbox.minY.toFixed(2)}..${fp.bbox.maxY.toFixed(2)}` : 'no cutting'}`);
}
report.errors.forEach(e => console.log('ERROR: ' + e));
report.warnings.forEach(w => console.log('warn:  ' + w));

if (!report.ok) {
  console.log('\nverification FAILED — not writing output files');
  process.exit(1);
}

writeFileSync(join(outDir, 'composed.sbp'), postJobToSbp(job, composed, { title: 'Seam demo: topo relief + margin label' }));
writeFileSync(join(outDir, 'composed.nc'), postJobToGcode(job, composed, { title: 'Seam demo: topo relief + margin label' }));
console.log(`\nwrote out/composed.sbp, out/composed.nc`);

// ---------- sabotage cases: the gate must close ----------

console.log('\n=== Sabotage cases (verifier must reject each) ===');
let gateOk = true;

function expectReject(label, brokenJob, brokenMoves, expectFragment) {
  const r = verifyJob(brokenJob, brokenMoves ?? composeJob(brokenJob));
  const caught = !r.ok && r.errors.some(e => e.includes(expectFragment));
  console.log(`${caught ? 'PASS' : 'FAIL'} ${label}`);
  if (!caught) {
    console.log(`  expected error containing "${expectFragment}", got: ${r.errors.join(' | ') || '(no errors)'}`);
    gateOk = false;
  } else {
    console.log(`  caught: ${r.errors.find(e => e.includes(expectFragment))}`);
  }
}

// 1. label moved onto the relief — footprints collide
expectReject(
  'label placed on top of relief',
  { ...job, operations: [reliefOp, { ...labelOp, placement: { x: 3.0, y: 2.5 } }] },
  null,
  'footprints overlap',
);

// 2. stock too thin for the relief depth — cuts through the bottom
expectReject(
  'stock thinner than relief depth',
  { ...job, stock: { ...job.stock, thickness: 0.2 } },
  null,
  'through stock bottom',
);

// 3. hand-mangled program: a rapid that dives below the stock top
expectReject(
  'rapid descending into material',
  job,
  [...composed, { type: 'rapid', x: 4, y: 3, z: -0.1 }],
  'rapid ends below stock top',
);

// 4. label pushed off the stock entirely
expectReject(
  'label placed off the stock',
  { ...job, operations: [reliefOp, { ...labelOp, placement: { x: 7.5, y: 0.25 } }] },
  null,
  'leaves stock envelope',
);

process.exit(gateOk ? 0 : 1);
