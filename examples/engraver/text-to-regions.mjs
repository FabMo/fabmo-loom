// Text → engraving regions, on real font outlines.
//
// opentype.js gives us the actual TrueType contours (no "single-line font"
// approximations); this module flattens them to polygon regions
// ({ outer, holes }) in inches, Y up, translated so the text's bounding box
// sits at (0,0). Counters — the enclosed holes of e, o, p, a — arrive as
// proper holes, which is what lets the medial-axis V-carve leave them
// standing instead of plowing through.
//
// Runs in Node and the browser (opentype.js ESM build is vendored).

import * as opentype from './vendor/opentype.min.mjs';

const CHORD_TOL = 0.003; // inches — bezier flattening tolerance-ish (per segment)

function flattenCommands(commands) {
  // opentype getPath yields canvas-convention coords (Y down). Collect raw
  // contours here; the caller flips Y once at the end.
  const contours = [];
  let cur = null;
  let last = { x: 0, y: 0 };
  const bezierSteps = (approxLen) =>
    Math.max(6, Math.min(48, Math.ceil(approxLen / CHORD_TOL / 4)));

  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (cur && cur.length > 2) contours.push(cur);
        cur = [{ x: c.x, y: c.y }];
        last = { x: c.x, y: c.y };
        break;
      case 'L':
        cur.push({ x: c.x, y: c.y });
        last = { x: c.x, y: c.y };
        break;
      case 'Q': {
        const approx = Math.hypot(c.x1 - last.x, c.y1 - last.y) + Math.hypot(c.x - c.x1, c.y - c.y1);
        const n = bezierSteps(approx);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          cur.push({
            x: u * u * last.x + 2 * u * t * c.x1 + t * t * c.x,
            y: u * u * last.y + 2 * u * t * c.y1 + t * t * c.y,
          });
        }
        last = { x: c.x, y: c.y };
        break;
      }
      case 'C': {
        const approx = Math.hypot(c.x1 - last.x, c.y1 - last.y) +
          Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2);
        const n = bezierSteps(approx);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          cur.push({
            x: u * u * u * last.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            y: u * u * u * last.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          });
        }
        last = { x: c.x, y: c.y };
        break;
      }
      case 'Z':
        if (cur && cur.length > 2) contours.push(cur);
        cur = null;
        break;
    }
  }
  if (cur && cur.length > 2) contours.push(cur);
  return contours;
}

const signedArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
};

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].y, yj = ring[j].y;
    if ((yi > y) !== (yj > y) &&
        x < ((ring[j].x - ring[i].x) * (y - yi)) / (yj - yi) + ring[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

const dedupe = (ring) => {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
  }
  const first = out[0], lastP = out[out.length - 1];
  if (out.length > 1 && Math.hypot(first.x - lastP.x, first.y - lastP.y) < 1e-6) out.pop();
  return out;
};

// Assemble the text path glyph by glyph, bypassing opentype's shaper —
// its GSUB lookup parser rejects tables some common fonts carry (DejaVu's
// lookup type 6 format 2, for one). Cost: no ligatures. For engraved tags,
// per-glyph outlines + kern pairs are the right trade.
function layoutCommands(font, text, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  const commands = [];
  let x = 0;
  let prev = null;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (prev) {
      try { x += font.getKerningValue(prev, glyph) * scale; } catch { /* no kern data */ }
    }
    commands.push(...glyph.getPath(x, 0, fontSize).commands);
    x += glyph.advanceWidth * scale;
    prev = glyph;
  }
  return commands;
}

/**
 * @param {ArrayBuffer} fontBuffer - a TTF/OTF file
 * @param {string} text
 * @param {Object} opts - { letterHeight } target height of the text bbox, inches
 * @returns {{ regions: [{outer, holes}], width, height, font }} bbox at (0,0)
 */
export function textToRegions(fontBuffer, text, { letterHeight = 1 } = {}) {
  const font = opentype.parse(fontBuffer);

  // Lay out once at a probe size, flatten, then scale the points so the
  // rendered bbox height equals letterHeight exactly (descenders included —
  // a tag must fit its stock, not its cap height).
  const PROBE = 100;
  let contours = flattenCommands(layoutCommands(font, text, PROBE)).map(dedupe).filter(r => r.length > 2);

  // Flip Y (canvas → CNC) — do it before containment so geometry is final.
  contours = contours.map(r => r.map(p => ({ x: p.x, y: -p.y })));
  contours = contours.filter(r => Math.abs(signedArea(r)) > 1e-6);

  let probeMinY = Infinity, probeMaxY = -Infinity;
  for (const r of contours) for (const p of r) {
    if (p.y < probeMinY) probeMinY = p.y;
    if (p.y > probeMaxY) probeMaxY = p.y;
  }
  const probeH = probeMaxY - probeMinY;
  if (!(probeH > 0)) return { regions: [], width: 0, height: 0, font };
  const s = letterHeight / probeH;
  contours = contours.map(r => r.map(p => ({ x: p.x * s, y: p.y * s })));

  // Containment depth by even-odd counting (winding-agnostic — fonts are
  // not reliable about contour direction). Even depth = outer, odd = hole
  // of its smallest containing outer.
  const meta = contours.map((ring, i) => ({ ring, i, area: Math.abs(signedArea(ring)) }));
  for (const m of meta) {
    m.depth = 0;
    m.parents = [];
    const p0 = m.ring[0];
    for (const other of meta) {
      if (other === m) continue;
      if (pointInRing(p0.x, p0.y, other.ring)) { m.depth++; m.parents.push(other); }
    }
  }

  const ccw = (ring) => (signedArea(ring) > 0 ? ring : [...ring].reverse());
  const regions = [];
  const regionByContour = new Map();
  for (const m of meta.filter(m => m.depth % 2 === 0)) {
    const region = { outer: ccw(m.ring), holes: [] };
    regionByContour.set(m, region);
    regions.push(region);
  }
  for (const m of meta.filter(m => m.depth % 2 === 1)) {
    const outers = m.parents.filter(p => p.depth % 2 === 0);
    outers.sort((a, b) => a.area - b.area);
    const parent = regionByContour.get(outers[0]);
    if (parent) parent.holes.push(ccw(m.ring));
  }

  // Translate the whole set so the bbox min corner is (0,0).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    for (const ring of [r.outer, ...r.holes]) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  const shift = (ring) => ring.forEach(p => { p.x -= minX; p.y -= minY; });
  for (const r of regions) { shift(r.outer); r.holes.forEach(shift); }

  return { regions, width: maxX - minX, height: maxY - minY, font };
}
