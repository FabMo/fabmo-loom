// Machinability gate — proven in BOTH directions, with measured numbers.
// Sound jobs pass; a loose small piece, a buried small bit, a cut past the
// flutes and a paper-thin wall are each refused, and the number the gate
// reports is checked against the number the test planned.
// Run: node test/machinability-test.mjs

import { generateProfile } from '../strategies/profile.js';
import { generatePocket } from '../strategies/pocket.js';
import {
  checkMachinability, retentionNeed, pieceMetrics, tabSpecFor, passDepthFor,
  RETENTION, MIN_BRIDGE, REACH_RATIO,
} from '../ir/machinability.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const STRICT = { levels: { reach: 'error', passDepth: 'error', retention: 'error', web: 'error' } };

function job(ops, { thickness = 0.5, tools } = {}) {
  return {
    units: 'in', stock: { w: 40, h: 40, thickness }, safeZ: 0.5, spindleSpeed: 12000,
    tools: tools ?? { 1: { name: '1/4" endmill', diameter: 0.25 } },
    operations: ops,
  };
}
function cutout(ring, { d = 0.25, thickness = 0.5, depthPerPass = 0.25, tabs = null, entry = 'ramp', tool = 1, name = 'cutout' } = {}) {
  const prof = generateProfile({ outer: ring }, { diameter: d }, { side: 'outside', totalDepth: thickness, depthPerPass, safeZ: 0.5, entry, tabs });
  return { name, tool, feedRate: 80, plungeRate: 30, moves: prof.moves, target: { type: 'profile', side: 'outside', rings: [ring], depth: thickness } };
}
function pocket(ring, { d = 0.25, depth = 0.25, depthPerPass = 0.125, tool = 1, name = 'pocket' } = {}) {
  const g = generatePocket({ outer: ring, holes: [] }, { diameter: d }, { stepoverPct: 40, totalDepth: depth, depthPerPass, safeZ: 0.5 });
  return { name, tool, feedRate: 80, plungeRate: 30, moves: g.moves, target: g.target };
}

console.log('retention — which pieces need holding');
{
  const big = pieceMetrics(rect(0, 0, 12, 30)), small = pieceMetrics(rect(0, 0, 2, 2)), strip = pieceMetrics(rect(0, 0, 1, 40));
  ok('a 12 × 30 piece needs nothing with no hold-down declared', !retentionNeed(big).need);
  ok('a 2 × 2 piece needs holding', retentionNeed(small).need, retentionNeed(small).why);
  ok('a 1 × 40 strip needs holding on its width alone (area is over the line)', strip.area > RETENTION.undeclared.area && retentionNeed(strip).need);
  ok('vacuum holds a 4 × 4', !retentionNeed(pieceMetrics(rect(0, 0, 4, 4)), 'vacuum').need);
  ok('vacuum does not hold a 2 × 2', retentionNeed(small, 'vacuum').need);
  ok('a part that is itself fixed down never needs tabs', !retentionNeed(small, 'fixed').need);
  ok('an unknown hold-down name is treated as undeclared', retentionNeed(small, 'magnets').need);
}

