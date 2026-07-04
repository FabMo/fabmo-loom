// Pocket clearing — the first strategy-bulge primitive owned by seams.
//
// Contour-parallel pocket clearing for a polygon-with-holes region, lowered
// directly to the canonical moves rail. The offset kernel is Clipper
// (vendor/clipper.js) instead of the hand-rolled vertex-bisector code the
// apps grew: every inset is computed FROM THE ORIGINAL REGION (no error
// accumulation across levels), output rings are guaranteed simple, holes and
// islands are first-class, and tolerances are integer-grid robust.
//
// Region (op-local coordinates, Z=0 stock top):
//   { outer: [{x,y}],          closed boundary, any orientation
//     holes: [[{x,y}], ...],   islands to leave standing (optional)
//     edgeTypes: ['wall'|'open', ...] }  per outer edge i (v_i -> v_i+1);
//                              'open' edges have no wall — the tool sweeps
//                              past them by one bit radius (optional)
//
// Output moves follow the operation contract in ir/job.js: they begin with a
// rapid XY positioning move, all internal retracts go to params.safeZ, and
// plunges are Z-only linears (the rail posts them at the Z/plunge feed).
// When params.feedRate/plungeRate are given, cutting moves are additionally
// annotated with a feedRate field — harmless to the rail, and it lets the
// existing per-app previews/exporters consume these moves unchanged.

import ClipperLib from '../vendor/clipper.js';

// Integer grid: 1e-6 units. At inches that is a microinch — far below any
// machine resolution; at mm it is a nanometre. 96" stock → 9.6e7, safely
// inside exact integer range.
export const SCALE = 1e6;
const ARC_TOL = 0.0005 * SCALE;   // max deviation when rounding joins
const MITER = 2;

// Slot-fit tolerance: a groove within this of the bit width still gets a
// centerline pass — the bit rubs the walls by up to this much per side.
// Matches the verifier's kerfGrazeTol, which classifies that contact as a
// graze (warning), not a gouge (error).
export const SLOT_GRAZE = 0.005;

export const toClipper = ring => ring.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
export const fromClipper = path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

// positive for counter-clockwise rings (standard math orientation)
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return a / 2;
}

// point strictly inside a clipper Paths region (inside an outer, not inside
// a hole) — orientation-aware via nonzero winding over all rings.
function pointInPaths(x, y, paths) {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let winding = 0;
  for (const path of paths) {
    const r = ClipperLib.Clipper.PointInPolygon(pt, path);
    if (r === -1) return true; // on a boundary counts as inside
    if (r === 1) winding += ClipperLib.Clipper.Orientation(path) ? 1 : -1;
  }
  return winding > 0;
}

