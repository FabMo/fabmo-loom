// rib_lattice — a 3D form built from flat ribs slotted together in two
// directions (waffle / egg-crate construction): the sliced-sculpture look
// of a stacked-slice piece, but hollow, with every rib a vertical SECTION
// of the form instead of a horizontal slice. One op, many pieces: every
// rib is cut free as its own outline, with half-lap slots at every
// crossing (X ribs slotted from the top, Y ribs from the bottom), laid out
// on the sheet, and handed to the assembled view standing in place.
//
// The form is a profile: STATIONS of width × depth against height
// (fraction 0..1 of the overall height), joined by a smooth monotone
// curve. Its horizontal section at any height is an ellipse (or a
// rectangle) w(y) × d(y). A rib in the plane x = x0 therefore spans, at
// height y, z = ±(d/2)·sqrt(1 − (x0/(w/2))²) — closed form, no mesh. The
// crossing of rib X_i and rib Y_j shares ONE vertical interval (the form's
// extent at that point), so both half-laps meet at its middle.
//
// v1 builds ribs that are ONE piece. A waist deep enough that a rib past
// the waist's half-width splits into a top and a bottom blob is refused by
// name (fewer ribs, or a softer waist) rather than built wrong.

import { generateProfile } from '../strategies/profile.js';
import { booleanRegions, offsetRegions } from './shape.mjs';
import { formatDiameter } from '../strategies/tool-select.js';

const SAMPLES = 200;          // y samples per rib outline (each side), before simplification
const SIMPLIFY_TOL = 0.002;   // inches: Douglas–Peucker on the finished outline
const GAP = 0.5;              // between ribs on the sheet
const MARGIN = 0.375;         // sheet edge allowance when wrapping rows

// ---- the profile: monotone cubic (Fritsch–Carlson) through the stations ----
function pchip(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = [], m = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); m.push((ys[i + 1] - ys[i]) / h[i]); }
  const d = new Array(n).fill(0);
  if (n === 2) { d[0] = d[1] = m[0]; }
  else {
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) d[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        d[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
      }
    }
    const end = (hk, hk1, mk, mk1) => {
      let dd = ((2 * hk + hk1) * mk - hk * mk1) / (hk + hk1);
      if (Math.sign(dd) !== Math.sign(mk)) dd = 0;
      else if (Math.sign(mk) !== Math.sign(mk1) && Math.abs(dd) > Math.abs(3 * mk)) dd = 3 * mk;
      return dd;
    };
    d[0] = end(h[0], h[1], m[0], m[1]);
    d[n - 1] = end(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    return h00 * ys[i] + h10 * h[i] * d[i] + h01 * ys[i + 1] + h11 * h[i] * d[i + 1];
  };
}

// y-intervals over [0, H] where f(y) is true — sampled, merged
function intervals(H, f, n = SAMPLES * 2) {
  const out = [];
  let open = null;
  for (let k = 0; k <= n; k++) {
    const y = (H * k) / n;
    if (f(y)) { if (!open) open = { a: y, b: y }; else open.b = y; }
    else if (open) { out.push(open); open = null; }
  }
  if (open) out.push(open);
  return out;
}

export const bboxOf = (ring) => ring.reduce((a, q) => ({
  minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y), maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
}), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

// Douglas–Peucker on a closed ring (duplicates dropped first)
export function simplifyRing(ring, tol) {
  const pts = [];
  for (const q of ring) { const l = pts[pts.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-7) pts.push(q); }
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-7) pts.pop();
  if (pts.length < 4) return pts;
  // split at the two farthest-apart points so each half is an open polyline
  let i0 = 0, i1 = 0, best = -1;
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 64))) for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 64))) {
    const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
    if (d > best) { best = d; i0 = i; i1 = j; }
  }
  const rdp = (seg) => {
    if (seg.length < 3) return seg;
    const a = seg[0], b = seg[seg.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    let k = -1, far = 0;
    for (let i = 1; i < seg.length - 1; i++) {
      const d = Math.abs(dy * (seg[i].x - a.x) - dx * (seg[i].y - a.y)) / L;
      if (d > far) { far = d; k = i; }
    }
    if (far <= tol) return [a, b];
    const left = rdp(seg.slice(0, k + 1)), right = rdp(seg.slice(k));
    return [...left.slice(0, -1), ...right];
  };
  const h1 = pts.slice(i0, i1 + 1);
  const h2 = [...pts.slice(i1), ...pts.slice(0, i0 + 1)];
  const out = [...rdp(h1).slice(0, -1), ...rdp(h2).slice(0, -1)];
  return out.length >= 3 ? out : pts;
}

