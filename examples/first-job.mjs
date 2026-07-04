// FabMo Loom — your first job, end to end.
//
// Pocket a rounded rectangle with a circular island, on a 1/4" endmill:
//   strategy → moves → Job → compose → VERIFY → post (.sbp + .nc)
//
// Everything below the verifier is deterministic code. Nothing is exported
// until the verifier has measured the motion against what the operation
// *declared* it would machine. That gate is the whole point of Loom.
//
// Run:  node examples/first-job.mjs
// Out:  examples/out/first-job.sbp  examples/out/first-job.nc

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePocket } from '../strategies/pocket.js';
import { composeJob, postJobToSbp, postJobToGcode } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

// ---------------------------------------------------------------- geometry
// Regions are polygons: { outer: ring, holes?: [ring, ...] } in inches,
// origin at the stock's bottom-left corner, CCW outer / any winding holes.

function roundedRect(x, y, w, h, r, seg = 8) {
  const ring = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);      // bottom-right
  corner(x + w - r, y + h - r, 0);             // top-right
  corner(x + r, y + h - r, Math.PI / 2);       // top-left
  corner(x + r, y + r, Math.PI);               // bottom-left
  return ring;
}

function circle(cx, cy, r, n = 64) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return ring;
}

const region = {
  outer: roundedRect(1, 1, 4, 3, 0.5),
  holes: [circle(3, 2.5, 0.6)],          // an island the pocket must respect
};

// ---------------------------------------------------------------- strategy
// A strategy is (form, tool, params) → { moves, target, warnings, stats }.
// `target` is the op's DECLARATION: the swept footprint + depth it claims.
// The verifier will check the motion against it with independent geometry.

const tool = { diameter: 0.25 };
const pocket = generatePocket(region, tool, {
  stepoverPct: 40,
  totalDepth: 0.375,
  depthPerPass: 0.125,
  safeZ: 0.5,
});

// ---------------------------------------------------------------- the Job
// A Job is the unit of composition. The composer owns ALL program-level
// motion (retracts, toolchanges, feeds); an op's moves are mid-program.

const job = {
  units: 'in',
  stock: { w: 6, h: 5, thickness: 0.75 },   // Z=0 is the stock TOP
  safeZ: 0.5,
  spindleSpeed: 12000,
  tools: { 1: { name: '1/4in endmill', diameter: 0.25 } },
  operations: [{
    name: 'rounded-rect pocket with island',
    tool: 1,
    feedRate: 100,      // in/min
    plungeRate: 30,
    moves: pocket.moves,
    target: pocket.target,
  }],
};

// ------------------------------------------------------- compose + verify
const composed = composeJob(job);
const report = verifyJob(job, composed);

console.log('verifier says:', report.ok ? 'OK' : 'REJECTED');
for (const w of report.warnings) console.log('  warn:', w);
const t = report.stats.targets[0];
console.log(`  gouge samples: ${t.gouges}/${t.samples}`);
console.log(`  coverage residual: ${t.coverageResidualPct}%`);
console.log(`  moves: ${report.stats.moveCount}, cut length: ${report.stats.cutLength}", est ${report.stats.estCutTimeMin} min`);

if (!report.ok) {
  for (const e of report.errors) console.log('  error:', e);
  process.exit(1);
}

// The gate: post ONLY what verified. Numbers, not vibes.
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'first-job.sbp'),
  postJobToSbp(job, composed, { title: 'Loom first job' }));
fs.writeFileSync(path.join(outDir, 'first-job.nc'),
  postJobToGcode(job, composed, { title: 'Loom first job' }));
console.log('\nwrote examples/out/first-job.sbp and .nc');

// ------------------------------------------------- see the gate slam shut
// Sabotage: one stray cut outside the declared region. A naive exporter
// would ship it. The verifier measures it and refuses.

const sabotaged = {
  ...job,
  operations: [{
    ...job.operations[0],
    name: 'sabotaged pocket',
    moves: [...pocket.moves,
      { type: 'rapid', x: 5.5, y: 4.5 },
      { type: 'linear', z: -0.2 },
      { type: 'linear', x: 5.9, y: 4.9 },   // gouge, well outside the pocket
    ],
  }],
};
const badReport = verifyJob(sabotaged, composeJob(sabotaged));
console.log('\nsabotage (stray cut outside the declared region):',
  badReport.ok ? 'NOT CAUGHT — this is a bug, file it!' : 'REJECTED');
for (const e of badReport.errors.slice(0, 3)) console.log('  error:', e);
process.exit(badReport.ok ? 1 : 0);