// Normalize a region to clipper Paths with consistent orientation
// (outer counter-clockwise/positive, holes clockwise/negative), applying
// open-edge spillover. `ext` is how far past an open edge the shape is
// extended. Pass 2·bitRadius: the FIXED virtual region whose outermost
// inset (bitRadius) lands exactly bitRadius past the open edge — full
// clearance — while deeper insets retreat inward by one stepover per
// level, exactly like a closed pocket. (Extending per-level by
// insetDistance + bitRadius instead pins EVERY ring to the open edge,
// re-cutting the same air band each pass — correct but hugely wasteful.)
export function regionToPaths(region, ext) {
  let outer = region.outer;
  let edgeTypes = region.edgeTypes ?? null;
  if (signedArea(outer) < 0) {
    const n = outer.length;
    outer = outer.slice().reverse();
    if (edgeTypes) edgeTypes = outer.map((_, k) => region.edgeTypes[(((n - 2 - k) % n) + n) % n]);
  }

  let paths = [toClipper(outer)];

  if (edgeTypes && ext > 0 && edgeTypes.includes('open')) {
    const rects = [];
    const n = outer.length;
    // outward normal of a CCW ring is to the RIGHT of travel
    const normals = outer.map((a, i) => {
      const b = outer[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      return len < 1e-9 ? null : { x: dy / len, y: -dx / len };
    });
    for (let i = 0; i < n; i++) {
      if (edgeTypes[i] !== 'open' || !normals[i]) continue;
      const a = outer[i], b = outer[(i + 1) % n];
      const { x: nx, y: ny } = normals[i];
      rects.push(toClipper([
        a, b,
        { x: b.x + nx * ext, y: b.y + ny * ext },
        { x: a.x + nx * ext, y: a.y + ny * ext },
      ]));
    }
    // Where two OPEN edges meet, the per-edge rects leave the diagonal
    // corner unfilled — the virtual region gets a notch there and every
    // inset bows around it ("avoiding the corner"). Patch the vertex with
    // the parallelogram spanned by both edge normals so the spillover
    // wraps the open corner like the rest of the open boundary.
    // Wound (v → nc → np+nc → np) to MATCH the edge rects' winding: a
    // mixed-orientation clip set makes the nonzero union emit an extra
    // hole-like path that cancels real region during the inset.
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      if (edgeTypes[i] !== 'open' || edgeTypes[prev] !== 'open') continue;
      const np = normals[prev], nc = normals[i];
      if (!np || !nc) continue;
      const v = outer[i];
      rects.push(toClipper([
        v,
        { x: v.x + nc.x * ext, y: v.y + nc.y * ext },
        { x: v.x + (np.x + nc.x) * ext, y: v.y + (np.y + nc.y) * ext },
        { x: v.x + np.x * ext, y: v.y + np.y * ext },
      ]));
    }
    if (rects.length) {
      const c = new ClipperLib.Clipper();
      c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
      c.AddPaths(rects, ClipperLib.PolyType.ptClip, true);
      const out = new ClipperLib.Paths();
      c.Execute(ClipperLib.ClipType.ctUnion, out,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      paths = out;
    }
  }

  if (region.holes?.length) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(region.holes.map(toClipper), ClipperLib.PolyType.ptClip, true);
    const out = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctDifference, out,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    paths = out;
  }

  return paths;
}

// Inset a region by distance d (in region units). Returns clipper Paths —
// possibly several disjoint outers, each possibly with holes (islands).
// Round joins: the inset is exactly the locus a round tool of radius d can
// reach, so sharp concave corners get the physically correct fillet.
export function insetRegion(region, d, bitRadius = 0) {
  const paths = regionToPaths(region, 2 * bitRadius);
  const co = new ClipperLib.ClipperOffset(MITER, ARC_TOL);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, -d * SCALE);
  // drop collinear/near-duplicate vertices at the arc-tolerance scale —
  // keeps ring point counts (and posted file sizes) sane
  return ClipperLib.Clipper.CleanPolygons(out, ARC_TOL).filter(p => p.length >= 3);
}

export function generateDepths(totalDepth, depthPerPass) {
  const n = Math.max(1, Math.ceil(totalDepth / depthPerPass));
  const depths = [];
  for (let i = 1; i <= n; i++) depths.push(Math.min((i * totalDepth) / n, totalDepth));
  return depths;
}

const ringPerimeter = ring => {
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    len += Math.hypot(ring[j].x - ring[i].x, ring[j].y - ring[i].y);
  }
  return len;
};

const closestVertexIndex = (ring, x, y) => {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - x, ring[i].y - y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

// Can the tool travel a->b at depth without leaving the cleared envelope?
// Measured: sample the segment against the level-0 inset (the full region
// the tool center may ever occupy). Anything outside would gouge a wall.
function segmentInside(a, b, paths, step) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const nSamples = Math.min(32, Math.max(2, Math.ceil(len / step) + 1));
  for (let i = 0; i <= nSamples; i++) {
    const t = i / nSamples;
    if (!pointInPaths(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), paths)) return false;
  }
  return true;
}

/**
 * Contour-parallel pocket clearing.
 *
 * region: { outer, holes?, edgeTypes? }   (see header)
 * tool:   { diameter }
 * params: { stepoverPct=40, totalDepth, depthPerPass,
 *           safeZ, feedRate?, plungeRate? }
 *
 * Returns { moves, contours, levels, warnings, stats }.
 */
