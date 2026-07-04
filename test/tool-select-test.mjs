// tool-select gauntlet — the coverage/knee machinery that decides which
// bit machines which feature, plus generatePocket's slot-fit fallback and
// reachable-footprint targets that make partial machinability honest.
//
// Usage: node test/tool-select-test.mjs

import {
  coverageCurve, pickKnee, reachablePaths, regionArea,
  formatDiameter, KNEE_DEFAULTS,
} from '../strategies/tool-select.js';
import { generatePocket, SLOT_GRAZE, signedArea } from '../strategies/pocket.js';

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

const circle = (cx, cy, r, n = 96) =>
  Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((2 * Math.PI * i) / n),
    y: cy + r * Math.sin((2 * Math.PI * i) / n),
  }));

// ---- pickKnee on synthetic curves (the criteria, isolated) ----------------
console.log('\n== pickKnee: knee-of-the-curve criteria ==');
{
  // Brian's canonical example: 1/4 blind, 1/8 25%, 1/16 85%, 1/32 95% —
  // the 1/16 is the knee; the 1/32's +10% on a small feature isn't worth it.
  const curve = [
    { diameter: 0.25, frac: 0 },
    { diameter: 0.125, frac: 0.25 },
    { diameter: 0.0625, frac: 0.85 },
    { diameter: 0.03125, frac: 0.95 },
  ];
  const i = pickKnee(curve, 0.5);
  check(i === 2, `0/25/85/95 on a 0.5 sq in feature → 1/16" (got ${curve[i]?.diameter})`);
}
{
  // sharp-corner trap: the big bit already covers 97% — no smaller bit
  // earns a toolchange for the last slivers
  const curve = [
    { diameter: 0.25, frac: 0.97 },
    { diameter: 0.125, frac: 0.99 },
    { diameter: 0.0625, frac: 0.998 },
  ];
  const i = pickKnee(curve, 0.8);
  check(i === 0, `97/99/99.8 → stay with 1/4" (got ${curve[i]?.diameter})`);
}
{
  // absolute-area override: 6% more of a 10 sq in pocket is 0.6 sq in of
  // real material — worth it even below the relative threshold
  const curve = [
    { diameter: 0.25, frac: 0.90 },
    { diameter: 0.125, frac: 0.96 },
  ];
  const i = pickKnee(curve, 10);
  check(i === 1, `90→96% of 10 sq in → take the 1/8" (got ${curve[i]?.diameter})`);
}
{
  // same 6% on a small feature: not worth it
  const curve = [
    { diameter: 0.25, frac: 0.90 },
    { diameter: 0.125, frac: 0.96 },
  ];
  const i = pickKnee(curve, 0.5);
  check(i === 0, `90→96% of 0.5 sq in → stay with 1/4" (got ${curve[i]?.diameter})`);
}
{
  // excluded entries (depth-gated or user-vetoed) are invisible to the walk
  const curve = [
    { diameter: 0.25, frac: 0 },
    { diameter: 0.125, frac: 0.9, excluded: 'vetoed' },
    { diameter: 0.0625, frac: 0.97 },
  ];
  const i = pickKnee(curve, 0.5);
  check(i === 2, `vetoed 1/8 is skipped → 1/16 (got ${curve[i]?.diameter})`);
}
{
  // nothing earns a cut: unmachinable feature
  const i = pickKnee([{ diameter: 0.25, frac: 0 }, { diameter: 0.125, frac: 0.005 }], 0.2);
  check(i === -1, 'all-noise coverage → no bit picked');
}
{
  // doneAt: once covered, stop — even if a smaller bit would gain "enough"
  const curve = [
    { diameter: 0.25, frac: 0.99 },
    { diameter: 0.03125, frac: 1.0 },
  ];
  const i = pickKnee(curve, 100);
  check(i === 0, `99% is done — the last 1 sq in of a huge pocket doesn't summon the 1/32 (got ${curve[i]?.diameter})`);
}

