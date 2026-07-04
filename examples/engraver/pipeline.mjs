// The engraver pipeline: text → verified V-carve Job.
//
// Deterministic end to end. Every export goes through verifyJob; the app
// (or the test) only offers files the verifier accepted.
//
//   textToRegions       real font outlines → { outer, holes } regions
//   computeMedialAxis   v_engraver kernel — the skeleton of each glyph
//   generateVEngrave…   depth = local half-width / tan(halfAngle), clamped
//   generatePocketPasses flat-bottom clearing where strokes are wider than
//                        the bit reaches at maxDepth
//   composeJob → verifyJob → postJobToSbp / postJobToGcode
//
// Runs in Node (tests) and the browser (the app) unchanged.

import { textToRegions } from './text-to-regions.mjs';
import { computeMedialAxis } from '../../vendor/v_engraver/medial-axis.js';
import { generateVEngraveToolpath, generatePocketPasses } from '../../vendor/v_engraver/toolpath-gen.js';
import { generateProfile } from '../../strategies/profile.js';
import { composeJob, postJobToSbp, postJobToGcode } from '../../ir/job.js';
import { verifyJob } from '../../ir/verify.js';

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
};

export const DEFAULTS = {
  letterHeight: 1.0,           // inches, bbox height incl. descenders
  margin: 0.375,               // min clearance from text bbox to stock edge
  stock: { w: 8, h: 2.5, thickness: 0.5 },
  // tipDiameter is the verifier's model of the tool, not the bit's flute:
  // the medial-axis kernel drives a POINT tip (it cuts exactly into corner
  // apexes, where a physical tip flat overhangs the outline by half its
  // width — sub-visible, below the platform's 0.005" tolerance floor).
  // Declaring the point model keeps the profile-window check honest.
  vBit: { includedAngle: 60, maxDepth: 0.2, tipDiameter: 0.002 },
  machine: { feedRate: 60, plungeRate: 30, safeZ: 0.5, rpm: 14000 },
  // optional second op: cut the engraved text free as a rounded-corner tag
  cutout: {
    enabled: false,
    buffer: 0.25,          // tag edge clearance around the text bbox
    cornerRadius: 0.5,     // clamped to what the tag can geometrically carry
    tool: { diameter: 0.25 },
    feedRate: 80, plungeRate: 30,
    depthPerPass: 0.25,
    entry: 'ramp',
  },
};

// rounded rectangle, CCW, arcs tessellated — the tag outline
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

/**
 * @returns {{ ok, errors, warnings, report?, job?, sbp?, gcode?, preview }}
 *   errors before `report` exists are fit/layout errors (app-level);
 *   once a job composes, all judgment comes from the verifier.
 */
