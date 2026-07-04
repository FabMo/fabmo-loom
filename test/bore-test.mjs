// Bore strategy — bit-clearance holes (the "0.126 hole for a 1/8 bit" CAD
// convention) cut by a center plunge, with an orbit when the slack is real.
import { generateBore } from '../strategies/bore.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const PARAMS = { totalDepth: 0.5, depthPerPass: 0.125, safeZ: 0.5 };

// ---- exact-size hole: plunge only, pecks between passes
{
  const r = generateBore({ centerX: 2, centerY: 3, radius: 0.0625 }, { diameter: 0.125 }, PARAMS);
  const cuts = r.moves.filter(m => m.type === 'linear');
  if (cuts.length && cuts.every(m => approx(m.x, 2) && approx(m.y, 3))) {
    pass(`exact-size hole: ${cuts.length} moves, all on the center axis (no orbit)`);
  } else {
    fail(`exact-size hole: expected pure plunge at center, got ${cuts.length} cuts, off-axis ${
      cuts.filter(m => !approx(m.x, 2) || !approx(m.y, 3)).length}`);
  }
  const bottom = Math.min(...cuts.map(m => m.z));
  if (approx(bottom, -0.5)) pass('reaches full depth -0.5');
  else fail(`bottom at ${bottom}, expected -0.5`);
  const lifts = cuts.filter((m, i) => i && m.z > cuts[i - 1].z).length;
  if (lifts === 3) pass('3 chip-break pecks between 4 passes');
  else fail(`${lifts} pecks, expected 3`);
  if (r.stats.plunges === 4 && r.stats.orbits === 0) pass('stats: 4 plunges, 0 orbits');
  else fail(`stats ${JSON.stringify(r.stats)}, expected 4 plunges / 0 orbits`);
  const maxR = Math.max(...r.target.rings[0].map(p => Math.hypot(p.x - 2, p.y - 3)));
  if (approx(maxR, 0.0625, 1e-6)) pass('target sweeps the bit circle (R=0.0625)');
  else fail(`target radius ${maxR}, expected 0.0625`);
}

// ---- real slack: every depth pass orbits at (radius − R), target = designed hole
{
  const r = generateBore({ centerX: 0, centerY: 0, radius: 0.075 }, { diameter: 0.125 }, PARAMS);
  const cuts = r.moves.filter(m => m.type === 'linear');
  const maxOff = Math.max(...cuts.map(m => Math.hypot(m.x, m.y)));
  if (approx(maxOff, 0.0125, 1e-6)) pass(`orbit radius ${maxOff.toFixed(4)} = designed slack`);
  else fail(`max centerline offset ${maxOff}, expected 0.0125`);
  if (r.stats.orbits === 4) pass('one orbit per depth pass');
  else fail(`${r.stats.orbits} orbits, expected 4`);
  const maxR = Math.max(...r.target.rings[0].map(p => Math.hypot(p.x, p.y)));
  if (approx(maxR, 0.075, 1e-6)) pass('target sweeps the designed hole (R=0.075)');
  else fail(`target radius ${maxR}, expected 0.075`);
}

// ---- sub-orbit slack: plunge cuts bit-size, warning says what stays
{
  const r = generateBore({ centerX: 0, centerY: 0, radius: 0.063 }, { diameter: 0.125 }, PARAMS);
  if (r.moves.length && r.stats.orbits === 0) pass('0.126 hole for a 1/8 bit: plunge, no noise orbit');
  else fail(`expected plunge-only for 0.0005 slack, got ${JSON.stringify(r.stats)}`);
  if (r.warnings.some(w => /slack/.test(w))) pass(`slack warning: ${r.warnings.find(w => /slack/.test(w))}`);
  else fail('no slack warning for the 0.001 designed clearance');
}

// ---- hole a few thou under the bit: the DRILL case — plunge it, warn
// about the graze (the same few-thou tolerance slot-fit grants grooves
// nominally at bit width; 004681's 0.122" drill holes vs the 1/8")
{
  const r = generateBore({ centerX: 0, centerY: 0, radius: 0.061 }, { diameter: 0.125 }, PARAMS);
  if (r.moves.length && r.warnings.some(w => /drill graze/.test(w))) {
    pass('0.122 hole drilled by the 1/8 bit (graze within slot tolerance)');
  } else {
    fail(`expected graze plunge for 0.0015 radial oversize, got ${r.moves.length} moves: ${JSON.stringify(r.warnings)}`);
  }
}

// ---- hole clearly smaller than the bit: refuse — never oversize a
// designed fit beyond the slot-graze tolerance
{
  const r = generateBore({ centerX: 0, centerY: 0, radius: 0.055 }, { diameter: 0.125 }, PARAMS);
  if (!r.moves.length && r.warnings.some(w => /smaller than/.test(w))) {
    pass('undersize hole (7.5 thou radial) refused with a warning');
  } else {
    fail(`undersize hole: expected refusal, got ${r.moves.length} moves`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
