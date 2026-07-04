// Profile strategy + profile verifier target — proven in BOTH directions.
// A clean part the verifier must accept; a wrong-side / over-deep cut it must
// reject with a measured number. Run: node test/profile-test.mjs

import { generateProfile } from '../strategies/profile.js';
import { composeJob } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) passed++; else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const rectRing = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

// Build a one-op job around a profile of `region`, cutting `side`, declaring a
// `targetSide` profile target at `depth` (defaults follow the cut).
function profileJob({ region, side = 'outside', targetSide = side, depth = 0.5, depthPerPass = 0.25, stock }) {
  const tool = { diameter: 0.25 };
  const { moves } = generateProfile(region, tool, { side, totalDepth: depth, depthPerPass, safeZ: 0.25 });
  const op = {
    name: 'Profile', tool: 1, feedRate: 120, plungeRate: 40,
    target: { type: 'profile', outer: region.outer, holes: region.holes ?? [], side: targetSide, depth },
    moves,
  };
  const job = {
    units: 'in', stock, safeZ: 0.25, spindleSpeed: 12000,
    tools: { 1: { name: '1/4"', diameter: 0.25 } }, operations: [op],
  };
  return verifyJob(job, composeJob(job));
}

const outerRect = { outer: rectRing(1, 1, 12, 30), holes: [] };
const stock = { w: 14, h: 32, thickness: 0.5 };

// --- clean outside profile: accepted, no intrusion --------------------------
{
  const v = profileJob({ region: outerRect, side: 'outside', stock });
  ok('clean outside profile verifies', v.errors.length === 0, JSON.stringify(v.errors));
  const t = v.stats.targets.find((s) => s.type === 'profile');
  ok('profile target recorded with ~zero intrusion', t && t.intrusionArea === 0, JSON.stringify(t));
}

// --- SABOTAGE: cut ON the line but declare an OUTSIDE target -----------------
// An on-the-line cut sweeps one radius into the part body; the keep-out check
// must reject it with a measured intrusion area.
{
  const v = profileJob({ region: outerRect, side: 'on', targetSide: 'outside', stock });
  ok('on-line cut vs outside target is REJECTED', v.errors.length > 0, 'expected an intrusion error');
  ok('rejection names the part-body intrusion',
    v.errors.some((e) => /intrudes the part body/.test(e)), JSON.stringify(v.errors));
}

// --- SABOTAGE: over-deep cut caught by the depth check ----------------------
{
  const v = profileJob({ region: outerRect, side: 'outside', depth: 0.25, depthPerPass: 0.25, stock });
  // cut depth follows `depth`=0.25 here, so deepen the CUT only by overriding:
  const tool = { diameter: 0.25 };
  const { moves } = generateProfile(outerRect, tool, { side: 'outside', totalDepth: 0.6, depthPerPass: 0.3, safeZ: 0.25 });
  const job = {
    units: 'in', stock, safeZ: 0.25, spindleSpeed: 12000, tools: { 1: { name: '1/4"', diameter: 0.25 } },
    operations: [{ name: 'Deep', tool: 1, feedRate: 120, plungeRate: 40, moves,
      target: { type: 'profile', outer: outerRect.outer, holes: [], side: 'outside', depth: 0.25 } }],
  };
  const vv = verifyJob(job, composeJob(job));
  ok('cut deeper than declared depth is REJECTED', vv.errors.some((e) => /below its declared depth/.test(e)),
    JSON.stringify(vv.errors));
}

// --- inside profile (window to size): clean accepted ------------------------
{
  // a 2"-dia round window, cut INSIDE the line, in a big enough part/stock
  const window = { outer: rectRing(0, 0, 0, 0), holes: [] };
  // use a circle region for the window
  const seg = 64, cx = 7, cy = 16, r = 1.0;
  window.outer = Array.from({ length: seg }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / seg), y: cy + r * Math.sin((2 * Math.PI * i) / seg) }));
  const v = profileJob({ region: window, side: 'inside', depth: 0.5, stock });
  ok('clean inside profile verifies', v.errors.length === 0, JSON.stringify(v.errors));
  const t = v.stats.targets.find((s) => s.type === 'profile');
  ok('inside profile target ~zero escape', t && t.intrusionArea === 0, JSON.stringify(t));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
