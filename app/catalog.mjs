// The strategy catalog — what the Loom app can weave.
//
// Each entry is a macro-strategy: typed parameters (the schema the intent
// layer is allowed to emit) plus a run() that lowers to canonical-rail
// moves with a declared verifier target. The catalog doc string is
// assembled into the LLM's grounding prompt, so an entry's `doc` and
// param descriptions ARE the model's knowledge of what exists — write
// them for a machine audience.
//
// A recipe references entries by key; anything not in this file is
// undoable by prompt and must be DECLINED (the decline is the gap report
// that grows this file).
//
// GUEST entries: a whole sibling app can mount itself as one catalog
// verb (see AGENTS.md "Mounting a guest app"). registerCatalogEntries
// merges a guest module's entries at boot — same contract as a native
// entry: typed params, doc written for the model, run() → ops on the
// canonical rail with declared targets, in the WORKING FRAME (bake any
// internal placements — translation of moves/targets — before returning).

import { textToContours } from '../examples/engraver/text-to-regions.mjs';
import { computeMedialAxis } from '../vendor/v_engraver/medial-axis.js';
import { pointInPolygon, distanceToBoundary } from '../vendor/v_engraver/polygon-utils.js';
import { generateVEngraveToolpath, generatePocketPasses } from '../vendor/v_engraver/toolpath-gen.js';
import { generateProfile } from '../strategies/profile.js';
import { generatePocket } from '../strategies/pocket.js';
import { generateRestPocket } from '../strategies/rest.js';
import { generateBore } from '../strategies/bore.js';
import { generateChamfer, imprintChamfer } from '../strategies/chamfer.js';
import { generateSurfaceRaster } from '../strategies/surface-raster.js';
import { coverageCurve, pickChainSlotAware, regionArea, formatDiameter } from '../strategies/tool-select.js';
import ClipperLib from '../vendor/clipper.js';
import { FONTS, DEFAULT_FONT } from './fonts.mjs';
import { weldContours, pathToRegions, offsetRegions, booleanRegions } from './shape.mjs';
import { TEXTURES, TEXTURE_IDS, sampleTexture, distanceGridForRings, gridSampler, insideGridEvenOdd } from './texture-kernel.mjs';

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
};
const ccw = (ring) => (ringArea(ring) > 0 ? ring : [...ring].reverse());
const cwr = (ring) => (ringArea(ring) < 0 ? ring : [...ring].reverse());

function circleRing(cx, cy, r, n = 96) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return ring;
}

// shapes center themselves on the existing content (so a pocket, a
// monogram, and a disc cutout all stack concentrically); the first op in
// a recipe centers at the local origin
function contentCenter(ctx) {
  const b = ctx.contentBBox;
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
}

// entries register their true outlines so downstream shapes (a disc cutout
// sizing itself around a round pocket) measure real geometry, not bounding
// boxes — a 2" circle reaches 1.0" from center, not its bbox corner's 1.41"
function noteContent(ctx, rings) {
  (ctx.contentRings ??= []).push(...rings);
}
function contentReach(ctx, c) {
  if (!ctx.contentRings?.length) {
    const b = ctx.contentBBox;
    if (!b) return 0;
    return Math.max(
      Math.hypot(b.minX - c.x, b.minY - c.y), Math.hypot(b.maxX - c.x, b.minY - c.y),
      Math.hypot(b.minX - c.x, b.maxY - c.y), Math.hypot(b.maxX - c.x, b.maxY - c.y));
  }
  let reach = 0;
  for (const ring of ctx.contentRings) {
    for (const q of ring) reach = Math.max(reach, Math.hypot(q.x - c.x, q.y - c.y));
  }
  return reach;
}

// Clipper round-joint outward offset of a single ring (largest result
// piece); null on failure so callers can fall back to the original
const CLIP_SCALE_OFF = 1e6;
function expandRing(ring, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.005 * CLIP_SCALE_OFF);
  co.AddPath(ring.map(q => ({ X: Math.round(q.x * CLIP_SCALE_OFF), Y: Math.round(q.y * CLIP_SCALE_OFF) })),
    ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * CLIP_SCALE_OFF);
  if (!out.length) return null;
  const biggest = out.reduce((a, b) => (Math.abs(ClipperLib.Clipper.Area(a)) > Math.abs(ClipperLib.Clipper.Area(b)) ? a : b));
  return biggest.map(q => ({ x: q.X / CLIP_SCALE_OFF, y: q.Y / CLIP_SCALE_OFF }));
}

function roundedRectRing(x0, y0, x1, y1, r, seg = 10) {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const ring = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return ring;
}

// Sampling lattice shared by the texture entries: ~300k cells over the
// field bbox extended by the ball reach, so resolution scales with area.
// The distance fields driving origin/flow/fade live on the same lattice.
function textureGrid(x0, y0, x1, y1, ext) {
  const ox = x0 - ext, oy = y0 - ext;
  const spanX = (x1 - x0) + 2 * ext, spanY = (y1 - y0) + 2 * ext;
  const cell = Math.max(0.01, Math.sqrt((spanX * spanY) / 300000));
  return { cols: Math.ceil(spanX / cell) + 1, rows: Math.ceil(spanY / cell) + 1, cell, ox, oy };
}

// Font contours weld under the NONZERO fill rule — the same rule every
// rasterizer applies to these outlines. The contours arrive AS AUTHORED
// (textToContours): outers and counters wind opposite ways, so nonzero
// keeps counters as holes, keeps self-crossing script strokes filled,
// and welds the joins where connected letters overlap. Do NOT
// pre-classify outer/hole by containment — script glyphs overlap instead
// of nesting, and that misclassification is exactly what used to delete
// strokes and counters. The weld itself lives in shape.mjs, shared with
// the svg-path shape source.

// resolve a shapes-section reference to a closed region (largest);
// returns { region, warnings, anchored: true } or { error }
function namedShapeRegion(ctx, id, use) {
  const sh = ctx.shapes?.[id];
  if (!sh) {
    const known = Object.keys(ctx.shapes ?? {});
    return { error: `unknown shape "${id}" — defined shapes: ${known.length ? known.join(', ') : 'none'}` };
  }
  if (sh.kind !== 'region') return { error: `shape "${id}" is an open curve — ${use} needs a closed outline` };
  const regions = [...sh.regions].sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
  const warnings = regions.length > 1
    ? [`shape "${id}" welds to ${regions.length} separate pieces — using the largest`] : [];
  return { region: regions[0], warnings, anchored: true };
}

// ALL pieces of a (possibly multi-piece) shape — for consumers that
// machine each piece (pocketing a signage glyph's separate figures).
// Single-outline consumers (cutouts: N pieces = N loose parts) keep
// namedShapeRegion's largest-piece rule.
function namedShapeRegionsAll(ctx, id, use) {
  const sh = ctx.shapes?.[id];
  if (!sh) {
    const known = Object.keys(ctx.shapes ?? {});
    return { error: `unknown shape "${id}" — defined shapes: ${known.length ? known.join(', ') : 'none'}` };
  }
  if (sh.kind !== 'region') return { error: `shape "${id}" is an open curve — ${use} needs a closed outline` };
  return { regions: sh.regions, anchored: true };
}

// resolve a shapes-section reference to a polyline to follow: an open
// curve directly, or a closed region's outer ring
function namedShapePolyline(ctx, id) {
  const sh = ctx.shapes?.[id];
  if (!sh) {
    const known = Object.keys(ctx.shapes ?? {});
    return { error: `unknown shape "${id}" — defined shapes: ${known.length ? known.join(', ') : 'none'}` };
  }
  if (sh.kind === 'curve') {
    const warnings = sh.polylines.length > 1 ? [`curve "${id}" has ${sh.polylines.length} subpaths — following the first`] : [];
    return { ...sh.polylines[0], warnings };
  }
  const regions = [...sh.regions].sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
  return { points: regions[0].outer, closed: true, warnings: [] };
}

