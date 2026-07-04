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

// Center text geometry on the content so far — a monogram added to a
// coaster lands with its VISUAL center (bbox center) on the pocket's
// center, not its bottom-left corner ("center the letter" means the
// letter's middle, to a human). Returns translated COPIES: the text
// cache stays in its own frame so repeat ops agree.
function centeredText(ctx, text, letterHeight) {
  const { regions, width, height } = textGeometry(ctx, text, letterHeight);
  const cc = contentCenter(ctx);
  const dx = cc.x - width / 2, dy = cc.y - height / 2;
  const shift = (ring) => ring.map(q => ({ x: q.x + dx, y: q.y + dy }));
  return {
    regions: regions.map(r => ({ outer: shift(r.outer), holes: r.holes.map(shift) })),
    width, height,
    bbox: { minX: dx, minY: dy, maxX: dx + width, maxY: dy + height },
  };
}

// Shared text→regions step for the text strategies. ctx caches by
// (text, letterHeight) so multiple ops over the same text agree exactly.
function textGeometry(ctx, text, letterHeight) {
  const key = `${letterHeight}|${text}`;
  if (!ctx._textCache) ctx._textCache = new Map();
  if (!ctx._textCache.has(key)) {
    ctx._textCache.set(key, textToRegions(ctx.fontBuffer, text, { letterHeight }));
  }
  return ctx._textCache.get(key);
}

