// Arc-fit validation — line/arc segmentation and the moves-rail transform.
// Run: node test/arc-fit-test.mjs

import { fitArcs, fitArcsSeeded, arcFitMoves } from '../ir/arc-fit.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) passed++; else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (name, got, want, eps = 1e-6) => ok(name, Math.abs(got - want) <= eps, `got ${got}, want ${want}`);

const tess = (cx, cy, r, a0, a1, steps) => {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
};

// --- a straight polyline stays all lines ------------------------------------
{
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  const segs = fitArcs(pts, 1e-3);
  ok('straight line → all line segments', segs.every((s) => s.type === 'line'), JSON.stringify(segs.map((s) => s.type)));
}

// --- a rectangle ring → exactly 4 line segments -----------------------------
{
  const ring = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }];
  const segs = fitArcs(ring, 1e-3);
  ok('rectangle → 4 lines, no arcs', segs.length === 4 && segs.every((s) => s.type === 'line'),
    JSON.stringify(segs.map((s) => s.type)));
}

// --- a 90° tessellated arc → one arc, correct centre/radius -----------------
{
  const pts = tess(2, 2, 1.5, 0, Math.PI / 2, 16); // CCW quarter circle
  const segs = fitArcs(pts, 1e-3);
  const arcs = segs.filter((s) => s.type === 'arc');
  ok('quarter arc → a single arc segment', segs.length === 1 && arcs.length === 1, JSON.stringify(segs.map((s) => s.type)));
  if (arcs.length) {
    near('fitted centre x', arcs[0].center.x, 2, 1e-3);
    near('fitted centre y', arcs[0].center.y, 2, 1e-3);
    ok('CCW arc is not flagged cw', arcs[0].cw === false, String(arcs[0].cw));
  }
}

// --- a CW arc is flagged cw -------------------------------------------------
{
  const pts = tess(0, 0, 2, Math.PI / 2, 0, 16); // sweeps clockwise
  const arc = fitArcs(pts, 1e-3).find((s) => s.type === 'arc');
  ok('clockwise arc flagged cw', arc && arc.cw === true, arc && String(arc.cw));
}

// --- rounded rectangle → 4 lines + 4 arcs -----------------------------------
{
  const r = 0.5, w = 6, h = 4, seg = 10;
  const ring = [];
  const corner = (cx, cy, a0, a1) => { for (const p of tess(cx, cy, r, a0, a1, seg)) ring.push(p); };
  corner(r, r, Math.PI, Math.PI * 1.5);
  corner(w - r, r, Math.PI * 1.5, Math.PI * 2);
  corner(w - r, h - r, 0, Math.PI * 0.5);
  corner(r, h - r, Math.PI * 0.5, Math.PI);
  ring.push({ ...ring[0] });
  const segs = fitArcs(ring, 1e-3);
  const lines = segs.filter((s) => s.type === 'line').length;
  const arcs = segs.filter((s) => s.type === 'arc').length;
  ok('rounded rect → 4 arcs', arcs === 4, `${arcs} arcs`);
  ok('rounded rect → 4 straight sides', lines === 4, `${lines} lines`);
}

// --- arcFitMoves: deviation from the faceted path stays within tol ----------
{
  // a closed octagon ring of cutting moves at constant z, framed by plunge/retract
  const ring = tess(5, 5, 2, 0, Math.PI * 2, 48);
  const moves = [{ type: 'rapid', x: ring[0].x, y: ring[0].y }, { type: 'linear', z: -0.2 }];
  for (let i = 1; i < ring.length; i++) moves.push({ type: 'linear', x: ring[i].x, y: ring[i].y });
  moves.push({ type: 'rapid', z: 0.25 });

  const tol = 1e-3;
  const fitted = arcFitMoves(moves, tol);
  const arcs = fitted.filter((m) => m.type === 'arc');
  ok('full circle collapses to arcs (≤4 of them)', arcs.length > 0 && arcs.length <= 4, `${arcs.length} arcs`);
  ok('plunge + retract preserved', fitted.some((m) => m.type === 'linear' && m.z === -0.2) && fitted.some((m) => m.type === 'rapid' && m.z === 0.25));

  // reconstruct posted XY path and check every emitted arc midpoint sits on the true circle
  let maxErr = 0;
  let cur = { x: ring[0].x, y: ring[0].y };
  for (const m of fitted) {
    if (m.type === 'arc') {
      const C = { x: cur.x + m.i, y: cur.y + m.j };
      const r = Math.hypot(cur.x - C.x, cur.y - C.y);
      // sample the arc: centre must be the true (5,5) r=2
      maxErr = Math.max(maxErr, Math.abs(C.x - 5), Math.abs(C.y - 5), Math.abs(r - 2));
      cur = { x: m.x, y: m.y };
    } else if (m.type === 'linear' && m.x !== undefined) {
      cur = { x: m.x, y: m.y };
    }
  }
  ok('arc centres/radius match the true circle within tol', maxErr < 5e-3, `maxErr ${maxErr.toFixed(5)}`);
}

// --- arcFitMoves never mutates its input ------------------------------------
{
  const moves = [{ type: 'linear', x: 1, y: 1 }, { type: 'linear', x: 2, y: 2 }];
  const copy = JSON.parse(JSON.stringify(moves));
  arcFitMoves(moves, 1e-3);
  ok('input moves unchanged', JSON.stringify(moves) === JSON.stringify(copy));
}

// --- seeded fit: known centre recovers the arc EXACTLY ----------------------
{
  const pts = tess(3, 2, 1.25, 0, Math.PI / 2, 20); // quarter arc, centre (3,2) r=1.25
  // exact candidate + a decoy that shouldn't match
  const segs = fitArcsSeeded(pts, [{ x: 3, y: 2, r: 1.25 }, { x: 9, y: 9, r: 0.5 }], 2e-3);
  const arcs = segs.filter((s) => s.type === 'arc');
  ok('seeded fit recovers one arc on the known centre', segs.length === 1 && arcs.length === 1, JSON.stringify(segs.map((s) => s.type)));
  ok('seeded arc uses the exact authored centre', arcs[0] && arcs[0].center.x === 3 && arcs[0].center.y === 2, JSON.stringify(arcs[0]?.center));
}

// --- seeded fit: a rectangle's concyclic corners are NOT mistaken for an arc -
{
  const ring = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }];
  // candidates only include the (wrong) circumcircle centre; no corner has a fillet
  const segs = fitArcsSeeded(ring, [{ x: 2, y: 1.5, r: 2.5 }], 1e-3);
  ok('seeded fit leaves a rectangle as lines', segs.every((s) => s.type === 'line'), JSON.stringify(segs.map((s) => s.type)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
