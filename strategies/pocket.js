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
// (outer counter-clockwise/positive, holes clockwise/negative). Open-edge
// spillover is NOT applied here — insetRegion owns it (set-theoretically;
// see its header).
export function regionToPaths(region) {
  let outer = region.outer;
  if (signedArea(outer) < 0) outer = outer.slice().reverse();

  let paths = [toClipper(outer)];

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

// drop collinear/near-duplicate vertices at the arc-tolerance scale —
// keeps ring point counts (and posted file sizes) sane
const cleaned = out =>
  ClipperLib.Clipper.CleanPolygons(out, ARC_TOL).filter(p => p.length >= 3);

// Inset a region by distance d (in region units). Returns clipper Paths —
// possibly several disjoint outers, each possibly with holes (islands).
// Round joins: the inset is exactly the locus a round tool of radius d can
// reach, so sharp concave corners get the physically correct fillet.
//
// With open edges (bitRadius > 0), the legal tool-center set at level d is
// built set-theoretically instead of by insetting a spillover-extended
// virtual polygon:
//
//   legal(d) = dilate(region, 2·bitRadius − d) − bands(walls ∪ islands, d)
//
// dilate: everything within (2R − d) of the region. Past open edges that
// is exactly the spillover ladder — level 0 (d = R) lands the center R
// past the edge (periphery 2R past, full clearance), deeper levels retreat
// one stepover per level like a closed pocket, d > 2R is a plain erode.
// bands: round-capped both-sided offset of every wall chain and island
// ring — the ring-level standoff from real geometry. Ring levels have
// d ≥ R ≥ 2R − d, so the wall band also swallows the whole beyond-wall
// shadow the dilation added: no center ever lands past a wall. The
// slot-graze fallback (d = R − graze < R) reopens a 2·graze-deep shadow
// window past walls; a second, outside-only subtraction closes it without
// tightening the in-region standoff.
//
// The previous construction unioned a per-open-edge rectangle fan onto the
// region and inset that. Around a concave circular bite the fan left slit
// artifacts, and every fictitious slit pushes the inset a full bit radius
// away — phantom keep-out that cost the 1/4" its only corridor through
// 004681 Pocket 3's narrow neck and dragged in a pointless 1/8" rest pass.
export function insetRegion(region, d, bitRadius = 0) {
  const hasOpen = bitRadius > 0 && !!region.edgeTypes?.includes('open');
  if (!hasOpen) {
    const co = new ClipperLib.ClipperOffset(MITER, ARC_TOL);
    co.AddPaths(regionToPaths(region), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const out = new ClipperLib.Paths();
    co.Execute(out, -d * SCALE);
    return cleaned(out);
  }

  const base = regionToPaths(region);
  const grow = new ClipperLib.ClipperOffset(MITER, ARC_TOL);
  grow.AddPaths(base, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const dilated = new ClipperLib.Paths();
  grow.Execute(dilated, (2 * bitRadius - d) * SCALE);
  if (!dilated.length) return [];

  // wall chains, indexed against the CCW-oriented outer like edgeTypes
  let outer = region.outer;
  let edgeTypes = region.edgeTypes;
  if (signedArea(outer) < 0) {
    const n = outer.length;
    outer = outer.slice().reverse();
    edgeTypes = outer.map((_, k) => region.edgeTypes[(((n - 2 - k) % n) + n) % n]);
  }
  const n = outer.length;
  const isWall = e => edgeTypes[e] !== 'open';
  // a wall chain ends where an open edge begins, but the material it stands
  // for does not necessarily end there (a neighboring region's wall often
  // continues the same face). Persist each wall as a half-plane constraint
  // through the whole spillover zone: extend the chain tangentially past
  // both end vertices before offsetting.
  const EXT = 2 * bitRadius;
  const extended = pts => {
    const out = pts.slice();
    for (const [from, at] of [[1, 0], [pts.length - 2, pts.length - 1]]) {
      // walk inward past zero-length segments for a usable direction
      let f = from;
      const step = from < at ? -1 : 1;
      while (f >= 0 && f < pts.length
        && Math.hypot(pts[at].x - pts[f].x, pts[at].y - pts[f].y) < 1e-9) f += step;
      if (f < 0 || f >= pts.length) continue;
      const dx = pts[at].x - pts[f].x, dy = pts[at].y - pts[f].y;
      const len = Math.hypot(dx, dy);
      const p = { x: pts[at].x + (dx / len) * EXT, y: pts[at].y + (dy / len) * EXT };
      if (at === 0) out.unshift(p); else out.push(p);
    }
    return out;
  };
  // spillover must not wrap around an open chain's END vertex: the space
  // diagonally past it belongs to geometry this region knows nothing about
  // (Aggregate's Pocket 13 has full-height material there). Fence each end
  // with a segment along the end edge's outward normal — the lateral bound
  // the old spillover rectangles enforced by their flat sides.
  const fences = [];
  for (let s = 0; s < n; s++) {
    if (isWall(s) || !isWall((s - 1 + n) % n)) continue; // open-chain starts
    let last = s;
    for (let e = s; !isWall(e); e = (e + 1) % n) last = e;
    for (const e of [s, last]) {
      const a = outer[e], b = outer[(e + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len; // outward, CCW ring
      const v = e === s ? a : b;
      fences.push([v, { x: v.x + nx * EXT, y: v.y + ny * EXT }]);
    }
  }
  const bands = radius => {
    const so = new ClipperLib.ClipperOffset(MITER, ARC_TOL);
    for (let s = 0; s < n; s++) {
      if (!isWall(s) || isWall((s - 1 + n) % n)) continue; // chain starts
      const pts = [outer[s]];
      for (let e = s; isWall(e); e = (e + 1) % n) pts.push(outer[(e + 1) % n]);
      so.AddPath(toClipper(extended(pts)), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    }
    for (const f of fences) {
      so.AddPath(toClipper(f), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    }
    for (const h of region.holes ?? []) {
      so.AddPath(toClipper(h), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedLine);
    }
    const out = new ClipperLib.Paths();
    so.Execute(out, radius * SCALE);
    return out;
  };

  const c = new ClipperLib.Clipper();
  c.AddPaths(dilated, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(bands(d), ClipperLib.PolyType.ptClip, true);
  if (2 * bitRadius - d > d + 1e-12) {
    // graze-fallback shadow closure: fence beyond-wall (and inside-island)
    // space out to the dilation depth, keeping the in-region standoff at d
    const wide = new ClipperLib.Clipper();
    wide.AddPaths(bands(2 * bitRadius - d), ClipperLib.PolyType.ptSubject, true);
    wide.AddPaths(base, ClipperLib.PolyType.ptClip, true);
    const shadow = new ClipperLib.Paths();
    wide.Execute(ClipperLib.ClipType.ctDifference, shadow,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    c.AddPaths(shadow, ClipperLib.PolyType.ptClip, true);
  }
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, out,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return cleaned(out);
}

// Slot-aware inset for the outermost (bit-radius) level. A groove within
// SLOT_GRAZE of the bit width has no room at the exact inset — STEP or
// tessellation noise alone kills it — but earns a centerline pass that
// grazes the walls. The graze inset is a superset of the exact one
// (insets are monotone), so swap to it whenever it opens SUBSTANTIALLY
// more center room, not only when the exact inset is empty: a mixed
// region never triggers an all-or-nothing fallback-on-empty (004681's
// Through Cutout 15 — the junction diamonds where its 1/8"-nominal slots
// cross fit the 1/8" exactly, so the slot legs between them used to
// read unreachable and fell to a residual pass that excludes through
// cuts entirely).
// ratio = Infinity restores fallback-on-empty only — rest passes use it:
// their synthetic corner blobs are always small, so the ratio test would
// fire spuriously and rub finish walls the bulk bit already cut to size.
const SLOT_SWAP_RATIO = 1.5;
export function insetRegionSlotAware(region, d, bitRadius, ratio = SLOT_SWAP_RATIO) {
  const exact = insetRegion(region, d, bitRadius);
  const graze = insetRegion(region, d - SLOT_GRAZE, bitRadius);
  // net center area (holes are negatively oriented and subtract)
  const area = paths => paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0);
  const slotFit = graze.length > 0
    && (!exact.length || area(graze) > ratio * area(exact));
  return { paths: slotFit ? graze : exact, slotFit };
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
    let paths;
    if (k === 0) {
      const sa = insetRegionSlotAware(region, d, bitRadius, params.slotSwapRatio);
      paths = sa.paths;
      slotFit = sa.slotFit;
    } else {
      paths = insetRegion(region, d, bitRadius);
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