export function generatePocket(region, tool, params) {
  const bitRadius = tool.diameter / 2;
  const stepoverPct = params.stepoverPct ?? 40;
  const stepover = tool.diameter * (stepoverPct / 100);
  const safeZ = params.safeZ;
  const depths = generateDepths(params.totalDepth, params.depthPerPass);
  const warnings = [];

  // ---- inset levels, each from the original region ----
  const MAX_LEVELS = 4000;
  const levels = [];   // levels[k] = array of rings ({x,y}[]) at inset bitRadius + k*stepover
  let level0Paths = [];
  let slotFit = false;
  for (let k = 0; k < MAX_LEVELS; k++) {
    const d = bitRadius + k * stepover;
    let paths = insetRegion(region, d, bitRadius);
    if (k === 0 && !paths.length) {
      // exact-width slot: a groove machined by a bit of (nominally) its own
      // width has no room at the full-radius inset — tessellation noise
      // alone kills it. Retry grazing-close so the centerline pass survives.
      paths = insetRegion(region, d - SLOT_GRAZE, bitRadius);
      if (paths.length) slotFit = true;
    }
    if (!paths.length) break;
    if (k === 0) level0Paths = paths;
    // keep rings worth cutting: big enough to matter, or long-and-thin
    // (a slot centerline has tiny area but real length). Rest passes
    // override minRingArea to 0 — a corner blob is small by definition.
    const minArea = params.minRingArea ?? (1 - stepoverPct / 100) * Math.PI * bitRadius * bitRadius * 0.25;
    const rings = [];
    for (const path of paths) {
      const ring = fromClipper(path);
      if (ring.length < 3) continue;
      if (Math.abs(signedArea(ring)) < minArea && ringPerimeter(ring) < 4 * stepover) continue;
      rings.push(ring);
    }
    if (!rings.length) break;
    levels.push(rings);
    if (k === MAX_LEVELS - 1) warnings.push(`hit MAX_LEVELS=${MAX_LEVELS}; pocket may be incompletely cleared`);
  }

  if (!levels.length) {
    warnings.push(`region too small for a ${tool.diameter} tool — nothing machinable`);
    return { moves: [], contours: [], levels, warnings, stats: { pockets: 0, contours: 0, stayDownLinks: 0, retractLinks: 0 } };
  }
  if (slotFit) {
    warnings.push(`slot fit: groove is within ${SLOT_GRAZE}" of the bit width — centerline pass grazes the walls`);
  }

  // ---- group rings into pockets (disjoint machinable areas) ----
  // The level-0 inset defines where the tool center may ever be; each of its
  // outers is one pocket and doubles as the stay-down envelope.
  const pocketOuters = level0Paths.filter(p => ClipperLib.Clipper.Orientation(p));
  const pockets = pocketOuters.map(outer => {
    const envelope = [outer, ...level0Paths.filter(p =>
      !ClipperLib.Clipper.Orientation(p) &&
      ClipperLib.Clipper.PointInPolygon(p[0], outer) === 1)];
    return { envelope, ringsByLevel: [] };
  });
  const pocketOf = ring => {
    for (let i = 0; i < pockets.length; i++) {
      if (ClipperLib.Clipper.PointInPolygon(toClipper([ring[0]])[0], pocketOuters[i]) !== 0) return i;
    }
    return 0;
  };
  levels.forEach((rings, k) => {
    for (const ring of rings) {
      const p = pockets[pocketOf(ring)];
      (p.ringsByLevel[k] ??= []).push(ring);
    }
  });

  // ---- moves: per depth pass, per pocket, inside-out with stay-down links ----
  const moves = [];
  const contours = [];
  let stayDownLinks = 0, retractLinks = 0;
  let firstEntry = true;
  let toolPos = null;
  let atDepth = false;   // tool is at the current pass depth (stay-down legal)

  const traceFrom = (ring, startIdx, z, feedRate) => {
    const n = ring.length;
    for (let s = 1; s <= n; s++) {
      const v = ring[(startIdx + s) % n];
      const m = { type: 'linear', x: v.x, y: v.y, z };
      if (feedRate) m.feedRate = feedRate;
      moves.push(m);
    }
    toolPos = { x: ring[startIdx].x, y: ring[startIdx].y };
  };

  for (let pass = 0; pass < depths.length; pass++) {
    const z = -depths[pass];
    moves.push({ type: 'comment', text: `Depth pass z=${z.toFixed(4)}` });
    atDepth = false;   // previous pass ended retracted (and its depth differs)

    for (const pocket of pockets) {
      const pending = [];
      for (let k = pocket.ringsByLevel.length - 1; k >= 0; k--) {
        for (const ring of pocket.ringsByLevel[k] ?? []) pending.push(ring);
      }
      if (!pending.length) continue;

      while (pending.length) {
        // nearest pending ring (insertion order is already inside-out)
        let pick = 0;
        if (toolPos) {
          let bestD = Infinity;
          for (let i = 0; i < pending.length; i++) {
            const ci = closestVertexIndex(pending[i], toolPos.x, toolPos.y);
            const d = Math.hypot(pending[i][ci].x - toolPos.x, pending[i][ci].y - toolPos.y);
            if (d < bestD) { bestD = d; pick = i; }
          }
        }
        const ring = pending.splice(pick, 1)[0];
        if (pass === 0) contours.push(ring);
        const startIdx = toolPos ? closestVertexIndex(ring, toolPos.x, toolPos.y) : 0;
        const entry = ring[startIdx];

        const linkDist = toolPos ? Math.hypot(entry.x - toolPos.x, entry.y - toolPos.y) : Infinity;
        const stayDown = atDepth && toolPos && linkDist <= 2.5 * stepover &&
          segmentInside(toolPos, entry, pocket.envelope, stepover / 2);

        if (stayDown) {
          stayDownLinks++;
          const m = { type: 'linear', x: entry.x, y: entry.y, z };
          if (params.feedRate) m.feedRate = params.feedRate;
          moves.push(m);
        } else {
          retractLinks++;
          if (firstEntry) {
            // operation contract: first move is a rapid XY positioning move
            moves.push({ type: 'rapid', x: entry.x, y: entry.y });
            firstEntry = false;
          } else {
            moves.push({ type: 'rapid', z: safeZ });
            moves.push({ type: 'rapid', x: entry.x, y: entry.y });
          }
          const plunge = { type: 'linear', z };
          if (params.plungeRate) plunge.feedRate = params.plungeRate;
          moves.push(plunge);
        }
        atDepth = true;
        traceFrom(ring, startIdx, z, params.feedRate);
      }
      // retract between pockets; toolPos (XY) persists for nearest-first ordering
      moves.push({ type: 'rapid', z: safeZ });
      atDepth = false;
    }
  }

  const stats = {
    pockets: pockets.length,
    levels: levels.length,
    contours: contours.length,
    depthPasses: depths.length,
    stayDownLinks,
    retractLinks,
  };

  // declared target for the verifier (ir/verify.js): the SWEPT footprint —
  // the level-0 tool-center region dilated by the bit radius — and the
  // depth it promises not to exceed. Declaring the full region would claim
  // material a too-big bit can't reach: the verifier would flag it uncut,
  // and worse, the residual mask (claimed = excluded) would hide it from
  // the raster catch-all, so nobody would cut it. The honest footprint
  // leaves the unreachable remainder in the residual for a smaller bit or
  // the raster. Deliberately NOT clipped to the region: a slot-fit pass
  // really does graze up to SLOT_GRAZE into the walls, and hiding that
  // from the declaration would just make the verifier's inset degenerate.
  const sweep = new ClipperLib.ClipperOffset(MITER, ARC_TOL);
  sweep.AddPaths(level0Paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const swept = new ClipperLib.Paths();
  sweep.Execute(swept, bitRadius * SCALE);
  const target = {
    type: 'region',
    rings: ClipperLib.Clipper.CleanPolygons(swept, ARC_TOL)
      .filter(p => p.length >= 3).map(fromClipper),
    depth: params.totalDepth,
  };

  return { moves, contours, levels, warnings, stats, target };
}
