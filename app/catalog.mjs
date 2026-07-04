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
      const { regions, width, height } = textGeometry(ctx, p.text, p.letterHeight);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
      const vBit = { includedAngle: p.includedAngle, maxDepth: p.maxDepth };
      const machine = { feedRate: p.feedRate, plungeRate: 30, safeZ: ctx.safeZ, rpm: ctx.rpm };
      const ma = computeMedialAxis(regions, {});
      const moves = generateVEngraveToolpath(ma, vBit, machine);
      const halfAngle = (p.includedAngle / 2) * Math.PI / 180;
      const maxR = p.maxDepth * Math.tan(halfAngle);
      const pocketMoves = ma.branches.some(b => b.some(q => q.radius > maxR + 1e-9))
        ? generatePocketPasses(regions, vBit, machine, maxR * 0.8) : [];
      return {
        tool: { name: `${p.includedAngle}° V-bit`, diameter: 0.002 },  // point-tip model (see engraver notes)
        feedRate: p.feedRate, plungeRate: 30,
        moves: [...moves, ...pocketMoves],
        target: { type: 'region', rings: regions.flatMap(r => [ccw(r.outer), ...r.holes.map(cwr)]), depth: p.maxDepth },
        bbox: { minX: 0, minY: 0, maxX: width, maxY: height },
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
      const { regions, width, height } = textGeometry(ctx, p.text, p.letterHeight);
      if (!regions.length) return { error: 'no engravable outlines in that text' };
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
        feedRate: p.feedRate, plungeRate: 30,
        moves,
        // 'on' profile: the tip rides the boundary itself — depth is the check
        target: { type: 'profile', side: 'on', rings: rings.map(ccw), depth: p.depth },
        bbox: { minX: 0, minY: 0, maxX: width, maxY: height },
        previewRegions: regions,
      };
    },
  },

  tag_cutout: {
    doc: 'Cut the work free as a rounded-corner tag: an outside profile around everything machined so far, with a buffer. Cuts through the full stock thickness with an endmill (ramp entry, depth passes). NOTE: no holding tabs yet — through-cut parts must be held with tape/onion skin; a request for tabs must be declined as a capability gap.',
    params: {
      buffer: { type: 'number', default: 0.25, doc: 'clearance from the content bounding box to the tag edge, inches', bindable: true },
      cornerRadius: { type: 'number', default: 0.5, doc: 'tag corner radius, inches (clamped to fit)', bindable: true },
      toolDiameter: { type: 'number', default: 0.25, doc: 'endmill diameter, inches' },
      feedRate: { type: 'number', default: 80, doc: 'inches per minute' },
    },
    run(p, ctx) {
      const b = ctx.contentBBox; // union of prior ops' bboxes
      if (!b) return { error: 'tag_cutout needs at least one prior operation to cut around' };
      const ring = roundedRectRing(b.minX - p.buffer, b.minY - p.buffer,
        b.maxX + p.buffer, b.maxY + p.buffer, p.cornerRadius);
      const prof = generateProfile({ outer: ring }, { diameter: p.toolDiameter }, {
        side: 'outside', totalDepth: ctx.stock.thickness, depthPerPass: 0.25,
        safeZ: ctx.safeZ, entry: 'ramp',
      });
      return {
        tool: { name: `${p.toolDiameter}" endmill`, diameter: p.toolDiameter },
        feedRate: p.feedRate, plungeRate: 30,
        moves: prof.moves,
        target: { type: 'profile', side: 'outside', rings: [ring], depth: ctx.stock.thickness },
        bbox: {
          minX: b.minX - p.buffer - p.toolDiameter / 2, minY: b.minY - p.buffer - p.toolDiameter / 2,
          maxX: b.maxX + p.buffer + p.toolDiameter / 2, maxY: b.maxY + p.buffer + p.toolDiameter / 2,
        },
        previewRing: ring,
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
