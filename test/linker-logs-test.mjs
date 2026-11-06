// Linker Logs gauntlet — the notched play-plank kit proven in BOTH directions.
//
//   geometry   the plank outline against Bill Young's drawing, checked by
//              brute force here (own point-in-polygon, own area formula) —
//              nothing shared with the generator
//   clean      a plank's cut is accepted by verifyJob AND by an independent
//              check that no cutting vertex comes within a bit radius of the
//              part, and that the bit really reaches into every relief
//   sabotage   a cut made for one plank against another's outline, and two
//              planks nested closer than their kerfs, are REJECTED with
//              measured numbers
//   kit        the verb's own layout: every plank on a sheet, none closer
//              than two kerfs and a web, the refusals named
//
// Run: node test/linker-logs-test.mjs

import { generateProfile } from '../strategies/profile.js';
import { composeJob } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';
import { plankRing, connectorRing, towerPlan, LINKER_LOG_ENTRIES, BILLS_SHEET, BILLS_CONNECTORS } from '../app/linkerlogs.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- independent geometry helpers (deliberately not the app's) ----
const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const signedArea = (ring) => ring.reduce((s, a, i) => { const b = ring[(i + 1) % ring.length]; return s + a.x * b.y - b.x * a.y; }, 0) / 2;
const distToRing = (ring, x, y) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
};

// Bill's drawing, as measured from his DXFs (1/2" plywood, 0.50" slots)
const BILL = { width: 3.5, pitch: 6, endMargin: 2.25, slotW: 0.5, depth: 0.87, reliefR: 0.19, cornerR: 0.25 };

// ---------------- 1. geometry ----------------
console.log('--- linker logs: plank geometry ---');
{
  const lengths = { 1: 4.5, 2: 10.5, 4: 22.5, 6: 34.5, 8: 46.5 };
  const got = Object.keys(lengths).map(n => plankRing({ ...BILL, notches: +n }).length);
  ok('plank lengths for 1 / 2 / 4 / 6 / 8 notches are 4.5 / 10.5 / 22.5 / 34.5 / 46.5 (Bill\'s five planks)',
    got.every((L, i) => Math.abs(L - Object.values(lengths)[i]) < 1e-9), got.join(', '));

  const { ring, length: L, centres } = plankRing({ ...BILL, notches: 2 });
  const W = BILL.width, { slotW: s, depth: d, reliefR: r, cornerR: cr } = BILL;
  ok('the ring is counter-clockwise and stays inside the plank\'s 10.5 × 3.5 box',
    signedArea(ring) > 0 && ring.every(q => q.x > -1e-9 && q.x < L + 1e-9 && q.y > -1e-9 && q.y < W + 1e-9));
  ok('notch centres sit 2.25" from each end, 6" apart', centres.length === 2 && Math.abs(centres[0] - 2.25) < 1e-9 && Math.abs(centres[1] - 8.25) < 1e-9, centres.join(', '));

  // analytic area: the box, less the four corner rounds, less per notch the
  // slot (s × d) and the two half-disc reliefs (π r²)
  const analytic = L * W - (4 - Math.PI) * cr * cr - 2 * centres.length * (s * d + Math.PI * r * r);
  const area = signedArea(ring);
  ok(`area ${area.toFixed(4)} sq in matches the drawing's ${analytic.toFixed(4)} within 0.01, and errs on the side of MORE relief, never less`,
    Math.abs(area - analytic) < 0.01 && area <= analytic + 1e-6, `diff ${(area - analytic).toFixed(5)}`);

  // probes: void where a mating plank and the bit must pass, wood where the joint bears
  const c = centres[0];
  const probes = [
    ['the notch mouth (bottom edge)', c, 0.05, false],
    ['just above the notch floor', c, d - 0.01, false],
    ['just below the notch floor is wood (the web)', c, d + 0.01, true],
    ['the middle of the web', c, W / 2, true],
    ['the notch mouth (top edge)', c, W - 0.05, false],
    ['inside the left relief, outside the slot wall', c - s / 2 - r + 0.02, d - r, false],
    ['inside the right relief', c + s / 2 + r - 0.02, d - r, false],
    ['the cheek beside the slot above the relief is wood', c - s / 2 - 0.02, d - 2 * r - 0.03, true],
    ['beyond the relief is wood', c - s / 2 - r - 0.02, d - r, true],
    ['the plank\'s middle', L / 2, W / 2, true],
    ['the sharp box corner is rounded off', 0.03, 0.03, false],
  ];
  const wrong = probes.filter(([, x, y, want]) => inRing(ring, x, y) !== want).map(p => p[0]);
  ok(`${probes.length} probes: notch, reliefs and corner rounds are open, web and cheeks are wood`, !wrong.length, wrong.join(' | '));

  // the notch is a true slot: its walls are exactly the slot width apart
  // above the reliefs, on both edges
  const wallXs = ring.filter(q => Math.abs(q.y - 0.2) < 0.21 && Math.abs(q.x - c) < s).map(q => +q.x.toFixed(6));
  ok('the slot walls are 0.500" apart', Math.abs(Math.max(...wallXs) - Math.min(...wallXs) - s) < 1e-9, `${(Math.max(...wallXs) - Math.min(...wallXs)).toFixed(6)}`);

  // the relief polygon contains the TRUE circle: no point of the drawn
  // relief's outer half lies inside the wood
  let proud = 0;
  for (const [cx, sign] of [[c - s / 2, -1], [c + s / 2, 1]]) for (let k = 1; k < 60; k++) {
    const a = (Math.PI * k) / 60 - Math.PI / 2;   // the half facing away from the slot
    if (inRing(ring, cx + sign * (r - 1e-4) * Math.cos(a), d - r + (r - 1e-4) * Math.sin(a))) proud++;
  }
  ok('the faceted reliefs contain the drawn 0.38" circles (a bit that fits the drawing fits the cut)', proud === 0, `${proud} points of the true circle are inside the wood`);

  // mirrored on both axes: every vertex has a partner across the plank's centre lines
  const has = (x, y) => ring.some(q => Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6);
  ok('the outline is mirrored top-to-bottom and end-to-end', ring.every(q => has(q.x, W - q.y) && has(L - q.x, q.y)));
}

