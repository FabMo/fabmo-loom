// Engraver gauntlet — the workshop opener app, proven in both directions.
//
// Clean text must produce a verified job; sabotaged motion (a stray cut
// outside the letterforms, a cut through a counter) must be REJECTED with
// measured numbers; impossible requests (text too big for stock, bit
// deeper than stock) must fail before motion is ever generated.
//
// Usage: node examples/engraver/test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngraveJob, DEFAULTS } from './pipeline.mjs';
import { textToRegions } from './text-to-regions.mjs';
import { composeJob } from '../../ir/job.js';
import { verifyJob } from '../../ir/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const buf = readFileSync(join(here, 'assets', 'DejaVuSans-Bold.ttf'));
const FONT = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

// the medial-axis kernel narrates; keep gauntlet output readable
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

// ---------------- 1. counters arrive as holes ----------------

console.log('--- text → regions: counters are holes ---');
{
  const { regions } = quiet(() => textToRegions(FONT, 'Help', { letterHeight: 1 }));
  const holeCounts = regions.map(r => r.holes.length);
  if (regions.length === 4) pass('4 glyph regions for "Help"');
  else fail(`expected 4 regions, got ${regions.length}`);
  if (holeCounts.filter(n => n === 1).length === 2 && holeCounts.filter(n => n === 0).length === 2) {
    pass(`counters of "e" and "p" arrive as holes (hole counts: ${holeCounts.join(',')})`);
  } else fail(`unexpected hole structure: ${holeCounts.join(',')}`);
}

// ---------------- 2. clean job verifies and posts ----------------

console.log('--- clean "Help" → verified SBP ---');
let clean;
{
  clean = quiet(() => buildEngraveJob(FONT, 'Help'));
  const t = clean.report?.stats.targets[0];
  if (clean.ok && t.depthViolations === 0 && t.gouges === 0) {
    pass(`verified: ${t.samples} samples, 0 gouges, 0 depth violations — ` +
      `${clean.report.stats.moveCount} moves, ${clean.report.stats.cutLength}" cut`);
  } else fail(`clean job rejected: ${clean.errors.join(' | ')}`);
  if (clean.sbp?.includes('MS,') && clean.sbp.split('\n').length > 100 && clean.gcode?.includes('G1')) {
    pass(`posted SBP (${clean.sbp.split('\n').length} lines) + G-code`);
  } else fail('posts missing or malformed');
}

// ---------------- 3. sabotage: stray cut outside the letters ----------------

console.log('--- sabotage: stray cut outside the letterforms ---');
{
  const op = clean.job.operations[0];
  const sab = {
    ...clean.job,
    operations: [{
      ...op,
      moves: [...op.moves,
        { type: 'rapid', x: -0.6, y: -0.6 },      // op-local: outside the text bbox
        { type: 'linear', z: -0.05 },
        { type: 'linear', x: -0.2, y: -0.2 },
      ],
    }],
  };
  const report = quiet(() => verifyJob(sab, composeJob(sab)));
  if (!report.ok && report.errors.some(e => e.includes('gouges outside its declared region'))) {
    pass(`rejected: ${report.errors.find(e => e.includes('gouges outside'))}`);
  } else fail(`stray cut not caught (ok=${report.ok}: ${report.errors.join(' | ')})`);
}

// ---------------- 4. sabotage: plowing through the "e" counter ----------------

console.log('--- sabotage: cut through the counter of "e" ---');
{
  // find the counter: centroid of the first region hole
  const { regions } = quiet(() => textToRegions(FONT, 'Help', { letterHeight: 1 }));
  const holed = regions.find(r => r.holes.length === 1);
  const c = holed.holes[0].reduce((a, p) => ({ x: a.x + p.x / holed.holes[0].length, y: a.y + p.y / holed.holes[0].length }), { x: 0, y: 0 });
  const op = clean.job.operations[0];
  const sab = {
    ...clean.job,
    operations: [{
      ...op,
      moves: [...op.moves,
        { type: 'rapid', x: c.x - 0.03, y: c.y },
        { type: 'linear', z: -0.05 },
        { type: 'linear', x: c.x + 0.03, y: c.y },  // straight through the counter
      ],
    }],
  };
  const report = quiet(() => verifyJob(sab, composeJob(sab)));
  if (!report.ok && report.errors.some(e => e.includes('gouges outside its declared region'))) {
    pass(`rejected: a cut through the counter is a gouge outside the letterform region`);
  } else fail(`counter cut not caught (ok=${report.ok}: ${report.errors.join(' | ')})`);
}

