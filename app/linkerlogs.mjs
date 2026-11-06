// linker_logs — a kit of notched plywood PLAY PLANKS (Bill Young's Linker
// Logs, after the 1950s "Plywood Play Planks"): flat planks with matching
// notches on both long edges that cross-lap into each other like log-cabin
// logs, so a pile of them builds walls, towers, forts and bridges with no
// fasteners. One op, many pieces: every plank is cut free as its own
// outline, packed into sheets, counted.
//
// The proportions are measured from Bill's own drawings (4×8 sheet of 1/2"
// plywood, 50 planks):
//
//   plank width 3.5", corners rounded 0.25"
//   notches on BOTH long edges, mirrored, 6" centre to centre, the first
//     one centred 2.25" from each end — so a plank with n notches per edge
//     is (n − 1)·6 + 4.5" long: 4.5 / 10.5 / 22.5 / 34.5 / 46.5 for
//     1 / 2 / 4 / 6 / 8 notches
//   notch depth 0.87" (a quarter of the width, less 0.005"): two crossed
//     planks overlap by half a plank, each course rises the other half
//   notch width = the stock thickness (0.48" and 0.50" in his two files)
//   a T-BONE relief, 0.38" diameter, on each wall at the notch floor: the
//     circle is centred on the wall line and tangent to the floor, so the
//     square edge of the mating plank seats on a flat floor a round bit
//     could not otherwise leave. It costs its own diameter of straight
//     wall: 0.38 off a 0.87 wall leaves 0.49 to grip (56%). That ratio,
//     not the 0.38, is what carries to other scales — the verb sizes the
//     bit to the plank and the relief to the bit (STOCK_BITS, MIN_GRIP),
//     so a half-size plank is cut with a 1/8" bit and keeps 0.30 of 0.43
//   one sheet: 6 × 8-notch, 6 × 6-notch, 8 × 4-notch, 14 × 2-notch,
//     16 × 1-notch
//
// and the ANGLE CONNECTORS (his 2×4 sheet: 12 each at 15°, 30°, 45°): a
// ring segment — two straight edges at the angle, an inner and an outer
// arc about their common centre — with one plank notch in the middle of
// each straight edge, and the angle scored on its face. A plank seated in
// each notch stands at that angle to the other: walls that turn a corner
// other than square, a pitched roof. The rule behind his three, recovered
// from the drawings (it reproduces all six radii to 0.0001" at his 0.48"
// plywood):
//
//   the notch centre sits at radius  (W/2) / tan(angle/2) + t/2
//     — so the two seated planks, each reaching half a plank width W/2 in
//     from its edge, meet exactly along their inner corners
//   the segment reaches one end margin (2.25") either side of that radius
//     — a connector is a one-notch plank bent round a corner
//
// Everything is a parameter; the slot follows the stock thickness, so the
// same kit re-fits itself to whatever plywood is on the table.
//
// A STRUCTURE ("tiers") is the same planks, counted and posed: rectangular
// tiers stacked on the notch grid, log-cabin fashion. Courses alternate
// direction; a course is two planks on the tier's two wall lines, each
// seated in the notches of the course below. Crossed planks each give up a
// quarter of their width, so a course rises half a plank (W − 2·depth) and
// the planks two courses apart on one wall line meet edge to edge: the
// walls are solid, every corner cross-lapped. A tier that steps in cannot
// stand on air — its first course runs LONG, across the full extent of the
// tier below, to reach that tier's walls, and the stepped-in courses then
// sit on those two beams (towerPlan below; the gauntlet checks by brute
// force that every plank is carried at two notches and no two collide).
// SEVERAL tiers may stand on the same one ("on") — spires on a hall, corner
// towers on a keep: each brings its own two beams across the tier below
// (siblings whose walls share a line share that beam), and siblings keep a
// clear cell between them so their planks never want the same notch.
//
// A TOP is the skyline a tier nothing stands on may carry: ONE more course
// of two planks whose bottom edge is notched like any plank — they seat on
// the course below exactly as a plank would, and the structure audit treats
// them as one — and whose top edge is a SILHOUETTE instead of notches: a
// spire, a dome, an ogee, a terraced crown, a battlement, a stepped parapet
// (TOP_SHAPES, topSilhouette, finialRing). The shapes are a fixed
// vocabulary drawn from numbers (height, count), never a traced outline, so
// ornament is chosen and sized, not copied — the likeness rule holds. The
// ornament rides above the plank body (y ≥ W), so the notches, the relief
// and the wall they leave are exactly a plank's.

import { generateProfile } from '../strategies/profile.js';
import { formatDiameter } from '../strategies/tool-select.js';
import { bboxOf } from './lattice.mjs';
import { lineFontById, DEFAULT_LINE_FONT, textToStrokes } from './stroke-fonts.mjs';

const MARGIN = 0.375;         // sheet edge allowance (the board adds its margin)
const ARC_TOL = 0.001;        // inches: chord error when an arc is faceted
const WEB = 0.5;              // skeleton left between two pieces' kerfs — what the tabs hold on to
const MAX_PIECES = 400;       // one job, one weave — a kit past this is several jobs
const DEFAULT_SHEET = [96, 48];
const STOCK_BITS = [0.25, 0.125, 0.0625];   // the endmills a bit sized to the planks is chosen from, biggest first
const MIN_GRIP = 0.5;         // at least this much of a notch wall stays straight above its relief
const RELIEF_CLEAR = 0.01;    // a relief is this much wider than the bit, so the path can turn in it
const LABEL_DEPTH = 0.03;     // the scored angle: a traced line, not relief
const LABEL_CLEAR = 0.08;     // wood kept between a scored label and a notch
export const BILLS_SHEET = [
  { notches: 8, count: 6 }, { notches: 6, count: 6 }, { notches: 4, count: 8 },
  { notches: 2, count: 14 }, { notches: 1, count: 16 },
];
export const BILLS_CONNECTORS = [{ angle: 15, count: 12 }, { angle: 30, count: 12 }, { angle: 45, count: 12 }];

const segsFor = (r, sweep) => Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - ARC_TOL / Math.max(r, ARC_TOL * 2))))));

// an arc of the part's own outline (a corner round, a connector's inner
// and outer edge): vertices ON the circle
function cornerArc(out, cx, cy, r, a0, a1) {
  const n = segsFor(r, a1 - a0);
  for (let k = 0; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
}

// a relief (VOID inside the arc): the facets are TANGENT to the circle, so
// the cut-away shape contains the true round — the bit that fits the
// drawing fits the polygon, and the mating plank's corner clears. The arc
// starts and ends exactly on the circle, leaving along its tangent (the
// wall meets the relief square, the relief runs out flat into the floor).
function reliefArc(out, cx, cy, r, a0, a1) {
  const n = segsFor(r, a1 - a0), step = (a1 - a0) / n, R = r / Math.cos(Math.abs(step) / 2);
  out.push({ x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) });
  for (let k = 0; k < n; k++) { const a = a0 + (k + 0.5) * step; out.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }); }
  out.push({ x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) });
}

// drop the duplicate points where one feature ends where the next begins
function cleanRing(ring) {
  const clean = [];
  for (const q of ring) { const l = clean[clean.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-9) clean.push(q); }
  if (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 1e-9) clean.pop();
  return clean;
}

const H = Math.PI / 2;
// a notch cut UP from the line y = 0 at x = c, traversed left → right
function notchUp(ring, c, s, d, r) {
  ring.push({ x: c - s / 2, y: 0 });
  reliefArc(ring, c - s / 2, d - r, r, -H, -3 * H);       // left wall: bottom → west → top (clockwise: a void)
  reliefArc(ring, c + s / 2, d - r, r, H, -H);            // right wall: top → east → bottom
  ring.push({ x: c + s / 2, y: 0 });
}

/**
 * One plank outline, CCW, in plank-local inches: x along the length
 * (0 … length), y across the width (0 … width).
 * g = { notches, width, pitch, endMargin, slotW, depth, reliefR, cornerR }
 */