console.log('retention — bridges are measured in the motion');
{
  const ring = rect(5, 5, 2, 2);
  const loose = checkMachinability(job([cutout(ring)]), STRICT);
  ok('SABOTAGE: a 2 × 2 piece cut free with no tabs is REFUSED', !loose.ok && loose.errors.some(e => /no tabs/.test(e)), JSON.stringify(loose.errors));
  ok('…and the piece is reported with zero bridges', loose.pieces[0].bridges === 0 && !loose.pieces[0].held, JSON.stringify(loose.pieces));

  const tabbed = checkMachinability(job([cutout(ring, { tabs: tabSpecFor(0.25) })]), STRICT);
  ok('the same piece with tabs sized for the bit passes', tabbed.ok, JSON.stringify(tabbed.errors));
  ok(`…with at least 4 bridges found in the motion (found ${tabbed.pieces[0].bridges})`, tabbed.pieces[0].bridges >= 4);
  ok(`…each standing at least ${MIN_BRIDGE}" across the whole kerf (weakest ${tabbed.pieces[0].weakest}")`, tabbed.pieces[0].weakest >= MIN_BRIDGE);

  // the finding that sized tabSpecFor: a 0.3" tab under a 1/2" bit is cut
  // away along the kerf centre by the bit's own leading and trailing edge
  const half = { 1: { name: '1/2" endmill', diameter: 0.5 } };
  const short = checkMachinability(job([cutout(ring, { d: 0.5, tabs: { height: 0.08, spacing: 6, length: 0.3 } })], { tools: half }), STRICT);
  ok(`SABOTAGE: 0.3" tabs under a 1/2" bit are not bridges — REFUSED (${short.pieces[0].bridges} found)`, !short.ok && short.pieces[0].bridges === 0, JSON.stringify(short.pieces));
  const sized = checkMachinability(job([cutout(ring, { d: 0.5, tabs: tabSpecFor(0.5) })], { tools: half }), STRICT);
  ok(`tabs from tabSpecFor(0.5) hold under the same bit (${sized.pieces[0].bridges} bridges, weakest ${sized.pieces[0].weakest}")`, sized.ok && sized.pieces[0].bridges >= 4);

  const bigLoose = checkMachinability(job([cutout(rect(2, 2, 12, 30))]), STRICT);
  ok('a 12 × 30 piece with no tabs is accepted (big enough to stay put)', bigLoose.ok, JSON.stringify(bigLoose.errors));
  ok('declaring the part fixed down accepts the loose 2 × 2', checkMachinability(job([cutout(ring)]), { ...STRICT, holdDown: 'fixed' }).ok);
  ok('declaring vacuum still refuses the loose 2 × 2', !checkMachinability(job([cutout(ring)]), { ...STRICT, holdDown: 'vacuum' }).ok);

  // a profile that stops short of the bottom frees nothing
  const shallow = generateProfile({ outer: ring }, { diameter: 0.25 }, { side: 'outside', totalDepth: 0.3, depthPerPass: 0.15, safeZ: 0.5 });
  const groove = checkMachinability(job([{ name: 'groove', tool: 1, feedRate: 80, plungeRate: 30, moves: shallow.moves, target: { type: 'profile', side: 'outside', rings: [ring], depth: 0.3 } }]), STRICT);
  ok('a groove that does not go through frees no piece', groove.ok && groove.pieces.length === 0);
}