// ---------------- 5. impossible requests fail before motion ----------------

console.log('--- impossible requests fail early, with human-sized messages ---');
{
  const big = quiet(() => buildEngraveJob(FONT, 'Congratulations', { letterHeight: 2 }));
  if (!big.ok && big.errors.some(e => e.includes('stock is'))) pass(`too-big text: "${big.errors[0].slice(0, 80)}..."`);
  else fail(`oversized text not caught: ${JSON.stringify(big.errors)}`);

  const deep = quiet(() => buildEngraveJob(FONT, 'Hi', { vBit: { ...DEFAULTS.vBit, maxDepth: 0.6 } }));
  if (!deep.ok && deep.errors.some(e => e.includes('stock thickness'))) pass('bit deeper than stock: caught');
  else fail(`over-deep bit not caught: ${JSON.stringify(deep.errors)}`);
}

// ---------------- 6. descenders, spaces, punctuation ----------------

console.log('--- layout robustness ---');
{
  const r = quiet(() => buildEngraveJob(FONT, 'Jo & py!', { letterHeight: 0.6 }));
  if (r.ok) pass(`"Jo & py!" (space, ampersand, descenders) verifies: ${r.report.stats.moveCount} moves`);
  else fail(`mixed text rejected: ${r.errors.join(' | ')}`);
}

// ---------------- 7. iteration: cut the tag free ----------------
// The "second prompt" feature: an outside profile with a 0.25" buffer and
// rounded corners, composed as a second tool. Two targets, one toolchange,
// and the profile's own sabotage direction.

console.log('--- cutout tag: two tools, two targets, one verified program ---');
{
  const r = quiet(() => buildEngraveJob(FONT, 'Help', { cutout: { enabled: true } }));
  const targets = r.report?.stats.targets ?? [];
  const prof = targets.find(t => t.type === 'profile');
  if (r.ok && targets.length === 2 && prof && prof.intrusionArea === 0 && prof.depthViolations === 0) {
    pass(`verified two-tool job: engrave target + profile target (${prof.samples} samples, 0 intrusion)`);
  } else fail(`cutout job rejected or malformed: ${r.errors.join(' | ')}`);
  const mounts = (r.sbp?.match(/C9/g) ?? []).length;
  if (mounts === 2) pass('SBP carries both tool mounts (C9 × 2)');
  else fail(`expected 2 tool mounts in SBP, found ${mounts}`);

  // sabotage: the endmill wanders INTO the tag body (where the fresh
  // engraving lives) at cutting depth
  const op2 = r.job.operations[1];
  const sab = {
    ...r.job,
    operations: [r.job.operations[0], {
      ...op2,
      moves: [...op2.moves,
        { type: 'rapid', x: 0.5, y: 0.5 },     // op-local: inside the tag
        { type: 'linear', z: -0.3 },
        { type: 'linear', x: 1.2, y: 0.5 },
      ],
    }],
  };
  const report = quiet(() => verifyJob(sab, composeJob(sab), { coverageWarnPct: 100 }));
  if (!report.ok && report.errors.some(e => e.includes('intrudes the part body'))) {
    pass(`rejected: ${report.errors.find(e => e.includes('intrudes')).slice(0, 90)}`);
  } else fail(`tag-body intrusion not caught (ok=${report.ok}: ${report.errors.join(' | ')})`);

  // too-tight: tag + cutter + margins exceed stock → early human-sized error
  const tight = quiet(() => buildEngraveJob(FONT, 'Help', { cutout: { enabled: true }, stock: { w: 4, h: 2, thickness: 0.5 } }));
  if (!tight.ok && tight.errors.some(e => e.includes('tag buffer'))) pass('tag that exceeds stock: caught early with the buffer in the message');
  else fail(`oversized tag not caught: ${JSON.stringify(tight.errors)}`);
}

console.log(failures === 0 ? '\nALL ENGRAVER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