export function plankRing(g) {
  const { notches: n, width: W, pitch, endMargin, slotW: s, depth: d, reliefR: r, cornerR: cr } = g;
  const L = (n - 1) * pitch + 2 * endMargin;
  const centres = Array.from({ length: n }, (_, i) => endMargin + i * pitch);
  const ring = [];
  // bottom edge, left → right: each notch cuts UP into the plank
  ring.push({ x: cr, y: 0 });
  for (const c of centres) notchUp(ring, c, s, d, r);
  cornerArc(ring, L - cr, cr, cr, -H, 0);
  cornerArc(ring, L - cr, W - cr, cr, 0, H);
  // top edge, right → left: each notch cuts DOWN
  for (const c of [...centres].reverse()) {
    ring.push({ x: c + s / 2, y: W });
    reliefArc(ring, c + s / 2, W - d + r, r, H, -H);        // right wall: top → east → bottom
    reliefArc(ring, c - s / 2, W - d + r, r, -H, -3 * H);   // left wall: bottom → west → top
    ring.push({ x: c - s / 2, y: W });
  }
  cornerArc(ring, cr, W - cr, cr, H, 2 * H);
  cornerArc(ring, cr, cr, cr, 2 * H, 3 * H);
  return { ring: cleanRing(ring), length: L, centres };
}

/**
 * One angle-connector outline, CCW, in inches about the CENTRE of its two
 * arcs: edge 1 lies along the +x axis, edge 2 at `angle` from it, the piece
 * between radius rIn and rOut. Built as the half belonging to edge 1 and
 * its mirror image across the bisector, so the two notches are identical.
 * g = { angle (degrees), width, endMargin, slotW, depth, reliefR, cornerR, thickness }
 * → { ring, rn, rIn, rOut, web, clear } or { error }
 *   rn    radius of both notch centres
 *   web   wood left between the two notches (measured across the bisector)
 *   clear from the bisector to the nearest notch — the room a label has
 */
export function connectorRing(g) {
  const { angle, width: W, endMargin, slotW: s, depth: d, reliefR: r, cornerR: cr, thickness: t } = g;
  const th = (angle * Math.PI) / 180, half = th / 2;
  const rn = W / 2 / Math.tan(half) + t / 2;
  const rIn = rn - endMargin, rOut = rn + endMargin;
  if (rIn < cr + 0.05) return { error: `a ${angle}° connector is too sharp: its inner edge would close up (inner radius ${rIn.toFixed(2)}") — a smaller angle, a wider plank, or a shorter end margin` };
  // corner rounds on edge 1: tangent to the edge (y = 0) and to each arc
  const fInX = Math.sqrt((rIn + cr) ** 2 - cr ** 2), aIn = Math.atan2(cr, fInX);
  const fOutX = Math.sqrt(Math.max(0, (rOut - cr) ** 2 - cr ** 2)), aOut = Math.atan2(cr, fOutX);
  if (aIn > half - 1e-3) return { error: `a ${angle}° connector is too sharp for ${cr}" corner rounds on its inner edge — a smaller angle or a smaller cornerRadius` };
  const dist = (x, y) => x * Math.sin(half) - y * Math.cos(half);   // from the bisector, toward edge 1
  const web = 2 * Math.min(dist(rn - s / 2, d), dist(rn - s / 2, d - r) - r);
  const clear = dist(rn - s / 2 - r, d);   // the notch and its reliefs, boxed
  const h1 = [];
  cornerArc(h1, 0, 0, rIn, half, aIn);                       // inner arc, from the bisector down to the corner round
  if (cr > 1e-6) cornerArc(h1, fInX, cr, cr, aIn + Math.PI, 3 * H);
  notchUp(h1, rn, s, d, r);
  if (cr > 1e-6) cornerArc(h1, fOutX, cr, cr, -H, aOut);
  cornerArc(h1, 0, 0, rOut, aOut, half);                     // outer arc, up to the bisector
  const c2 = Math.cos(th), s2 = Math.sin(th);
  const mirror = (q) => ({ x: q.x * c2 + q.y * s2, y: q.x * s2 - q.y * c2 });
  return { ring: cleanRing([...h1, ...h1.map(mirror).reverse()]), rn, rIn, rOut, web, clear };
}

// ---- decorative tops ----
export const TOP_SHAPES = {
  spire: { doc: 'straight slopes from both ends to a point at the centre — a steeple when tall, a gable or roofline when low', count: null },
  dome: { doc: 'a half-ellipse, its full height at the centre', count: null },
  ogee: { doc: 'an ogee arch: round shoulders curving in to a sharp point', count: null },
  crown: { doc: 'terraced arches, each stepped in and rising above the one outside it (the Chrysler Building\'s crown) — count = terraces', count: [5, 2, 9] },
  crenellation: { doc: 'a battlement: count square merlons with open crenels between them', count: [5, 2, 30] },
  steps: { doc: 'a stepped parapet rising to the centre — count steps each side (Art Deco setbacks, a ziggurat)', count: [3, 1, 12] },
};
export const TOP_SHAPE_NAMES = Object.keys(TOP_SHAPES);
const CROWN_ARCH = 0.6;      // a crown terrace's arch rises this share of its half-width (a semicircle would be 1)

/**
 * The top edge of a decorative plank: points left → right from x = 0 to
 * x = L, y = height ABOVE the plank body's top line (≥ 0, peak = h).
 * tool = the cutting bit: a slot narrower than it cannot be cut.
 * → { pts, peak, count } or { error }
 */
export function topSilhouette(shape, L, h, count = null, tool = 0) {
  const spec = TOP_SHAPES[shape];
  if (!spec) return { error: `"${shape}" is not a top shape — one of ${TOP_SHAPE_NAMES.join(', ')}` };
  if (!(h > 0)) return { error: `a ${shape} top needs a height above 0 (got ${h})` };
  let n = null;
  if (spec.count) {
    n = Math.round(count ?? spec.count[0]);
    if (!(n >= spec.count[1] && n <= spec.count[2])) return { error: `a ${shape} top takes a count from ${spec.count[1]} to ${spec.count[2]} (got ${count})` };
  }
  const c = L / 2, pts = [];
  const P = (x, y) => pts.push({ x, y });
  const bezier = (p0, p1, p2, p3, m, skipFirst) => {
    for (let k = skipFirst ? 1 : 0; k <= m; k++) {
      const u = k / m, v = 1 - u, a = v * v * v, b = 3 * v * v * u, cc = 3 * v * u * u, d = u * u * u;
      P(a * p0[0] + b * p1[0] + cc * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + cc * p2[1] + d * p3[1]);
    }
  };
  switch (shape) {
    case 'spire': P(0, 0); P(c, h); P(L, 0); break;
    case 'dome': {
      const m = 64;
      for (let k = 0; k <= m; k++) { const th = Math.PI - (Math.PI * k) / m; P(c + c * Math.cos(th), h * Math.sin(th)); }
      break;
    }
    case 'ogee':
      // each half a cubic: a steep round shoulder from the end, pulled in to
      // a vertical tangent at the apex, so the two halves meet in a point
      bezier([0, 0], [0, 0.6 * h], [c, 0.4 * h], [c, h], 32, false);
      bezier([c, h], [c, 0.4 * h], [L, 0.6 * h], [L, 0], 32, true);
      break;
    case 'crown': {
      // n terraces: terrace i is a plinth of half-width a_i = c·(1 − i/n) up
      // to b_i, topped by an elliptical arch of rise r_i. The apexes climb
      // evenly to h; an arch rises CROWN_ARCH of its half-width, or less
      // when that would put its springing below the plank
      const terr = [];
      for (let i = 0; i < n; i++) { const a = c * (1 - i / n), apex = (h * (i + 1)) / n, r = Math.min(apex, CROWN_ARCH * a); terr.push({ a, r, b: apex - r }); }
      const at = (x) => Math.max(0, ...terr.map(T => (Math.abs(x - c) <= T.a + 1e-9 ? T.b + T.r * Math.sqrt(Math.max(0, 1 - ((x - c) / T.a) ** 2)) : 0)));
      const xs = new Set([0, L]);
      for (const T of terr) {
        const m = 48;
        for (let k = 0; k <= m; k++) xs.add(c + T.a * Math.cos(Math.PI - (Math.PI * k) / m));
        if (T.b > 0) { xs.add(c - T.a - 1e-6); xs.add(c + T.a + 1e-6); }   // the riser: a point just outside the terrace's edge
      }
      for (const x of [...xs].sort((p, q) => p - q)) P(Math.min(L, Math.max(0, x)), at(x));
      break;
    }
    case 'crenellation': {
      const unit = L / (2 * n - 1);
      if (unit < tool + 0.05) return { error: `${n} merlons on a ${L.toFixed(1)}" plank leave crenels ${unit.toFixed(2)}" wide — too narrow for a ${tool}" bit (at most ${Math.floor((L / (tool + 0.05) + 1) / 2)} merlons)` };
      for (let j = 0; j < 2 * n - 1; j++) { const y = j % 2 === 0 ? h : 0; P(j * unit, y); P((j + 1) * unit, y); }
      break;
    }
    case 'steps': {
      const m = 2 * n + 1, unit = L / m;
      for (let j = 0; j < m; j++) { const y = (h * (n - Math.abs(j - n) + 1)) / (n + 1); P(j * unit, y); P((j + 1) * unit, y); }
      break;
    }
  }
  pts[0].x = 0; pts[pts.length - 1].x = L;
  return { pts, peak: h, count: n };
}