// ---------------- 2. clean cut, 3. sabotage ----------------
console.log('--- linker logs: the cut, both directions ---');
const jobFor = (ops, stock, tools) => {
  const job = { units: 'in', stock, safeZ: 0.25, spindleSpeed: 12000, tools, operations: ops };
  return { job, composed: composeJob(job), report: verifyJob(job, composeJob(job)) };
};
const place = (ring, x, y) => ring.map(q => ({ x: q.x + x, y: q.y + y }));
for (const dia of [0.25, 0.375]) {
  const reliefR = Math.max(0.19, (dia + 0.01) / 2);
  const g = { ...BILL, reliefR, notches: 4 };
  const { ring: local, centres } = plankRing(g);
  const ring = place(local, 1, 1);
  const { moves } = generateProfile({ outer: ring }, { diameter: dia }, { side: 'outside', totalDepth: 0.5, depthPerPass: 0.25, safeZ: 0.25 });
  const { report } = jobFor([{ name: 'plank', tool: 1, feedRate: 80, plungeRate: 30, moves, target: { type: 'profile', outer: ring, holes: [], side: 'outside', depth: 0.5 } }],
    { w: 25, h: 6, thickness: 0.5 }, { 1: { name: 'endmill', diameter: dia } });
  const tgt = report.stats.targets.find(t => t.type === 'profile');
  ok(`${dia}" bit: a 4-notch plank's outside profile verifies with zero intrusion`, report.errors.length === 0 && tgt?.intrusionArea === 0, JSON.stringify(report.errors.slice(0, 2)));

  // independent of the verifier: walk the cutting vertices
  let x = 0, y = 0, z = 1, tooClose = 0, insidePart = 0;
  const cutting = [];
  for (const m of moves) {
    if (m.x !== undefined) x = m.x; if (m.y !== undefined) y = m.y; if (m.z !== undefined) z = m.z;
    if (m.type === 'linear' && z < -1e-9) cutting.push({ x, y });
  }
  for (const q of cutting) {
    if (inRing(ring, q.x, q.y)) insidePart++;
    else if (distToRing(ring, q.x, q.y) < dia / 2 - 0.002) tooClose++;
  }
  ok(`${dia}" bit: brute force over ${cutting.length} cutting vertices — none inside the plank, none closer than the bit radius`, insidePart === 0 && tooClose === 0, `inside ${insidePart}, too close ${tooClose}`);

  // …and the bit reaches into every relief (so the notch floor is square where the mating plank's edge lands)
  const reach = reliefR - dia / 2;
  let missed = 0;
  for (const c of centres) for (const yy of [BILL.depth - reliefR, BILL.width - BILL.depth + reliefR]) for (const sx of [-1, 1]) {
    const cx = 1 + c + (sx * BILL.slotW) / 2, cy = 1 + yy;
    // the bit's far edge must come within 0.003" of the relief's outer wall
    const far = Math.max(...cutting.map(q => (Math.hypot(q.x - cx, q.y - cy) <= reach + 0.004 ? sx * (q.x - cx) + dia / 2 : -Infinity)));
    if (!(far >= reliefR - 0.004)) missed++;
  }
  ok(`${dia}" bit: the cut reaches the outer wall of all ${centres.length * 4} reliefs`, missed === 0, `${missed} reliefs not reached`);
}
{
  // SABOTAGE: the motion of a plank whose notches sit 0.3" off, declared against the true outline
  const truth = place(plankRing({ ...BILL, notches: 2 }).ring, 1, 1);
  const off = place(plankRing({ ...BILL, notches: 2, endMargin: 2.55 }).ring, 1, 1);
  const { moves } = generateProfile({ outer: off }, { diameter: 0.25 }, { side: 'outside', totalDepth: 0.5, depthPerPass: 0.25, safeZ: 0.25 });
  const { report } = jobFor([{ name: 'plank', tool: 1, feedRate: 80, plungeRate: 30, moves, target: { type: 'profile', outer: truth, holes: [], side: 'outside', depth: 0.5 } }],
    { w: 14, h: 6, thickness: 0.5 }, { 1: { name: '1/4"', diameter: 0.25 } });
  const hit = report.errors.find(e => /intrudes the part body/.test(e));
  ok('SABOTAGE: notches cut 0.3" off the declared outline are REJECTED as an intrusion into the plank, with a measured area', !!hit && /by \d+\.\d+ sq units/.test(hit), JSON.stringify(report.errors.slice(0, 2)));
}
{
  // SABOTAGE: two planks nested 0.4" apart — less than two 1/4" kerfs
  const mk = (ring, name) => ({ name, tool: 1, feedRate: 80, plungeRate: 30,
    moves: generateProfile({ outer: ring }, { diameter: 0.25 }, { side: 'outside', totalDepth: 0.5, depthPerPass: 0.25, safeZ: 0.25 }).moves,
    target: { type: 'profile', outer: ring, holes: [], side: 'outside', depth: 0.5 } });
  const local = plankRing({ ...BILL, notches: 2 }).ring;
  const tight = jobFor([mk(place(local, 1, 1), 'plank A'), mk(place(local, 1, 1 + 3.5 + 0.4), 'plank B')], { w: 13, h: 10, thickness: 0.5 }, { 1: { name: '1/4"', diameter: 0.25 } }).report;
  const roomy = jobFor([mk(place(local, 1, 1), 'plank A'), mk(place(local, 1, 1 + 3.5 + 1.0), 'plank B')], { w: 13, h: 10, thickness: 0.5 }, { 1: { name: '1/4"', diameter: 0.25 } }).report;
  ok('SABOTAGE: planks nested 0.4" apart are REJECTED (their kerfs overlap); at the kit\'s 1.0" spacing the same pair verifies',
    tight.errors.some(e => /cutting footprints overlap/.test(e)) && roomy.errors.length === 0, `tight: ${tight.errors[0]} | roomy: ${roomy.errors[0]}`);
}

