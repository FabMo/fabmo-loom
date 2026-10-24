// rib_chair — a chair (or bench, lounger, rocker-less seat) built as SLICED
// SIDE RIBS joined by SLATS: the sliced-plywood answer to an upholstered
// chair. Every side rib is the chair's SIDE SILHOUETTE (the same outline
// profile_chair takes: y up from the floor, z from the back); the ribs
// stand across the width at even spacing with the outer two flush with
// the ends; SLATS are flat strips laid along the silhouette's covered runs
// (seat, back, arm tops — whichever runs the author flags), each standing
// perpendicular to the surface, notched half-lap into every rib: the rib
// takes a notch from its edge inward, the slat a notch from its inner edge
// outward, so the slat's outer edge lands flush with the silhouette and
// the two lock like a cross-lap. One op, many pieces: n ribs + m slats,
// each cut free as its own outline, laid out on the sheet, and handed to
// the assembled view standing in place.
//
// Pieces are one-piece by construction (a rib notch never crosses the rib)
// — a notch that would cut a rib in two, or land where the rib is thinner
// than half a slat plus a wall, is dropped or refused BY NAME.

import { generateProfile } from '../strategies/profile.js';
import { booleanRegions, offsetRegions } from './shape.mjs';
import { formatDiameter } from '../strategies/tool-select.js';
import { simplifyRing, bboxOf } from './lattice.mjs';

const EPS = 1e-6;
const CHORD_TOL = 0.004;      // arc sampling: max chord sag, inches
const SIMPLIFY_TOL = 0.002;
const GAP = 0.5;              // between pieces on the sheet
const MARGIN = 0.375;

// ---- the silhouette: points {a, b, arc?, r?} → sampled polygon, per run ----
// Same semantics as the furniture compiler's samplePolygon (profile_chair):
// an arc runs FROM its point TO the next; "convex" bulges outward from the
// panel, "concave" scoops in; r defaults to a quarter circle on the chord.
function polyArea(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.a * q.b - q.a * p.b; } return s / 2; }
function sampleRuns(pts) {
  const ccw = polyArea(pts) >= 0;
  const runs = [];
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i], Q = pts[(i + 1) % pts.length];
    const seg = [{ a: P.a, b: P.b }];
    if (P.arc) {
      const dx = Q.a - P.a, dy = Q.b - P.b, chord = Math.hypot(dx, dy);
      if (chord > EPS) {
        const r = Math.max(P.r > 0 ? P.r : chord / Math.SQRT2, chord / 2);
        const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
        const nx = (ccw ? -dy : dy) / chord, ny = (ccw ? dx : -dx) / chord;   // unit normal into the panel
        const side = P.arc === 'convex' ? 1 : -1;
        const cx = (P.a + Q.a) / 2 + side * nx * h, cy = (P.b + Q.b) / 2 + side * ny * h;
        const a0 = Math.atan2(P.b - cy, P.a - cx), a1 = Math.atan2(Q.b - cy, Q.a - cx);
        let sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - CHORD_TOL / r)));
        const n = Math.max(4, Math.min(96, Math.ceil(Math.abs(sweep) / step)));
        for (let j = 1; j < n; j++) { const th = a0 + (sweep * j) / n; seg.push({ a: cx + r * Math.cos(th), b: cy + r * Math.sin(th) }); }
      }
    }
    seg.push({ a: Q.a, b: Q.b });
    runs.push({ idx: i, pts: seg, slats: !!P.slats, floor: Math.abs(P.b) < EPS && Math.abs(Q.b) < EPS });
  }
  return { runs, ccw };
}
function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// material depth from a boundary point P inward along −n̂: the first crossing of the ring
function depthInward(ring, P, n, limit) {
  let best = limit;
  const x0 = P.x - 1e-4 * n.x, y0 = P.y - 1e-4 * n.y;   // start just inside
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = (-n.x) * ey - (-n.y) * ex;
    if (Math.abs(den) < 1e-12) continue;
    const s = ((a.x - x0) * ey - (a.y - y0) * ex) / den;      // along −n̂
    const u = ((a.x - x0) * (-n.y) - (a.y - y0) * (-n.x)) / den;
    if (s > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9 && s < best) best = s;
  }
  return best;
}