/**
 * A decorative TOP plank: a plank's notched bottom edge and straight sides,
 * and a silhouette for its top edge. CCW, plank-local inches like plankRing;
 * g as plankRing's, top = { shape, height, count }, tool = the cutting bit.
 * → { ring, length, centres, peak, height } or { error }
 */
export function finialRing(g, top, tool = 0) {
  const { notches: n, width: W, pitch, endMargin, slotW: s, depth: d, reliefR: r, cornerR: cr } = g;
  const L = (n - 1) * pitch + 2 * endMargin;
  const sil = topSilhouette(top.shape, L, top.height, top.count, tool);
  if (sil.error) return sil;
  const centres = Array.from({ length: n }, (_, i) => endMargin + i * pitch);
  const ring = [];
  ring.push({ x: cr, y: 0 });
  for (const c of centres) notchUp(ring, c, s, d, r);
  cornerArc(ring, L - cr, cr, cr, -H, 0);
  // up the right side to the silhouette's end, the silhouette right → left
  // on top of the plank body, down the left side
  for (const q of [...sil.pts].reverse()) ring.push({ x: q.x, y: W + q.y });
  cornerArc(ring, cr, cr, cr, 2 * H, 3 * H);
  return { ring: cleanRing(ring), length: L, centres, peak: sil.peak, height: W + sil.peak, count: sil.count };
}

/**
 * The planks of a stacked-tier structure, on the notch grid.
 * tiers: [{ w, d, courses, x, y, on }] — whole cells; x, y the tier's corner
 * relative to the base tier's; `on` the index of the tier it stands on
 * (-1 for the base; always an EARLIER tier), inside which it must lie.
 * A tier may carry `top` ({ shape, height, count }): one more course of two
 * decorative planks on its own wall lines (planks carry `top` too).
 * → { planks: [{ dir:'x'|'y', line, from, to, course, tier, transfer, top? }], courses, starts }
 *   an 'x' plank runs along X on the wall line y = line, spanning cells
 *   from … to (so it has to − from + 1 notches); a 'y' plank likewise.
 *   courses is the tallest branch; starts[i] the course tier i begins on.
 */
export function towerPlan(tiers) {
  const planks = [], seen = new Set(), starts = [];
  let top = 0;
  tiers.forEach((T, ti) => {
    const on = T.on ?? ti - 1;   // unnamed: the tier before it (a plain stack)
    const below = on >= 0 ? tiers[on] : null;
    const start = below ? starts[on] + below.courses : 0;
    starts.push(start);
    const courses = T.courses + (T.top ? 1 : 0);   // the top is one more course, of decorative planks
    top = Math.max(top, start + courses);
    for (let j = 0; j < courses; j++) {
      const k = start + j;
      // the first course of a tier that stands on another is carried by it:
      // its planks run that tier's full extent to reach its walls. Two
      // siblings whose walls share a line get ONE such beam between them.
      const span = below && j === 0 ? below : T;
      const crown = j === T.courses ? T.top : null;
      const add = (dir, line, from, to) => {
        const key = `${dir}/${line}/${from}/${to}/${k}`;
        if (seen.has(key)) return;
        seen.add(key);
        planks.push({ dir, line, from, to, course: k, tier: ti, transfer: span !== T, ...(crown ? { top: crown } : {}) });
      };
      if (k % 2 === 0) for (const line of [T.y, T.y + T.d]) add('x', line, span.x, span.x + span.w);
      else for (const line of [T.x, T.x + T.w]) add('y', line, span.y, span.y + span.d);
    }
  });
  return { planks, courses: top, starts };
}

const fmtAngle = (a) => `${+a.toFixed(1)}`;