// evenly spaced points along a polyline by ARC LENGTH — the deterministic
// replacement for the model baking direction cosines by hand. Open:
// count points from endMargin to L-endMargin (count 1 → the middle).
// Closed: count points around the loop starting at the first vertex.
function pointsAlong(poly, count, endMargin = 0) {
  const pts = poly.closed ? [...poly.points, poly.points[0]] : poly.points;
  const seg = [0];
  for (let i = 1; i < pts.length; i++) {
    seg.push(seg[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const L = seg[seg.length - 1];
  if (L < 1e-9) return { error: 'that curve has no length to space holes along' };
  let targets;
  if (poly.closed) {
    targets = Array.from({ length: count }, (_, k) => (k * L) / count);
  } else {
    const m = Math.min(endMargin, L / 2 - 1e-6);
    targets = count === 1
      ? [L / 2]
      : Array.from({ length: count }, (_, k) => m + (k * (L - 2 * m)) / (count - 1));
  }
  const out = [];
  let i = 1;
  for (const s of targets) {
    while (i < pts.length - 1 && seg[i] < s) i++;
    const t = (s - seg[i - 1]) / Math.max(1e-12, seg[i] - seg[i - 1]);
    out.push({
      x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
      y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
    });
  }
  return { points: out };
}

// A custom shape lowered from an svg path, largest region by outer area
// (the LLM occasionally authors stray slivers; the plaque is the big one)
function customShapeRegion(p) {
  const sized = pathToRegions(p.path ?? '', {
    width: p.width > 0 ? p.width : 0,
    height: p.height > 0 ? p.height : 0,
  });
  if (sized.error) return sized;
  const regions = [...sized.regions].sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
  const warnings = [];
  if (regions.length > 1) {
    warnings.push(`that shape welds to ${regions.length} separate pieces — using the largest; the rest are ignored`);
  }
  return { region: regions[0], w: sized.w, h: sized.h, warnings, anchored: sized.anchored };
}

// Enforce the medial axis's own invariant against the exact region
// geometry: every branch point must lie INSIDE its region with radius no
// larger than the true distance to the boundary (tip depth = radius/tanβ,
// so the vee's cut circle then stays inside by construction), and every
// SEGMENT must provably stay inside — a chord is contained whenever its
// length ≤ the sum of its endpoints' clearance radii (the endpoint disks
// cover it). The Voronoi approximation plus branch smoothing violates
// both by a few thou at the pinch waists a script weld creates — the
// verifier caught the strays live. Where the disk test fails, subdivide
// against the true boundary distance; where a midpoint lands outside,
// SPLIT the branch: the stroke tapers to the surface on each side of the
// waist (radius → waist depth → 0), which is also the correct cut.
// Exact and local — globally densifying the Voronoi sampling instead is
// quadratic and made long words take minutes.
function clampMedialAxis(ma, regions) {
  const inside = (x, y) => regions.find(r => pointInPolygon(x, y, r));
  const clamp = (q, reg) => {
    const d = distanceToBoundary(q.x, q.y, reg);
    return q.radius > d ? { ...q, radius: d } : q;
  };
  const branches = [];
  let seg = [];
  const flush = () => { if (seg.length >= 2) branches.push(seg); seg = []; };

  // a and b are clamped and inside reg; append the refined open interval
  // (a, b] to seg, flushing at waist splits. Recursion halves the chord,
  // so depth is bounded by log2(L / 0.002).
  const refine = (a, b, reg) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L <= a.radius + b.radius || L < 0.002) { seg.push(b); return; }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, radius: (a.radius + b.radius) / 2 };
    if (!pointInPolygon(mid.x, mid.y, reg)) { flush(); seg = [b]; return; }
    const m = clamp(mid, reg);
    refine(a, m, reg);
    refine(m, b, reg);
  };

  for (const branch of ma.branches) {
    seg = [];
    let prev = null;
    for (const q of branch) {
      const reg = inside(q.x, q.y);
      if (!reg) { flush(); prev = null; continue; }
      const c = clamp(q, reg);
      if (!prev) seg.push(c);
      else refine(prev, c, reg);
      prev = c;
    }
    flush();
  }
  ma.branches = branches;
}

// The text strategies share this guard: an unknown/unloaded font is a
// friendly error naming the shelf, not a crash.
function fontBufferOf(ctx, fontId) {
  const buf = ctx.fonts?.[fontId];
  if (!buf) {
    return { error: `unknown font "${fontId}" — available: ${FONTS.map(f => f.id).join(', ')}` };
  }
  return { buf };
}

// Center text geometry on the content so far — a monogram added to a
// coaster lands with its VISUAL center (bbox center) on the pocket's
// center, not its bottom-left corner ("center the letter" means the
// letter's middle, to a human). Returns translated COPIES: the text
// cache stays in its own frame so repeat ops agree.
function centeredText(ctx, text, letterHeight, fontId) {
  const { regions, width, height, merged } = textGeometry(ctx, text, letterHeight, fontId);
  const cc = contentCenter(ctx);
  const dx = cc.x - width / 2, dy = cc.y - height / 2;
  const shift = (ring) => ring.map(q => ({ x: q.x + dx, y: q.y + dy }));
  return {
    regions: regions.map(r => ({ outer: shift(r.outer), holes: r.holes.map(shift) })),
    width, height, merged,
    bbox: { minX: dx, minY: dy, maxX: dx + width, maxY: dy + height },
  };
}

// The standard drawer auto tool selection shops from (toolDiameter = 0).
const DRAWER = [0.25, 0.125, 0.0625, 0.03125];

// Coverage-knee tool selection aggregated across a set of regions: sum the
// per-region coverage curves, then pickChainSlotAware — the largest bit
// whose coverage clears the knee thresholds, plus any smaller bits whose
// marginal corner area earns a rest pass. Returns the chain ({d, prev}
// pairs, bulk first) and a user-facing note naming the pick.
function autoToolChain(regions, depth) {
  const bits = DRAWER.map(d => ({ diameter: d }));
  let total = 0;
  const agg = new Map(DRAWER.map(d => [d, { area: 0, slotArea: 0, excluded: null }]));
  for (const region of regions) {
    total += regionArea(region);
    for (const e of coverageCurve(region, depth, bits)) {
      const a = agg.get(e.diameter);
      if (e.excluded) { a.excluded = e.excluded; continue; }
      a.area += e.area;
      a.slotArea += e.slotArea ?? e.area;
    }
  }
  if (!(total > 0)) return { error: 'nothing to pocket' };
  const curve = DRAWER.map(d => {
    const a = agg.get(d);
    return {
      diameter: d, excluded: a.excluded ?? undefined,
      frac: a.area / total, area: a.area,
      slotFrac: a.slotArea / total, slotArea: a.slotArea,
    };
  });
  const { chain, slot } = pickChainSlotAware(curve, total);
  if (!chain.length) {
    return { error: `no bit in the drawer (${DRAWER.map(formatDiameter).join(', ')}) earns a cut at ${depth}" deep — enlarge the feature or shallow the pocket` };
  }
  const seq = chain.map((i, k) => ({ d: curve[i].diameter, prev: k === 0 ? null : curve[chain[k - 1]].diameter }));
  // one decimal: a rest pass often earns its keep on corner blobs that
  // round away at integer percent ("100% → 100%" reads as a no-op)
  const pct = f => (f * 100).toFixed(1);
  const cov = chain.map(i => (slot ? curve[i].slotFrac : curve[i].frac));
  const note = `auto tool: ${seq.map(s => formatDiameter(s.d)).join(' + ')} — coverage ${cov.map(pct).join('% → ')}%${slot ? ' (slot-fit centerline rescue)' : ''}`;
  return { chain: seq, note };
}

// Edge-break sub-op for the cutout entries: a 90° V-bit rides the cutout
// ring (CCW = material to the LEFT of travel = the part's top rim) cutting
// a 45° face `width` wide. The declared target is the INTENDED surface —
// flat stock imprinted with the chamfer cone over the band — so the
// verifier measures the vee's motion against intent, independent of the
// kernel that generated it. allowOverlap: the band deliberately straddles
// the rim the profile kerf abuts.
function chamferRimOp(ring, width, feedRate, safeZ) {
  const VEE = { kind: 'vee', diameter: 0.5, angleDeg: 90 }; // cuts a 45° face
  // flat-stock heightmap over the band, imprinted with the intent
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of ring) {
    minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
  }
  const pad = width + 0.1;
  const span = Math.max(maxX - minX, maxY - minY) + 2 * pad;
  const cell = Math.max(0.008, span / 400);
  const cols = Math.ceil((maxX - minX + 2 * pad) / cell) + 1;
  const rows = Math.ceil((maxY - minY + 2 * pad) / cell) + 1;
  const flat = {
    originX: minX - pad, originY: minY - pad,
    dx: cell, dy: cell, cols, rows,
    heights: new Float64Array(cols * rows),
  };
  const edge = { points: ring, closed: true };
  const surface = imprintChamfer(flat, edge, width, 45);
  const g = generateChamfer(edge, VEE, {
    width, angleDeg: 45, depthPerPass: 0.1, safeZ, surface, outsideZ: 0,
  });
  if (!g.moves.length) {
    return { error: `chamfer failed: ${g.warnings.join('; ') || 'no motion generated'}` };
  }
  return {
    op: {
      subName: 'chamfer rim',
      allowOverlap: true,
      tool: { name: '90° V-bit', diameter: VEE.diameter, kind: 'vee', angleDeg: 90 },
      cutter: { type: 'vee', includedAngle: 90 },
      feedRate, plungeRate: 30,
      moves: g.moves,
      target: g.target,
      warnings: g.warnings,
    },
  };
}

// Shared text→regions step for the text strategies. ctx caches by
// (font, text, letterHeight) so multiple ops over the same text agree
// exactly. Regions are unioned here so every consumer (medial axis,
// pocketing, previews) sees overlap-free geometry.
function textGeometry(ctx, text, letterHeight, fontId) {
  const key = `${fontId}|${letterHeight}|${text}`;
  if (!ctx._textCache) ctx._textCache = new Map();
  if (!ctx._textCache.has(key)) {
    const raw = textToContours(ctx.fonts[fontId], text, { letterHeight });
    const { regions, merged } = weldContours(raw.contours);
    ctx._textCache.set(key, { regions, merged, width: raw.width, height: raw.height });
  }
  return ctx._textCache.get(key);
}

// Lay out a text block for multi-element signs. A text block otherwise
// centers on the content machined so far — which stacks a sign's text
// right ON its glyph. `place` moves it RELATIVE to that content with no
// coordinates to compute: "below" drops the block a gap under everything
// so far, "above" lifts it a gap over. This makes pipeline order the
// vertical stack the model expects (glyph, then text below, then braille
// below). posX/posY remain an ABSOLUTE-center override for precise work.
// Builds fresh arrays: centeredText's result is cached, never mutated.
function placeTextBlock(ctx, { regions, bbox }, p) {
  const bc = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
  const half = (bbox.maxY - bbox.minY) / 2;
  const cb = ctx.contentBBox;
  let tx = bc.x, ty = bc.y;
  if (p.place === 'below' && cb) ty = cb.minY - p.gap - half;
  else if (p.place === 'above' && cb) ty = cb.maxY + p.gap + half;
  if (Number.isFinite(p.posX) && p.posX !== 0) tx = p.posX;
  if (Number.isFinite(p.posY) && p.posY !== 0) ty = p.posY;
  const dx = tx - bc.x, dy = ty - bc.y;
  if (!dx && !dy) return { regions, bbox };
  const mv = (ring) => ring.map(q => ({ x: q.x + dx, y: q.y + dy }));
  return {
    regions: regions.map(r => ({ outer: mv(r.outer), holes: r.holes.map(mv) })),
    bbox: { minX: bbox.minX + dx, minY: bbox.minY + dy, maxX: bbox.maxX + dx, maxY: bbox.maxY + dy },
  };
}