const rect = (a0, a1, b0, b1) => ({ outer: [{ x: a0, y: b0 }, { x: a1, y: b0 }, { x: a1, y: b1 }, { x: a0, y: b1 }], holes: [] });

export const LATTICE_ENTRIES = {
  rib_lattice: {
    doc: 'Build a 3D FORM FROM INTERLOCKING RIBS — waffle / egg-crate / sliced-sculpture construction: flat ribs standing in two directions, half-lap SLOTTED into each other at every crossing (X ribs slotted from the top, Y ribs from the bottom), each rib a vertical SECTION of the form. A stool, side table, lamp body, vase form, planter, display plinth or sculpture base with that "sliced" look — hollow, light, knocks together without glue. ONE op makes EVERY rib: each is cut free as its own outline with its slots, laid out on the sheet, counted as a piece, and shown standing in the assembled view. Describe the FORM as a profile of horizontal sections against height: profile {stations:[{h, w, d}, …]} where h is the FRACTION of the overall height (0 = floor, 1 = top; first station 0, last 1, in order), w the width (across X) and d the depth (across Y) of the section there, inches — a smooth monotone curve joins the stations, so three stations (floor, waist, top) make a waisted form, two make a taper, one straight. section "ellipse" (default: every horizontal section is an ellipse w × d — round forms) or "rect" (box-like forms). height = the overall height; ribsX = how many ribs stand across the width (planes of constant X, spanning the depth), ribsY across the depth; ribs are evenly spaced with the outer ones half a spacing in from the footprint edge. Slot width = the stock thickness + slotClearance, and each half-lap is deepened by the endmill\'s corner relief so square-edged ribs seat fully (no dog-bones needed). Where a pinched waist or a rib\'s tapering end leaves the OUTER cheek beside a slot thinner than the stock, that cheek is trimmed to the rib\'s edge (an open-sided notch: the mating rib passes, the joint is carried by the inner cheek and the closed stretch of slot), so waisted forms build. THE WAIST LIMIT: this version builds ribs that are ONE piece — a waist pinched so far that a rib past the waist\'s half-width would split into a top and a bottom blob, or so that two ribs meet at two separate heights, is REFUSED by name, as is a crossing where a rib has no stock-thick cheek at ANY height; answer with fewer ribs (so none sits past the waist) or a softer waist, and say so. Bind height/ribsX/ribsY to controls. Do NOT add cutouts for the ribs (they are freed here) and do not pair this with set_assembly — it previews its own assembly. The stock thickness is the rib thickness (set_thickness to the plywood on hand).',
    freesPieces: true,
    params: {
      profile: { type: 'object', doc: '{stations:[{h:0, w:14, d:11}, {h:0.67, w:9, d:7}, {h:1, w:13, d:10}]} — h a fraction 0..1 of height (first 0, last 1, increasing), w/d inches (numbers or arithmetic strings over control ids)' },
      section: { type: 'string', default: 'ellipse', doc: '"ellipse" (round forms) or "rect" (box forms): the shape of every horizontal section' },
      height: { type: 'number', default: 12, doc: 'overall height of the form, inches', bindable: true },
      ribsX: { type: 'number', default: 5, min: 1, max: 40, doc: 'ribs standing across the WIDTH (planes of constant X), whole number', bindable: true },
      ribsY: { type: 'number', default: 5, min: 1, max: 40, doc: 'ribs standing across the DEPTH (planes of constant Y), whole number', bindable: true },
      slotClearance: { type: 'number', default: 0.01, min: 0, max: 0.1, doc: 'extra slot width beyond the stock thickness, inches (plywood runs thin; 0.01 is a snug push fit)' },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches — must not exceed the slot width (the stock thickness)' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      tabs: { type: 'boolean', default: true, doc: 'holding tabs on every rib (ribs are large — tabs keep them from shifting when freed)' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches' },
      tabSpacing: { type: 'number', default: 6, doc: 'target spacing between tabs, inches' },
    },
    run(p, ctx) {
      const t = ctx.stock.thickness;
      const H = +p.height;
      if (!(H > 0)) return { error: 'rib_lattice: height must be positive' };
      const nX = Math.round(+p.ribsX), nY = Math.round(+p.ribsY);
      if (!(nX >= 1 && nY >= 1)) return { error: 'rib_lattice: ribsX and ribsY must be at least 1' };
      const section = p.section === 'rect' ? 'rect' : 'ellipse';
      const slotW = t + Math.max(0, +p.slotClearance || 0);
      if (p.toolDiameter > slotW + 1e-9) return { error: `rib_lattice: the ${formatDiameter(p.toolDiameter)} endmill is wider than the ${slotW.toFixed(3)}" slot (stock thickness ${t}" + clearance) — use a bit no wider than the stock thickness` };
      // corner relief: a round bit leaves fillets at a slot's floor corners
      // that a square rib edge would ride up on — deepen each half-lap so
      // the rib still seats to the mating rib's mid-line
      const relief = (p.toolDiameter / 2) * (1 - Math.SQRT1_2);

      // ---- stations → w(y), d(y) ----
      const st = p.profile?.stations;
      if (!Array.isArray(st) || st.length < 1) return { error: 'rib_lattice: profile needs stations [{h, w, d}, …] — the form\'s width × depth against height' };
      const stations = [];
      for (let i = 0; i < st.length; i++) {
        const s = st[i] ?? {};
        const num = (v, what) => {
          const r = ctx.evalNumber(v);
          if (r.error || !Number.isFinite(r.value)) return { error: `rib_lattice: station ${i + 1} ${what} "${v}": ${r.error ?? 'not a number'}` };
          return r;
        };
        const h = num(s.h ?? (st.length === 1 ? 0 : i / (st.length - 1)), 'h'), w = num(s.w, 'w'), d = num(s.d ?? s.w, 'd');
        if (h.error) return h; if (w.error) return w; if (d.error) return d;
        if (!(w.value > 0 && d.value > 0)) return { error: `rib_lattice: station ${i + 1} needs positive w and d (got ${w.value} × ${d.value})` };
        stations.push({ h: h.value, w: w.value, d: d.value });
      }
      if (stations.length === 1) stations.push({ ...stations[0], h: 1 }), (stations[0].h = 0);
      for (let i = 1; i < stations.length; i++) if (!(stations[i].h > stations[i - 1].h)) return { error: 'rib_lattice: station h values must increase (0 at the floor to 1 at the top)' };
      if (Math.abs(stations[0].h) > 1e-9 || Math.abs(stations[stations.length - 1].h - 1) > 1e-9) return { error: 'rib_lattice: the first station is the floor (h 0) and the last the top (h 1)' };
      const hs = stations.map(s => s.h * H);
      const wOf = pchip(hs, stations.map(s => s.w)), dOf = pchip(hs, stations.map(s => s.d));
      let W = 0, D = 0;
      for (let k = 0; k <= SAMPLES; k++) { const y = (H * k) / SAMPLES; W = Math.max(W, wOf(y)); D = Math.max(D, dOf(y)); }

      // inside test at height y for a point (x, z) of the footprint
      const inside = (x, z, y) => {
        const hw = wOf(y) / 2, hd = dOf(y) / 2;
        return section === 'rect' ? Math.abs(x) <= hw && Math.abs(z) <= hd : (x / hw) ** 2 + (z / hd) ** 2 <= 1;
      };
      // a rib's half-extent at height y: X rib (plane x = x0) spans z; Y rib (plane z = z0) spans x
      const halfZ = (x0, y) => { const hw = wOf(y) / 2, hd = dOf(y) / 2; if (Math.abs(x0) >= hw) return 0; return section === 'rect' ? hd : hd * Math.sqrt(1 - (x0 / hw) ** 2); };
      const halfX = (z0, y) => { const hw = wOf(y) / 2, hd = dOf(y) / 2; if (Math.abs(z0) >= hd) return 0; return section === 'rect' ? hw : hw * Math.sqrt(1 - (z0 / hd) ** 2); };
      // WALLS: a slot wants material on both sides thick enough to cut and
      // to hold — at least the stock thickness (and never thinner than the
      // bit). A rib ends where it is no longer wide enough to carry a slot;
      // a thin OUTER cheek at a crossing is opened to the edge (see the
      // crossings below) rather than left as a sliver.
      const wall = Math.max(t, p.toolDiameter);
      const minHalf = slotW / 2 + wall;

      const xs = Array.from({ length: nX }, (_, i) => -W / 2 + ((i + 0.5) * W) / nX);
      const zs = Array.from({ length: nY }, (_, j) => -D / 2 + ((j + 0.5) * D) / nY);

      // ---- rib outlines (rib-local: a along the rib, b up) ----
      const ribs = [];   // { id, dir:'x'|'y', at, outline:[{x:a,y:b}], ya, yb }
      const outlineFor = (half, label) => {
        const iv = intervals(H, (y) => half(y) > minHalf);
        if (!iv.length) return { error: `rib_lattice: ${label} lies outside the form everywhere — fewer ribs, or a wider form` };
        if (iv.length > 1) return { split: iv.length };
        const { a: ya, b: yb } = iv[0];
        const right = [], left = [];
        for (let k = 0; k <= SAMPLES; k++) {
          const y = ya + ((yb - ya) * k) / SAMPLES;
          const hh = Math.max(half(y), minHalf);
          right.push({ x: hh, y }); left.push({ x: -hh, y });
        }
        return { outline: [...right, ...left.reverse()], ya, yb, half };
      };
      const splits = [];
      xs.forEach((x0, i) => {
        const o = outlineFor((y) => halfZ(x0, y), `rib X${i + 1} (x = ${x0.toFixed(2)}")`);
        if (o.error) { ribs.push(o); return; }
        if (o.split) { splits.push(`X${i + 1} at x = ${x0.toFixed(2)}"`); return; }
        ribs.push({ id: `X${i + 1}`, dir: 'x', at: x0, ...o });
      });
      zs.forEach((z0, j) => {
        const o = outlineFor((y) => halfX(z0, y), `rib Y${j + 1} (y = ${z0.toFixed(2)}")`);
        if (o.error) { ribs.push(o); return; }
        if (o.split) { splits.push(`Y${j + 1} at y = ${z0.toFixed(2)}"`); return; }
        ribs.push({ id: `Y${j + 1}`, dir: 'y', at: z0, ...o });
      });
      const bad = ribs.find(r => r.error);
      if (bad) return bad;
      if (splits.length) {
        return { error: `rib_lattice: the waist pinches the form so far that ${splits.length === 1 ? 'rib' : 'ribs'} ${splits.join(', ')} would split into a top and a bottom piece — this version builds one-piece ribs. Use fewer ribs (so none stands past the waist's half-width), or soften the waist station.` };
      }

      // ---- half-lap slots at every crossing ----
      // X rib i crosses Y rib j at (x_i, z_j). Where BOTH ribs have material
      // on that line is one vertical interval [ya, yb] (read off the ribs'
      // own clipped outlines, not the ideal form); X takes the top half, Y
      // the bottom. A slot also needs its WALLS: where a rib is too narrow
      // around the slot (near its tapering end) the thin walls are trimmed
      // away with the notch, so the mating rib passes and no sliver thinner
      // than the bit is left for the verifier to refuse.
      const extent = (rib, a, m) => intervals(H, (y) => y >= rib.ya - 1e-9 && y <= rib.yb + 1e-9 && Math.max(rib.half(y), minHalf) >= Math.abs(a) + m);
      const intersect = (A, B) => { const out = []; for (const u of A) for (const v of B) { const a = Math.max(u.a, v.a), b = Math.min(u.b, v.b); if (b > a + 1e-9) out.push({ a, b }); } return out; };
      const notches = new Map();   // rib id → [region]
      let crossings = 0;
      const xRibs = ribs.filter(r => r.dir === 'x'), yRibs = ribs.filter(r => r.dir === 'y');
      const add = (id, region) => (notches.get(id) ?? notches.set(id, []).get(id)).push(region);
      for (const rx of xRibs) for (const ry of yRibs) {
        const iv = intersect(extent(rx, ry.at, 0), extent(ry, rx.at, 0));
        if (!iv.length) continue;   // the ribs never meet (corner of the footprint)
        if (iv.length > 1) return { error: `rib_lattice: where rib ${rx.id} crosses rib ${ry.id} the form is pinched into ${iv.length} separate heights (the waist) — this version slots ribs that meet once. Use fewer ribs or a softer waist.` };
        const { a: ya, b: yb } = iv[0];
        const mid = (ya + yb) / 2;
        // each rib needs walls along ITS OWN notch: X from the split up to
        // the top of the shared extent, Y from the bottom up to the split.
        // Where a rib is too narrow around its notch — its tapering end, or
        // a pinched waist that runs across the crossing — the OUTER cheek
        // (the side away from the rib's own centre) is trimmed off out to
        // the rib's edge: the notch is open-sided there, the mating rib
        // passes, and the joint is carried by the inner cheek (always at
        // least a wall thick, the rib widens toward its centre) and by the
        // closed stretch of slot. The split is placed inside the longest
        // stretch where BOTH ribs keep full cheeks, nearest mid-height, so
        // the closed slot is as long as the form allows. A notch is open at
        // one end, so a trim always runs from the thin band to that end.
        const m = slotW / 2 + wall;
        const WX = extent(rx, ry.at, m).filter(w => w.b > ya && w.a < yb);
        const WY = extent(ry, rx.at, m).filter(w => w.b > ya && w.a < yb);
        if (!WX.length || !WY.length) return { error: `rib_lattice: where rib ${rx.id} crosses rib ${ry.id} the ribs are too narrow to carry a ${slotW.toFixed(2)}" slot with ${wall}" walls — fewer ribs, a fuller form, or thinner stock` };
        let best = null;
        for (const wx of WX) for (const wy of WY) {
          const lo = Math.max(ya, wx.a, wy.a) + relief, hi = Math.min(yb, wx.b, wy.b) - relief;
          if (hi < lo) continue;   // these two stretches never share a height
          const span = Math.min(yb, wx.b) - Math.max(ya, wy.a);   // closed slot: Y's cheeks from wy.a up to the split, X's from the split up to wx.b
          const ym = Math.min(Math.max(mid, lo), hi);
          const cand = { wx, wy, ym, span, off: Math.abs(ym - mid) };
          if (!best || cand.span > best.span + 1e-9 || (Math.abs(cand.span - best.span) <= 1e-9 && cand.off < best.off)) best = cand;
        }
        if (!best) return { error: `rib_lattice: where rib ${rx.id} crosses rib ${ry.id} there is no height at which both ribs are wide enough for their half-laps — fewer ribs, a fuller form, or thinner stock` };
        const { wx, wy, ym } = best;
        crossings++;
        const BIG = W + D + H;
        const outer = (at) => (at < 0 ? [-BIG, at + slotW / 2] : [at - slotW / 2, BIG]);   // from the slot's outer wall out past the rib's edge
        add(rx.id, rect(ry.at - slotW / 2, ry.at + slotW / 2, ym - relief, yb + 1));
        if (wx.b < yb - 1e-6) add(rx.id, rect(...outer(ry.at), wx.b, yb + 1));            // X too narrow above wx.b: open the notch to the edge up to the top
        add(ry.id, rect(rx.at - slotW / 2, rx.at + slotW / 2, ya - 1, ym + relief));
        if (wy.a > ya + 1e-6) add(ry.id, rect(...outer(rx.at), ya - 1, wy.a));            // Y too narrow below wy.a: open it to the edge down to the bottom
      }
      for (const r of ribs) {
        const cut = notches.get(r.id);
        if (!cut?.length) continue;
        const res = booleanRegions('difference', [[{ outer: r.outline, holes: [] }], cut]);
        if (res.error) return { error: `rib_lattice: ${res.error}` };
        if (res.regions.length !== 1) return { error: `rib_lattice: the slots cut rib ${r.id} into ${res.regions.length} pieces — the form is too thin there for ${t}" stock; thinner stock, fewer ribs, or a fuller form` };
        r.outline = res.regions[0].outer;
      }
      // MIN FEATURE: an opening (erode, then dilate) by the bit's radius
      // drops any sliver thinner than the bit — the wedge where a trimmed
      // slot wall meets a sloping edge, a clamped tip — that the verifier
      // would otherwise refuse as a cut intruding the part. Convex corners
      // round by that radius (a slot mouth gains a lead-in); concave slot
      // corners stay sharp.
      const rO = p.toolDiameter / 2 + 0.01;
      for (const r of ribs) {
        const opened = offsetRegions(offsetRegions([{ outer: r.outline, holes: [] }], -rO), rO);
        if (opened.length !== 1) return { error: `rib_lattice: rib ${r.id} has a neck thinner than the ${formatDiameter(p.toolDiameter)} bit — fewer ribs, a fuller form, or a smaller bit` };
        // a sampled curve carries hundreds of nearly collinear vertices; the
        // profile offset's vertex cleaning nudges such a path inward by
        // about the verifier's tolerance and the cut reads as an intrusion
        // (taper form, 2026-10-19). Keep only the vertices that matter.
        r.outline = simplifyRing(opened[0].outer, SIMPLIFY_TOL);
      }

      // ---- sheet layout: rows, wrapping under the shop's width ----
      const limits = [ctx.shop?.machineW, ctx.shop?.materialW].filter(v => v > 0);
      const limitW = limits.length ? Math.min(...limits) - 2 * MARGIN - p.toolDiameter : Infinity;   // the board adds its margin and the kerf
      let cx = 0, floorY = 0, rowTop = 0, rowStart = true;
      const placed = [];
      for (const r of ribs) {
        const bb = bboxOf(r.outline);
        const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
        if (!rowStart && cx + GAP + w > limitW) { cx = 0; floorY = rowTop + GAP; rowStart = true; }
        const sx = (rowStart ? 0 : cx + GAP) - bb.minX, sy = floorY - bb.minY;
        const ring = r.outline.map(q => ({ x: q.x + sx, y: q.y + sy }));
        cx = (rowStart ? 0 : cx + GAP) + w;
        rowTop = Math.max(rowStart ? 0 : rowTop, floorY + h);
        rowStart = false;
        placed.push({ ...r, ring, sx, sy });
      }

      // ---- the cut: one outside profile per rib ----
      const ops = [];
      let all = null;
      for (const r of placed) {
        const prof = generateProfile({ outer: r.ring }, { diameter: p.toolDiameter }, {
          side: 'outside', totalDepth: t, depthPerPass: 0.25, safeZ: ctx.safeZ, entry: 'ramp',
          tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
        });
        ops.push({
          subName: `rib ${r.id}`,
          tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
          cutter: { type: 'flat', diameter: p.toolDiameter },
          feedRate: p.feedRate, plungeRate: 30,
          moves: prof.moves,
          target: { type: 'profile', side: 'outside', rings: [r.ring], depth: t },
          previewRing: r.ring,
          previewTabs: prof.tabs,
          rib: true,
          warnings: prof.warnings.map(w => `rib ${r.id}: ${w}`),
        });
        const bb = bboxOf(r.ring);
        all = all ? { minX: Math.min(all.minX, bb.minX), minY: Math.min(all.minY, bb.minY), maxX: Math.max(all.maxX, bb.maxX), maxY: Math.max(all.maxY, bb.maxY) } : bb;
      }

      // ---- the assembled view: every rib standing in its plane ----
      // world (Y-up): footprint X ∈ [0, W], Z ∈ [0, D], height Y ∈ [0, H].
      // Rib-local (a, b) = (along, up); a ring point is (a + sx, b + sy).
      const panels = placed.map(r => r.dir === 'x'
        ? { id: r.id, thickness: t, rings: [r.ring], sheet: { x: 0, y: 0, rot: 0 }, setup: 1, active: true,
            world: { origin: [r.at + W / 2 + t / 2, -r.sy, D / 2 - r.sx], u: [0, 0, 1], v: [0, 1, 0] } }   // u×v = −X: slab spans x ∈ [at − t/2, at + t/2]
        : { id: r.id, thickness: t, rings: [r.ring], sheet: { x: 0, y: 0, rot: 0 }, setup: 1, active: true,
            world: { origin: [W / 2 - r.sx, -r.sy, r.at + D / 2 - t / 2], u: [1, 0, 0], v: [0, 1, 0] } }); // u×v = +Z: slab spans z ∈ [at − t/2, at + t/2]
      const r2 = p.toolDiameter / 2;
      return {
        ops,
        bbox: { minX: all.minX - r2, minY: all.minY - r2, maxX: all.maxX + r2, maxY: all.maxY + r2 },
        pieces: placed.length,
        assembly: { kind: 'lattice', ribsX: nX, ribsY: nY, crossings, height: H, footprint: [W, D], box: [W, H, D], panels },
        warnings: [],
      };
    },
  },
};