export const LINKER_LOG_ENTRIES = {
  linker_logs: {
    doc: 'Cut a KIT OF LINKER LOGS — notched plywood PLAY PLANKS (Bill Young\'s design, after the 1950s "Plywood Play Planks"; giant flat Lincoln-log-style building planks). Every plank has matching notches on BOTH long edges; two planks cross-lap at a notch, each sinking a quarter of its width into the other, so courses stack like a log cabin and a pile of planks builds walls, towers, forts, bridges and playhouses with no fasteners — and knocks down flat. ONE op makes the WHOLE KIT: each plank is cut free as its own outline with its notches, packed into sheets, counted as a piece. Use it for any ask for Linker Logs, play planks, notched building planks, a plywood log-cabin / fort building set, or interlocking construction planks — never hand-author the planks as cutouts. "planks" lists the kit: [{notches, count}, …], where notches is how many notches the plank has along EACH edge and count how many of that plank (numbers or arithmetic over control ids). A plank\'s length follows its notches: (notches − 1) × pitch + 2 × endMargin — with the defaults 4.5", 10.5", 22.5", 34.5" and 46.5" for 1, 2, 4, 6 and 8 notches (any whole number of notches works: 3 → 16.5", 5 → 28.5"). The default planks list is Bill\'s standard sheet — 6 × 8-notch, 6 × 6-notch, 8 × 4-notch, 14 × 2-notch, 16 × 1-notch = 50 planks on one 4×8 — so leave planks out for "a set of Linker Logs" and use "sets" for more of them. ANGLE CONNECTORS are the kit\'s other part: "connectors" [{angle, count}, …] adds small ring-segment pieces with one plank notch in each of two straight edges set at that angle (degrees; with Bill\'s proportions anything from 5 to about 70 — a sharper one closes up its inner edge and is refused by name), so a plank seated in each stands at that angle to the other — for walls that turn a corner other than square, polygons, a pitched roof. Bill\'s connector sheet is [{"angle":15,"count":12},{"angle":30,"count":12},{"angle":45,"count":12}] (36 pieces, a 2×4); the default is none, so add them when the user asks for connectors, angles, a roof or a round/polygonal build — and pass planks [] to cut connectors alone. Each connector has its angle scored on its face ("labels", on by default) so 15s and 30s are told apart in the bin: the label is a traced hairline with a 60° V-bit, which is a TOOL CHANGE before the cutting bit — say so, or set labelToolDiameter to the cutting bit\'s diameter to score with it and skip the change, or labels false. TO BUILD A STRUCTURE instead of a loose kit, give "tiers": a tower, a skyscraper\'s massing with its setbacks, a stepped pyramid, a fort or keep, a box — anything that is RECTANGULAR TIERS stacked bottom to top — as [{w, d, courses, x?, y?, on?}, …]. w and d are the tier\'s footprint in GRID CELLS across and deep (one cell = one pitch, 6" by default), courses how many plank courses tall it is (at least 2), and x, y its corner in cells from the BASE tier\'s corner (default: centred on the tier it stands on — keep the widths all odd or all even so setbacks come out symmetric). Each tier stands on the PREVIOUS tier in the list unless "on" names another (the index of an earlier tier, 0 = the base) and must sit inside it. SEVERAL tiers may stand on the same one — a hall with a spire at each end, a keep with four corner towers, twin towers on a podium: give each "on" and its own x, y, and leave at least ONE CLEAR CELL between any two that share a tier (so two 1 × 1 spires need a base at least 3 cells that way: cells 0–1 and 2–3). The structure\'s height is its tallest branch. Courses alternate direction and each rises half a plank width (1.76" by default), so a branch\'s height is (its courses, base to top − 1) × 1.76 + 3.5; the footprint is the base tier\'s cells × pitch + 4.5. The op then cuts EXACTLY the planks the structure needs (two per course; the first course of a tier that stands on another runs long, across that tier, to carry it), counts them, and shows the structure ASSEMBLED in the 3D view (no set_assembly). With tiers, "planks" lists SPARES to add (default none) and connectors stay optional extras. Walls come out solid — planks stack edge to edge — with every corner cross-lapped and the top open. The SKYLINE is a tier\'s "top": any tier NOTHING stands on may carry top {"shape", "height", "count"?} — one more course of two planks notched underneath like any plank and cut to a silhouette on top, rising "height" inches above the plank (default one plank width). Shapes, by name only: "spire" (a point — steeple when tall, gable or roofline when low), "dome" (half-ellipse), "ogee" (round shoulders to a sharp point), "crown" (terraced arches stepping in and up, the Chrysler Building\'s crown; count = terraces, 2–9, default 5), "crenellation" (a battlement, count merlons, default 5), "steps" (a stepped parapet rising to the centre, count steps each side, default 3). [{"w":3,"d":3,"courses":12},{"w":1,"d":1,"courses":20,"top":{"shape":"crown","height":9,"count":7}}] is a tower with a terraced crown. The top shows on the two faces its planks run along; it is chosen and sized from this vocabulary — never an outline traced from a picture — and a top on a tier another tier stands on is refused by name. A top taller than the sheet is wide is refused; one more than twice its plank\'s length is warned as fragile. Everything else a building wears — windows, columns, statues, a needle finer than a spire, anything on the walls — is NOT built: decline it by name. Size it with the grid: scale plankWidth / pitch / endMargin and the stock together to reach a target height, and report the height and footprint the observation gives. THE STOCK THICKNESS IS THE NOTCH WIDTH: Bill draws it for 1/2" plywood, so set_thickness 0.5 unless the user names their plywood (thicker stock works — the notches widen to match; say so). Notch width = stock thickness + slotClearance; notch depth is a quarter of plankWidth, so two crossed planks overlap by half a plank; each notch floor carries a round T-bone relief on both walls so the square edge of the mating plank seats (no dog-bone needed). THE BIT IS SIZED TO THE PLANKS: leave toolDiameter and reliefDiameter at 0 and the verb picks the largest of 1/4", 1/8" and 1/16" that fits the notch and leaves at least half of every notch wall straight above its relief for the crossing plank to grip (a relief takes its own diameter off that wall, so a bit too big for a small plank leaves the joint nothing to hold) — the observation names the bit it chose; say which bit to load. TO BUILD AT ANOTHER SCALE (a tabletop set, a model) scale plankWidth, pitch and endMargin together (Bill\'s are 3.5 / 6 / 2.25) and pick stock near plankWidth ÷ 7; the bit follows by itself. The pieces are laid along the long side of a 4×8 sheet, or of the shop\'s declared material / machine area, in as few sheets as they need; when that is more than one, a warning says how many and "setup" picks the sheet this file cuts — bind it to a control. A plank longer than the sheet is refused by name (fewer notches). claims.pieces = the total piece count across all sheets, planks plus connectors (read it from the observation). WITHOUT tiers this is a KIT OF LOOSE PARTS: it has no assembled view and makes no particular building — do not promise one. Never pair it with set_assembly or add cutouts for the pieces.',
    freesPieces: true,
    params: {
      planks: { type: 'object', default: BILLS_SHEET, doc: 'the planks: [{"notches":8,"count":6},{"notches":2,"count":14}] — notches per edge (whole number ≥ 1, sets the length) and how many of that plank (numbers or arithmetic strings over control ids). Default: Bill\'s standard 50-plank sheet. [] with connectors cuts connectors alone' },
      connectors: { type: 'object', default: [], doc: 'angle connectors: [{"angle":30,"count":12}] — the angle between the two notched edges, degrees (5 to about 70), and how many (numbers or arithmetic over control ids). Default none; Bill\'s connector sheet is 12 each at 15, 30 and 45' },
      tiers: { type: 'object', default: [], doc: 'a structure, bottom to top: [{"w":3,"d":3,"courses":12},{"w":1,"d":1,"courses":20}] — w × d grid cells, courses tall (≥ 2), optional x / y corner in cells from the base tier\'s corner (default centred on the tier it stands on), optional "on": the index of the earlier tier it stands on (default the previous one; several tiers may share one, a clear cell apart — [{"w":7,"d":3,"courses":6},{"w":1,"d":1,"courses":10,"on":0,"x":0,"y":1},{"w":1,"d":1,"courses":10,"on":0,"x":6,"y":1}] is a hall with a spire at each end); optional "top": {"shape":"spire"|"dome"|"ogee"|"crown"|"crenellation"|"steps", "height": inches above the plank, "count"?: terraces / merlons / steps} on a tier nothing stands on — the skyline; numbers or arithmetic over control ids. Default none (a loose kit)' },
      sets: { type: 'number', default: 1, min: 1, max: 20, doc: 'how many times over to cut the planks and connectors lists (2 = two kits), whole number', bindable: true },
      plankWidth: { type: 'number', default: 3.5, min: 0.75, max: 12, doc: 'plank width, inches (Bill\'s is 3.5)', bindable: true },
      pitch: { type: 'number', default: 6, min: 1, max: 24, doc: 'notch spacing, centre to centre, inches (Bill\'s is 6) — the building grid', bindable: true },
      endMargin: { type: 'number', default: 2.25, min: 0.4, max: 12, doc: 'from each plank end to the centre of its first notch, inches (Bill\'s is 2.25, three-eighths of the pitch) — the overhang past a corner, and how far a connector reaches either side of its notches', bindable: true },
      notchDepth: { type: 'number', default: 0, min: 0, max: 6, doc: 'notch depth, inches; 0 = a quarter of plankWidth less 0.005" (Bill\'s 0.87 on a 3.5 plank) — leave 0 unless asked, since both pieces of a crossing must share it' },
      reliefDiameter: { type: 'number', default: 0, min: 0, max: 1, doc: 'diameter of the round relief at each notch-floor corner, inches; 0 = just clears the bit (bit + 0.01"), which leaves the most notch wall to grip the crossing plank — leave 0 unless asked. Bill\'s drawing has 0.38 for his 3/8" bit; a relief that leaves less than half the notch wall straight is refused' },
      cornerRadius: { type: 'number', default: 0.25, min: 0, max: 2, doc: 'radius on every outside corner, inches (toys want soft corners)' },
      slotClearance: { type: 'number', default: 0.01, min: 0, max: 0.1, doc: 'extra notch width beyond the stock thickness, inches (0.01 is a snug fit; 0.02–0.03 loosens it for small hands or painted planks)' },
      labels: { type: 'boolean', default: true, doc: 'score each connector\'s angle on its face (planks carry no label)' },
      labelToolDiameter: { type: 'number', default: 0, min: 0, max: 0.5, doc: 'flat endmill diameter for the scored labels, inches — the line is exactly this wide; 0 = a fine 60° V-bit hairline (a tool change). Set it to toolDiameter to score with the cutting bit' },
      toolDiameter: { type: 'number', default: 0, min: 0, doc: 'endmill diameter, inches; 0 = SIZED TO THE PLANKS: the largest of 1/4", 1/8" and 1/16" that fits the notch and leaves at least half of each notch wall straight above its relief (1/4" for Bill\'s 3.5" planks, 1/8" at half scale, 1/16" at quarter scale) — leave 0 unless the user names a bit. A named bit that leaves less than half the wall is refused with the bit that fits' },
      feedRate: { type: 'number', default: 0, min: 0, doc: 'inches per minute; 0 = 80 for a 1/8" bit or bigger, 40 for a finer one' },
      setup: { type: 'number', default: 1, min: 1, bindable: true, doc: 'which SHEET to cut when the kit needs several: this picks the one this file cuts — bind it to a number control' },
      tabs: { type: 'boolean', default: true, doc: 'holding tabs on every piece (long thin parts shift when freed)' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches' },
      tabSpacing: { type: 'number', default: 12, doc: 'target spacing between tabs along the cut, inches (the notches make a plank\'s outline long — 12 puts about a dozen on the longest plank, four on the shortest; every tab is an edge to sand on a toy)' },
    },
    run(p, ctx) {
      const t = ctx.stock.thickness;
      const W = +p.plankWidth, pitch = +p.pitch, endMargin = +p.endMargin;
      const slotW = t + Math.max(0, +p.slotClearance || 0);

      // ---- the notch ----
      const depth = p.notchDepth > 0 ? +p.notchDepth : W / 4 - 0.005;
      const warnings = [];
      // ---- the bit, sized to the planks ----
      // A round bit cannot cut the square corner at a notch floor, so each
      // wall carries a round relief there — and the relief takes its whole
      // diameter off the straight wall the crossing plank grips. On Bill's
      // 3.5" plank his 3/8" bit leaves 0.49" of a 0.87" wall; the same bit
      // and relief on a half-size plank would leave 0.05". So the bit is
      // chosen FOR the plank: the biggest stock endmill that fits the notch
      // and leaves at least MIN_GRIP of the wall straight.
      const gripOf = (bit) => depth - Math.max(+p.reliefDiameter || 0, bit + RELIEF_CLEAR);
      const fits = (bit) => bit <= slotW + 1e-9 && gripOf(bit) >= MIN_GRIP * depth - 1e-9;
      if (+p.toolDiameter < 0) return { error: 'linker_logs: toolDiameter must be positive (or 0 to size the bit to the planks)' };
      const named = +p.toolDiameter > 0;
      const tool = named ? +p.toolDiameter : STOCK_BITS.find(fits);
      const finer = STOCK_BITS.find(b => b < (tool ?? Infinity) && fits(b));
      if (!tool && +p.reliefDiameter > 0) {
        // it is the NAMED relief that leaves no wall, not the plank
        const bare = STOCK_BITS.find(b => b <= slotW + 1e-9 && depth - (b + RELIEF_CLEAR) >= MIN_GRIP * depth - 1e-9);
        if (bare) return { error: `linker_logs: a ${(+p.reliefDiameter).toFixed(3)}" relief in a ${depth.toFixed(3)}" deep notch leaves only ${Math.max(0, depth - p.reliefDiameter).toFixed(3)}" of straight wall for the crossing plank to grip — at least half is needed. Leave reliefDiameter at 0: a ${formatDiameter(bare)} endmill needs only ${(bare + RELIEF_CLEAR).toFixed(3)}" and leaves ${(depth - bare - RELIEF_CLEAR).toFixed(3)}"` };
      }
      if (!tool) {
        return { error: `linker_logs: no stock endmill (1/4", 1/8", 1/16") fits a ${slotW.toFixed(3)}" wide, ${depth.toFixed(3)}" deep notch and leaves half its wall straight — a wider plank, or thicker stock` };
      }
      if (tool > slotW + 1e-9) return { error: `linker_logs: the ${formatDiameter(tool)} endmill is wider than the ${slotW.toFixed(3)}" notch (stock thickness ${t}" + clearance) — use a bit no wider than the stock thickness` };
      // the relief must swallow the bit, with room for the path to turn
      let reliefD = +p.reliefDiameter || 0;
      if (reliefD < tool + RELIEF_CLEAR) {
        if (reliefD > 0 && reliefD < tool - 1e-9) warnings.push(`the ${reliefD}" notch reliefs were opened to ${(tool + RELIEF_CLEAR).toFixed(3)}" so the ${formatDiameter(tool)} endmill can cut them`);
        reliefD = tool + RELIEF_CLEAR;
      }
      const grip = depth - reliefD;   // straight notch wall left above the relief
      if (grip < MIN_GRIP * depth - 1e-9) {
        const pct = Math.max(0, Math.round((grip / depth) * 100));
        const tooBigRelief = reliefD > tool + RELIEF_CLEAR + 1e-9 && depth - (tool + RELIEF_CLEAR) >= MIN_GRIP * depth - 1e-9;
        // the stock bit that WOULD work here with a relief no bigger than it needs
        const bare = STOCK_BITS.find(b => b <= slotW + 1e-9 && depth - (b + RELIEF_CLEAR) >= MIN_GRIP * depth - 1e-9);
        const fix = tooBigRelief
          ? `a smaller relief (leave reliefDiameter at 0: ${(tool + RELIEF_CLEAR).toFixed(3)}" clears the ${formatDiameter(tool)} bit and leaves ${(depth - tool - RELIEF_CLEAR).toFixed(3)}")`
          : finer
            ? `a finer bit: a ${formatDiameter(finer)} endmill leaves ${gripOf(finer).toFixed(3)}" (or leave toolDiameter at 0 and the bit is sized to the planks)`
            : bare
              ? `a finer bit and its own relief: leave toolDiameter and reliefDiameter at 0 — a ${formatDiameter(bare)} endmill with a ${(bare + RELIEF_CLEAR).toFixed(3)}" relief leaves ${(depth - bare - RELIEF_CLEAR).toFixed(3)}"`
              : 'a wider plank or a deeper notch';
        return { error: `linker_logs: a ${reliefD.toFixed(3)}" relief for the ${formatDiameter(tool)} endmill in a ${depth.toFixed(3)}" deep notch leaves only ${Math.max(0, grip).toFixed(3)}" of straight wall (${pct}%) for the crossing plank to grip — at least half is needed. Use ${fix}` };
      }
      const feed = +p.feedRate > 0 ? +p.feedRate : tool >= 0.125 - 1e-9 ? 80 : 40;
      const reliefR = reliefD / 2;
      const wall = Math.max(t, tool);   // the least material worth leaving beside a cut
      const web = W - 2 * depth;
      if (web < wall) return { error: `linker_logs: notches ${depth.toFixed(3)}" deep from both edges leave only ${web.toFixed(3)}" of a ${W}" plank between them — a wider plank or shallower notches (the web should be at least the ${wall}" stock thickness)` };
      const between = pitch - slotW - 2 * reliefR;
      if (between < wall) return { error: `linker_logs: notches ${pitch}" apart leave only ${between.toFixed(3)}" between one notch's relief and the next — a wider pitch (at least ${(slotW + 2 * reliefR + wall).toFixed(2)}")` };
      const endLand = endMargin - slotW / 2 - reliefR;
      if (endLand < wall) return { error: `linker_logs: an end margin of ${endMargin}" leaves only ${endLand.toFixed(3)}" of plank beyond the last notch — at least ${(slotW / 2 + reliefR + wall).toFixed(2)}"` };
      const cornerR = Math.max(0, Math.min(+p.cornerRadius || 0, W / 2 - 1e-3, endLand - 1e-3));

      // ---- the kit ----
      const listOf = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : v == null ? [] : null);
      const tierList = listOf(p.tiers, 'tiers'), connList = listOf(p.connectors, 'connectors');
      if (!tierList) return { error: 'linker_logs: tiers needs a list [{w, d, courses}, …] — the structure\'s tiers, bottom to top' };
      // with a structure, planks lists SPARES: the default sheet is not added to it
      const plankList = tierList.length && p.planks === BILLS_SHEET ? [] : listOf(p.planks, 'planks');
      if (!plankList) return { error: 'linker_logs: planks needs a list [{notches, count}, …] — which planks, and how many of each' };
      if (!connList) return { error: 'linker_logs: connectors needs a list [{angle, count}, …] — which angles, and how many of each' };
      if (!plankList.length && !connList.length && !tierList.length) return { error: 'linker_logs: planks and connectors are both empty — list the planks [{notches, count}, …] and/or the connectors [{angle, count}, …] to cut' };
      const sets = Math.max(1, Math.round(+p.sets || 1));
      const numAt = (v, where) => {
        const r = ctx.evalNumber(v ?? 0);
        if (r.error || !Number.isFinite(r.value)) return { error: `linker_logs: ${where} "${v}": ${r.error ?? 'not a number'}` };
        return r;
      };
      const kinds = new Map();   // notches → count
      for (let i = 0; i < plankList.length; i++) {
        const row = plankList[i] ?? {};
        const n = numAt(row.notches, `planks[${i}].notches`), c = numAt(row.count ?? 1, `planks[${i}].count`);
        if (n.error) return n; if (c.error) return c;
        const notches = Math.round(n.value), count = Math.round(c.value) * sets;
        if (!(notches >= 1)) return { error: `linker_logs: planks[${i}] needs at least 1 notch per edge (got ${n.value})` };
        if (notches > 60) return { error: `linker_logs: planks[${i}] asks for ${notches} notches per edge — 60 is the most one plank carries` };
        if (count < 0) return { error: `linker_logs: planks[${i}].count is negative (${c.value})` };
        if (count > 0) kinds.set(notches, (kinds.get(notches) ?? 0) + count);
      }
      const angles = new Map();  // angle → count
      for (let i = 0; i < connList.length; i++) {
        const row = connList[i] ?? {};
        const a = numAt(row.angle, `connectors[${i}].angle`), c = numAt(row.count ?? 1, `connectors[${i}].count`);
        if (a.error) return a; if (c.error) return c;
        const angle = Math.round(a.value * 10) / 10, count = Math.round(c.value) * sets;
        if (!(angle >= 5 && angle <= 80)) return { error: `linker_logs: connectors[${i}].angle is ${a.value}° — a connector turns between 5° and 80° (two planks crossed in each other's notches already make 90°)` };
        if (count < 0) return { error: `linker_logs: connectors[${i}].count is negative (${c.value})` };
        if (count > 0) angles.set(angle, (angles.get(angle) ?? 0) + count);
      }
      // the structure: whole-cell tiers, each standing on (and inside) an earlier one
      const tiers = [];
      for (let i = 0; i < tierList.length; i++) {
        const row = tierList[i] ?? {};
        const w = numAt(row.w, `tiers[${i}].w`), d = numAt(row.d ?? row.w, `tiers[${i}].d`), c = numAt(row.courses, `tiers[${i}].courses`);
        if (w.error) return w; if (d.error) return d; if (c.error) return c;
        const T = { w: Math.round(w.value), d: Math.round(d.value), courses: Math.round(c.value), on: i - 1 };
        if (!(T.w >= 1 && T.d >= 1)) return { error: `linker_logs: tiers[${i}] needs a footprint of at least 1 × 1 cells (got ${w.value} × ${d.value})` };
        if (!(T.courses >= 2)) return { error: `linker_logs: tiers[${i}] needs at least 2 courses (one each way) — got ${c.value}` };
        if (row.on != null) {
          const on = numAt(row.on, `tiers[${i}].on`);
          if (on.error) return on;
          T.on = Math.round(on.value);
          if (i === 0) return { error: 'linker_logs: tiers[0] is the base — it stands on the ground, so it takes no "on"' };
          if (!(T.on >= 0 && T.on < i)) return { error: `linker_logs: tiers[${i}].on is ${on.value} — a tier stands on an EARLIER tier in the list (0 … ${i - 1}); list the tiers bottom to top` };
        }
        const below = tiers[T.on];
        for (const [axis, size, belowSize] of [['x', T.w, below?.w], ['y', T.d, below?.d]]) {
          if (row[axis] == null) { T[axis] = below ? below[axis] + Math.floor((belowSize - size) / 2) : 0; continue; }
          const v = numAt(row[axis], `tiers[${i}].${axis}`);
          if (v.error) return v;
          T[axis] = Math.round(v.value);
        }
        if (!below && (T.x !== 0 || T.y !== 0)) return { error: 'linker_logs: tiers[0] is the base — its x and y are 0 (the other tiers are placed from its corner)' };
        if (below && (T.x < below.x || T.y < below.y || T.x + T.w > below.x + below.w || T.y + T.d > below.y + below.d)) {
          return { error: `linker_logs: tiers[${i}] (${T.w} × ${T.d} cells at x ${T.x}, y ${T.y}) reaches outside tiers[${T.on}] (${below.w} × ${below.d} at x ${below.x}, y ${below.y}) — a tier stands on the walls of the one below, so it must fit inside it` };
        }
        // siblings: two tiers on the same one need a clear cell between
        // them, or their planks would want the same notches
        const clash = tiers.findIndex(S => S.on === T.on && !(T.x > S.x + S.w || S.x > T.x + T.w || T.y > S.y + S.d || S.y > T.y + T.d));
        if (i > 0 && clash >= 0) {
          const S = tiers[clash];
          return { error: `linker_logs: tiers[${i}] (${T.w} × ${T.d} at x ${T.x}, y ${T.y}) and tiers[${clash}] (${S.w} × ${S.d} at x ${S.x}, y ${S.y}) both stand on tiers[${T.on}] and touch or overlap — leave at least one clear cell between two tiers on the same one (give each its own x / y)` };
        }
        if (row.top != null) {
          const tp = typeof row.top === 'string' ? { shape: row.top } : row.top;
          if (!tp || typeof tp !== 'object' || typeof tp.shape !== 'string') return { error: `linker_logs: tiers[${i}].top needs {"shape", "height"} — shape one of ${TOP_SHAPE_NAMES.join(', ')}` };
          const shape = tp.shape.trim().toLowerCase();
          if (!TOP_SHAPES[shape]) return { error: `linker_logs: tiers[${i}].top.shape "${tp.shape}" is not a top shape — one of ${TOP_SHAPE_NAMES.join(', ')}` };
          const h = tp.height == null ? { value: W } : numAt(tp.height, `tiers[${i}].top.height`);
          if (h.error) return h;
          if (!(h.value > 0)) return { error: `linker_logs: tiers[${i}].top.height is ${h.value} — the ornament's height above the plank, in inches (above 0)` };
          let count = null;
          if (tp.count != null) { const cn = numAt(tp.count, `tiers[${i}].top.count`); if (cn.error) return cn; count = Math.round(cn.value); }
          else if (TOP_SHAPES[shape].count) count = TOP_SHAPES[shape].count[0];
          T.top = { shape, height: h.value, count };
        }
        tiers.push(T);
      }
      // a top is a skyline: nothing stands on it
      for (let i = 0; i < tiers.length; i++) {
        const above = tiers.findIndex(S => S.on === i);
        if (tiers[i].top && above >= 0) return { error: `linker_logs: tiers[${i}] carries a ${tiers[i].top.shape} top but tiers[${above}] stands on it — a top goes only on a tier nothing stands on (move the top to tiers[${above}], or drop it)` };
      }
      const plan = tiers.length ? towerPlan(tiers) : null;
      const nStruct = plan ? plan.planks.length * sets : 0;
      const nPlanks = [...kinds.values()].reduce((a, b) => a + b, 0) + nStruct, nConn = [...angles.values()].reduce((a, b) => a + b, 0);
      const total = nPlanks + nConn;
      if (!total) return { error: 'linker_logs: every count is 0 — nothing to cut' };
      if (total > MAX_PIECES) return { error: `linker_logs: ${total} ${nConn ? 'pieces' : 'planks'} in one job — cut at most ${MAX_PIECES} at a time (${plan ? 'fewer courses, or build it in sections' : 'lower sets or the counts'})` };

      // ---- the scored labels ----
      const labelTool = Math.max(0, +p.labelToolDiameter || 0);   // 0 = V-bit hairline
      const labelR = labelTool / 2;
      const font = lineFontById(DEFAULT_LINE_FONT);

      // one outline per kind, a piece per part. Every piece is local to its
      // own bounding box (0,0 at its lower-left) with w along the row.
      const pieces = [];
      for (const [angle, count] of [...angles].sort((a, b) => b[0] - a[0])) {
        const cr = connectorRing({ angle, width: W, endMargin, slotW, depth, reliefR, cornerR, thickness: t });
        if (cr.error) return { error: `linker_logs: ${cr.error}` };
        if (cr.web < wall) return { error: `linker_logs: a ${fmtAngle(angle)}° connector leaves only ${cr.web.toFixed(3)}" between its two notches — a smaller angle or a wider plank` };
        const bb = bboxOf(cr.ring);
        const shift = (q) => ({ x: q.x - bb.minX, y: q.y - bb.minY });
        // the angle, scored along the bisector between the two notches,
        // reading outward from the centre; sized to the room it has
        let label = null;
        if (p.labels) {
          const room = 2 * (cr.clear - labelR - LABEL_CLEAR);
          const capH = Math.min(0.26 * W, room);
          const laid = capH >= 0.25 ? textToStrokes(font, fmtAngle(angle), capH) : null;
          if (laid?.bbox) {
            const lw = laid.bbox.maxX - laid.bbox.minX, fit = Math.min(1, (2 * endMargin - 2 * cornerR - 0.5 - labelTool) / lw);
            const cx = (laid.bbox.minX + laid.bbox.maxX) / 2, cy = (laid.bbox.minY + laid.bbox.maxY) / 2;
            const half = (angle * Math.PI) / 360, ca = Math.cos(half), sa = Math.sin(half);
            const ox = cr.rn * ca, oy = cr.rn * sa;
            label = laid.polylines.map(pl => pl.map(q => {
              const u = (q.x - cx) * fit, v = (q.y - cy) * fit;
              return shift({ x: ox + u * ca - v * sa, y: oy + u * sa + v * ca });
            }));
          } else warnings.push(`the ${fmtAngle(angle)}° connectors are too small between their notches to score a label — cut unlabelled`);
        }
        const ring = cr.ring.map(shift);
        for (let k = 0; k < count; k++) pieces.push({ id: `A${fmtAngle(angle)}-${k + 1}`, kind: `${fmtAngle(angle)}° connector`, ring, label, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, area: (bb.maxX - bb.minX) * (bb.maxY - bb.minY) });
      }
      const outlines = new Map();   // notches → plank outline, drawn once
      const outlineFor = (notches) => outlines.get(notches) ?? outlines.set(notches, plankRing({ notches, width: W, pitch, endMargin, slotW, depth, reliefR, cornerR })).get(notches);
      const plankPiece = (id, notches, pose = null) => { const pr = outlineFor(notches); return { id, kind: `${notches}-notch`, plank: true, notches, ring: pr.ring, label: null, w: pr.length, h: W, area: pr.length * W, pose }; };
      // a decorative top plank: a plank's notched bottom, a silhouette on top
      const finials = new Map();
      const finialFor = (notches, top) => {
        const key = `${notches}/${top.shape}/${top.height}/${top.count}`;
        if (!finials.has(key)) finials.set(key, finialRing({ notches, width: W, pitch, endMargin, slotW, depth, reliefR, cornerR }, top, tool));
        return finials.get(key);
      };
      const topPiece = (id, notches, top, tierIndex, pose = null) => {
        const fr = finialFor(notches, top);
        if (fr.error) return { error: `linker_logs: tiers[${tierIndex}].top: ${fr.error}` };
        return { id, kind: `${notches}-notch ${top.shape} top`, plank: true, top: true, tier: tierIndex, shape: top.shape, peak: fr.peak, count: fr.count, notches, ring: fr.ring, label: null, w: fr.length, h: fr.height, area: fr.length * fr.height, pose };
      };
      // the structure's planks: named by course (C7-1, C7-2), posed in the
      // assembled view; a second set is the same planks, loose
      if (plan) {
        const nth = new Map();
        for (let s = 0; s < sets; s++) for (const sp of plan.planks) {
          const key = `${s}/${sp.course}`, i = (nth.get(key) ?? 0) + 1;
          nth.set(key, i);
          const id = `C${sp.course + 1}-${i}${s ? `/${s + 1}` : ''}`, notches = sp.to - sp.from + 1;
          if (!sp.top) { pieces.push(plankPiece(id, notches, s ? null : sp)); continue; }
          const pc = topPiece(id, notches, sp.top, sp.tier, s ? null : sp);
          if (pc.error) return pc;
          if (pc.peak > 2 * pc.w) warnings.push(`the ${sp.top.shape} top on tiers[${sp.tier}] rises ${pc.peak.toFixed(1)}" above a ${pc.w.toFixed(1)}" plank — a thin, fragile piece in ${t}" stock; a lower top or a wider tier would be sturdier`);
          pieces.push(pc);
        }
      }
      for (const [notches, count] of [...kinds].sort((a, b) => b[0] - a[0])) {
        for (let k = 0; k < count; k++) pieces.push(plankPiece(`P${notches}-${k + 1}`, notches));
      }

      // ---- sheets: rows along the long side, first-fit ----
      // 4×8 unless the shop declares its material or its machine; the
      // board adds its own margin and the kerf, so pack inside them
      const lim = (a, b) => { const v = [a, b].filter(x => x > 0); return v.length ? Math.min(...v) : null; };
      const sheetW = lim(ctx.shop?.machineW, ctx.shop?.materialW) ?? DEFAULT_SHEET[0];
      const sheetH = lim(ctx.shop?.machineH, ctx.shop?.materialH) ?? DEFAULT_SHEET[1];
      // between pieces: an outside profile sweeps a full bit diameter beyond
      // each outline, so two kerfs plus a web of skeleton for the tabs to
      // hold on to (Bill's own sheet leaves about 1.25" between rows)
      const gap = 2 * tool + WEB;
      const longSide = Math.max(sheetW, sheetH) - 2 * MARGIN - tool;
      const shortSide = Math.min(sheetW, sheetH) - 2 * MARGIN - tool;
      const upright = sheetH > sheetW;          // the long side runs up the board: stand the rows on end
      const tooLong = pieces.find(pc => pc.w > longSide + 1e-9);
      if (tooLong) {
        return { error: tooLong.plank
          ? `linker_logs: the ${tooLong.notches}-notch plank is ${tooLong.w.toFixed(1)}" long and the ${sheetW}" × ${sheetH}" sheet takes at most ${longSide.toFixed(1)}" — use planks with fewer notches (${Math.max(1, Math.floor((longSide - 2 * endMargin) / pitch) + 1)} at most), or a shorter pitch`
          : `linker_logs: a ${tooLong.kind} is ${tooLong.w.toFixed(1)}" long and the ${sheetW}" × ${sheetH}" sheet takes at most ${longSide.toFixed(1)}" — a bigger sheet or a smaller kit scale` };
      }
      const tooTall = pieces.find(pc => pc.h > shortSide + 1e-9);
      if (tooTall) {
        return { error: tooTall.top
          ? `linker_logs: the ${tooTall.shape} top on tiers[${tooTall.tier}] is ${tooTall.h.toFixed(1)}" tall (a ${W}" plank plus ${tooTall.peak.toFixed(1)}" of ornament) and the ${sheetW}" × ${sheetH}" sheet takes at most ${shortSide.toFixed(1)}" across — a lower top (at most ${(shortSide - W).toFixed(1)}") or a bigger sheet`
          : `linker_logs: a ${tooTall.plank ? `${W}" plank` : tooTall.kind} (${tooTall.h.toFixed(1)}" across) does not fit across the ${sheetW}" × ${sheetH}" sheet — a narrower plank or a bigger sheet` };
      }
      // tallest rows first, longest pieces first within a height: a piece
      // joins the first row it fits in (never a row shorter than itself)
      const order = [...pieces].sort((a, b) => (Math.abs(b.h - a.h) > 1e-9 ? b.h - a.h : b.w - a.w));
      const rows = [];   // { h, used, items: [{pc, x}] }
      for (const pc of order) {
        let row = rows.find(r => pc.h <= r.h + 1e-9 && r.used + gap + pc.w <= longSide + 1e-9);
        if (!row) { row = { h: pc.h, used: -gap, items: [] }; rows.push(row); }
        row.items.push({ pc, x: row.used + gap });
        row.used += gap + pc.w;
      }
      const bins = [];   // { used, rows: [{row, y}] }
      for (const row of rows) {
        let bin = bins.find(b => b.used + gap + row.h <= shortSide + 1e-9);
        if (!bin) { bin = { used: -gap, rows: [] }; bins.push(bin); }
        bin.rows.push({ row, y: bin.used + gap });
        bin.used += gap + row.h;
      }
      const nBins = bins.length;
      const setup = Math.min(nBins, Math.max(1, Math.round(+p.setup || 1)));
      const placed = [];
      bins.forEach((bin, b) => {
        for (const { row, y } of bin.rows) for (const { pc, x } of row.items) {
          // rows run along X; on an upright sheet the whole layout is turned a
          // quarter (x, y) → (span − y, x) — a proper rotation, so every ring
          // keeps its handedness and a label still reads
          const at = (q) => (upright ? { x: bin.used - (q.y + y), y: q.x + x } : { x: q.x + x, y: q.y + y });
          placed.push({ ...pc, ring: pc.ring.map(at), label: pc.label?.map(pl => pl.map(at)) ?? null, bin: b, at: { x, y, span: bin.used } });
        }
      });
      const groups = Array.from({ length: nBins }, (_, b) => placed.filter(pc => pc.bin === b).map(pc => pc.id));
      if (nBins > 1) {
        const tally = (b) => { const m = new Map(); for (const pc of placed) if (pc.bin === b) m.set(pc.kind, (m.get(pc.kind) ?? 0) + 1); return [...m].map(([k, c]) => `${c} × ${k}`).join(', '); };
        const noun = nConn ? 'pieces' : 'planks';
        warnings.push(`the ${placed.length} ${noun} need ${nBins} sheets of ${sheetW}" × ${sheetH}" — ${groups.map((ids, b) => `sheet ${b + 1}: ${ids.length} ${noun} (${tally(b)})`).join('; ')}. This file cuts sheet ${setup}; bind setup to a control to flip through them`);
      }
      const current = placed.filter(pc => pc.bin === setup - 1);

      // ---- the cut ----
      const ops = [];
      // labels first, all of this sheet's in ONE op: the face is scored
      // while the sheet is whole (a freed, tabbed piece is no place to
      // engrave), and a V-bit is mounted once
      const strokes = current.flatMap(pc => pc.label ?? []);
      if (strokes.length) {
        const moves = [];
        for (const pl of strokes) {
          moves.push({ type: 'rapid', x: pl[0].x, y: pl[0].y });
          moves.push({ type: 'linear', z: -LABEL_DEPTH });
          for (let i = 1; i < pl.length; i++) moves.push({ type: 'linear', x: pl[i].x, y: pl[i].y });
          moves.push({ type: 'rapid', z: ctx.safeZ });
        }
        const vee = !(labelTool > 0);
        ops.push({
          subName: 'angle labels',
          tool: vee ? { name: '60° V-bit', diameter: 0.002 } : { name: `${formatDiameter(labelTool)} endmill`, diameter: labelTool },
          cutter: vee ? { type: 'vee', includedAngle: 60 } : { type: 'flat', diameter: labelTool },
          feedRate: 60, plungeRate: 30,
          moves,
          // 'on' profile: the tip rides the stroke itself — depth is the check (open pen paths, as line_text)
          target: { type: 'profile', side: 'on', rings: strokes, depth: LABEL_DEPTH },
          warnings: [],
        });
      }
      // then one outside profile per piece on THIS sheet
      let all = null;
      for (const pc of current) {
        const prof = generateProfile({ outer: pc.ring }, { diameter: tool }, {
          side: 'outside', totalDepth: t, depthPerPass: Math.min(0.25, tool), safeZ: ctx.safeZ, entry: 'ramp',
          tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
        });
        const name = pc.plank ? `plank ${pc.id}` : `connector ${pc.id}`;
        ops.push({
          subName: name,
          tool: { name: `${formatDiameter(tool)} endmill`, diameter: tool },
          cutter: { type: 'flat', diameter: tool },
          feedRate: feed, plungeRate: Math.min(30, feed / 2),
          moves: prof.moves,
          target: { type: 'profile', side: 'outside', rings: [pc.ring], depth: t },
          previewRing: pc.ring,
          previewTabs: prof.tabs,
          rib: true,   // a kit part, not a cutout outline for a stack assembly
          warnings: prof.warnings.filter(w => !/ramp entry ignored/.test(w)).map(w => `${name}: ${w}`),
        });
        const bb = bboxOf(pc.ring);
        all = all ? { minX: Math.min(all.minX, bb.minX), minY: Math.min(all.minY, bb.minY), maxX: Math.max(all.maxX, bb.maxX), maxY: Math.max(all.maxY, bb.maxY) } : bb;
      }
      // the runtime surfaces per-op warnings only: the verb's own ride on the first op
      if (ops.length && warnings.length) ops[0].warnings = [...warnings, ...ops[0].warnings];
      const r2 = tool / 2;
      const area = pieces.reduce((a, pc) => a + pc.area, 0);
      const labelled = placed.some(pc => pc.label);
      // every plank cut, by length (the structure's and the loose ones together)
      const byNotches = new Map();
      for (const pc of pieces) if (pc.plank && !pc.top) byNotches.set(pc.notches, (byNotches.get(pc.notches) ?? 0) + 1);
      // the decorative tops, by tier
      const topsByTier = new Map();
      for (const pc of pieces) if (pc.top) {
        const cur = topsByTier.get(pc.tier) ?? { tier: pc.tier, shape: pc.shape, height: +pc.peak.toFixed(4), count: pc.count, planks: 0, length: +pc.w.toFixed(4), notches: pc.notches };
        cur.planks++;
        topsByTier.set(pc.tier, cur);
      }
      const tops = [...topsByTier.values()].sort((a, b) => a.tier - b.tier);

      // ---- the assembled view: every structural plank standing in its course ----
      // world (Y-up): X across, Z deep, the base tier's wall lines at
      // endMargin … endMargin + cells × pitch (so the plank ends, which
      // overhang by endMargin, start at 0). A plank's local (a, b) = (along,
      // up); an X plank is a slab on z = its wall line, a Y plank on x. The
      // pose handed over maps the SHEET ring back: unturned the ring is
      // (a + x, b + y); on an upright sheet (span − y − b, a + x).
      const rise = W - 2 * depth;
      let assembly = null;
      if (plan) {
        const sub = (A, B, k) => A.map((v, i) => v - k * B[i]);
        const panels = placed.filter(pc => pc.pose).map(pc => {
          const { dir, line, from, course } = pc.pose;
          const U = dir === 'x' ? [1, 0, 0] : [0, 0, 1], V = [0, 1, 0];
          const O = dir === 'x'
            ? [from * pitch, course * rise, line * pitch + endMargin - t / 2]    // U × V = +Z: the slab spans z ∈ [line − t/2, line + t/2]
            : [line * pitch + endMargin + t / 2, course * rise, from * pitch];   // U × V = −X: the slab spans x ∈ [line − t/2, line + t/2]
          const world = upright
            ? { origin: sub(sub(O, U, pc.at.x), V, -(pc.at.span - pc.at.y)), u: V.map(v => -v), v: U }
            : { origin: sub(sub(O, U, pc.at.x), V, pc.at.y), u: U, v: V };
          return { id: pc.id, thickness: t, rings: [pc.ring], sheet: { x: 0, y: 0, rot: 0 }, setup: pc.bin + 1, active: pc.bin === setup - 1, world };
        });
        // as tall as its highest plank — a top's ornament counts
        const base = tiers[0], height = Math.max(...placed.filter(pc => pc.pose).map(pc => pc.pose.course * rise + pc.h));
        const footprint = [base.w * pitch + 2 * endMargin, base.d * pitch + 2 * endMargin];
        assembly = { kind: 'linker_tower', tiers: tiers.map((T, i) => ({ w: T.w, d: T.d, courses: T.courses, x: T.x, y: T.y, on: T.on, from: plan.starts[i], ...(T.top ? { top: T.top } : {}) })), courses: plan.courses, planks: plan.planks.length, tops,
          height: +height.toFixed(4), footprint: footprint.map(v => +v.toFixed(4)), box: [footprint[0], height, footprint[1]], panels };
      }
      return {
        ops,
        bbox: { minX: all.minX - r2, minY: all.minY - r2, maxX: all.maxX + r2, maxY: all.maxY + r2 },
        pieces: placed.length,
        kit: {
          planks: [...byNotches].sort((a, b) => b[0] - a[0]).map(([notches, count]) => ({ notches, count, length: +((notches - 1) * pitch + 2 * endMargin).toFixed(4) })),
          structure: assembly ? { tiers: assembly.tiers, courses: assembly.courses, planks: assembly.planks, tops, height: assembly.height, footprint: assembly.footprint } : null,
          tops,
          connectors: [...angles].sort((a, b) => a[0] - b[0]).map(([angle, count]) => ({ angle, count })),
          labels: labelled ? (labelTool > 0 ? `${formatDiameter(labelTool)} endmill` : '60° V-bit') : null,
          plankWidth: W, pitch, endMargin, slotWidth: +slotW.toFixed(4), notchDepth: +depth.toFixed(4), reliefDiameter: +reliefD.toFixed(4),
          toolDiameter: tool, toolSized: !named, grip: +grip.toFixed(4),
          courseRise: +(W - 2 * depth).toFixed(4), sheets: nBins, sheet: [sheetW, sheetH],
        },
        ingredients: [{ kind: 'sheet', thickness: t, w: sheetW, h: sheetH, count: nBins, note: 'Linker Logs kit', utilization: Math.min(1, area / (nBins * sheetW * sheetH)) }],
        ...(assembly ? { assembly } : {}),
        ...(nBins > 1 ? { setups: { count: nBins, current: setup, groups } } : {}),
        warnings,
      };
    },
  },
};