// ---------------- 4. the kit verb ----------------
console.log('--- linker logs: the kit ---');
const entry = LINKER_LOG_ENTRIES.linker_logs;
const defaults = Object.fromEntries(Object.entries(entry.params).map(([k, s]) => [k, s.default]));
const ctxFor = (thickness, shop = {}) => ({ stock: { thickness }, safeZ: 0.25, shop, evalNumber: (v) => (Number.isFinite(+v) ? { value: +v } : { error: 'not a number' }) });
const runKit = (params = {}, thickness = 0.5, shop = {}) => entry.run({ ...defaults, ...params }, ctxFor(thickness, shop));
const bb = (ring) => ring.reduce((a, q) => [Math.min(a[0], q.x), Math.min(a[1], q.y), Math.max(a[2], q.x), Math.max(a[3], q.y)], [Infinity, Infinity, -Infinity, -Infinity]);
{
  const r = runKit();
  const k = r.kit;
  ok('the default kit is Bill\'s sheet: 6 × 46.5", 6 × 34.5", 8 × 22.5", 14 × 10.5", 16 × 4.5" = 50 planks on one 4×8',
    !r.error && r.pieces === 50 && k.sheets === 1 && !r.setups
    && JSON.stringify(k.planks.map(p => [p.count, p.length])) === JSON.stringify([[6, 46.5], [6, 34.5], [8, 22.5], [14, 10.5], [16, 4.5]])
    && BILLS_SHEET.reduce((n, p) => n + p.count, 0) === 50, r.error ?? JSON.stringify(k));
  ok('notch 0.51" wide (0.5" stock + 0.01), 0.87" deep; a 1/4" bit sized to the plank and a 0.26" relief that just clears it; crossed planks rise 1.76" a course',
    Math.abs(k.slotWidth - 0.51) < 1e-9 && Math.abs(k.notchDepth - 0.87) < 1e-9 && k.toolDiameter === 0.25 && k.toolSized === true && Math.abs(k.reliefDiameter - 0.26) < 1e-9 && Math.abs(k.courseRise - 1.76) < 1e-9, JSON.stringify(k));
  // brute-force layout check: inside the sheet, and no two planks closer than two kerfs + the web
  const boxes = r.ops.map(o => bb(o.previewRing));
  const span = [Math.max(...boxes.map(b => b[2])) - Math.min(...boxes.map(b => b[0])), Math.max(...boxes.map(b => b[3])) - Math.min(...boxes.map(b => b[1]))];
  let close = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const gx = Math.max(a[0] - b[2], b[0] - a[2]), gy = Math.max(a[1] - b[3], b[1] - a[3]);
    if (Math.max(gx, gy) < 2 * 0.25 + 0.5 - 1e-6) close++;
  }
  ok(`layout: 50 planks span ${span[0].toFixed(1)}" × ${span[1].toFixed(1)}" (fits 96 × 48 with margins), every pair at least 1.0" apart (two 1/4" kerfs + a 1/2" web)`,
    span[0] <= 96 - 0.75 - 0.25 + 1e-6 && span[1] <= 48 - 0.75 - 0.25 + 1e-6 && close === 0, `${close} pairs too close`);
  ok('every plank declares its own outside-profile target at full stock depth', r.ops.length === 50 && r.ops.every(o => o.target?.type === 'profile' && o.target.side === 'outside' && o.target.depth === 0.5 && o.target.rings?.[0] === o.previewRing));
  ok('ingredients: one 96 × 48 sheet of 1/2"', r.ingredients?.length === 1 && r.ingredients[0].count === 1 && r.ingredients[0].w === 96 && r.ingredients[0].thickness === 0.5);
}
// ---- the bit, sized to the planks ----
// A relief takes its whole diameter off the straight notch wall the crossing
// plank grips. The wall is MEASURED here from the outline the verb hands to
// the cutter — the longest straight run square to the plank's length, away
// from its ends — and never read from the verb's own report.
console.log('--- linker logs: the bit, sized to the planks ---');
{
  const wallOf = (ring) => {
    const b = bb(ring);
    const along = b[2] - b[0] >= b[3] - b[1] ? 'x' : 'y', across = along === 'x' ? 'y' : 'x';
    const lo = along === 'x' ? b[0] : b[1], hi = along === 'x' ? b[2] : b[3];
    let best = 0;
    ring.forEach((a, i) => {
      const c = ring[(i + 1) % ring.length];
      if (Math.abs(a[along] - c[along]) < 1e-9 && a[along] > lo + 1e-6 && a[along] < hi - 1e-6) best = Math.max(best, Math.abs(a[across] - c[across]));
    });
    return best;
  };
  // the deepest single step the cutter takes down, from the z levels it cuts at
  const stepOf = (op) => {
    const z = [0, ...new Set(op.moves.filter(m => m.z !== undefined && m.z < 0).map(m => +m.z.toFixed(4)))].sort((a, b) => b - a);
    return Math.max(...z.slice(1).map((v, i) => z[i] - v));
  };
  const longest = (r) => r.ops.filter(o => o.previewRing).reduce((a, o) => { const b = bb(o.previewRing); return !a || Math.max(b[2] - b[0], b[3] - b[1]) > a.len ? { len: Math.max(b[2] - b[0], b[3] - b[1]), op: o } : a; }, null).op;
  const HALF = { plankWidth: 1.75, pitch: 3, endMargin: 1.125 };
  const QUARTER = { plankWidth: 0.875, pitch: 1.5, endMargin: 0.5625, cornerRadius: 0.06 };
  const rows = [
    ['Bill\'s 3.5" plank, 1/2" stock', {}, 0.5, 0.25, 0.61, 80],
    ['half scale, 1/4" stock', HALF, 0.25, 0.125, 0.2975, 80],
    ['quarter scale, 1/8" stock', QUARTER, 0.125, 0.0625, 0.14125, 40],
    ['Bill\'s plank in 3/4" stock', {}, 0.75, 0.25, 0.61, 80],
  ];
  for (const [name, params, stock, bit, wall, feed] of rows) {
    const r = runKit(params, stock);
    const op = r.error ? null : longest(r);
    const measured = op ? wallOf(op.previewRing) : 0;
    const depth = r.kit?.notchDepth ?? 1;
    ok(`${name}, no bit named: a ${bit}" endmill, and ${measured.toFixed(3)}" of each ${depth.toFixed(3)}" notch wall measured straight (${Math.round(100 * measured / depth)}%, at least half)`,
      !r.error && r.kit.toolDiameter === bit && r.kit.toolSized && op.cutter.diameter === bit && Math.abs(measured - wall) < 2e-3 && Math.abs(r.kit.grip - measured) < 2e-3 && measured >= 0.5 * depth,
      r.error ?? `bit ${r.kit.toolDiameter}, measured ${measured}, reported ${r.kit.grip}`);
    ok(`…fed at ${feed} in/min, and never stepping down more than its own ${bit}" diameter (deepest step ${op ? stepOf(op).toFixed(3) : '?'}")`,
      !!op && op.feedRate === feed && stepOf(op) <= bit + 1e-6, op ? `feed ${op.feedRate}, step ${stepOf(op)}` : r.error);
  }
  // what live cut before this rule: a half-size plank with the full-size relief
  const before = wallOf(plankRing({ length: 3 + 2 * 1.125, width: 1.75, notches: 2, pitch: 3, endMargin: 1.125, slotW: 0.26, depth: 1.75 / 4 - 0.005, reliefR: 0.19, cornerR: 0.125 }).ring ?? []);
  ok(`the defect this guards against, measured: a half-size plank with the full-size 0.38" relief keeps ${before.toFixed(3)}" of a 0.433" wall`, before > 0.03 && before < 0.07, `${before}`);

  const refusals = [
    ['a 1/4" bit named for half-size planks', runKit({ ...HALF, toolDiameter: 0.25 }, 0.25), /leaves only 0\.172" of straight wall \(40%\).*a finer bit: a 1\/8" endmill leaves 0\.297"/],
    ['the full-size 0.38" relief named for half-size planks', runKit({ ...HALF, reliefDiameter: 0.38 }, 0.25), /a 0\.380" relief in a 0\.432" deep notch leaves only 0\.052".*Leave reliefDiameter at 0: a 1\/8" endmill needs only 0\.135" and leaves 0\.297"/],
    ['both named, as live cut it', runKit({ ...HALF, toolDiameter: 0.25, reliefDiameter: 0.38 }, 0.25), /leaves only 0\.052" of straight wall \(12%\).*leave toolDiameter and reliefDiameter at 0 — a 1\/8" endmill with a 0\.135" relief leaves 0\.297"/],
    ['a 1/8" bit named for quarter-size planks', runKit({ ...QUARTER, toolDiameter: 0.125 }, 0.125), /straight wall \(37%\).*a 1\/16" endmill leaves 0\.141"/],
    ['a plank too small for any stock bit', runKit({ plankWidth: 0.75, pitch: 1.5, endMargin: 0.6, notchDepth: 0.1 }, 0.125), /no stock endmill \(1\/4", 1\/8", 1\/16"\) fits a 0\.135" wide, 0\.100" deep notch/],
    ['a negative bit', runKit({ toolDiameter: -1 }), /toolDiameter must be positive/],
  ];
  const badR = refusals.filter(([, r, re]) => !(r.error && re.test(r.error))).map(([what, r]) => `${what}: ${r.error ?? 'NOT refused'}`);
  ok(`${refusals.length} refusals, each with the measured wall and the bit that fits: a bit too big for the plank (two scales), a relief too big, both, a plank too small for any bit, a negative bit`, !badR.length, badR.join(' | '));

  const bills = runKit({ toolDiameter: 0.375 });
  const billsWall = bills.error ? 0 : wallOf(longest(bills).previewRing);
  ok(`Bill's own 3/8" bit on his 3.5" plank is accepted: ${billsWall.toFixed(3)}" of the 0.87" wall measured straight (56%)`, !bills.error && !bills.kit.toolSized && Math.abs(billsWall - 0.485) < 2e-3, bills.error ?? `${billsWall}`);
  const drawn = runKit({ reliefDiameter: 0.38 });
  ok('Bill\'s drawn 0.38" relief can still be asked for by name, and is cut with the 1/4" bit', !drawn.error && drawn.kit.reliefDiameter === 0.38 && drawn.kit.toolDiameter === 0.25 && Math.abs(wallOf(longest(drawn).previewRing) - 0.49) < 2e-3, drawn.error ?? JSON.stringify(drawn.kit));
}
{
  const r34 = runKit({}, 0.75);
  ok('3/4" stock: the notch follows the plywood (0.76"), everything else holds', !r34.error && Math.abs(r34.kit.slotWidth - 0.76) < 1e-9 && r34.pieces === 50, r34.error);
  const half = runKit({ plankWidth: 1.75, pitch: 3, endMargin: 1.125, cornerRadius: 0.125, reliefDiameter: 0.19, toolDiameter: 0.125 }, 0.25);
  ok('half scale on 1/4" stock: planks 2.25" … 23.25" long, courses rise 0.885"', !half.error && half.kit.planks[0].length === 23.25 && half.kit.planks[4].length === 2.25 && Math.abs(half.kit.courseRise - 0.885) < 1e-9, half.error ?? JSON.stringify(half.kit));
  const grown = runKit({ toolDiameter: 0.375, reliefDiameter: 0.3 });
  ok('a 3/8" bit with 0.3" reliefs: the reliefs open to 0.385" and the kit says so', !grown.error && Math.abs(grown.kit.reliefDiameter - 0.385) < 1e-9 && grown.warnings.some(w => /reliefs were opened to 0\.385"/.test(w)), grown.error ?? grown.warnings.join(' | '));
  const two = runKit({ sets: 2 });
  const second = runKit({ sets: 2, setup: 2 });
  ok('two sets: 100 planks over 2 sheets, named in a warning; setup 1 and setup 2 cut every plank once between them',
    !two.error && two.pieces === 100 && two.setups?.count === 2 && two.ops.length + second.ops.length === 100 && second.setups.current === 2
    && two.warnings.some(w => /100 planks need 2 sheets/.test(w)) && two.ingredients[0].count === 2, two.error ?? JSON.stringify(two.setups));
  const custom = runKit({ planks: [{ notches: 3, count: 2 }, { notches: 5, count: 2 }] });   // counts as arithmetic over controls: app/test.mjs, through the real runtime
  ok('a custom list: 3- and 5-notch planks come out 16.5" and 28.5"', !custom.error && custom.pieces === 4 && custom.kit.planks.map(p => p.length).join() === '28.5,16.5', custom.error ?? JSON.stringify(custom.kit?.planks));
  const upright = runKit({}, 0.5, { machineW: 48, machineH: 96 });
  const ub = upright.error ? null : upright.ops.map(o => bb(o.previewRing));
  ok('a 48 × 96 machine: the rows stand on end, one sheet, every outline still counter-clockwise',
    ub && upright.kit.sheets === 1 && Math.max(...ub.map(b => b[2])) <= 48 && Math.max(...ub.map(b => b[3])) > 90 && upright.ops.every(o => signedArea(o.previewRing) > 0), upright.error);
}
{
  const refusals = [
    ['a 3/4" bit in a 0.51" notch', runKit({ toolDiameter: 0.75 }), /endmill is wider than the 0\.510" notch/],
    ['an 8-notch plank on a 30" machine', runKit({}, 0.5, { machineW: 30, machineH: 30 }), /8-notch plank is 46\.5" long and the 30" × 30" sheet takes at most/],
    ['notches so deep no web is left', runKit({ notchDepth: 1.6 }), /leave only 0\.300" of a 3\.5" plank between them/],
    ['a pitch too tight for the reliefs', runKit({ pitch: 1.2 }), /between one notch's relief and the next/],
    ['an empty kit', runKit({ planks: [{ notches: 4, count: 0 }] }), /every count is 0/],
    ['a kit past the cap', runKit({ sets: 20 }), /1000 planks in one job/],
    ['a plank with no notches', runKit({ planks: [{ notches: 0, count: 2 }] }), /at least 1 notch per edge/],
  ];
  const bad = refusals.filter(([, r, re]) => !(r.error && re.test(r.error))).map(([what, r]) => `${what}: ${r.error ?? 'NOT refused'}`);
  ok(`${refusals.length} refusals, each by name: bit wider than the notch, plank longer than the sheet, no web, tight pitch, empty kit, oversize kit, zero notches`, !bad.length, bad.join(' | '));
}

// ---------------- 5. angle connectors ----------------
console.log('--- linker logs: angle connectors ---');
// Bill's three, as drawn: 0.48" plywood, reaching 2.24" either side of the notch radius
const DRAWN = { width: 3.5, endMargin: 2.24, slotW: 0.48, depth: 0.87, reliefR: 0.19, cornerR: 0.25, thickness: 0.48 };
{
  // the six radii measured off his DXFs (outer, inner) — the rule must land on them
  const measured = { 15: [15.7725, 11.2925], 30: [9.0111, 4.5311], 45: [6.7049, 2.2249] };
  const off = Object.entries(measured).map(([a, [ro, ri]]) => { const c = connectorRing({ ...DRAWN, angle: +a }); return Math.max(Math.abs(c.rOut - ro), Math.abs(c.rIn - ri)); });
  ok(`the radius rule (W/2 ÷ tan(angle/2) + t/2, ± the end margin) lands on all six radii measured from Bill's 15°, 30° and 45° drawings within 0.0002"`, off.every(d => d < 2e-4), off.map(d => d.toFixed(5)).join(', '));

  for (const angle of [15, 30, 45, 22.5, 60]) {
    const g = { ...BILL, endMargin: 2.25, thickness: 0.5, angle };
    const c = connectorRing(g);
    const th = (angle * Math.PI) / 180, half = th / 2, ring = c.ring;
    const pol = (rho, a) => [rho * Math.cos(a), rho * Math.sin(a)];
    const mirrored = ring.every(q => { const mx = q.x * Math.cos(th) + q.y * Math.sin(th), my = q.x * Math.sin(th) - q.y * Math.cos(th); return ring.some(v => Math.hypot(v.x - mx, v.y - my) < 1e-6); });
    const radial = ring.every(q => { const rho = Math.hypot(q.x, q.y), a = Math.atan2(q.y, q.x); return rho > c.rIn - 2e-3 && rho < c.rOut + 1e-6 && a > -1e-6 && a < th + 1e-6; });
    // probes in polar terms: (radius, angle from edge 1) → wood?
    const probes = [
      ['mid-web, on the bisector', ...pol(c.rn, half), true],
      ['edge-1 notch mouth', c.rn, 0.05, false],
      ['edge-1 notch, just above its floor', c.rn, BILL.depth - 0.01, false],
      ['under the edge-1 notch floor', c.rn, BILL.depth + 0.02, true],
      ['edge-1 relief, inner side', c.rn - BILL.slotW / 2 - 0.17, BILL.depth - 0.19, false],
      ['inside the inner arc', ...pol(c.rIn - 0.05, half), false],
      ['beyond the outer arc', ...pol(c.rOut + 0.05, half), false],
      ['a cheek beside the notch', c.rn + 1.2, 0.3, true],
    ];
    // every edge-1 probe has a twin on edge 2 (the mirror image)
    const all = probes.flatMap(([n, x, y, want]) => [[n, x, y, want], [`${n} (edge 2)`, x * Math.cos(th) + y * Math.sin(th), x * Math.sin(th) - y * Math.cos(th), want]]);
    const wrong = all.filter(([, x, y, want]) => inRing(ring, x, y) !== want).map(p => p[0]);
    // the two seated planks' inner corners coincide: the point half a plank width up plank 1's inner face lies ON the bisector
    const meet = Math.abs((c.rn - 0.25) * Math.sin(half) - (BILL.width / 2) * Math.cos(half));
    ok(`${angle}° connector: counter-clockwise, mirrored across its bisector, inside its ring segment; ${all.length} probes right; the two seated planks' inner corners meet (${meet.toExponential(1)}" apart)`,
      signedArea(ring) > 0 && mirrored && radial && !wrong.length && meet < 1e-9, `ccw ${signedArea(ring) > 0} mirrored ${mirrored} radial ${radial} wrong: ${wrong.join(' | ')}`);
  }
}
for (const [angle, dia] of [[30, 0.25], [45, 0.375], [15, 0.25]]) {
  const reliefR = Math.max(0.19, (dia + 0.01) / 2);
  const c = connectorRing({ ...BILL, endMargin: 2.25, thickness: 0.5, reliefR, angle });
  const b = bb(c.ring);
  const ring = place(c.ring, 1 - b[0], 1 - b[1]);
  const { moves } = generateProfile({ outer: ring }, { diameter: dia }, { side: 'outside', totalDepth: 0.5, depthPerPass: 0.25, safeZ: 0.25 });
  const { report } = jobFor([{ name: 'connector', tool: 1, feedRate: 80, plungeRate: 30, moves, target: { type: 'profile', outer: ring, holes: [], side: 'outside', depth: 0.5 } }],
    { w: 8, h: 8, thickness: 0.5 }, { 1: { name: 'endmill', diameter: dia } });
  let x = 0, y = 0, z = 1, bad = 0, n = 0, deep = 0;
  for (const m of moves) {
    if (m.x !== undefined) x = m.x; if (m.y !== undefined) y = m.y; if (m.z !== undefined) z = m.z;
    if (m.type === 'linear' && z < -1e-9) { n++; if (inRing(ring, x, y) || distToRing(ring, x, y) < dia / 2 - 0.002) bad++; }
  }
  // the bit gets to the bottom of both notches: a cutting vertex within a bit radius (+tol) of each notch floor's midpoint
  const th = (angle * Math.PI) / 180;
  const floors = [[c.rn, BILL.depth], [c.rn * Math.cos(th) + BILL.depth * Math.sin(th), c.rn * Math.sin(th) - BILL.depth * Math.cos(th)]].map(([fx, fy]) => [fx + 1 - b[0], fy + 1 - b[1]]);
  x = 0; y = 0; z = 1;
  const reached = floors.map(() => false);
  for (const m of moves) {
    const px = x, py = y;
    if (m.x !== undefined) x = m.x; if (m.y !== undefined) y = m.y; if (m.z !== undefined) z = m.z;
    // the bit crosses a floor in the middle of a straight run: measure to the SEGMENT, not its ends
    if (m.type === 'linear' && z < -1e-9) floors.forEach(([fx, fy], i) => { if (distToRing([{ x: px, y: py }, { x, y }], fx, fy) < dia / 2 + 0.004) reached[i] = true; });
  }
  ok(`${angle}° connector, ${dia}" bit: verifies with zero intrusion; brute force over ${n} cutting vertices finds none inside or within a bit radius; the bit reaches both notch floors`,
    report.errors.length === 0 && report.stats.targets[0]?.intrusionArea === 0 && bad === 0 && reached.every(Boolean), `${JSON.stringify(report.errors.slice(0, 1))} bad ${bad} reached ${reached}`);
}
{
  // SABOTAGE: a 45° connector's motion declared against a 30° connector's outline
  const c30 = connectorRing({ ...BILL, endMargin: 2.25, thickness: 0.5, angle: 30 }), c45 = connectorRing({ ...BILL, endMargin: 2.25, thickness: 0.5, angle: 45 });
  const sh = (c) => { const b = bb(c.ring); return place(c.ring, 2 - b[0], 2 - b[1]); };
  const { moves } = generateProfile({ outer: sh(c45) }, { diameter: 0.25 }, { side: 'outside', totalDepth: 0.5, depthPerPass: 0.25, safeZ: 0.25 });
  const { report } = jobFor([{ name: 'connector', tool: 1, feedRate: 80, plungeRate: 30, moves, target: { type: 'profile', outer: sh(c30), holes: [], side: 'outside', depth: 0.5 } }],
    { w: 10, h: 10, thickness: 0.5 }, { 1: { name: '1/4"', diameter: 0.25 } });
  ok('SABOTAGE: a 45° connector cut where a 30° one was declared is REJECTED as an intrusion, with a measured area', report.errors.some(e => /intrudes the part body by \d+\.\d+ sq units/.test(e)), JSON.stringify(report.errors.slice(0, 1)));
}
{
  const only = runKit({ planks: [], connectors: BILLS_CONNECTORS });
  const labelOp = only.ops?.[0], cuts = only.ops?.slice(1) ?? [];
  ok('Bill\'s connector sheet alone (planks []): 36 pieces — 12 each at 15°, 30°, 45° — on one 4×8, the label op first, then 36 outside profiles',
    !only.error && only.pieces === 36 && !only.setups && labelOp?.subName === 'angle labels' && labelOp.cutter.type === 'vee' && labelOp.target.side === 'on' && cuts.length === 36
    && cuts.every(o => o.target.side === 'outside' && o.previewRing) && JSON.stringify(only.kit.connectors) === JSON.stringify(BILLS_CONNECTORS) && only.kit.labels === '60° V-bit' && only.kit.planks.length === 0, only.error);
  // brute force: every scored stroke lies inside a connector, clear of its edge and notches
  const clearOf = (r, need) => {
    let out = 0, near = 0, n = 0;
    for (const pl of r.ops[0].target.rings) for (let i = 0; i < pl.length; i++) {
      // sample along each stroke segment, not only its vertices
      const a = pl[i], b = pl[Math.min(i + 1, pl.length - 1)];
      for (let k = 0; k <= 4; k++) {
        const x = a.x + ((b.x - a.x) * k) / 4, y = a.y + ((b.y - a.y) * k) / 4; n++;
        const home = r.ops.slice(1).find(o => inRing(o.previewRing, x, y));
        if (!home) out++; else if (distToRing(home.previewRing, x, y) < need - 1e-6) near++;
      }
    }
    return { out, near, n };
  };
  const v = clearOf(only, 0.08);
  ok(`labels, V-bit: ${v.n} points along ${only.ops[0].target.rings.length} strokes all lie inside a connector and at least 0.08" from its outline and notches`, v.out === 0 && v.near === 0, `outside ${v.out}, too near ${v.near}`);
  const flat = runKit({ planks: [], connectors: [{ angle: 10, count: 1 }, { angle: 22.5, count: 1 }, { angle: 45, count: 1 }, { angle: 60, count: 1 }, { angle: 70, count: 1 }], labelToolDiameter: 0.25 });
  const vf = flat.error ? { out: 1, near: 1, n: 0 } : clearOf(flat, 0.125 + 0.08);
  ok(`labels with the 1/4" cutting bit, 10° … 70°: one tool for the whole job, the strokes' centre lines at least 0.205" (the bit radius + 0.08") from every outline; the label reads "22.5" where the angle is 22.5`,
    !flat.error && vf.out === 0 && vf.near === 0 && flat.ops[0].tool.name === flat.ops[1].tool.name && flat.kit.labels === '1/4" endmill' && flat.ops.some(o => o.subName === 'connector A22.5-1'), flat.error ?? `outside ${vf.out}, too near ${vf.near}`);
  const plain = runKit({ planks: [], connectors: BILLS_CONNECTORS, labels: false });
  ok('labels false: no label op, 36 profiles, the kit says unlabelled', !plain.error && plain.ops.length === 36 && plain.ops.every(o => o.previewRing) && plain.kit.labels === null, plain.error);

  const both = runKit({ connectors: BILLS_CONNECTORS, sets: 2 });
  const boxes = both.error ? [] : both.ops.filter(o => o.previewRing).map(o => bb(o.previewRing));
  let close = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (Math.max(Math.max(a[0] - b[2], b[0] - a[2]), Math.max(a[1] - b[3], b[1] - a[3])) < 1.0 - 1e-6) close++;
  }
  ok(`planks and connectors together, two sets: 172 pieces over ${both.setups?.count} sheets; on sheet 1 every pair of the ${boxes.length} pieces is at least 1.0" apart and inside the sheet`,
    !both.error && both.pieces === 172 && both.kit.connectors.every(c => c.count === 24) && both.setups?.count >= 3 && close === 0
    && Math.max(...boxes.map(b => b[2])) <= 95 + 1e-6 && Math.max(...boxes.map(b => b[3])) <= 47 + 1e-6 && both.warnings.some(w => /172 pieces need \d sheets/.test(w) && /° connector/.test(w)), both.error ?? `close ${close}`);
  const refusals = [
    ['a 75° connector', runKit({ planks: [], connectors: [{ angle: 75, count: 1 }] }), /a 75° connector is too sharp: its inner edge would close up/],
    ['a 90° connector', runKit({ planks: [], connectors: [{ angle: 90, count: 1 }] }), /angle is 90° — a connector turns between 5° and 80°/],
    ['nothing at all', runKit({ planks: [], connectors: [] }), /planks and connectors are both empty/],
    ['connectors that are not a list', runKit({ connectors: 'three' }), /connectors needs a list/],
  ];
  const badR = refusals.filter(([, r, re]) => !(r.error && re.test(r.error))).map(([what, r]) => `${what}: ${r.error ?? 'NOT refused'}`);
  ok(`${refusals.length} connector refusals, each by name: too sharp to have an inner edge, out of range, an empty kit, a malformed list`, !badR.length, badR.join(' | '));
}

// ---------------- 6. structures (tiers) ----------------
console.log('--- linker logs: structures ---');
// every panel's world box, from the pose the verb hands the assembled view —
// the checks below read ONLY these boxes, never the plan that made them
const worldBoxes = (r) => r.assembly.panels.map(p => {
  const { origin: o, u, v } = p.world;
  const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const pts = p.rings[0].flatMap(q => { const base = [0, 1, 2].map(i => o[i] + q.x * u[i] + q.y * v[i]); return [base, base.map((c, i) => c + p.thickness * w[i])]; });
  const min = [0, 1, 2].map(i => Math.min(...pts.map(q => q[i]))), max = [0, 1, 2].map(i => Math.max(...pts.map(q => q[i])));
  return { id: p.id, min, max, alongX: max[0] - min[0] > max[2] - min[2], active: p.active, det: u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]) };
});
const boxKey = (b) => `${b.min.map(v => v.toFixed(3)).join(',')}|${b.max.map(v => v.toFixed(3)).join(',')}`;
// brute force over every pair of planks: who touches whom, and how
function structureAudit(boxes, { W, t, depth, pitch, endMargin }) {
  const rise = W - 2 * depth;
  const issues = [];
  const courseOf = (b) => Math.round(b.min[1] / rise);
  const supports = new Map(boxes.map(b => [b.id, 0]));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ov = [0, 1, 2].map(k => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
    if (ov.some(v => v <= 1e-6)) continue;   // apart
    const ca = courseOf(a), cb = courseOf(b);
    // the only contact allowed: perpendicular planks one course apart, sharing a t × t column 2·depth tall (the two notches)
    if (a.alongX === b.alongX) { issues.push(`${a.id} and ${b.id} are parallel and overlap by ${ov.map(v => v.toFixed(3)).join(' × ')}`); continue; }
    if (Math.abs(ca - cb) !== 1) { issues.push(`${a.id} (course ${ca + 1}) and ${b.id} (course ${cb + 1}) cross but are not one course apart`); continue; }
    if (Math.abs(ov[0] - t) > 1e-6 || Math.abs(ov[2] - t) > 1e-6 || Math.abs(ov[1] - 2 * depth) > 1e-6) { issues.push(`${a.id} × ${b.id}: the shared column is ${ov.map(v => v.toFixed(3)).join(' × ')}, not ${t} × ${(2 * depth).toFixed(3)} × ${t}`); continue; }
    // …and that column sits ON A NOTCH of both planks: endMargin + a whole number of pitches from each plank's end
    for (const pk of [a, b]) {
      const ax = pk.alongX ? 0 : 2, centre = (Math.max(a.min[ax], b.min[ax]) + Math.min(a.max[ax], b.max[ax])) / 2;
      const n = (centre - pk.min[ax] - endMargin) / pitch;
      if (Math.abs(n - Math.round(n)) > 1e-6 || n < -1e-6) issues.push(`${pk.id}: crossed ${(centre - pk.min[ax]).toFixed(3)}" from its end — not at a notch`);
    }
    supports.set(ca > cb ? a.id : b.id, supports.get(ca > cb ? a.id : b.id) + 1);
  }
  for (const b of boxes) if (courseOf(b) > 0 && supports.get(b.id) < 2) issues.push(`${b.id} (course ${courseOf(b) + 1}) is carried at ${supports.get(b.id)} notch(es) — needs 2`);
  for (const b of boxes) if (courseOf(b) === 0 && Math.abs(b.min[1]) > 1e-6) issues.push(`${b.id} should stand on the ground`);
  return issues;
}
const FULL = { W: 3.5, t: 0.5, depth: 0.87, pitch: 6, endMargin: 2.25 };
{
  const plan = towerPlan([{ w: 3, d: 3, courses: 4, x: 0, y: 0 }, { w: 1, d: 1, courses: 3, x: 1, y: 1 }]);
  const perCourse = [...Array(plan.courses).keys()].map(k => plan.planks.filter(p => p.course === k));
  ok('towerPlan: 7 courses, two planks each, directions alternate from X; a stepped-in tier\'s first course runs the full extent of the tier below',
    plan.courses === 7 && perCourse.every((c, k) => c.length === 2 && c.every(p => p.dir === (k % 2 === 0 ? 'x' : 'y')))
    && perCourse[4].every(p => p.transfer && p.from === 0 && p.to === 3 && [1, 2].includes(p.line)) && perCourse[5].every(p => !p.transfer && p.from === 1 && p.to === 2)
    && plan.planks.filter(p => p.transfer).length === 2, JSON.stringify(perCourse[4]));

  const tower = runKit({ tiers: [{ w: 5, d: 3, courses: 6 }, { w: 3, d: 3, courses: 5 }, { w: 1, d: 1, courses: 8 }] });
  const boxes = tower.error ? [] : worldBoxes(tower);
  const issues = tower.error ? [tower.error] : structureAudit(boxes, FULL);
  ok(`a 3-tier tower (5×3, 3×3, 1×1 cells; 19 courses): brute force over all ${(boxes.length * (boxes.length - 1)) / 2} pairs of its ${boxes.length} planks — every contact is two notches meeting (a 0.5 × 1.74 × 0.5 column at a notch of both planks), every plank above the ground is carried at two notches, nothing else touches`,
    !issues.length && boxes.length === 38, issues.slice(0, 3).join(' | '));
  const a = tower.assembly;
  const ext = [0, 1, 2].map(i => [Math.min(...boxes.map(b => b.min[i])), Math.max(...boxes.map(b => b.max[i]))]);
  ok('its size: 19 courses → (19 − 1) × 1.76 + 3.5 = 35.18" tall on a 5 × 6 + 4.5 = 34.5" by 3 × 6 + 4.5 = 22.5" footprint; the posed planks fill exactly that box',
    Math.abs(a.height - 35.18) < 1e-6 && a.footprint[0] === 34.5 && a.footprint[1] === 22.5 && a.courses === 19 && a.planks === 38
    && ext.every(([lo], i) => Math.abs(lo) < 1e-6) && Math.abs(ext[0][1] - 34.5) < 1e-6 && Math.abs(ext[1][1] - 35.18) < 1e-6 && Math.abs(ext[2][1] - 22.5) < 1e-6, JSON.stringify({ h: a.height, f: a.footprint, ext }));
  ok('it cuts exactly its planks — 38, named by course (C1-1 … C19-2) — and the default 50-plank sheet is NOT added; every pose is a proper rotation and every panel is the outline its op cuts',
    tower.pieces === 38 && tower.ops.length === 38 && tower.ops[0].subName.startsWith('plank C') && boxes.every(b => Math.abs(b.det - 1) < 1e-9)
    && a.panels.every(p => tower.ops.some(o => o.previewRing === p.rings[0])) && tower.kit.structure.planks === 38 && tower.kit.planks.reduce((n, k) => n + k.count, 0) === 38, `pieces ${tower.pieces}`);

  // the same tower on an upright sheet and across several small sheets: the poses must land every plank in the same place
  const ref = new Set(boxes.map(boxKey));
  const upright = runKit({ tiers: [{ w: 5, d: 3, courses: 6 }, { w: 3, d: 3, courses: 5 }, { w: 1, d: 1, courses: 8 }] }, 0.5, { machineW: 48, machineH: 96 });
  const small = runKit({ tiers: [{ w: 5, d: 3, courses: 6 }, { w: 3, d: 3, courses: 5 }, { w: 1, d: 1, courses: 8 }], setup: 2 }, 0.5, { machineW: 48, machineH: 40 });
  const ub = upright.error ? [] : worldBoxes(upright), sb = small.error ? [] : worldBoxes(small);
  ok(`turned a quarter on a 48 × 96 sheet, and split over ${small.setups?.count} sheets of 48 × 40 (cutting sheet 2): all 38 planks still pose into the identical 38 places; the other sheets' planks are marked inactive`,
    ub.length === 38 && ub.every(b => ref.has(boxKey(b)) && Math.abs(b.det - 1) < 1e-9) && sb.length === 38 && sb.every(b => ref.has(boxKey(b))) && small.setups?.count > 1
    && sb.filter(b => b.active).length === small.ops.length && sb.some(b => !b.active), upright.error ?? small.error ?? `upright ${ub.filter(b => ref.has(boxKey(b))).length}/38, split ${sb.filter(b => ref.has(boxKey(b))).length}/38`);

  // other shapes of tower, same audit: flush walls, an off-centre tier, a tall single cell, half scale
  const more = [
    ['a tier flush with two walls of the one below', { tiers: [{ w: 4, d: 4, courses: 4 }, { w: 2, d: 3, courses: 4, x: 0, y: 0 }] }, FULL, 0.5],
    ['an off-centre tier, odd course counts', { tiers: [{ w: 4, d: 2, courses: 5 }, { w: 2, d: 1, courses: 3, x: 2, y: 1 }, { w: 1, d: 1, courses: 7, x: 3, y: 1 }] }, FULL, 0.5],
    ['a single-cell chimney, 24 courses', { tiers: [{ w: 1, d: 1, courses: 24 }] }, FULL, 0.5],
    ['half scale on 1/4" stock, four tiers', { plankWidth: 1.75, pitch: 3, endMargin: 1.125, cornerRadius: 0.125, reliefDiameter: 0.19, toolDiameter: 0.125, tiers: [{ w: 7, d: 7, courses: 4 }, { w: 5, d: 5, courses: 4 }, { w: 3, d: 3, courses: 4 }, { w: 1, d: 1, courses: 4 }] },
      { W: 1.75, t: 0.25, depth: 1.75 / 4 - 0.005, pitch: 3, endMargin: 1.125 }, 0.25],
  ];
  const badT = more.map(([what, params, geo, th]) => { const r = runKit(params, th); const iss = r.error ? [r.error] : structureAudit(worldBoxes(r), geo); return iss.length ? `${what}: ${iss[0]}` : null; }).filter(Boolean);
  ok(`${more.length} more structures pass the same audit: flush walls, an off-centre tier with odd course counts, a 24-course single cell, a four-tier pyramid at half scale`, !badT.length, badT.join(' | '));

  // SABOTAGE the audit itself: a plank nudged off its notch, and one lifted a course, must both be caught
  const nudged = boxes.map(b => (b.id === 'C8-1' ? { ...b, min: [b.min[0] + 0.3, b.min[1], b.min[2]], max: [b.max[0] + 0.3, b.max[1], b.max[2]] } : b));
  const lifted = boxes.map(b => (b.id === 'C12-1' ? { ...b, min: [b.min[0], b.min[1] + 1.76, b.min[2]], max: [b.max[0], b.max[1] + 1.76, b.max[2]] } : b));
  ok('SABOTAGE: the audit rejects a plank slid 0.3" off its notches and a plank lifted one course (so a wrong pose could not pass it)',
    structureAudit(nudged, FULL).some(m => /not at a notch|shared column/.test(m)) && structureAudit(lifted, FULL).length > 0, `${structureAudit(nudged, FULL)[0]} // ${structureAudit(lifted, FULL)[0]}`);
}
{
  // ---- several tiers on one: spires on a hall, corner towers on a keep ----
  const hall = [{ w: 7, d: 3, courses: 6 }, { w: 1, d: 1, courses: 8, on: 0, x: 0, y: 1 }, { w: 1, d: 1, courses: 12, on: 0, x: 3, y: 1 }, { w: 1, d: 1, courses: 8, on: 0, x: 6, y: 1 }];
  const hp = towerPlan(hall.map(T => ({ x: 0, y: 0, ...T, on: T.on ?? -1 })));   // towerPlan takes resolved tiers: the verb fills x / y / on
  const beams = hp.planks.filter(p => p.transfer);
  ok('towerPlan, three spires in a row on a 7 × 3 hall: all three start on course 7, share ONE pair of long beams (their walls are on the same two lines), and the structure is as tall as its tallest branch (6 + 12 courses)',
    hp.starts.join() === '0,6,6,6' && hp.courses === 18 && beams.length === 2 && beams.every(b => b.course === 6 && b.dir === 'x' && b.from === 0 && b.to === 7 && [1, 2].includes(b.line)), JSON.stringify({ starts: hp.starts, courses: hp.courses, beams }));
  const multi = [
    ['a hall with three spires in a row (shared beams)', { tiers: hall }, 2 * 6 + 2 + (2 * 7 + 2 * 11 + 2 * 7), 18],
    ['a keep with four corner towers', { tiers: [{ w: 5, d: 5, courses: 6 }, { w: 1, d: 1, courses: 6, on: 0, x: 0, y: 0 }, { w: 1, d: 1, courses: 6, on: 0, x: 4, y: 0 }, { w: 1, d: 1, courses: 6, on: 0, x: 0, y: 4 }, { w: 1, d: 1, courses: 6, on: 0, x: 4, y: 4 }] }, null, 12],
    ['twin towers of different heights on a podium, one with a top stage', { tiers: [{ w: 7, d: 3, courses: 4 }, { w: 2, d: 3, courses: 10, on: 0, x: 0, y: 0 }, { w: 2, d: 3, courses: 7, on: 0, x: 5, y: 0 }, { w: 1, d: 1, courses: 5, on: 1 }] }, null, 19],
    ['six spires on a hall — three at each end, the middle one of each set out and taller', { tiers: [{ w: 11, d: 5, courses: 6 },
      { w: 1, d: 1, courses: 8, on: 0, x: 0, y: 0 }, { w: 1, d: 1, courses: 8, on: 0, x: 0, y: 4 }, { w: 1, d: 1, courses: 12, on: 0, x: 2, y: 2 },
      { w: 1, d: 1, courses: 8, on: 0, x: 10, y: 0 }, { w: 1, d: 1, courses: 8, on: 0, x: 10, y: 4 }, { w: 1, d: 1, courses: 12, on: 0, x: 8, y: 2 }] }, null, 18],
    ['towers on an odd-course base (their first course runs the other way)', { tiers: [{ w: 5, d: 3, courses: 5 }, { w: 1, d: 3, courses: 4, on: 0, x: 0, y: 0 }, { w: 1, d: 3, courses: 6, on: 0, x: 4, y: 0 }] }, null, 11],
  ];
  const badM = multi.map(([what, params, planks, courses]) => {
    const r = runKit(params);
    if (r.error) return `${what}: ${r.error}`;
    const iss = structureAudit(worldBoxes(r), FULL);
    if (iss.length) return `${what}: ${iss[0]}`;
    if (r.assembly.courses !== courses) return `${what}: ${r.assembly.courses} courses, expected ${courses}`;
    if (planks != null && r.pieces !== planks) return `${what}: ${r.pieces} planks, expected ${planks}`;
    if (Math.abs(r.assembly.height - ((courses - 1) * 1.76 + 3.5)) > 1e-6) return `${what}: height ${r.assembly.height}`;
    return null;
  }).filter(Boolean);
  ok(`${multi.length} multi-tower structures pass the audit — three spires in a row, four corner towers, twin towers with a top stage, six spires on a hall, towers on an odd-course base: every contact two notches meeting, every plank carried at two, nothing else touching, heights by the tallest branch`, !badM.length, badM.join(' | '));
  const six = runKit(multi[3][1]);
  ok(`the six-spire hall: ${six.pieces} planks; tier list in the assembly carries each tier's "on" and starting course`,
    !six.error && six.assembly.tiers.length === 7 && six.assembly.tiers.slice(1).every(T => T.on === 0 && T.from === 6) && six.assembly.tiers[0].on === -1 && six.assembly.panels.length === six.pieces, six.error);
  const sib = [
    ['two tiers touching on a shared wall line', runKit({ tiers: [{ w: 4, d: 2, courses: 4 }, { w: 2, d: 2, courses: 4, on: 0, x: 0, y: 0 }, { w: 2, d: 2, courses: 4, on: 0, x: 2, y: 0 }] }), /tiers\[2\] \(2 × 2 at x 2, y 0\) and tiers\[1\] \(2 × 2 at x 0, y 0\) both stand on tiers\[0\] and touch or overlap — leave at least one clear cell/],
    ['two tiers overlapping', runKit({ tiers: [{ w: 5, d: 3, courses: 4 }, { w: 3, d: 3, courses: 4, on: 0, x: 0, y: 0 }, { w: 3, d: 3, courses: 4, on: 0, x: 2, y: 0 }] }), /both stand on tiers\[0\] and touch or overlap/],
    ['two tiers meeting at a corner', runKit({ tiers: [{ w: 4, d: 4, courses: 4 }, { w: 2, d: 2, courses: 4, on: 0, x: 0, y: 0 }, { w: 2, d: 2, courses: 4, on: 0, x: 2, y: 2 }] }), /touch or overlap/],
    ['"on" naming a later tier', runKit({ tiers: [{ w: 3, d: 3, courses: 4 }, { w: 1, d: 1, courses: 4, on: 2 }, { w: 1, d: 1, courses: 4 }] }), /tiers\[1\]\.on is 2 — a tier stands on an EARLIER tier/],
    ['"on" on the base', runKit({ tiers: [{ w: 3, d: 3, courses: 4, on: 0 }] }), /tiers\[0\] is the base — it stands on the ground/],
    ['a tier outside the one it names', runKit({ tiers: [{ w: 5, d: 3, courses: 4 }, { w: 1, d: 1, courses: 4, on: 0, x: 0, y: 1 }, { w: 1, d: 1, courses: 4, on: 1, x: 4, y: 1 }] }), /tiers\[2\] \(1 × 1 cells at x 4, y 1\) reaches outside tiers\[1\]/],
  ];
  const badS = sib.filter(([, r, re]) => !(r.error && re.test(r.error))).map(([what, r]) => `${what}: ${r.error ?? 'NOT refused'}`);
  ok(`${sib.length} multi-tower refusals, each by name: siblings sharing a wall, overlapping, or meeting at a corner; "on" naming a later tier or set on the base; a tier outside the one it stands on`, !badS.length, badS.join(' | '));
  // and the refusal is not over-cautious: one clear cell is enough, by the audit
  const close = runKit({ tiers: [{ w: 3, d: 3, courses: 4 }, { w: 1, d: 3, courses: 6, on: 0, x: 0, y: 0 }, { w: 1, d: 3, courses: 6, on: 0, x: 2, y: 0 }] });
  ok('two towers ONE clear cell apart (cells 0–1 and 2–3) build and pass the audit', !close.error && !structureAudit(worldBoxes(close), FULL).length, close.error ?? structureAudit(worldBoxes(close), FULL)[0]);

  const spares = runKit({ tiers: [{ w: 2, d: 2, courses: 4 }], planks: [{ notches: 3, count: 2 }], connectors: [{ angle: 30, count: 2 }] });
  ok('with tiers, planks are SPARES and connectors extras: 8 structural planks + 2 spares + 2 connectors = 12 pieces, 8 of them posed',
    !spares.error && spares.pieces === 12 && spares.assembly.panels.length === 8 && spares.kit.planks.find(k => k.notches === 3).count === 10 && spares.kit.connectors[0].count === 2, spares.error ?? `pieces ${spares.pieces}`);
  const twice = runKit({ tiers: [{ w: 2, d: 2, courses: 4 }], sets: 2 });
  ok('sets 2 with tiers: the planks for two (16), one structure posed (8 panels), the second set named C1-1/2 …', !twice.error && twice.pieces === 16 && twice.assembly.panels.length === 8 && twice.ops.some(o => o.subName === 'plank C1-1/2'), twice.error);
  const refusals = [
    ['a tier wider than the one below', runKit({ tiers: [{ w: 2, d: 2, courses: 4 }, { w: 3, d: 1, courses: 4 }] }), /tiers\[1\] \(3 × 1 cells at x -1, y 0\) reaches outside tiers\[0\]/],
    ['a tier pushed off the one below', runKit({ tiers: [{ w: 4, d: 4, courses: 4 }, { w: 2, d: 2, courses: 4, x: 3, y: 0 }] }), /reaches outside tiers\[0\]/],
    ['a one-course tier', runKit({ tiers: [{ w: 2, d: 2, courses: 1 }] }), /tiers\[0\] needs at least 2 courses/],
    ['a zero-width tier', runKit({ tiers: [{ w: 0, d: 2, courses: 4 }] }), /footprint of at least 1 × 1 cells/],
    ['a base tier with an offset', runKit({ tiers: [{ w: 2, d: 2, courses: 4, x: 1 }] }), /tiers\[0\] is the base/],
    ['tiers that are not a list', runKit({ tiers: 'tall' }), /tiers needs a list/],
    ['a tower past the piece cap', runKit({ tiers: [{ w: 1, d: 1, courses: 240 }] }), /480 planks in one job — cut at most 400 at a time \(fewer courses/],
    ['a base wider than the sheet', runKit({ tiers: [{ w: 16, d: 2, courses: 2 }] }), /17-notch plank is 100\.5" long/],
  ];
  const badR = refusals.filter(([, r, re]) => !(r.error && re.test(r.error))).map(([what, r]) => `${what}: ${r.error ?? 'NOT refused'}`);
  ok(`${refusals.length} structure refusals, each by name: a tier outside the one below (two ways), one course, no width, an offset base, a malformed list, too many planks, a plank longer than the sheet`, !badR.length, badR.join(' | '));
}

console.log(failed === 0 ? `\nALL ${passed} LINKER LOGS CHECKS PASSED` : `\n${failed} LINKER LOGS CHECK(S) FAILED (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
