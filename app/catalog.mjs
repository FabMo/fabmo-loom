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

import { textToRegions } from '../examples/engraver/text-to-regions.mjs';
import { computeMedialAxis } from '../vendor/v_engraver/medial-axis.js';
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

// Union overlapping glyph outlines into clean regions. Connected scripts
// (Pacifico) overlap BETWEEN letters and decorative faces overlap within
// them — the medial axis would double-carve every overlap. Disjoint text
// passes through geometrically unchanged (Clipper also normalizes ring
// orientation for free). textToRegions emits holes CCW like outers, so
// holes are reversed going in; everything comes back out CCW to keep the
// downstream convention.
const CLIP_SCALE = 1e6;
function unionTextRegions(regions) {
  if (!regions.length) return regions;
  const toClip = ring => ring.map(q => ({ X: Math.round(q.x * CLIP_SCALE), Y: Math.round(q.y * CLIP_SCALE) }));
  const fromClip = path => path.map(q => ({ x: q.X / CLIP_SCALE, y: q.Y / CLIP_SCALE }));
  const c = new ClipperLib.Clipper();
  for (const r of regions) {
    c.AddPath(toClip(r.outer), ClipperLib.PolyType.ptSubject, true);
    for (const h of r.holes) c.AddPath(toClip([...h].reverse()), ClipperLib.PolyType.ptSubject, true);
  }
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree);
  return ex
    .filter(e => e.outer?.length >= 3)
    .map(e => ({ outer: ccw(fromClip(e.outer)), holes: (e.holes ?? []).map(h => ccw(fromClip(h))) }));
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
    const raw = textToRegions(ctx.fonts[fontId], text, { letterHeight });
    const regions = unionTextRegions(raw.regions);
    // merged = glyphs actually fused (connected script): downstream can
    // spend extra care on the seams the fusion created
    ctx._textCache.set(key, { ...raw, regions, merged: regions.length !== raw.regions.length });
  }
  return ctx._textCache.get(key);
}

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
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox, merged } = centeredText(ctx, p.text, p.letterHeight, p.font);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      const vBit = { includedAngle: p.includedAngle, maxDepth: p.maxDepth };
      const machine = { feedRate: p.feedRate, plungeRate: 30, safeZ: ctx.safeZ, rpm: ctx.rpm };
      noteContent(ctx, regions.map(r => r.outer));
      // adaptive boundary sampling, but only for FUSED text: the medial
      // axis is a Voronoi approximation, and at the default density the
      // pinched seams a connected script's union creates (Pacifico)
      // starve for sites — vertices stray a few thou outside the outline
      // and the verifier rightly rejects the motion. Target ~0.015"
      // spacing there; disjoint letterforms keep the fast default.
      let samplingDensity;
      if (merged) {
        let perimeter = 0;
        for (const r of regions) {
          for (const ring of [r.outer, ...r.holes]) {
            for (let i = 0; i < ring.length; i++) {
              const j = (i + 1) % ring.length;
              perimeter += Math.hypot(ring[j].x - ring[i].x, ring[j].y - ring[i].y);
            }
          }
        }
        samplingDensity = Math.min(6000, Math.max(500, Math.round(perimeter / 0.015)));
      }
      const ma = computeMedialAxis(regions, samplingDensity ? { samplingDensity } : {});
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
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = centeredText(ctx, p.text, p.letterHeight, p.font);
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
    },
    run(p, ctx) {
      const fe = fontBufferOf(ctx, p.font);
      if (fe.error) return fe;
      const { regions, bbox } = centeredText(ctx, p.text, p.letterHeight, p.font);
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
    doc: 'Pocket a GEOMETRIC shape into the surface — a round or rounded-rectangle recess at constant depth (coaster wells, trays, dishes, inlay recesses). This is the verb for "a 2 inch round pocket"; pocket_text is only for letterforms. Centers itself on the content machined so far, or stands alone as the first operation. Optional REST cleanup with a smaller bit for rectangle corners (circles have none).',
    params: {
      shape: { type: 'string', default: 'circle', doc: '"circle" or "rectangle"' },
      diameter: { type: 'number', default: 2, doc: 'circle only: pocket diameter, inches', bindable: true },
      width: { type: 'number', default: 2, doc: 'rectangle only: pocket width, inches', bindable: true },
      height: { type: 'number', default: 1.5, doc: 'rectangle only: pocket height, inches', bindable: true },
      cornerRadius: { type: 'number', default: 0.25, doc: 'rectangle only: corner radius, inches' },
      depth: { type: 'number', default: 0.125, doc: 'pocket floor depth, inches', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'bulk endmill diameter, inches; 0 = pick automatically from the standard drawer (1/4", 1/8", 1/16", 1/32") at the coverage knee, adding rest passes as they earn their toolchange (restDiameter is then ignored)' },
      restDiameter: { type: 'number', default: 0, doc: '0 = no rest pass; otherwise a smaller bit that cleans rectangle corners' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const c = contentCenter(ctx);
      let ring;
      if (p.shape === 'circle') {
        ring = circleRing(c.x, c.y, p.diameter / 2);
      } else if (p.shape === 'rectangle') {
        ring = roundedRectRing(c.x - p.width / 2, c.y - p.height / 2, c.x + p.width / 2, c.y + p.height / 2, p.cornerRadius);
      } else {
        return { error: `pocket_shape: unknown shape "${p.shape}" (circle or rectangle)` };
      }
      noteContent(ctx, [ring]);
      const region = { outer: ring };
      const params = {
        stepoverPct: 40, totalDepth: p.depth, depthPerPass: 0.125,
        safeZ: ctx.safeZ, feedRate: p.feedRate, plungeRate: 30,
      };
      let chain, autoWarnings = [];
      if (p.toolDiameter === 0) {
        const auto = autoToolChain([region], p.depth);
        if (auto.error) return { error: `that ${p.shape} pocket: ${auto.error}` };
        chain = auto.chain;
        autoWarnings = [auto.note];
      } else {
        chain = [{ d: p.toolDiameter, prev: null }];
        if (p.restDiameter > 0 && p.restDiameter < p.toolDiameter) {
          chain.push({ d: p.restDiameter, prev: p.toolDiameter });
        }
      }
      const bb = ring.reduce((a, q) => ({
        minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
        maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const ops = [];
      for (const { d, prev } of chain) {
        const g = prev == null
          ? generatePocket(region, { diameter: d }, params)
          : generateRestPocket(region, prev, { diameter: d }, params);
        if (prev == null && !g.moves.length) {
          return { error: `a ${d}" bit does not fit that ${p.shape} pocket — enlarge it or use a smaller bit` };
        }
        if (!g.moves.length) continue;
        ops.push({
          subName: prev == null ? 'bulk' : `rest ${formatDiameter(d)}`,
          allowOverlap: prev != null,
          tool: { name: `${formatDiameter(d)} endmill`, diameter: d },
          cutter: { type: 'flat', diameter: d },
          feedRate: p.feedRate, plungeRate: 30,
          moves: g.moves,
          target: g.target ?? { type: 'region', rings: [ring], depth: p.depth },
          ...(prev == null ? { previewRegions: [{ outer: ring, holes: [] }], warnings: autoWarnings } : {}),
        });
      }
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

  bore_hole: {
    doc: 'Drill a round HOLE — a hang hole for a tag, mounting/screw holes, dowel holes. Peck-plunges an endmill (plus one orbit per depth pass when the hole is larger than the bit) so the hole comes out the designed size; through the stock by default. Holes must be between 1× and 3× the bit diameter (a wider recess is pocket_shape\'s job). Positions itself relative to the content machined so far: "above" is the classic hang hole over the text; "corners" places FOUR holes around the content (a later cutout will wrap them into the part\'s corners).',
    params: {
      diameter: { type: 'number', default: 0.25, min: 0.05, max: 1, doc: 'finished hole diameter, inches', bindable: true },
      position: { type: 'string', default: 'above', doc: '"above", "below", "left", "right", or "center" of the content so far, or "corners" (4 holes around it)' },
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
      if (p.position === 'center' || !b) {
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
      const warnings = [];
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

// Human/LLM-readable catalog documentation, assembled for the grounding prompt.
export function catalogDoc() {
  return Object.entries(CATALOG).map(([key, e]) => {
    const params = Object.entries(e.params).map(([k, s]) =>
      `    ${k} (${s.type}${s.default !== undefined ? `, default ${s.default}` : ''}${s.bindable ? ', bindable to a control' : ''}): ${s.doc}`
    ).join('\n');
    return `- ${key}: ${e.doc}\n${params}`;
  }).join('\n');
}