console.log('pass depth — measured from the replayed cut');
{
  const ring = rect(5, 5, 6, 4);
  for (const step of [0.25, 0.125, 0.1]) {
    const m = checkMachinability(job([cutout(rect(2, 2, 12, 30), { depthPerPass: step })]), STRICT);
    ok(`a ramped cutout planned at ${step}"/pass measures ${m.ops[0].maxPass}"`, near(m.ops[0].maxPass, step, 0.01), `off by ${Math.abs(m.ops[0].maxPass - step).toFixed(4)}`);
  }
  const plunge = checkMachinability(job([cutout(rect(2, 2, 12, 30), { depthPerPass: 0.2, entry: 'plunge' })]), STRICT);
  // 0.5" at "0.2 a pass" is three even passes of 0.1667"
  ok(`a plunge-entry cutout asked for 0.2"/pass over 0.5" measures ${plunge.ops[0].maxPass}" (three even passes)`, near(plunge.ops[0].maxPass, 0.5 / 3, 0.01));
  const pk = checkMachinability(job([pocket(ring, { depth: 0.3, depthPerPass: 0.1 })]), STRICT);
  ok(`a pocket at 0.1"/pass measures ${pk.ops[0].maxPass}" (three levels, not their sum)`, near(pk.ops[0].maxPass, 0.1, 0.01));

  const small = { 1: { name: '1/16" endmill', diameter: 0.0625 } };
  const buried = checkMachinability(job([pocket(rect(5, 5, 1, 1), { d: 0.0625, depth: 0.25, depthPerPass: 0.25 })], { tools: small }), STRICT);
  ok(`SABOTAGE: a 1/16" bit taking 0.25" in one pass is REFUSED (measured ${buried.ops[0].maxPass}", ${(buried.ops[0].maxPass / 0.0625).toFixed(1)}× its diameter)`,
    !buried.ok && buried.errors.some(e => /in one pass/.test(e)) && near(buried.ops[0].maxPass, 0.25, 0.01), JSON.stringify(buried.errors));
  const step = passDepthFor(0.0625, 0.125);
  ok(`passDepthFor(1/16", 0.125) = ${step}" — never more than the bit's diameter`, near(step, 0.0625, 1e-6));
  const fixed = checkMachinability(job([pocket(rect(5, 5, 1, 1), { d: 0.0625, depth: 0.25, depthPerPass: step })], { tools: small }), STRICT);
  ok(`the same pocket at that step passes (measured ${fixed.ops[0].maxPass}")`, fixed.ok, JSON.stringify(fixed.errors));
  ok('a 1/4" bit keeps the strategy step (0.125 stays 0.125, 0.25 stays 0.25)', passDepthFor(0.25, 0.125) === 0.125 && passDepthFor(0.25, 0.25) === 0.25);
  ok(`a declared material tightens it (1/4" in hardwood: ${passDepthFor(0.25, 0.25, 'hardwood')}", aluminum: ${passDepthFor(0.25, 0.25, 'aluminum')}")`,
    near(passDepthFor(0.25, 0.25, 'hardwood'), 0.1, 1e-6) && near(passDepthFor(0.25, 0.25, 'aluminum'), 0.025, 1e-6));

  // a line cut there and back at two depths: the second pass retraces the
  // first and must read ITS floor, not the stock top
  const line = [
    { type: 'rapid', x: 5, y: 5 }, { type: 'linear', z: -0.1 }, { type: 'linear', x: 15, y: 5 },
    { type: 'linear', z: -0.2 }, { type: 'linear', x: 5, y: 5 }, { type: 'rapid', z: 0.5 },
  ];
  const back = checkMachinability(job([{ name: 'score', tool: 1, feedRate: 80, plungeRate: 30, moves: line }]), STRICT);
  ok(`a there-and-back score at 0.1" then 0.2" measures ${back.ops[0].maxPass}" a pass, not 0.2"`, near(back.ops[0].maxPass, 0.1, 0.01));

  // an arc move is replayed along the arc, not its chord
  const arc = [
    { type: 'rapid', x: 10, y: 5 }, { type: 'linear', z: -0.1 },
    { type: 'arc', x: 10, y: 15, i: 0, j: 5, cw: false },
    { type: 'linear', z: -0.2 }, { type: 'arc', x: 10, y: 5, i: 0, j: -5, cw: true }, { type: 'rapid', z: 0.5 },
  ];
  const arcM = checkMachinability(job([{ name: 'arc', tool: 1, feedRate: 80, plungeRate: 30, moves: arc }]), STRICT);
  ok(`a half-circle cut out and back along the same arc measures ${arcM.ops[0].maxPass}" a pass`, near(arcM.ops[0].maxPass, 0.1, 0.01));

  const vee = checkMachinability(job([{ name: 'vcarve', tool: 1, feedRate: 60, plungeRate: 30, moves: line }], { tools: { 1: { name: '60° V-bit', diameter: 0.002 } } }), STRICT);
  ok('a point-model V-bit is not judged by diameter (no pass or reach verdict)', vee.ok && vee.ops[0].maxPass === null && vee.ops[0].reach === null);
}