export function buildEngraveJob(fontBuffer, text, opts = {}) {
  const letterHeight = opts.letterHeight ?? DEFAULTS.letterHeight;
  const margin = opts.margin ?? DEFAULTS.margin;
  const stock = { ...DEFAULTS.stock, ...opts.stock };
  const vBit = { ...DEFAULTS.vBit, ...opts.vBit };
  const machine = { ...DEFAULTS.machine, ...opts.machine };
  const cutout = { ...DEFAULTS.cutout, ...opts.cutout, tool: { ...DEFAULTS.cutout.tool, ...opts.cutout?.tool } };

  const errors = [];
  if (!text || !text.trim()) return { ok: false, errors: ['nothing to engrave'], warnings: [], preview: null };
  if (vBit.maxDepth >= stock.thickness) {
    errors.push(`max cut depth ${vBit.maxDepth}" is not less than stock thickness ${stock.thickness}"`);
  }

  const { regions, width, height } = textToRegions(fontBuffer, text, { letterHeight });
  if (!regions.length) return { ok: false, errors: ['no engravable outlines in that text'], warnings: [], preview: null };

  // Fit: measured bbox + margins vs stock. The verifier will independently
  // check every motion against the stock envelope; this check exists to
  // give a human-sized message ("make the letters smaller") before motion
  // is ever generated. With the cutout on, the outermost motion is the
  // endmill center riding one tool radius outside the tag edge.
  const fringe = cutout.enabled ? cutout.buffer + cutout.tool.diameter / 2 : 0;
  const needW = width + 2 * (fringe + margin), needH = height + 2 * (fringe + margin);
  if (needW > stock.w + 1e-9 || needH > stock.h + 1e-9) {
    const via = cutout.enabled ? `text + ${cutout.buffer}" tag buffer + cutter + ${margin}" margins` : `text + ${margin}" margins`;
    errors.push(
      `"${text}" at ${letterHeight}" letters needs ${needW.toFixed(2)}" × ${needH.toFixed(2)}" ` +
      `(${via}) — stock is ${stock.w}" × ${stock.h}"`);
  }
  if (errors.length) return { ok: false, errors, warnings: [], preview: { regions, width, height } };

  // ---- motion (op-local coords; placement centers the text on stock) ----
  const medialAxis = computeMedialAxis(regions, {});
  const moves = generateVEngraveToolpath(medialAxis, vBit, machine);

  // Wide strokes: where the glyph is wider than the bit's flute at maxDepth
  // the V pass bottoms out; clear the remaining flat with raster passes.
  const halfAngle = (vBit.includedAngle / 2) * Math.PI / 180;
  const maxRadius = vBit.maxDepth * Math.tan(halfAngle);
  const needsPocket = medialAxis.branches.some(b => b.some(p => p.radius > maxRadius + 1e-9));
  let pocketMoves = [];
  if (needsPocket) {
    pocketMoves = generatePocketPasses(regions, vBit, machine, maxRadius * 0.8);
  }

  const placement = {
    x: (stock.w - width) / 2,
    y: (stock.h - height) / 2,
  };

  // The declaration: a region target — every cutting SAMPLE's tool center
  // must stay inside the letterforms (with the point-tip model the legal
  // region is the glyphs dilated by a sub-tolerance 0.001", so corner
  // apexes pass and anything genuinely outside is a gouge with
  // coordinates), and never below maxDepth. Per-sample containment is the
  // right check for a hairline tool: an area-based intrusion test would
  // erode a 0.002"-wide stray ribbon into nothing. The verifier's
  // nonzero-winding fill needs holes wound opposite the outers, or a
  // counter (the hole of e, o, p) wouldn't count as forbidden ground —
  // and "don't plow through the counters" is half the point.
  const ccw = ring => (ringArea(ring) > 0 ? ring : [...ring].reverse());
  const cw = ring => (ringArea(ring) < 0 ? ring : [...ring].reverse());
  const targetRings = regions.flatMap(r => [ccw(r.outer), ...r.holes.map(cw)]);

  const op = {
    name: `engrave "${text}"`,
    tool: 1,
    feedRate: machine.feedRate,
    plungeRate: machine.plungeRate,
    placement,
    moves: [...moves, ...pocketMoves],
    target: { type: 'region', rings: targetRings, depth: vBit.maxDepth },
  };

  // ---- optional op 2: cut the tag free (rounded-corner profile) ----
  // Same op-local frame as the engraving (text bbox at 0,0), same placement.
  // Through-cut is exactly −thickness: the verifier's depth gate is the
  // stock bottom, spoilboard allowance is a deliberate non-feature here —
  // hold the last skin with tape and a light sand.
  const operations = [op];
  const tools = { 1: { name: `${vBit.includedAngle}° V-bit`, diameter: vBit.tipDiameter } };
  let tagRing = null;
  if (cutout.enabled) {
    tagRing = roundedRectRing(-cutout.buffer, -cutout.buffer,
      width + cutout.buffer, height + cutout.buffer, cutout.cornerRadius);
    const prof = generateProfile({ outer: tagRing }, cutout.tool, {
      side: 'outside',
      totalDepth: stock.thickness,
      depthPerPass: cutout.depthPerPass,
      safeZ: machine.safeZ,
      entry: cutout.entry,
    });
    tools[2] = { name: `${cutout.tool.diameter}" endmill`, diameter: cutout.tool.diameter };
    operations.push({
      name: `cut out tag (${cutout.buffer}" buffer, r${cutout.cornerRadius}")`,
      tool: 2,
      feedRate: cutout.feedRate,
      plungeRate: cutout.plungeRate,
      placement,
      moves: prof.moves,
      // The declaration: an OUTSIDE profile — any swept area intruding the
      // tag body (which holds the fresh engraving) is an error with
      // measured area; depth capped at stock thickness.
      target: { type: 'profile', side: 'outside', rings: [tagRing], depth: stock.thickness },
    });
  }

  const job = {
    units: 'in',
    stock,
    safeZ: machine.safeZ,
    spindleSpeed: machine.rpm,
    tools,
    operations,
  };

  const composed = composeJob(job);
  // coverageWarnPct: coverage-residual is a QUALITY metric for area-clearing
  // ops; a medial-line engraving sweeps a hairline of its region by design,
  // so the threshold is parked at 100. Gouge and depth stay hard errors —
  // this opt cannot admit unsafe motion.
  const report = verifyJob(job, composed, { coverageWarnPct: 100 });
  const result = {
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    report, job, composed,
    preview: {
      regions, width, height, placement, medialAxis, moves: op.moves, pocketed: needsPocket,
      tagRing, cutoutMoves: cutout.enabled ? operations[1].moves : null,
    },
  };
  if (report.ok) {
    result.sbp = postJobToSbp(job, composed, { title: `Loom engraver — "${text}"` });
    result.gcode = postJobToGcode(job, composed, { title: `Loom engraver — "${text}"` });
  }
  return result;
}