export const RIB_CHAIR_ENTRIES = {
  rib_chair: {
    doc: 'Build a CHAIR, ARMCHAIR, LOUNGE CHAIR, BENCH or SEAT AS SLICED RIBS — the flat-stock answer to an upholstered / cushioned chair (a wingback, a club chair, a sofa section): identical SIDE RIBS carrying the chair\'s side silhouette stand across the width, and SLATS lie along the seat, back and arms, each notched half-lap into every rib, so the surface you sit on is a lattice of slat edges that follows the silhouette exactly. ONE op makes EVERY piece (ribs + slats), each cut free as its own outline with its notches, laid out on the sheet, counted as a piece, shown standing in the assembled view; knocks together without glue, or glue the notches. "outline" is the SIDE SILHOUETTE as the furniture compiler\'s profile_chair takes it: 8–16 {"y","z"} points (y UP from the floor, z from the BACK, inches; numbers or {arithmetic} over controls), traced from the floor under the back leg {"y":0,"z":0} up the back, over the top, down the back\'s front / the wing, along the arm, down the front leg to {"y":0,"z":<depth>}, then back along the floor; a point\'s "arc":"convex"|"concave" makes the run FROM it TO the next point an arc ("r" its radius, default a quarter circle on the chord); a point\'s "slats":true lays slats along the run FROM it TO the next (flag the SEAT, the BACK\'s front face, ARM tops, a WING\'s inside — the surfaces a cushion would cover; with no flags every run off the floor gets slats). "width" = the chair\'s overall width (across X, bind it to a control); "ribs" = how many side ribs stand across it (outer two flush with the ends; 4–7 for a chair, more for a sofa); "slatSpacing" = centre-to-centre along the surface (2–3"), "slatDepth" = how deep each slat stands (2–3"). Slots are the stock thickness + slotClearance, deepened by the endmill\'s corner relief. Keep legs ≥ 4" wide at the floor and the material behind every slatted surface ≥ slatDepth/2 + the stock thick — a notch that would land in thinner material is DROPPED with a warning naming it, and a notch that would cut a rib in two is REFUSED by name. Do NOT add cutouts for the pieces (they are freed here) and do not pair this with set_assembly (it previews its own assembly). The stock thickness is the rib and slat thickness.',
    freesPieces: true,
    params: {
      outline: { type: 'object', doc: 'the side silhouette: [{"y":0,"z":0},{"y":"h - 4","z":0,"arc":"convex"},{"y":"h","z":4},…] — y up from the floor, z from the back, inches or {arithmetic}; "arc" on a point curves the run to the next point; "slats":true on a point lays slats along that run' },
      width: { type: 'number', default: 24, doc: 'overall width across the chair, inches', bindable: true },
      ribs: { type: 'number', default: 5, min: 2, max: 40, doc: 'side ribs standing across the width (outer two flush with the ends), whole number', bindable: true },
      slatSpacing: { type: 'number', default: 2.5, min: 1, max: 12, doc: 'slat centre-to-centre spacing along the surface, inches', bindable: true },
      slatDepth: { type: 'number', default: 2.5, min: 1, max: 6, doc: 'how deep each slat stands into the chair, inches (its outer edge is flush with the silhouette)' },
      slotClearance: { type: 'number', default: 0.01, min: 0, max: 0.1, doc: 'extra slot width beyond the stock thickness, inches (0.01 is a snug push fit)' },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches — must not exceed the slot width (the stock thickness)' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      setup: { type: 'number', default: 1, min: 1, bindable: true, doc: 'which SHEET to cut when the pieces need several (a chair always does): the weave lays every rib and slat into 4×8 sheets (or the shop\'s declared material / machine area), warns how many, and this picks the one this file cuts — bind it to a number control; the assembled view shows the whole chair with the other sheets\' pieces ghosted' },
      tabs: { type: 'boolean', default: true, doc: 'holding tabs on every piece' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches' },
      tabSpacing: { type: 'number', default: 6, doc: 'target spacing between tabs, inches' },
    },
    run(p, ctx) {
      const t = ctx.stock.thickness;
      const W = +p.width;
      if (!(W > 0)) return { error: 'rib_chair: width must be positive' };
      const n = Math.round(+p.ribs);
      if (!(n >= 2)) return { error: 'rib_chair: ribs must be at least 2 (the two end ribs)' };
      if (W < 3 * t) return { error: `rib_chair: a ${W}" wide chair cannot hold two ${t}" ribs` };
      const slotW = t + Math.max(0, +p.slotClearance || 0);
      if (p.toolDiameter > slotW + 1e-9) return { error: `rib_chair: the ${formatDiameter(p.toolDiameter)} endmill is wider than the ${slotW.toFixed(3)}" slot (stock thickness ${t}" + clearance) — use a bit no wider than the stock thickness` };
      const relief = (p.toolDiameter / 2) * (1 - Math.SQRT1_2);
      const sd = +p.slatDepth, spacing = +p.slatSpacing;
      if (!(sd > 0) || !(spacing > 0)) return { error: 'rib_chair: slatDepth and slatSpacing must be positive' };
      const wall = Math.max(t, p.toolDiameter);

      // ---- the silhouette ----
      const src = p.outline;
      if (!Array.isArray(src) || src.length < 3) return { error: 'rib_chair: outline needs at least 3 {y, z} points — the chair\'s side silhouette' };
      const pts = [];
      for (let i = 0; i < src.length; i++) {
        const q = src[i] ?? {};
        const num = (v, what) => { const r = ctx.evalNumber(v); if (r.error || !Number.isFinite(r.value)) return { error: `rib_chair: outline[${i}].${what} "${v}": ${r.error ?? 'not a number'}` }; return r; };
        const y = num(q.y, 'y'), z = num(q.z, 'z');
        if (y.error) return y; if (z.error) return z;
        if (y.value < -EPS || z.value < -EPS) return { error: `rib_chair: outline[${i}] is below the floor or behind the back (y ${y.value}, z ${z.value}) — y and z start at 0` };
        const pt = { a: z.value, b: y.value, slats: q.slats === true || q.slats === 'true' };
        if (q.arc) {
          if (!['convex', 'round', 'rounded', 'concave', 'cove'].includes(String(q.arc))) return { error: `rib_chair: outline[${i}].arc must be "convex" (bulges out) or "concave" (scoops in)` };
          pt.arc = /^conc|^cove/.test(String(q.arc)) ? 'concave' : 'convex';
          if (q.r !== undefined) { const r = num(q.r, 'r'); if (r.error) return r; if (r.value > 0) pt.r = r.value; }
        }
        pts.push(pt);
      }
      if (!pts.some(q => Math.abs(q.b) < EPS)) return { error: 'rib_chair: the outline never touches the floor (no point with y 0)' };
      if (Math.abs(polyArea(pts)) < 1) return { error: 'rib_chair: the outline encloses no area' };
      const { runs, ccw } = sampleRuns(pts);
      if (!runs.some(r => r.slats)) for (const r of runs) r.slats = !r.floor;   // default: every run off the floor
      // the rib ring in sheet coordinates: x = z (depth, from the back), y = height
      let ring = [];
      for (const r of runs) ring.push(...r.pts.slice(0, -1).map(q => ({ x: q.a, y: q.b })));
      const D = Math.max(...ring.map(q => q.x)), H = Math.max(...ring.map(q => q.y));
      if (!(D > 0) || !(H > 0)) return { error: 'rib_chair: the outline has no depth or no height' };
      // outward normal of a directed edge: (dy, −dx) for a CCW ring, (−dy, dx) for CW — checked once
      const outward = (dx, dy) => { const L = Math.hypot(dx, dy) || 1; return ccw ? { x: dy / L, y: -dx / L } : { x: -dy / L, y: dx / L }; };
      { const a = ring[0], b = ring[1 % ring.length]; const nrm = outward(b.x - a.x, b.y - a.y); const mx = (a.x + b.x) / 2 + 0.01 * nrm.x, my = (a.y + b.y) / 2 + 0.01 * nrm.y;
        if (pointInRing(ring, mx, my)) return { error: 'rib_chair: the outline crosses itself — trace it as one loop' }; }

      // ---- slat stations along the flagged runs ----
      const stations = [];   // { P:{x,y}, T:{x,y} (travel), N:{x,y} (outward), run }
      const warnings = [];
      const dn = sd / 2 + relief;                 // notch depth into the rib: half a slat plus the corner relief
      const m0 = Math.max(slotW, 0.75, dn + wall);  // end margin: a notch at a run's end must not reach a notch on the next run (it would sever the corner)
      for (const r of runs) {
        if (!r.slats) continue;
        const seg = r.pts;
        const cum = [0];
        for (let i = 1; i < seg.length; i++) cum.push(cum[i - 1] + Math.hypot(seg[i].a - seg[i - 1].a, seg[i].b - seg[i - 1].b));
        const L = cum[cum.length - 1];
        if (L < 2 * m0 + slotW) { warnings.push(`run ${r.idx + 1} is too short (${L.toFixed(2)}") for a slat`); continue; }
        const k = Math.max(1, Math.floor((L - 2 * m0) / spacing) + 1);
        for (let j = 0; j < k; j++) {
          const s = k === 1 ? L / 2 : m0 + (j * (L - 2 * m0)) / (k - 1);
          let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
          const a = seg[i - 1], b = seg[i], f = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
          const P = { x: a.a + f * (b.a - a.a), y: a.b + f * (b.b - a.b) };
          const dx = b.a - a.a, dy = b.b - a.b, Ln = Math.hypot(dx, dy) || 1;
          stations.push({ P, T: { x: dx / Ln, y: dy / Ln }, N: outward(dx, dy), run: r.idx + 1 });
        }
      }
      if (!stations.length) return { error: 'rib_chair: no run of the outline could take a slat — flag longer runs with "slats":true or lower slatSpacing' };
      // a notch needs material behind it: half a slat plus a wall; and two
      // notches closer than a slot plus a wall (around a sharp corner) collide
      const kept = [];
      for (const st of stations) {
        const deep = depthInward(ring, st.P, st.N, 1e9);
        if (deep < dn + wall) { warnings.push(`slat on run ${st.run} at (z ${st.P.x.toFixed(1)}, y ${st.P.y.toFixed(1)}) dropped — only ${deep.toFixed(2)}" of rib behind it (needs ${(dn + wall).toFixed(2)}")`); continue; }
        const near = kept.find(k => Math.hypot(k.P.x - st.P.x, k.P.y - st.P.y) < slotW + wall);
        if (near) { warnings.push(`slat on run ${st.run} at (z ${st.P.x.toFixed(1)}, y ${st.P.y.toFixed(1)}) dropped — within ${(slotW + wall).toFixed(2)}" of another`); continue; }
        kept.push(st);
      }
      if (!kept.length) return { error: `rib_chair: every slat station was dropped — ${warnings[warnings.length - 1]}` };

      // ---- rib outline with its notches ----
      // notches go in one at a time: one that would cut the rib in two (a
      // corner between two slatted runs, a thin wing) is dropped by name
      let ribRegion = { outer: ring, holes: [] };
      const final = [];
      for (const st of kept) {
        const c = (ta, na) => ({ x: st.P.x + ta * st.T.x + na * st.N.x, y: st.P.y + ta * st.T.y + na * st.N.y });
        const notch = { outer: [c(-slotW / 2, -dn), c(slotW / 2, -dn), c(slotW / 2, 1), c(-slotW / 2, 1)], holes: [] };
        const cut = booleanRegions('difference', [[ribRegion], [notch]]);
        if (cut.error) return { error: `rib_chair: ${cut.error}` };
        if (cut.regions.length !== 1) { warnings.push(`slat on run ${st.run} at (z ${st.P.x.toFixed(1)}, y ${st.P.y.toFixed(1)}) dropped — its notch would cut the side rib in two`); continue; }
        ribRegion = cut.regions[0];
        final.push(st);
      }
      if (!final.length) return { error: 'rib_chair: every slat notch would cut the side rib in two — thicken the material behind the seat and back, or lower slatDepth' };
      kept.length = 0; kept.push(...final);
      let ribRing = ribRegion.outer;
      const rO = p.toolDiameter / 2 + 0.01;
      const openR = offsetRegions(offsetRegions([{ outer: ribRing, holes: [] }], -rO), rO);
      if (openR.length !== 1) return { error: `rib_chair: the side rib has a neck thinner than the ${formatDiameter(p.toolDiameter)} bit — a fuller silhouette or a smaller bit` };
      ribRing = simplifyRing(openR[0].outer, SIMPLIFY_TOL);

      // ---- slats: a W × slatDepth strip notched from its inner edge at every rib ----
      const xs = Array.from({ length: n }, (_, i) => (n === 1 ? W / 2 : t / 2 + (i * (W - t)) / (n - 1)));
      const slatBase = { outer: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: sd }, { x: 0, y: sd }], holes: [] };
      const slatNotches = xs.map(x => ({ outer: [{ x: x - slotW / 2, y: -1 }, { x: x + slotW / 2, y: -1 }, { x: x + slotW / 2, y: dn }, { x: x - slotW / 2, y: dn }], holes: [] }));
      const sc = booleanRegions('difference', [[slatBase], slatNotches]);
      if (sc.error) return { error: `rib_chair: ${sc.error}` };
      if (sc.regions.length !== 1) return { error: 'rib_chair: the rib notches cut a slat in two — a wider chair or fewer ribs' };
      const openS = offsetRegions(offsetRegions([{ outer: sc.regions[0].outer, holes: [] }], -rO), rO);
      if (openS.length !== 1) return { error: `rib_chair: a slat has a neck thinner than the ${formatDiameter(p.toolDiameter)} bit — a deeper slat or fewer ribs` };
      const slatRing = simplifyRing(openS[0].outer, SIMPLIFY_TOL);

      // ---- pieces: n ribs, then the slats ----
      const pieces = [];
      for (let i = 0; i < n; i++) pieces.push({ id: `R${i + 1}`, kind: 'rib', at: xs[i], outline: ribRing });
      kept.forEach((st, j) => pieces.push({ id: `S${j + 1}`, kind: 'slat', st, outline: slatRing }));

      // ---- sheet layout: shelf-packed into SHEETS, pieces turned 90° when
      // that packs tighter (slats stand on end beside a rib), a new sheet
      // when a row no longer fits the height; the setup param picks the
      // sheet this file cuts (the furniture guest's contract) ----
      const lim = (a, b) => [a, b].filter(v => v > 0);
      const limsW = lim(ctx.shop?.machineW, ctx.shop?.materialW), limsH = lim(ctx.shop?.machineH, ctx.shop?.materialH);
      const binW = (limsW.length ? Math.min(...limsW) : Infinity) - 2 * MARGIN - p.toolDiameter;
      const binH = (limsH.length ? Math.min(...limsH) : Infinity) - 2 * MARGIN - p.toolDiameter;
      const rot90 = (ring) => ring.map(q => ({ x: -q.y, y: q.x }));
      const placed = [];
      let bin = 0, cx = 0, floorY = 0, rowH = 0, rowStart = true;
      for (const pc of pieces) {
        const asIs = { rot: 0, ring: pc.outline }, turned = { rot: 90, ring: rot90(pc.outline) };
        for (const o of [asIs, turned]) { const bb = bboxOf(o.ring); o.bb = bb; o.w = bb.maxX - bb.minX; o.h = bb.maxY - bb.minY; }
        const fitsBin = (o) => o.w <= binW + 1e-9 && o.h <= binH + 1e-9;
        if (!fitsBin(asIs) && !fitsBin(turned)) return { error: `rib_chair: ${pc.kind} ${pc.id} (${asIs.w.toFixed(1)}" × ${asIs.h.toFixed(1)}") does not fit the ${(binW + 2 * MARGIN + p.toolDiameter).toFixed(0)}" × ${(binH + 2 * MARGIN + p.toolDiameter).toFixed(0)}" sheet in any orientation — a smaller chair, or a bigger sheet in the shop settings` };
        // in the open row: an orientation that fits the remaining width and the row's height, as-is first
        let pick = null;
        if (!rowStart) pick = [asIs, turned].find(o => fitsBin(o) && cx + GAP + o.w <= binW + 1e-9 && o.h <= rowH + 1e-9)
          ?? [asIs, turned].find(o => fitsBin(o) && cx + GAP + o.w <= binW + 1e-9 && floorY + o.h <= binH + 1e-9 && o.h > rowH);   // taller than the row: grow it
        if (!pick) {
          // a new row: the lower orientation that fits the width; a new sheet when the row would overrun the height
          pick = [asIs, turned].filter(fitsBin).sort((a, b) => a.h - b.h)[0];
          const nextFloor = rowStart ? floorY : floorY + rowH + GAP;
          if (nextFloor + pick.h > binH + 1e-9) { bin++; floorY = 0; } else floorY = nextFloor;
          cx = 0; rowH = 0; rowStart = true;
        }
        const sx = (rowStart ? 0 : cx + GAP) - pick.bb.minX, sy = floorY - pick.bb.minY;
        const ring2 = pick.ring.map(q => ({ x: q.x + sx, y: q.y + sy }));
        cx = (rowStart ? 0 : cx + GAP) + pick.w;
        rowH = Math.max(rowH, pick.h);
        rowStart = false;
        placed.push({ ...pc, ring: ring2, sx, sy, rot: pick.rot, bin });
      }
      const nBins = bin + 1;
      const setup = Math.min(nBins, Math.max(1, Math.round(+p.setup || 1)));
      const groups = Array.from({ length: nBins }, (_, b) => placed.filter(pc => pc.bin === b).map(pc => pc.id));
      if (nBins > 1) warnings.push(`the ${placed.length} pieces need ${nBins} sheets — ${groups.map((ids, b) => `sheet ${b + 1}: ${ids.length} pieces (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''})`).join('; ')}. This file cuts sheet ${setup}; bind setup to a control to flip through them`);
      const current = placed.filter(pc => pc.bin === setup - 1);

      // ---- the cut: one outside profile per piece on THIS sheet ----
      const ops = [];
      let all = null;
      for (const pc of current) {
        const prof = generateProfile({ outer: pc.ring }, { diameter: p.toolDiameter }, {
          side: 'outside', totalDepth: t, depthPerPass: 0.25, safeZ: ctx.safeZ, entry: 'ramp',
          tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
        });
        ops.push({
          subName: `${pc.kind} ${pc.id}`,
          tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
          cutter: { type: 'flat', diameter: p.toolDiameter },
          feedRate: p.feedRate, plungeRate: 30,
          moves: prof.moves,
          target: { type: 'profile', side: 'outside', rings: [pc.ring], depth: t },
          previewRing: pc.ring,
          previewTabs: prof.tabs,
          rib: true,
          warnings: prof.warnings.map(w => `${pc.kind} ${pc.id}: ${w}`),
        });
        const bb = bboxOf(pc.ring);
        all = all ? { minX: Math.min(all.minX, bb.minX), minY: Math.min(all.minY, bb.minY), maxX: Math.max(all.maxX, bb.maxX), maxY: Math.max(all.maxY, bb.maxY) } : bb;
      }

      // ---- the assembled view ----
      // world (Y-up): width X ∈ [0, W], depth Z ∈ [0, D] from the back, height Y.
      // Each piece has an UNROTATED frame (O, U, V): local (a, b) ↦ O + a·U + b·V.
      // A rib's local a = z, b = y, standing in the plane x = at (slab toward −X
      // from O.x = at + t/2). A slat's local a = x along the width, b = up its
      // outward normal N̂; its outer edge (b = slatDepth) lies on the silhouette
      // at the station P, its slab is t thick along the tangent. The sheet ring
      // is that local ring shifted by (sx, sy) and, when turned, rotated 90°
      // ((a, b) → (−b, a)), so the pose that maps the SHEET ring back is
      //   unturned: origin = O − sx·U − sy·V, u = U, v = V
      //   turned:   origin = O − sy·U + sx·V, u = −V, v = U      (same u×v)
      const pose = (pc, O, U, V) => {
        const sub = (A, B, k) => [A[0] - k * B[0], A[1] - k * B[1], A[2] - k * B[2]];
        if (pc.rot === 0) return { origin: sub(sub(O, U, pc.sx), V, pc.sy), u: U, v: V };
        return { origin: sub(sub(O, U, pc.sy), V, -pc.sx), u: V.map(v => -v), v: U };
      };
      const panels = placed.map(pc => {
        let world;
        if (pc.kind === 'rib') world = pose(pc, [pc.at + t / 2, 0, 0], [0, 0, 1], [0, 1, 0]);
        else {
          const { P, N } = pc.st;
          const V = [0, N.y, N.x];                       // outward normal in world (y = N.y, z = N.x)
          const Wv = [0, -V[2], V[1]];                   // U × V for U = +X: the slab's thickness direction
          const O = [0, P.y - sd * V[1] - (t / 2) * Wv[1], P.x - sd * V[2] - (t / 2) * Wv[2]];
          world = pose(pc, O, [1, 0, 0], V);
        }
        return { id: pc.id, thickness: t, rings: [pc.ring], sheet: { x: 0, y: 0, rot: 0 }, setup: pc.bin + 1, active: pc.bin === setup - 1, world };
      });
      if (!all) all = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      // the runtime surfaces per-op warnings only: the verb's own (sheets, dropped slats) ride on the first op
      if (ops.length && warnings.length) ops[0].warnings = [...warnings, ...ops[0].warnings];
      const r2 = p.toolDiameter / 2;
      return {
        ops,
        bbox: { minX: all.minX - r2, minY: all.minY - r2, maxX: all.maxX + r2, maxY: all.maxY + r2 },
        pieces: placed.length,
        assembly: { kind: 'rib_chair', ribs: n, slats: kept.length, crossings: n * kept.length, height: H, width: W, depth: D, box: [W, H, D], panels,
          silhouette: ring.map(q => ({ z: +q.x.toFixed(4), y: +q.y.toFixed(4) })) },   // the un-notched side outline, (z, y)
        ...(nBins > 1 ? { setups: { count: nBins, current: setup, groups } } : {}),
        warnings,
      };
    },
  },
};