console.log('reach — the cut must stay within the flutes');
{
  const ring = rect(2, 2, 12, 30);
  const deep = checkMachinability(job([cutout(ring, { thickness: 1.5 })], { thickness: 1.5 }), STRICT);
  ok(`SABOTAGE: 1.5" through with a 1/4" bit (reach ${REACH_RATIO * 0.25}") is REFUSED`, !deep.ok && deep.errors.some(e => /reaches 1\.000/.test(e)), JSON.stringify(deep.errors));
  const long = checkMachinability(job([cutout(ring, { thickness: 1.5 })], { thickness: 1.5, tools: { 1: { name: '1/4" long', diameter: 0.25, maxDepth: 1.75 } } }), STRICT);
  ok('the same cut with a bit that declares 1.75" of cutting length passes', long.ok, JSON.stringify(long.errors));
  const eighth = checkMachinability(job([cutout(ring, { d: 0.125, thickness: 0.75, depthPerPass: 0.125 })], { thickness: 0.75, tools: { 1: { name: '1/8" endmill', diameter: 0.125 } } }), STRICT);
  ok('SABOTAGE: 3/4" through with a 1/8" bit (reach 0.5") is REFUSED', !eighth.ok && eighth.errors.some(e => /shank/.test(e)), JSON.stringify(eighth.errors));
  ok('3/4" through with a 1/4" bit is within reach', checkMachinability(job([cutout(ring, { thickness: 0.75 })], { thickness: 0.75 }), STRICT).ok);
}

console.log('thin webs — material left beside a cut');
{
  const part = rect(5, 5, 12, 12);
  const cut = cutout(part);
  // pocket wall 0.05" from the part edge (pocket region edge at x = 5.05)
  const thin = checkMachinability(job([pocket(rect(5.05, 8, 3, 3), { depth: 0.375, depthPerPass: 0.125 }), cut]), STRICT);
  ok('SABOTAGE: a 3/8"-deep pocket 0.05" from the part edge is REFUSED', !thin.ok && thin.errors.some(e => /of the edge of the part/.test(e)), JSON.stringify(thin.errors));
  const clear = checkMachinability(job([pocket(rect(6, 8, 3, 3), { depth: 0.375, depthPerPass: 0.125 }), cut]), STRICT);
  ok('the same pocket 1" in from the edge passes', clear.ok, JSON.stringify(clear.errors));
  const skin = checkMachinability(job([pocket(rect(5.05, 8, 3, 3), { depth: 0.02, depthPerPass: 0.02 }), cut]), STRICT);
  ok('a 0.02"-deep engraving the same 0.05" from the edge passes (a shallow cut leaves no tall wall)', skin.ok, JSON.stringify(skin.errors));
  const open = checkMachinability(job([pocket(rect(4, 8, 4, 3), { depth: 0.375, depthPerPass: 0.125 }), cut]), STRICT);
  ok('a dado that runs out through the edge is open by design, not a web', !open.errors.some(e => /edge of the part/.test(e)), JSON.stringify(open.errors));
  const pair = checkMachinability(job([
    pocket(rect(7, 8, 2, 2), { depth: 0.375, depthPerPass: 0.125, name: 'left' }),
    pocket(rect(9.04, 8, 2, 2), { depth: 0.375, depthPerPass: 0.125, name: 'right' }), cut]), STRICT);
  ok('SABOTAGE: two 3/8" pockets 0.04" apart are REFUSED', !pair.ok && pair.errors.some(e => /between them/.test(e)), JSON.stringify(pair.errors));
  const apart = checkMachinability(job([
    pocket(rect(7, 8, 2, 2), { depth: 0.375, depthPerPass: 0.125, name: 'left' }),
    pocket(rect(9.5, 8, 2, 2), { depth: 0.375, depthPerPass: 0.125, name: 'right' }), cut]), STRICT);
  ok('the same pockets 1/2" apart pass', apart.ok, JSON.stringify(apart.errors));
}

console.log('levels — a check can be a warning or off');
{
  const ring = rect(5, 5, 2, 2);
  const warn = checkMachinability(job([cutout(ring)]), { levels: { retention: 'warn' } });
  ok('retention at warn: the job passes and the loose piece is a warning', warn.ok && warn.warnings.some(w => /no tabs/.test(w)));
  const off = checkMachinability(job([cutout(ring)]), { levels: { retention: 'off' } });
  ok('retention off: nothing said', off.ok && !off.warnings.length && !off.pieces.length);
}

console.log(`\n${failed ? `${failed} MACHINABILITY CHECK(S) FAILED` : 'machinability gauntlet clean'} (${passed} passed)`);
process.exit(failed ? 1 : 0);