// Placement params shared by the text entries.
const TEXT_PLACE_PARAMS = {
  place: { type: 'string', default: 'center', doc: 'where the text sits RELATIVE to the content machined before it: "below" = a gap under it, "above" = a gap over it, "center" (default) = centered ON it (a monogram inside a pocket). For a stacked SIGN, set "below" on every element after the top one — no coordinates needed.' },
  gap: { type: 'number', default: 0.35, doc: 'spacing to the neighbouring element when place is "below"/"above", inches' },
  posX: { type: 'number', default: 0, doc: 'ABSOLUTE X of the block\'s center, inches (overrides place\'s X); 0/absent = leave to place' },
  posY: { type: 'number', default: 0, doc: 'ABSOLUTE Y of the block\'s center, inches (overrides place); 0/absent = leave to place' },
};

// One font param spec shared by the text entries; the doc is the model's
// entire knowledge of the shelf, so each id carries its blurb.
const FONT_PARAM = {
  type: 'string', default: DEFAULT_FONT, bindable: true,
  doc: `typeface id — ${FONTS.map(f => `"${f.id}" = ${f.blurb}`).join('; ')}. When the user may want to switch, bind it to a "choice" control whose options are these ids`,
};

export const CATALOG = {
  vcarve_text: {
    doc: 'V-carve text with a vee bit along the medial axis of real font outlines (classic engraved-sign look, variable-width strokes). Counters (the holes of e/o/p) are preserved. Adds flat-bottom clearing automatically where strokes are wider than the bit reaches.',
    params: {
      text: { type: 'string', doc: 'the text to engrave — bind to a text control so users can retype it', bindable: true },
      font: FONT_PARAM,
      letterHeight: { type: 'number', default: 1, min: 0.2, max: 4, doc: 'total text height in inches, descenders included', bindable: true },
      includedAngle: { type: 'number', default: 60, doc: 'vee bit included angle, degrees (30/60/90/120)' },
      maxDepth: { type: 'number', default: 0.2, doc: 'depth cap in inches; wider strokes bottom out here' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
      ...TEXT_PLACE_PARAMS,
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = placeTextBlock(ctx, centeredText(ctx, p.text, p.letterHeight, p.font), p);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      const vBit = { includedAngle: p.includedAngle, maxDepth: p.maxDepth };
      const machine = { feedRate: p.feedRate, plungeRate: 30, safeZ: ctx.safeZ, rpm: ctx.rpm };
      noteContent(ctx, regions.map(r => r.outer));
      const ma = computeMedialAxis(regions, {});
      clampMedialAxis(ma, regions);
      const moves = generateVEngraveToolpath(ma, vBit, machine);
      const halfAngle = (p.includedAngle / 2) * Math.PI / 180;
      const maxR = p.maxDepth * Math.tan(halfAngle);
      const pocketMoves = ma.branches.some(b => b.some(q => q.radius > maxR + 1e-9))
        ? generatePocketPasses(regions, vBit, machine, maxR * 0.8) : [];
      return {
        tool: { name: `${p.includedAngle}° V-bit`, diameter: 0.002 },  // point-tip model (see engraver notes)
        cutter: { type: 'vee', includedAngle: p.includedAngle },
        feedRate: p.feedRate, plungeRate: 30,
        moves: [...moves, ...pocketMoves],
        target: { type: 'region', rings: regions.flatMap(r => [ccw(r.outer), ...r.holes.map(cwr)]), depth: p.maxDepth },
        bbox,
        previewRegions: regions,
        // analytic ideal V-surface inputs for the 3D preview (see
        // vcarve-surface.mjs): render smooth groove walls instead of the
        // toolpath's scallops. Op-local frame, same as moves/regions.
        previewVee: { branches: ma.branches, regions, includedAngle: p.includedAngle, maxDepth: p.maxDepth },
      };
    },
  },

  outline_text: {
    doc: 'Trace the OUTLINES of text at a single shallow depth (stencil/outline look, constant-width line) instead of V-carving the body. Uses the same vee bit tip.',
    params: {
      text: { type: 'string', doc: 'the text to outline — bind to a text control', bindable: true },
      font: FONT_PARAM,
      letterHeight: { type: 'number', default: 1, min: 0.2, max: 4, doc: 'total text height in inches', bindable: true },
      depth: { type: 'number', default: 0.04, doc: 'single-pass outline depth in inches' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
      ...TEXT_PLACE_PARAMS,
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = placeTextBlock(ctx, centeredText(ctx, p.text, p.letterHeight, p.font), p);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      noteContent(ctx, regions.map(r => r.outer));
      const moves = [];
      const rings = regions.flatMap(r => [r.outer, ...r.holes]);
      for (const ring of rings) {
        moves.push({ type: 'rapid', x: ring[0].x, y: ring[0].y });
        moves.push({ type: 'linear', z: -p.depth });
        for (let i = 1; i <= ring.length; i++) {
          const q = ring[i % ring.length];
          moves.push({ type: 'linear', x: q.x, y: q.y });
        }
        moves.push({ type: 'rapid', z: ctx.safeZ });
      }
      return {
        tool: { name: '60° V-bit', diameter: 0.002 },
        cutter: { type: 'vee', includedAngle: 60 },
        feedRate: p.feedRate, plungeRate: 30,
        moves,
        // 'on' profile: the tip rides the boundary itself — depth is the check
        target: { type: 'profile', side: 'on', rings: rings.map(ccw), depth: p.depth },
        bbox,
        previewRegions: regions,
      };
    },
  },

  pocket_text: {
    doc: 'Pocket the text INTO the surface with a small endmill — flat-bottomed letterforms at constant depth, the look for paint-fill signs and inlays (vcarve_text is the variable-depth carved look instead). Counters preserved. Strokes narrower than the bit get a grazing slot-fit; genuinely too-narrow text fails with advice (bigger letters or a smaller bit). Optional REST cleanup: a second, smaller bit pockets only the corners the bulk bit could not reach (adds a toolchange).',
    params: {
      text: { type: 'string', doc: 'the text to pocket — bind to a text control', bindable: true },
      font: FONT_PARAM,
      letterHeight: { type: 'number', default: 1.5, min: 0.3, max: 6, doc: 'total text height in inches; pocketing wants larger letters than V-carving', bindable: true },
      depth: { type: 'number', default: 0.25, doc: 'pocket floor depth, inches' },
      toolDiameter: { type: 'number', default: 0.125, doc: 'bulk endmill diameter, inches; 0 = pick automatically from the standard drawer (1/4", 1/8", 1/16", 1/32") at the coverage knee, adding rest passes as they earn their toolchange (restDiameter is then ignored)' },
      restDiameter: { type: 'number', default: 0, doc: '0 = no rest pass; otherwise a smaller bit (e.g. 0.0625) that cleans just the corners' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      ...TEXT_PLACE_PARAMS,
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = placeTextBlock(ctx, centeredText(ctx, p.text, p.letterHeight, p.font), p);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      noteContent(ctx, regions.map(r => r.outer));
      const params = {
        stepoverPct: 40, totalDepth: p.depth, depthPerPass: 0.125,
        safeZ: ctx.safeZ, feedRate: p.feedRate, plungeRate: 30,
      };
      let chain, autoWarnings = [];
      if (p.toolDiameter === 0) {
        const auto = autoToolChain(regions, p.depth);
        if (auto.error) return { error: `"${p.text}" at ${p.letterHeight}" letters: ${auto.error}` };
        chain = auto.chain;
        autoWarnings = [auto.note];
      } else {
        chain = [{ d: p.toolDiameter, prev: null }];
        if (p.restDiameter > 0 && p.restDiameter < p.toolDiameter) {
          chain.push({ d: p.restDiameter, prev: p.toolDiameter });
        }
      }
      const ops = [];
      for (const { d, prev } of chain) {
        const acc = { moves: [], rings: [] };
        for (const region of regions) {
          const g = prev == null
            ? generatePocket(region, { diameter: d }, params)
            : generateRestPocket(region, prev, { diameter: d }, params);
          if (!g.moves.length) continue;
          if (acc.moves.length) acc.moves.push({ type: 'rapid', z: ctx.safeZ });
          acc.moves.push(...g.moves);
          if (g.target) acc.rings.push(...g.target.rings);
        }
        if (prev == null && !acc.moves.length) {
          return { error: `a ${d}" bit does not fit anywhere in "${p.text}" at ${p.letterHeight}" letters — try larger letters or a smaller bit` };
        }
        if (!acc.moves.length) continue;
        ops.push({
          subName: prev == null ? 'bulk' : `rest ${formatDiameter(d)}`,
          // rest recuts the cleared envelope at blob edges by design —
          // declared, so the footprint-overlap check stays armed for
          // everything that doesn't declare it
          allowOverlap: prev != null,
          tool: { name: `${formatDiameter(d)} endmill`, diameter: d },
          cutter: { type: 'flat', diameter: d },
          feedRate: p.feedRate, plungeRate: 30,
          moves: acc.moves,
          target: { type: 'region', rings: acc.rings, depth: p.depth },
          ...(prev == null ? { previewRegions: regions, warnings: autoWarnings } : {}),
        });
      }
      return { ops, bbox };
    },
  },

  pocket_shape: {
    doc: 'Pocket a SHAPE into the surface — a recess at constant depth (coaster wells, trays, inlay recesses). This is the verb for "a 2 inch round pocket"; pocket_text is only for letterforms. shape "circle" and "rectangle" are built in; shape "custom" pockets ANY outline you author as an SVG path in the path param (see shape_cutout for how to write one) — interior holes in the path survive as uncut islands. A referenced shape with SEVERAL pieces (a signage glyph\'s separate figures, a multi-part logo) pockets EVERY piece; pieces too small for the bit are skipped with a warning. This is also how EDGE PROFILES are cut: a RABBET/ledge/step along an edge of a later cutout is a custom pocket whose region is a band hugging that edge, overrunning it by ~0.05" so no sliver wall remains (set edgeTreatment true, and put this op BEFORE the cutout). With parametric {expressions} the band can share the cutout\'s controls — a rabbet on an arch\'s inside edge is the band from {r-t-0.05} to {r-t+rabbetW}, and it follows the radius/thickness sliders automatically. Centers itself on the content machined so far, or stands alone as the first operation. Optional REST cleanup with a smaller bit for tight corners.',
    params: {
      shape: { type: 'string', default: 'circle', doc: '"circle", "rectangle", "custom" (author the outline in the path param), or the id of a shapes-section entry (anchored in the shared frame)' },
      path: { type: 'string', default: '', template: true, doc: 'custom only: the outline as one SVG path "d" string — same authoring rules as shape_cutout.path, {arithmetic} of control ids included (set width and height 0 for parametric paths)' },
      diameter: { type: 'number', default: 2, doc: 'circle only: pocket diameter, inches', bindable: true },
      width: { type: 'number', default: 2, doc: 'rectangle/custom: pocket width, inches', bindable: true },
      height: { type: 'number', default: 0, doc: 'rectangle/custom: pocket height, inches; 0 = default (rectangle 1.5"; custom scales uniformly from width, keeping the shape\'s aspect)', bindable: true },
      cornerRadius: { type: 'number', default: 0.25, doc: 'rectangle only: corner radius, inches' },
      depth: { type: 'number', default: 0.125, doc: 'pocket floor depth, inches', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'bulk endmill diameter, inches; 0 = pick automatically from the standard drawer (1/4", 1/8", 1/16", 1/32") at the coverage knee, adding rest passes as they earn their toolchange (restDiameter is then ignored)' },
      restDiameter: { type: 'number', default: 0, doc: '0 = no rest pass; otherwise a smaller bit that cleans rectangle corners' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      edgeTreatment: { type: 'boolean', default: false, doc: 'true when this pocket is a RABBET/LEDGE along a later cutout\'s edge and deliberately overruns that edge a little — permits overlapping the cut-free kerf (otherwise cross-operation overlap is an error)' },
    },
    run(p, ctx) {
      const c = contentCenter(ctx);
      let regions;   // one or more pieces — every piece gets pocketed
      let shapeRoot = null;   // lineage: the base shape a reference derives from
      const shapeWarnings = [];
      if (p.shape === 'circle') {
        regions = [{ outer: circleRing(c.x, c.y, p.diameter / 2), holes: [] }];
      } else if (p.shape === 'rectangle') {
        const rh = p.height > 0 ? p.height : 1.5;
        regions = [{ outer: roundedRectRing(c.x - p.width / 2, c.y - rh / 2, c.x + p.width / 2, c.y + rh / 2, p.cornerRadius), holes: [] }];
      } else if (p.shape === 'custom') {
        const cs = customShapeRegion(p);
        if (cs.error) return cs;
        shapeWarnings.push(...cs.warnings);
        const shift = cs.anchored ? (ring => ring) : (ring => ring.map(q => ({ x: q.x + c.x, y: q.y + c.y })));
        regions = [{ outer: shift(cs.region.outer), holes: cs.region.holes.map(shift) }];
      } else if (ctx.shapes?.[p.shape]) {
        // a shapes-section reference: pocket EVERY piece — a multi-piece
        // shape (a signage glyph's separate figures, a multi-part logo)
        // is N recesses, not just the largest one. Anchored: references
        // stay in authored coordinates so ops sharing a frame (arch +
        // its rabbet) align by construction.
        const cs = namedShapeRegionsAll(ctx, p.shape, 'a pocket');
        if (cs.error) return cs;
        shapeRoot = ctx.shapes[p.shape].root;
        regions = cs.regions;
      } else {
        return { error: `pocket_shape: unknown shape "${p.shape}" (circle, rectangle, custom, or a defined shape id)` };
      }
      noteContent(ctx, regions.map(r => r.outer));
      const params = {
        stepoverPct: 40, totalDepth: p.depth, depthPerPass: 0.125,
        safeZ: ctx.safeZ, feedRate: p.feedRate, plungeRate: 30,
      };
      let chain, autoWarnings = [];
      if (p.toolDiameter === 0) {
        const auto = autoToolChain(regions, p.depth);
        if (auto.error) return { error: `that ${p.shape} pocket: ${auto.error}` };
        chain = auto.chain;
        autoWarnings = [auto.note];
      } else {
        chain = [{ d: p.toolDiameter, prev: null }];
        if (p.restDiameter > 0 && p.restDiameter < p.toolDiameter) {
          chain.push({ d: p.restDiameter, prev: p.toolDiameter });
        }
      }
      const bb = regions.flatMap(r => r.outer).reduce((a, q) => ({
        minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
        maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const ops = [];
      let cutPieces = 0;
      regions.forEach((region, ri) => {
        const piece = regions.length > 1 ? ` ${ri + 1}/${regions.length}` : '';
        let pieceCut = false;
        for (const { d, prev } of chain) {
          const g = prev == null
            ? generatePocket(region, { diameter: d }, params)
            : generateRestPocket(region, prev, { diameter: d }, params);
          if (prev == null && !g.moves.length) {
            if (regions.length === 1) {
              return; // fall through to the all-pieces error below
            }
            shapeWarnings.push(`piece ${ri + 1} of "${p.shape}" is too small for the ${formatDiameter(d)} bit — skipped`);
            break;
          }
          if (!g.moves.length) continue;
          pieceCut = true;
          // an edge treatment with KNOWN lineage gets a scoped allowance
          // (wired to the cutout of the same base shape by the runtime)
          // instead of the blanket flag — the verifier still catches it
          // overlapping anything unrelated
          ops.push({
            subName: (prev == null ? 'bulk' : `rest ${formatDiameter(d)}`) + piece,
            allowOverlap: prev != null || (p.edgeTreatment && !shapeRoot),
            edgeScopeRoot: p.edgeTreatment && shapeRoot ? shapeRoot : undefined,
            tool: { name: `${formatDiameter(d)} endmill`, diameter: d },
            cutter: { type: 'flat', diameter: d },
            feedRate: p.feedRate, plungeRate: 30,
            moves: g.moves,
            target: g.target ?? { type: 'region', rings: [ccw(region.outer), ...region.holes.map(cwr)], depth: p.depth },
            ...(prev == null ? { previewRegions: [region] } : {}),
          });
        }
        if (pieceCut) cutPieces++;
      });
      if (!ops.length) {
        return { error: `a ${chain[0].d}" bit does not fit that ${p.shape} pocket — enlarge it or use a smaller bit` };
      }
      ops[0] = { ...ops[0], warnings: [...shapeWarnings, ...autoWarnings] };
      return { ops, bbox: bb };
    },
  },

  dish_shape: {
    doc: 'Carve a smooth round DISH — a shallow spherical bowl that feathers to nothing at its rim (no wall, no flat floor): candy dishes, spoon rests, coaster wells that cradle a rounded glass. Use pocket_shape instead when the user wants a FLAT floor or a crisp wall. A ballnose bit rasters the surface with gouge-free compensation and the motion is checked against the declared 3D surface. Centers on the content machined so far, or stands alone. Depth must be modest relative to the diameter (a spherical cap, at most a hemisphere).',
    params: {
      diameter: { type: 'number', default: 2.5, min: 0.5, max: 8, doc: 'dish rim diameter, inches', bindable: true },
      depth: { type: 'number', default: 0.25, min: 0.05, max: 1, doc: 'dish depth at the center, inches', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'BALLNOSE bit diameter, inches — this strategy requires a ballnose' },
      stepoverPct: { type: 'number', default: 18, min: 5, max: 45, doc: 'stepover as a percentage of the bit diameter; smaller = smoother finish, longer cut' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const r = p.diameter / 2;
      if (p.depth >= r - 1e-9) {
        return { error: `a ${p.depth}" deep dish needs a diameter over ${(2 * p.depth).toFixed(2)}" (spherical cap, at most a hemisphere)` };
      }
      // sphere through the rim (z=0 at ρ=r) and the bottom (z=-depth at ρ=0)
      const Rs = (r * r + p.depth * p.depth) / (2 * p.depth);
      const R = p.toolDiameter / 2;
      const warnings = [];
      if (R > Rs) {
        warnings.push(`a ${p.toolDiameter}" ball is blunter than the dish's ${(2 * Rs).toFixed(2)}"-sphere bottom — the center will come out ball-shaped, not dish-shaped`);
      }
      const c = contentCenter(ctx);
      // heightmap: the intended dish surface, grid extending ≥ R past the rim
      const ext = r + R + 0.05;
      const cell = Math.max(0.008, (2 * ext) / 400);
      const cols = Math.ceil((2 * ext) / cell) + 1;
      const rows = cols;
      const heights = new Float64Array(cols * rows);
      const originX = c.x - ext, originY = c.y - ext;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const rho = Math.hypot(originX + col * cell - c.x, originY + row * cell - c.y);
          heights[row * cols + col] = rho >= r ? 0 : Math.min(0, (Rs - p.depth) - Math.sqrt(Rs * Rs - rho * rho));
        }
      }
      const heightmap = { heights, cols, rows, dx: cell, dy: cell, originX, originY };
      const maskRing = circleRing(c.x, c.y, r);
      const g = generateSurfaceRaster(heightmap, { diameter: p.toolDiameter }, {
        stepoverPct: p.stepoverPct, depthPerPass: 0.125, safeZ: ctx.safeZ,
        mask: { outer: maskRing, holes: [] }, outsideZ: 0,
      });
      if (!g.moves.length) {
        return { error: `dish produced no cutting moves — ${g.warnings[0] ?? 'surface at stock top everywhere'}` };
      }
      noteContent(ctx, [maskRing]);
      return {
        tool: { name: `${p.toolDiameter}" ballnose`, diameter: p.toolDiameter, kind: 'ball' },
        cutter: { type: 'ball', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: g.moves,
        warnings: [...warnings, ...g.warnings],
        target: g.target,
        bbox: { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r },
        previewRegions: [{ outer: maskRing, holes: [] }],
      };
    },
  },

  texture_field: {
    doc: 'Flood the area AROUND the content so far with a procedural relief TEXTURE — the "plaque with a name in the middle and a wavy texture around it" job. A ballnose rasters a shallow texture into the field and flows around the letters, leaving them raised and clean (a small clearance moat). Pick a family with "texture": waves (calm parallel ridges — the default "wavy"), ripples (concentric rings), interference (soft crossing waves), fluting (rounded reeds), basketweave (woven), woodgrain (faux-bois grain), crosshatch (incised lattice), hammered (peened dimples), flowing (marbled turbulence), slate (riven stone). THE LOOK HAS FOUR MORE LEVERS: angle rotates the pattern; origin re-drives the wave families (waves/ripples/fluting) — "content" makes the rings/ridges SPREAD FROM THE LETTERS themselves (the pond-drop plaque: ripples radiating from the name), "edge" makes them run parallel to the field boundary (a bordered, engine-turned read), "center" is radial from the field center; flow bends any wave family\'s ridges around the letters like water around a rock; fade calms the texture to a smooth pool right around the letters. By default it fills a rounded-rectangle field out to "buffer" past the content, so a following tag_cutout at the same buffer lands right on the texture edge — OR set "within" to a shapes-section id and the texture fills THAT shape instead (a textured border band: band-derive the tag outline and texture within it; a textured heart behind a name), clipped strictly inside it. Needs a prior op to surround unless "within" is set. The motion is checked against the declared 3D surface. Modest depth (a texture, not a pocket). Leave featureSize at 0 to use the family\'s tuned look; it is bit-aware — a feature finer than the ballnose can resolve is warned. Requires a BALLNOSE bit.',
    params: {
      texture: { type: 'string', default: 'waves', doc: `which family: ${TEXTURE_IDS.join(', ')}. Bind to a choice control to let the user switch textures.`, bindable: true },
      featureSize: { type: 'number', default: 0, min: 0, max: 3, doc: 'feature wavelength in inches; 0 = the family\'s tuned default. Larger = bigger, calmer features.', bindable: true },
      depth: { type: 'number', default: 0.06, min: 0.01, max: 0.25, doc: 'texture depth (peak-to-valley) in inches — keep it shallow', bindable: true },
      angle: { type: 'number', default: 0, min: -180, max: 180, doc: 'rotate the pattern this many degrees (waves at 30° etc.); radial looks ignore it', bindable: true },
      origin: { type: 'string', default: '', doc: 'wave families only (waves/ripples/fluting): "" = the family\'s native look, "content" = ridges/rings spread from the LETTERS (needs prior content), "edge" = ridges run parallel to the field boundary, "center" = radial from the field center' },
      flow: { type: 'number', default: 0, min: 0, max: 1, doc: 'wave families only: bend the ridges around the letters like streamlines around a rock (0 = straight through, 1 = full hug near the letters; needs prior content)', bindable: true },
      fade: { type: 'number', default: 0, min: 0, max: 3, doc: 'calm the texture to a smooth pool within this many inches of the letters (0 = full texture right up to the moat)', bindable: true },
      toolDiameter: { type: 'number', default: 0.125, doc: 'BALLNOSE bit diameter, inches — this strategy requires a ballnose' },
      stepoverPct: { type: 'number', default: 16, min: 5, max: 45, doc: 'stepover as a percentage of the bit diameter; smaller = smoother finish, longer cut' },
      buffer: { type: 'number', default: 0.35, doc: 'how far the textured field extends past the content, inches — match the tag_cutout buffer so the edges align (ignored when "within" is set)' },
      margin: { type: 'number', default: 0.05, doc: 'clear gap kept between the texture and the letters, inches' },
      within: { type: 'string', default: '', doc: 'a shapes-section id: texture strictly INSIDE that shape instead of the default rounded-rect field (prior content still gets its clearance moat)' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      seed: { type: 'number', default: 1, min: 1, max: 9999, doc: 'variation seed for the seeded families (hammered/flowing/slate); the others ignore it — bind to a slider for a "reseed" knob', bindable: true },
    },
    run(p, ctx) {
      const fam = TEXTURES[p.texture];
      if (!fam) return { error: `unknown texture "${p.texture}" — try one of: ${TEXTURE_IDS.join(', ')}` };
      if (p.origin && !['center', 'content', 'edge'].includes(p.origin)) {
        return { error: `unknown origin "${p.origin}" — use "center", "content", or "edge" (or leave it empty for the family's native look)` };
      }
      const F = p.featureSize > 0 ? p.featureSize : fam.defaultFeature;
      const R = p.toolDiameter / 2;
      const warnings = [];
      if (F < 2 * R) warnings.push(`feature size ${F.toFixed(3)}" is finer than a ${p.toolDiameter}" ballnose can resolve — the texture will cut muddy; use a smaller bit or a larger feature size`);

      // letters become clearance moats: offset outward by margin + ball radius
      // + guard so the ball NEVER reaches the carved letters (the tool center
      // stays out; padding by R keeps the overhang clear too). The GUARD is a
      // small geometry margin against grid-sampled boundaries — sub-cut, not a
      // loosened verifier.
      const guard = 0.03;
      const letterRings = ctx.contentRings ?? [];
      const moats = letterRings.length
        ? offsetRegions(letterRings.map((r) => ({ outer: r, holes: [] })), p.margin + R + guard)
        : [];

      // ---- the field: a rounded-rect plaque around the content (default),
      // or a named shape (within) — the texture then clips strictly inside it
      const b = ctx.contentBBox;
      let x0, y0, x1, y1, mask, edgeRings, clipRings = null, previewRegions;
      if (p.within) {
        const sh = namedShapeRegionsAll(ctx, p.within, 'texture_field');
        if (sh.error) return sh;
        const inset = offsetRegions(sh.regions, -guard);
        if (!inset.length) return { error: `shape "${p.within}" is too small to texture` };
        const carved = moats.length ? booleanRegions('difference', [inset, moats]) : { regions: inset };
        if (carved.error || !carved.regions.length) return { error: `nothing of shape "${p.within}" is left to texture once the content is cleared` };
        const rings = carved.regions.flatMap((rg) => [rg.outer, ...rg.holes]);
        mask = { outer: rings[0], holes: rings.slice(1) };   // even-odd: disjoint rings compose
        clipRings = sh.regions.flatMap((rg) => [rg.outer, ...rg.holes]);
        edgeRings = clipRings;
        previewRegions = carved.regions;
        x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
        for (const rg of sh.regions) for (const q of rg.outer) {
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
          if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
        }
      } else {
        if (!b) return { error: 'texture_field needs at least one prior operation (the name) to surround — or a "within" shape to fill' };
        x0 = b.minX - p.buffer; y0 = b.minY - p.buffer; x1 = b.maxX + p.buffer; y1 = b.maxY + p.buffer;
        const cornerR = Math.min(0.5, p.buffer * 1.2, (x1 - x0) / 2, (y1 - y0) / 2);
        const plaqueRing = roundedRectRing(x0 + guard, y0 + guard, x1 - guard, y1 - guard, Math.max(0.02, cornerR - guard));
        mask = { outer: plaqueRing, holes: moats.map((rg) => rg.outer) };
        edgeRings = [roundedRectRing(x0, y0, x1, y1, cornerR)];
        previewRegions = [{ outer: plaqueRing, holes: mask.holes }];
      }

      // heightmap lattice over the field bbox (+ ball reach); the distance
      // fields that drive origin/flow/fade live on the same lattice
      const ext = R + 0.05;
      const grid = textureGrid(x0, y0, x1, y1, ext);
      const { cols, rows, cell, ox, oy } = grid;
      const P = {
        F, seed: p.seed | 0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
        origin: p.origin, flow: Math.max(0, Math.min(1, p.flow)), fade: Math.max(0, p.fade),
      };
      if (((p.angle % 360) + 360) % 360 !== 0) {
        const a = (p.angle * Math.PI) / 180;
        P.rot = { c: Math.cos(a), s: Math.sin(a) };
      }
      if ((P.origin || P.flow > 0) && !fam.wave) {
        warnings.push(`"${p.texture}" is not a wave family — origin/flow shape the wave families (waves, ripples, fluting) and have no effect here`);
        P.origin = ''; P.flow = 0;
      }
      if ((P.origin === 'content' || P.flow > 0 || P.fade > 0) && !letterRings.length) {
        warnings.push('origin "content", flow, and fade measure from prior content — nothing machined yet, so they are ignored');
        if (P.origin === 'content') P.origin = 'center';
        P.flow = 0; P.fade = 0;
      }
      if (P.origin === 'content' || P.flow > 0 || P.fade > 0) {
        P.distContent = gridSampler(distanceGridForRings(letterRings, grid), grid);
      }
      if (P.origin === 'edge') {
        P.distEdge = gridSampler(distanceGridForRings(edgeRings, grid), grid);
      }

      const insideField = clipRings ? insideGridEvenOdd(clipRings, grid) : null;
      const heights = new Float64Array(cols * rows);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col;
          if (insideField && !insideField[i]) continue;   // outside the shape: uncut surface (z=0)
          const t = sampleTexture(fam, ox + col * cell, oy + row * cell, P);
          heights[i] = -(1 - t) * p.depth; // 1 = surface (z=0), 0 = -depth
        }
      }
      const heightmap = { heights, cols, rows, dx: cell, dy: cell, originX: ox, originY: oy };

      const g = generateSurfaceRaster(heightmap, { diameter: p.toolDiameter }, {
        stepoverPct: p.stepoverPct, depthPerPass: 0.125, safeZ: ctx.safeZ,
        mask, outsideZ: 0, feedRate: p.feedRate, plungeRate: 30,
      });
      if (!g.moves.length) {
        return { error: `texture produced no cutting moves — ${g.warnings[0] ?? 'nothing to cut in the field'}` };
      }
      // default field: do NOT grow contentBBox — report the content it
      // surrounds so a following tag_cutout at the same buffer aligns with
      // the texture edge. A within shape IS content: report its bbox so a
      // cutout wraps the textured shape.
      if (p.within) noteContent(ctx, edgeRings);
      const bbox = p.within
        ? { minX: x0, minY: y0, maxX: x1, maxY: y1 }
        : { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      return {
        tool: { name: `${p.toolDiameter}" ballnose`, diameter: p.toolDiameter, kind: 'ball' },
        cutter: { type: 'ball', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: g.moves,
        warnings: [...warnings, ...g.warnings],
        target: g.target,
        bbox,
        previewRegions,
      };
    },
  },

  texture_text: {
    doc: 'Render TEXT AS TEXTURE — the letters\' interiors carry a shallow procedural relief while the face around them stays untouched stock, so the name reads as a textured inlay in a smooth surface (the INVERSE of texture_field; pair them for full-face contrast). Counters (the holes of e/o/a) stay smooth. Same families as texture_field: waves, ripples, interference, fluting, basketweave, woodgrain, crosshatch, hammered, flowing, slate. A ballnose rasters strictly inside the letter outlines; the cut feathers up to the surface over about the ball\'s contact radius, giving a soft fabric-like edge — follow with outline_text at the SAME text/font/letterHeight for a crisp engraved border around each letter. origin "edge" runs the pattern parallel to each letter\'s own outline (concentric contour bands inside the strokes — the neon-tube look); "center" radiates across the whole word from its middle. Letters need meat: strokes narrower than the ball leave nothing to cut (friendly error) — use a large letterHeight, a bold font, and a SMALL ballnose (1/16" default). featureSize 0 auto-tunes to the letter size. Requires a BALLNOSE bit.',
    params: {
      text: { type: 'string', doc: 'the text to texture — bind to a text control so users can retype it', bindable: true },
      font: FONT_PARAM,
      letterHeight: { type: 'number', default: 2.5, min: 0.5, max: 8, doc: 'total text height in inches — texture needs room; below ~1.5" most families stop reading', bindable: true },
      texture: { type: 'string', default: 'waves', doc: `which family: ${TEXTURE_IDS.join(', ')}. Bind to a choice control to let the user switch textures.`, bindable: true },
      featureSize: { type: 'number', default: 0, min: 0, max: 3, doc: 'feature wavelength in inches; 0 auto-tunes to min(family default, letterHeight/4)', bindable: true },
      depth: { type: 'number', default: 0.05, min: 0.01, max: 0.2, doc: 'texture depth (peak-to-valley) in inches — keep it shallow', bindable: true },
      angle: { type: 'number', default: 0, min: -180, max: 180, doc: 'rotate the pattern this many degrees within the letters', bindable: true },
      origin: { type: 'string', default: '', doc: 'wave families only: "" = native, "edge" = pattern follows each letter\'s outline (contour bands), "center" = radial from the word\'s center' },
      toolDiameter: { type: 'number', default: 0.0625, doc: 'BALLNOSE bit diameter, inches — small: it must fit inside the letter strokes' },
      stepoverPct: { type: 'number', default: 16, min: 5, max: 45, doc: 'stepover as a percentage of the bit diameter; smaller = smoother finish, longer cut' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
      seed: { type: 'number', default: 1, min: 1, max: 9999, doc: 'variation seed for the seeded families (hammered/flowing/slate) — bind to a slider for a "reseed" knob', bindable: true },
      ...TEXT_PLACE_PARAMS,
    },
    run(p, ctx) {
      const fam = TEXTURES[p.texture];
      if (!fam) return { error: `unknown texture "${p.texture}" — try one of: ${TEXTURE_IDS.join(', ')}` };
      if (p.origin && !['center', 'edge'].includes(p.origin)) {
        return { error: `unknown origin "${p.origin}" — texture_text takes "center" or "edge" (or leave it empty)` };
      }
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = placeTextBlock(ctx, centeredText(ctx, p.text, p.letterHeight, p.font), p);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      const R = p.toolDiameter / 2;
      const F = p.featureSize > 0 ? p.featureSize : Math.min(fam.defaultFeature, p.letterHeight / 4);
      const warnings = [];
      if (F < 2 * R) warnings.push(`feature size ${F.toFixed(3)}" is finer than a ${p.toolDiameter}" ballnose can resolve — the texture will cut muddy; use a smaller bit or a larger feature size`);
      if ((p.origin) && !fam.wave) {
        warnings.push(`"${p.texture}" is not a wave family — origin shapes the wave families (waves, ripples, fluting) and has no effect here`);
        p = { ...p, origin: '' };
      }

      // strokes must admit the ball: if shrinking every letter by the ball
      // radius leaves nothing, no texture can fit inside
      if (!offsetRegions(regions, -R).length) {
        return { error: `the strokes of "${p.text}" at ${p.letterHeight}" are too thin for a ${p.toolDiameter}" ballnose to enter — use a larger letterHeight, a bolder font, or a smaller ballnose` };
      }

      // the heightmap carries the texture ONLY inside the letter outlines
      // (counters excluded); outside cells stay at the surface, so ballnose
      // compensation feathers the cut up to z=0 at each letter's edge — no
      // bleed past the outline by construction, and the mask keeps the tool
      // center inside the letters
      const allRings = regions.flatMap((r) => [r.outer, ...r.holes]);
      const mask = { outer: allRings[0], holes: allRings.slice(1) };   // even-odd: disjoint rings compose
      const ext = R + 0.05;
      const grid = textureGrid(bbox.minX, bbox.minY, bbox.maxX, bbox.maxY, ext);
      const { cols, rows, cell, ox, oy } = grid;
      const P = {
        F, seed: p.seed | 0,
        cx: (bbox.minX + bbox.maxX) / 2, cy: (bbox.minY + bbox.maxY) / 2,
        origin: p.origin, flow: 0, fade: 0,
      };
      if (((p.angle % 360) + 360) % 360 !== 0) {
        const a = (p.angle * Math.PI) / 180;
        P.rot = { c: Math.cos(a), s: Math.sin(a) };
      }
      if (P.origin === 'edge') P.distEdge = gridSampler(distanceGridForRings(allRings, grid), grid);
      const insideLetters = insideGridEvenOdd(allRings, grid);
      const heights = new Float64Array(cols * rows);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col;
          if (!insideLetters[i]) continue;   // outside the letters: uncut surface
          const t = sampleTexture(fam, ox + col * cell, oy + row * cell, P);
          heights[i] = -(1 - t) * p.depth;
        }
      }
      const heightmap = { heights, cols, rows, dx: cell, dy: cell, originX: ox, originY: oy };

      const g = generateSurfaceRaster(heightmap, { diameter: p.toolDiameter }, {
        stepoverPct: p.stepoverPct, depthPerPass: 0.125, safeZ: ctx.safeZ,
        mask, outsideZ: 0, feedRate: p.feedRate, plungeRate: 30,
      });
      if (!g.moves.length) {
        return { error: `no texture fits inside "${p.text}" — ${g.warnings[0] ?? 'the strokes are too thin or the depth too shallow'}; try a larger letterHeight or a smaller ballnose` };
      }
      noteContent(ctx, regions.map((r) => r.outer));
      return {
        tool: { name: `${p.toolDiameter}" ballnose`, diameter: p.toolDiameter, kind: 'ball' },
        cutter: { type: 'ball', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: g.moves,
        warnings: [...warnings, ...g.warnings],
        target: g.target,
        bbox,
        previewRegions: regions,
      };
    },
  },

  bore_hole: {
    doc: 'Drill round HOLES — a hang hole for a tag, mounting/screw holes, dowel holes, or a whole PATTERN of holes. Peck-plunges an endmill (plus one orbit per depth pass when the hole is larger than the bit) so each hole comes out the designed size; through the stock by default. Holes must be between 1× and 3× the bit diameter (a wider recess is pocket_shape\'s job). THREE ways to place: (1) position — relative to the content machined so far ("above" is the classic hang hole; "corners" places FOUR around it); (2) along — a shape id from the shapes section: "count" holes spaced EVENLY BY ARC LENGTH along it (an open curve runs end to end, endMargin inset; a closed shape\'s outline goes evenly around — bolt circles). "Five holes along the arch centerline" is a one-line open curve shape (the mid-radius arc) plus along: that id, count: 5 — the machine does the spacing math, and the pattern rides the same sliders as the shape; (3) at — EXPLICIT centers as semicolon-separated "x y" pairs in the working frame, {arithmetic} allowed, for irregular layouts. Holes must land INSIDE the part a later cutout frees (its fit check refuses strays).',
    params: {
      diameter: { type: 'number', default: 0.25, min: 0.05, max: 1, doc: 'finished hole diameter, inches', bindable: true },
      position: { type: 'string', default: 'above', doc: '"above", "below", "left", "right", or "center" of the content so far, or "corners" (4 holes around it); ignored when "along" or "at" is set' },
      along: { type: 'string', default: '', doc: 'a shape id to space holes along (open curve: end to end; closed shape: evenly around its outline)' },
      count: { type: 'number', default: 5, min: 1, max: 100, doc: 'along only: how many holes', bindable: true },
      endMargin: { type: 'number', default: 0, min: 0, doc: 'along an OPEN curve only: arc-length inset from each end, inches' },
      at: { type: 'string', default: '', template: true, doc: 'explicit hole centers: semicolon-separated "x y" pairs in the working frame, {arithmetic} of control ids allowed' },
      gap: { type: 'number', default: 0.125, min: 0, doc: 'clearance from the content edge to the hole edge, inches (ignored for center)', bindable: true },
      depth: { type: 'number', default: 0, doc: '0 = through the full stock thickness; otherwise hole depth in inches' },
      toolDiameter: { type: 'number', default: 0.125, doc: 'endmill diameter, inches' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const r = p.diameter / 2;
      if (p.diameter > 3 * p.toolDiameter + 1e-9) {
        return { error: `a ${p.diameter}" hole is more than 3× the ${p.toolDiameter}" bit — one bore orbit would leave a core standing; use a bigger bit, or pocket_shape for a wide recess` };
      }
      const b = ctx.contentBBox;
      const c = contentCenter(ctx);
      let centers;
      const alongWarnings = [];
      if (p.at?.trim() && p.along) {
        return { error: 'bore_hole: give either "at" (explicit centers) or "along" (spaced on a curve), not both' };
      }
      if (p.along) {
        const poly = namedShapePolyline(ctx, p.along);
        if (poly.error) return poly;
        alongWarnings.push(...poly.warnings);
        const n = Math.max(1, Math.round(p.count));
        const spaced = pointsAlong(poly, n, p.endMargin);
        if (spaced.error) return spaced;
        centers = spaced.points;
      } else if (p.at && p.at.trim()) {
        centers = [];
        for (const pair of p.at.split(';')) {
          if (!pair.trim()) continue;
          const nums = pair.trim().split(/[\s,]+/).map(parseFloat);
          if (nums.length !== 2 || nums.some(n => !Number.isFinite(n))) {
            return { error: `bore_hole: could not read hole center "${pair.trim()}" — each entry in "at" is one "x y" pair` };
          }
          centers.push({ x: nums[0], y: nums[1] });
        }
        if (!centers.length) return { error: 'bore_hole: "at" contains no hole centers' };
      } else if (p.position === 'center' || !b) {
        centers = [c];
      } else if (p.position === 'above') {
        centers = [{ x: c.x, y: b.maxY + p.gap + r }];
      } else if (p.position === 'below') {
        centers = [{ x: c.x, y: b.minY - p.gap - r }];
      } else if (p.position === 'left') {
        centers = [{ x: b.minX - p.gap - r, y: c.y }];
      } else if (p.position === 'right') {
        centers = [{ x: b.maxX + p.gap + r, y: c.y }];
      } else if (p.position === 'corners') {
        const o = p.gap + r;
        centers = [
          { x: b.minX - o, y: b.minY - o }, { x: b.maxX + o, y: b.minY - o },
          { x: b.maxX + o, y: b.maxY + o }, { x: b.minX - o, y: b.maxY + o },
        ];
      } else {
        return { error: `bore_hole: unknown position "${p.position}" (above, below, left, right, center, corners)` };
      }
      const depth = p.depth > 0 ? p.depth : ctx.stock.thickness;
      const moves = [];
      const rings = [];
      const warnings = [...alongWarnings];
      for (const q of centers) {
        const g = generateBore({ centerX: q.x, centerY: q.y, radius: r }, { diameter: p.toolDiameter }, {
          totalDepth: depth, depthPerPass: 0.125, safeZ: ctx.safeZ,
        });
        if (!g.moves.length) {
          return { error: `bore_hole: ${g.warnings[0] ?? 'nothing to cut'} — use a smaller bit or a bigger hole` };
        }
        moves.push(...g.moves);
        rings.push(...g.target.rings);
        warnings.push(...g.warnings);
      }
      noteContent(ctx, rings);
      const bbox = rings.flat().reduce((a, q) => ({
        minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
        maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      return {
        tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves, warnings,
        target: { type: 'region', rings, depth },
        bbox,
        previewHoles: centers.map(q => ({ x: q.x, y: q.y, r })),
      };
    },
  },

  disc_cutout: {
    doc: 'Cut out a ROUND part of an explicit diameter — coasters, discs, wheels — through the full stock thickness with an endmill (ramp entry, depth passes), centered on the content machined so far (or standing alone). Use this, not tag_cutout, when the user names a round part or gives its diameter. Everything machined so far must fit inside the disc. Holding tabs available, same behavior as tag_cutout; without tabs, hold with tape/onion skin.',
    params: {
      diameter: { type: 'number', default: 3, doc: 'the finished disc diameter, inches', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      tabs: { type: 'boolean', default: false, doc: 'leave triangular holding tabs on the final passes' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches' },
      tabSpacing: { type: 'number', default: 6, doc: 'target spacing between tabs, inches; at least 4 regardless' },
      chamfer: { type: 'number', default: 0, min: 0, max: 0.2, doc: '0 = square edge; otherwise ease the disc\'s top rim with a 45° chamfer this wide (inches), cut by a 90° V-bit before the part is freed (adds a toolchange)', bindable: true },
    },
    run(p, ctx) {
      const c = contentCenter(ctx);
      const R = p.diameter / 2;
      const reach = contentReach(ctx, c);
      if (reach > R + 1e-9) {
        return { error: `a ${p.diameter}" disc is too small for the content so far (needs ≥ ${(2 * reach).toFixed(2)}" diameter)` };
      }
      const ring = circleRing(c.x, c.y, R);
      const prof = generateProfile({ outer: ring }, { diameter: p.toolDiameter }, {
        side: 'outside', totalDepth: ctx.stock.thickness, depthPerPass: 0.25,
        safeZ: ctx.safeZ, entry: 'ramp',
        tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
      });
      const ops = [];
      if (p.chamfer > 0) {
        const ch = chamferRimOp(ring, p.chamfer, p.feedRate, ctx.safeZ);
        if (ch.error) return ch;
        ops.push(ch.op);
      }
      ops.push({
        subName: ops.length ? 'cut free' : undefined,
        tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        previewRing: ring,
        previewTabs: prof.tabs,
      });
      return {
        ops,
        bbox: {
          minX: c.x - R - p.toolDiameter / 2, minY: c.y - R - p.toolDiameter / 2,
          maxX: c.x + R + p.toolDiameter / 2, maxY: c.y + R + p.toolDiameter / 2,
        },
      };
    },
  },

  shape_cutout: {
    doc: 'Cut out a part with ANY outline — ellipse, star, heart, arch, hexagon, shield, arrow, cloud... — through the full stock thickness with an endmill (ramp entry, depth passes), centered on the content machined so far (or standing alone). Author the outline yourself as one SVG path "d" string in the path param: pick any convenient coordinate box (100×100 is fine) — it is scaled to width/height, centered, and flipped to shop coordinates automatically. An ellipse is two A arcs (M 0 50 A 50 30 0 1 1 100 50 A 50 30 0 1 1 0 50 Z); an n-pointed star is 2n straight lines alternating outer/inner radius points; hearts and leaves are a few C béziers. PARAMETRIC shapes — when a DIMENSION OF THE SHAPE ITSELF must be adjustable (an arch with radius and band-thickness sliders): write {arithmetic} of number-control ids inside the path, set width AND height to 0, and create the controls. The arch: path "M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {r-t} 0 A {r-t} {r-t} 0 0 0 {t-r} 0 Z" with controls r and t — every slider move re-evaluates, re-lowers, re-verifies. (A part dimension like that band thickness is a shape control — it is NOT the stock thickness.) Width/height 0 is ANCHORED mode: authored units are inches and authored coordinates are kept verbatim (y still flips), NOT auto-centered — so several parametric ops written in one frame align by construction (a rabbet band on the arch\'s inside edge shares the arch\'s own r and t), and prior content (which sits centered near the origin) must be enclosed by where YOU put the shape. Use absolute commands, close every subpath with Z, and keep the outline smooth — this edge gets cut by a round bit, so needle-thin spikes and slots narrower than the bit will not survive. Self-intersections weld under the nonzero fill rule (a pentagram becomes its solid star). Everything machined so far must fit INSIDE the shape — and when the content is the point (a name inside a heart), do NOT guess a width: reference a fit-derived shape (set_shape base outline centered on the origin, then fit {of, margin}) and the outline sizes itself around the content, like tag_cutout does. Use disc_cutout for circles and tag_cutout for rounded rectangles (they self-size; this one is explicit). Holding tabs and rim chamfer behave as on those entries.',
    params: {
      shape: { type: 'string', default: '', doc: 'PREFERRED: the id of a shapes-section entry to cut out (always anchored in the shared frame; width/height/path ignored)' },
      path: { type: 'string', default: '', template: true, doc: 'inline alternative to shape: the outline as one SVG path "d" string (any coordinate box; scaled to width/height); may contain {arithmetic} of control ids' },
      width: { type: 'number', default: 4, doc: 'inline path only: finished part width, inches; 0 = the path is already in inches (REQUIRED for parametric {…} paths — do not fight the shape controls with a second scale)', bindable: true },
      height: { type: 'number', default: 0, doc: 'inline path only: finished part height, inches; 0 = scale uniformly from width (aspect preserved), or true size if width is also 0', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      tabs: { type: 'boolean', default: false, doc: 'leave triangular holding tabs on the final passes' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches' },
      tabSpacing: { type: 'number', default: 6, doc: 'target spacing between tabs, inches; at least 4 regardless' },
      chamfer: { type: 'number', default: 0, min: 0, max: 0.2, doc: '0 = square edge; otherwise ease the part\'s top rim with a 45° chamfer this wide (inches), cut by a 90° V-bit before the part is freed (adds a toolchange)', bindable: true },
    },
    run(p, ctx) {
      let cs;
      if (p.shape) {
        cs = namedShapeRegion(ctx, p.shape, 'a cutout');
      } else if (p.path) {
        cs = customShapeRegion(p);
      } else {
        return { error: 'shape_cutout needs a shape reference (shape param) or an outline (path param)' };
      }
      if (cs.error) return cs;
      const warnings = [...cs.warnings];
      if (cs.region.holes.length) {
        warnings.push('interior holes in the shape are ignored for a cutout — add pocket/bore operations for interior features');
      }
      const c = contentCenter(ctx);
      const ring = cs.anchored
        ? cs.region.outer
        : cs.region.outer.map(q => ({ x: q.x + c.x, y: q.y + c.y }));
      const shapeRegion = { outer: ring, holes: [] };
      // content-fit: everything machined so far must sit INSIDE the shape.
      // Check the TRUE content outlines when entries recorded them (a star
      // pocket fits a star cutout even though its bounding BOX does not);
      // fall back to walking the bbox perimeter — perimeter, not just
      // corners, so a concavity (star waist) between corners is caught too.
      // The shape is expanded by a small grace first: edge treatments
      // (a rabbet pocket) deliberately overrun the future edge a little,
      // and that must not read as misplaced content.
      const EDGE_GRACE = 0.1;
      const graceRing = expandRing(ring, EDGE_GRACE) ?? ring;
      const graceRegion = { outer: graceRing, holes: [] };
      const sized = !p.shape && p.width > 0;
      const fitError = { error: `the content so far pokes outside that ${sized ? `${p.width}"-wide ` : ''}shape — enlarge ${sized ? 'width/height' : 'its controls'}, or reshape the outline` };
      if (ctx.contentRings?.length) {
        for (const cr of ctx.contentRings) {
          if (cr.some(q => !pointInPolygon(q.x, q.y, graceRegion))) return fitError;
        }
      } else if (ctx.contentBBox) {
        const b = ctx.contentBBox;
        const step = 0.05;
        const walk = [[b.maxX, b.minY], [b.maxX, b.maxY]];
        for (let x = b.minX; x <= b.maxX + 1e-9; x += step) { walk.push([x, b.minY], [x, b.maxY]); }
        for (let y = b.minY; y <= b.maxY + 1e-9; y += step) { walk.push([b.minX, y], [b.maxX, y]); }
        if (walk.some(([x, y]) => !pointInPolygon(x, y, graceRegion))) return fitError;
      }
      const prof = generateProfile(shapeRegion, { diameter: p.toolDiameter }, {
        side: 'outside', totalDepth: ctx.stock.thickness, depthPerPass: 0.25,
        safeZ: ctx.safeZ, entry: 'ramp',
        tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
      });
      const ops = [];
      if (p.chamfer > 0) {
        const ch = chamferRimOp(ring, p.chamfer, p.feedRate, ctx.safeZ);
        if (ch.error) return ch;
        ops.push(ch.op);
      }
      ops.push({
        subName: ops.length ? 'cut free' : undefined,
        tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        previewRing: ring,
        previewTabs: prof.tabs,
        warnings,
      });
      const bb = ring.reduce((a, q) => ({
        minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
        maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      // lineage: which base shape this cutout frees — edge treatments of
      // the same root get their overlap allowance scoped to THIS op
      if (p.shape) for (const o of ops) o.cutsRoot = ctx.shapes[p.shape].root;
      return {
        ops,
        bbox: {
          minX: bb.minX - p.toolDiameter / 2, minY: bb.minY - p.toolDiameter / 2,
          maxX: bb.maxX + p.toolDiameter / 2, maxY: bb.maxY + p.toolDiameter / 2,
        },
      };
    },
  },

  tag_cutout: {
    doc: 'Cut the work free as a rounded-corner rectangular tag: an outside profile around everything machined so far, with a buffer. (For a ROUND part with an explicit diameter, use disc_cutout instead.) Cuts through the full stock thickness with an endmill (ramp entry, depth passes). Holding tabs are available: triangular bridges that keep the piece attached to the sheet (snap out by hand, dress with a roundover) — placement is automatic with shop practice (a tab near each cardinal point, concave corners avoided). Without tabs, the part must be held with tape/onion skin.',
    params: {
      buffer: { type: 'number', default: 0.25, doc: 'clearance from the content bounding box to the tag edge, inches', bindable: true },
      cornerRadius: { type: 'number', default: 0.5, doc: 'tag corner radius, inches (clamped to fit)', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
      tabs: { type: 'boolean', default: false, doc: 'leave triangular holding tabs on the final passes' },
      tabHeight: { type: 'number', default: 0.08, doc: 'tab height above the cut bottom, inches (capped at half the stock thickness)' },
      tabSpacing: { type: 'number', default: 6, doc: 'target spacing between tabs along the profile, inches; at least 4 tabs regardless' },
      chamfer: { type: 'number', default: 0, min: 0, max: 0.2, doc: '0 = square edge; otherwise ease the tag\'s top rim with a 45° chamfer this wide (inches), cut by a 90° V-bit before the part is freed (adds a toolchange)', bindable: true },
    },
    run(p, ctx) {
      const b = ctx.contentBBox; // union of prior ops' bboxes
      if (!b) return { error: 'tag_cutout needs at least one prior operation to cut around' };
      const ring = roundedRectRing(b.minX - p.buffer, b.minY - p.buffer,
        b.maxX + p.buffer, b.maxY + p.buffer, p.cornerRadius);
      const prof = generateProfile({ outer: ring }, { diameter: p.toolDiameter }, {
        side: 'outside', totalDepth: ctx.stock.thickness, depthPerPass: 0.25,
        safeZ: ctx.safeZ, entry: 'ramp',
        tabs: p.tabs ? { height: p.tabHeight, spacing: p.tabSpacing } : null,
      });
      const ops = [];
      if (p.chamfer > 0) {
        const ch = chamferRimOp(ring, p.chamfer, p.feedRate, ctx.safeZ);
        if (ch.error) return ch;
        ops.push(ch.op);
      }
      ops.push({
        subName: ops.length ? 'cut free' : undefined,
        tool: { name: `${formatDiameter(p.toolDiameter)} endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        previewRing: ring,
        previewTabs: prof.tabs,
      });
      return {
        ops,
        bbox: {
          minX: b.minX - p.buffer - p.toolDiameter / 2, minY: b.minY - p.buffer - p.toolDiameter / 2,
          maxX: b.maxX + p.buffer + p.toolDiameter / 2, maxY: b.maxY + p.buffer + p.toolDiameter / 2,
        },
      };
    },
  },
};

// Merge guest entries (a sibling app mounted as catalog verbs) into the
// live catalog. Everything downstream — the grounding prompt, intent
// validation, the runtime — reads CATALOG, so registration at boot is
// all a guest needs. Never let a guest silently replace a native verb.
export function registerCatalogEntries(entries) {
  const added = [];
  for (const [key, e] of Object.entries(entries ?? {})) {
    if (CATALOG[key]) { console.warn(`guest entry "${key}" ignored: a catalog entry with that name exists`); continue; }
    if (!e || typeof e.run !== 'function' || typeof e.doc !== 'string' || !e.params) {
      console.warn(`guest entry "${key}" ignored: needs { doc, params, run }`);
      continue;
    }
    CATALOG[key] = e;
    added.push(key);
  }
  return added;
}

// Human/LLM-readable catalog documentation, assembled for the grounding prompt.
export function catalogDoc() {
  return Object.entries(CATALOG).map(([key, e]) => {
    const params = Object.entries(e.params).map(([k, s]) =>
      `    ${k} (${s.type}${s.default !== undefined ? `, default ${s.default}` : ''}${s.bindable ? ', bindable to a control' : ''}): ${s.doc}`
    ).join('\n');
    return `- ${key}: ${e.doc}\n${params}`;
  }).join('\n');
}