// ---- coverage on real geometry --------------------------------------------
console.log('\n== coverageCurve: annular groove (indicator-light style) ==');
{
  // 0.125-wide annular groove: exactly a 1/8" slot. The 1/4 is blind; the
  // 1/8 owns it via the slot graze.
  const region = { outer: circle(0, 0, 1.5), holes: [circle(0, 0, 1.375)] };
  const curve = coverageCurve(region, 0.4, [
    { diameter: 0.25 }, { diameter: 0.125, maxDepth: 0.5 },
  ]);
  check(curve[0].frac === 0, `1/4" cannot reach the 1/8-wide groove (frac=${curve[0].frac})`);
  check(curve[1].frac > 0.9, `1/8" covers the groove via slot fit (frac=${curve[1].frac.toFixed(3)})`);
  const i = pickKnee(curve, regionArea(region));
  check(i === 1, 'knee picks the 1/8"');
}
{
  // depth gate: a 1/16 bit with no declared reach is assumed 4x diameter
  // (0.25) — it may NOT be assigned a 0.32-deep groove; declaring
  // "1/16 x 0.4" unlocks it
  const region = { outer: circle(0, 0, 1.0), holes: [circle(0, 0, 0.9375)] }; // 1/16-wide groove
  const implicit = coverageCurve(region, 0.32, [{ diameter: 0.0625 }]);
  check(implicit[0].excluded === 'depth', `default maxDepth ${KNEE_DEFAULTS.depthRatio}x diameter excludes 1/16 at 0.32 deep`);
  const declared = coverageCurve(region, 0.32, [{ diameter: 0.0625, maxDepth: 0.4 }]);
  check(!declared[0].excluded && declared[0].frac > 0.5, `1/16 x 0.4 reaches it (frac=${declared[0].frac.toFixed(3)})`);
}

// ---- generatePocket: slot-fit fallback -------------------------------------
console.log('\n== generatePocket: slot fit + reachable target ==');
{
  // groove 0.0035 narrower than the bit (tessellation noise scale): the
  // old strict inset dropped it; slot fit cuts the centerline
  const w = 0.125 - 0.0035;
  const region = { outer: circle(0, 0, 1.0 + w / 2), holes: [circle(0, 0, 1.0 - w / 2)] };
  const r = generatePocket(region, { diameter: 0.125 },
    { stepoverPct: 40, totalDepth: 0.3, depthPerPass: 0.125, safeZ: 0.5 });
  check(r.moves.filter(m => m.type === 'linear').length > 50,
    `slot-width groove gets a centerline pass (${r.moves.length} moves)`);
  check(r.warnings.some(w2 => w2.includes('slot fit')), 'slot-fit warning emitted');
  // the pass must ride the centerline: every cutting move ~1.0 from center
  const bad = r.moves.filter(m =>
    m.type === 'linear' && m.x !== undefined &&
    Math.abs(Math.hypot(m.x, m.y) - 1.0) > SLOT_GRAZE + 1e-6);
  check(bad.length === 0, `centerline stays mid-groove (${bad.length} strays)`);
}
{
  // a groove clearly narrower than the bit still refuses (no gouging slots)
  const region = { outer: circle(0, 0, 1.05), holes: [circle(0, 0, 0.975)] }; // 0.075 wide
  const r = generatePocket(region, { diameter: 0.125 },
    { stepoverPct: 40, totalDepth: 0.2, depthPerPass: 0.125, safeZ: 0.5 });
  check(r.moves.length === 0 && r.warnings.some(w2 => w2.includes('too small')),
    'clearly-undersized groove still refused');
}
{
  // reachable target: a C-channel about as wide as the bit — the op must
  // claim only what it actually cuts, leaving the rest to the residual
  const outerR = 0.85, innerR = 0.55; // 0.30-wide channel, 0.25 bit → thin spine
  const n = 64, gap = Math.PI / 8;    // slit so it's a C, not a ring
  const arc = (r, a0, a1) => Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const region = { outer: [...arc(outerR, gap, 2 * Math.PI - gap), ...arc(innerR, 2 * Math.PI - gap, gap)] };
  const r = generatePocket(region, { diameter: 0.25 },
    { stepoverPct: 40, totalDepth: 0.25, depthPerPass: 0.125, safeZ: 0.5 });
  const declared = r.target.rings.reduce((a, ring) => a + Math.abs(signedArea(ring)), 0);
  const total = regionArea(region);
  check(r.moves.length > 0, `channel cuts (${r.moves.length} moves)`);
  check(declared < total * 0.995 + 1e-9,
    `target claims the reachable footprint, not the whole channel (${declared.toFixed(3)} < ${total.toFixed(3)} sq in)`);
  // and the reachable footprint math agrees with what the op declares
  const reach = reachablePaths(region, 0.25);
  check(reach.length > 0, 'reachablePaths sees the same machinable spine');
}

// ---- labels ----------------------------------------------------------------
console.log('\n== formatDiameter ==');
check(formatDiameter(0.25) === '1/4"' && formatDiameter(0.125) === '1/8"' &&
  formatDiameter(0.0625) === '1/16"' && formatDiameter(0.5) === '1/2"' &&
  formatDiameter(0.375) === '3/8"' && formatDiameter(1) === '1"' &&
  formatDiameter(0.2) === '0.2"', 'shop-talk bit names');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