export const CATALOG = {
  vcarve_text: {
    doc: 'V-carve text with a vee bit along the medial axis of real font outlines (classic engraved-sign look, variable-width strokes). Counters (the holes of e/o/p) are preserved. Adds flat-bottom clearing automatically where strokes are wider than the bit reaches.',
    params: {
      text: { type: 'string', doc: 'the text to engrave — bind to a text control so users can retype it', bindable: true },
      letterHeight: { type: 'number', default: 1, min: 0.2, max: 4, doc: 'total text height in inches, descenders included', bindable: true },
      includedAngle: { type: 'number', default: 60, doc: 'vee bit included angle, degrees (30/60/90/120)' },
      maxDepth: { type: 'number', default: 0.2, doc: 'depth cap in inches; wider strokes bottom out here' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const { regions, bbox } = centeredText(ctx, p.text, p.letterHeight);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      const vBit = { includedAngle: p.includedAngle, maxDepth: p.maxDepth };
      const machine = { feedRate: p.feedRate, plungeRate: 30, safeZ: ctx.safeZ, rpm: ctx.rpm };
      noteContent(ctx, regions.map(r => r.outer));
      const ma = computeMedialAxis(regions, {});
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
      letterHeight: { type: 'number', default: 1, min: 0.2, max: 4, doc: 'total text height in inches', bindable: true },
      depth: { type: 'number', default: 0.04, doc: 'single-pass outline depth in inches' },
      feedRate: { type: 'number', default: 60, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const { regions, bbox } = centeredText(ctx, p.text, p.letterHeight);
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
      letterHeight: { type: 'number', default: 1.5, min: 0.3, max: 6, doc: 'total text height in inches; pocketing wants larger letters than V-carving', bindable: true },
      depth: { type: 'number', default: 0.25, doc: 'pocket floor depth, inches' },
      toolDiameter: { type: 'number', default: 0.125, doc: 'bulk endmill diameter, inches' },
      restDiameter: { type: 'number', default: 0, doc: '0 = no rest pass; otherwise a smaller bit (e.g. 0.0625) that cleans just the corners' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const { regions, bbox } = centeredText(ctx, p.text, p.letterHeight);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      noteContent(ctx, regions.map(r => r.outer));
      const params = {
        stepoverPct: 40, totalDepth: p.depth, depthPerPass: 0.125,
        safeZ: ctx.safeZ, feedRate: p.feedRate, plungeRate: 30,
      };
      const bulk = { moves: [], rings: [] };
      for (const region of regions) {
        const g = generatePocket(region, { diameter: p.toolDiameter }, params);
        if (!g.moves.length) continue;
        if (bulk.moves.length) bulk.moves.push({ type: 'rapid', z: ctx.safeZ });
        bulk.moves.push(...g.moves);
        if (g.target) bulk.rings.push(...g.target.rings);
      }
      if (!bulk.moves.length) {
        return { error: `a ${p.toolDiameter}" bit does not fit anywhere in "${p.text}" at ${p.letterHeight}" letters — try larger letters or a smaller bit` };
      }
      const ops = [{
        subName: 'bulk',
        tool: { name: `${p.toolDiameter}" endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: bulk.moves,
        target: { type: 'region', rings: bulk.rings, depth: p.depth },
        previewRegions: regions,
      }];
      if (p.restDiameter > 0 && p.restDiameter < p.toolDiameter) {
        const rest = { moves: [], rings: [] };
        for (const region of regions) {
          const g = generateRestPocket(region, p.toolDiameter, { diameter: p.restDiameter }, params);
          if (!g.moves.length) continue;
          if (rest.moves.length) rest.moves.push({ type: 'rapid', z: ctx.safeZ });
          rest.moves.push(...g.moves);
          if (g.target) rest.rings.push(...g.target.rings);
        }
        if (rest.moves.length) {
          ops.push({
            subName: 'rest corners',
            // rest recuts the cleared envelope at blob edges by design —
            // declared, so the footprint-overlap check stays armed for
            // everything that doesn't declare it
            allowOverlap: true,
            tool: { name: `${p.restDiameter}" endmill`, diameter: p.restDiameter },
            cutter: { type: 'flat', diameter: p.restDiameter },
            feedRate: p.feedRate, plungeRate: 30,
            moves: rest.moves,
            target: { type: 'region', rings: rest.rings, depth: p.depth },
          });
        }
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
      toolDiameter: { type: 'number', default: 0.25, doc: 'bulk endmill diameter, inches' },
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
      const g = generatePocket(region, { diameter: p.toolDiameter }, params);
      if (!g.moves.length) {
        return { error: `a ${p.toolDiameter}" bit does not fit that ${p.shape} pocket — enlarge it or use a smaller bit` };
      }
      const bb = ring.reduce((a, q) => ({
        minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
        maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const ops = [{
        subName: 'bulk',
        tool: { name: `${p.toolDiameter}" endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: g.moves,
        target: g.target ?? { type: 'region', rings: [ring], depth: p.depth },
        previewRegions: [{ outer: ring, holes: [] }],
      }];
      if (p.restDiameter > 0 && p.restDiameter < p.toolDiameter) {
        const rg = generateRestPocket(region, p.toolDiameter, { diameter: p.restDiameter }, params);
        if (rg.moves.length) {
          ops.push({
            subName: 'rest corners',
            allowOverlap: true,
            tool: { name: `${p.restDiameter}" endmill`, diameter: p.restDiameter },
            feedRate: p.feedRate, plungeRate: 30,
            moves: rg.moves,
            target: rg.target ?? { type: 'region', rings: [ring], depth: p.depth },
          });
        }
      }
      return { ops, bbox: bb };
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
      return {
        tool: { name: `${p.toolDiameter}" endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        bbox: {
          minX: c.x - R - p.toolDiameter / 2, minY: c.y - R - p.toolDiameter / 2,
          maxX: c.x + R + p.toolDiameter / 2, maxY: c.y + R + p.toolDiameter / 2,
        },
        previewRing: ring,
        previewTabs: prof.tabs,
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
      return {
        tool: { name: `${p.toolDiameter}" endmill`, diameter: p.toolDiameter },
        cutter: { type: 'flat', diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        bbox: {
          minX: b.minX - p.buffer - p.toolDiameter / 2, minY: b.minY - p.buffer - p.toolDiameter / 2,
          maxX: b.maxX + p.buffer + p.toolDiameter / 2, maxY: b.maxY + p.buffer + p.toolDiameter / 2,
        },
        previewRing: ring,
        previewTabs: prof.tabs,
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
