// Uploaded SVG FILES lowered to regions — the "cut out my logo" source.
// shape.mjs speaks one path "d" string (what the model authors); this
// module speaks whole FILES (what a user exports from Inkscape or
// Illustrator): an XML tree, <g> transform stacks, shape elements
// (rect/circle/ellipse/polygon/polyline/path), per-element fill rules.
// Everything funnels into the same flatten→transform→weld machinery, so
// an uploaded file and an authored path are indistinguishable downstream.
//
// Scope is the FILLED ARTWORK: the silhouette a cutter can actually
// follow. Strokes, text, raster <image>s, and <use> clones are skipped
// with honest warnings — line-art engraving is its own future strategy,
// not a degraded cutout.
//
// DOM-free by construction (hand-rolled XML scan), so the gauntlet runs
// it in Node exactly as the browser does.

import { parseSvgSubpaths, weldContours, booleanRegions } from './shape.mjs';

// ------------------------------------------------------------- XML scan
//
// A minimal, tolerant scanner for the SVG subset: elements, attributes,
// comments/CDATA/DOCTYPE/PIs skipped. Text content is ignored (geometry
// lives in attributes). Returns the root element or throws.

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) throw new Error('unterminated CDATA');
      i = end + 3;
    } else if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal [subset]
      let j = i + 2, depth = 0;
      for (; j < n; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) throw new Error('unterminated processing instruction');
      i = end + 2;
    } else if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      if (end < 0) throw new Error('unterminated closing tag');
      if (stack.length > 1) stack.pop();
      i = end + 1;
    } else {
      // opening tag: scan to its '>' respecting quoted attribute values
      let j = i + 1, quote = null;
      for (; j < n; j++) {
        const ch = text[j];
        if (quote) { if (ch === quote) quote = null; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      if (j >= n) throw new Error('unterminated tag');
      let inner = text.slice(i + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([A-Za-z_][\w:.-]*)/.exec(inner);
      if (!m) throw new Error(`malformed tag near "${text.slice(i, i + 30)}"`);
      const attrs = {};
      const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let am;
      while ((am = attrRe.exec(inner.slice(m[1].length))) !== null) {
        attrs[am[1]] = decodeEntities(am[2] ?? am[3] ?? '');
      }
      // namespace prefixes (svg:path) collapse to the local name
      const el = { tag: m[1].split(':').pop().toLowerCase(), attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  return root;
}

// ------------------------------------------------------ transform stack
//
// 2×3 affine matrices [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f.

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, k) => [
  m[0] * k[0] + m[2] * k[1],
  m[1] * k[0] + m[3] * k[1],
  m[0] * k[2] + m[2] * k[3],
  m[1] * k[2] + m[3] * k[3],
  m[0] * k[4] + m[2] * k[5] + m[4],
  m[1] * k[4] + m[3] * k[5] + m[5],
];
const applyM = (m, q) => ({ x: m[0] * q.x + m[2] * q.y + m[4], y: m[1] * q.x + m[3] * q.y + m[5] });

export function parseTransform(str) {
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str ?? '')) !== null) {
    const a = t[2].trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
    if (a.some(v => !Number.isFinite(v))) throw new Error(`bad transform "${t[0]}"`);
    const rad = (a[0] ?? 0) * Math.PI / 180;
    switch (t[1]) {
      case 'matrix': if (a.length !== 6) throw new Error(`matrix() needs 6 numbers`); m = mul(m, a); break;
      case 'translate': m = mul(m, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]); break;
      case 'scale': m = mul(m, [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]); break;
      case 'rotate': {
        const c = Math.cos(rad), s = Math.sin(rad);
        if (a.length >= 3) m = mul(m, [1, 0, 0, 1, a[1], a[2]]);
        m = mul(m, [c, s, -s, c, 0, 0]);
        if (a.length >= 3) m = mul(m, [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': m = mul(m, [1, 0, Math.tan(rad), 1, 0, 0]); break;
      case 'skewY': m = mul(m, [1, Math.tan(rad), 0, 1, 0, 0]); break;
    }
  }
  return m;
}

// -------------------------------------------------------- element walk

const SKIP_SILENT = new Set(['defs', 'symbol', 'marker', 'pattern', 'clippath', 'mask', 'metadata', 'title', 'desc', 'style', 'script', 'filter', 'lineargradient', 'radialgradient']);

// presentation properties: inline style beats the attribute; both beat
// what was inherited from the parent
function styleProps(el, inherited) {
  const out = { ...inherited };
  for (const k of ['fill', 'fill-rule', 'fill-opacity', 'opacity', 'display', 'visibility']) {
    if (el.attrs[k] !== undefined) out[k] = el.attrs[k].trim();
  }
  // opacity and display are NOT inherited properties, but a zero/none on
  // any ancestor hides the subtree, which is all we use them for — so
  // folding them down the walk gives the right visibility answer
  for (const part of (el.attrs.style ?? '').split(';')) {
    const c = part.indexOf(':');
    if (c > 0) {
      const k = part.slice(0, c).trim().toLowerCase();
      const v = part.slice(c + 1).trim();
      if (['fill', 'fill-rule', 'fill-opacity', 'opacity', 'display', 'visibility'].includes(k)) out[k] = v;
    }
  }
  return out;
}

const num = (el, name, dflt = 0) => {
  const v = parseFloat(el.attrs[name]);
  return Number.isFinite(v) ? v : dflt;
};

const RING_SEGS = 96;  // full turn — matches the catalog's circleRing density
const ellipseRing = (cx, cy, rx, ry) =>
  Array.from({ length: RING_SEGS }, (_, k) => {
    const a = (2 * Math.PI * k) / RING_SEGS;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });

function rectContour(el) {
  const x = num(el, 'x'), y = num(el, 'y');
  const w = num(el, 'width'), h = num(el, 'height');
  if (w <= 0 || h <= 0) return null;
  let rx = parseFloat(el.attrs.rx), ry = parseFloat(el.attrs.ry);
  if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
  if (!Number.isFinite(ry)) ry = rx;
  rx = Math.min(Math.max(0, rx), w / 2);
  ry = Math.min(Math.max(0, ry), h / 2);
  if (rx < 1e-9 || ry < 1e-9) {
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let k = 0; k <= 24; k++) {
      const a = a0 + (Math.PI / 2) * (k / 24);
      pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
  };
  corner(x + w - rx, y + ry, -Math.PI / 2);
  corner(x + w - rx, y + h - ry, 0);
  corner(x + rx, y + h - ry, Math.PI / 2);
  corner(x + rx, y + ry, Math.PI);
  return pts;
}

function pointsAttr(el) {
  const raw = (el.attrs.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
  const pts = [];
  for (let k = 0; k + 1 < raw.length; k += 2) {
    if (Number.isFinite(raw[k]) && Number.isFinite(raw[k + 1])) pts.push({ x: raw[k], y: raw[k + 1] });
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * Lower a whole SVG file to welded regions in the file's own user units
 * (y-down, as authored). Fills only — see module header for what is
 * skipped and warned about.
 * @returns {{regions, warnings, unitsPerInch?} | {error}}
 */
export function svgToRegions(svgText) {
  let doc;
  try {
    doc = parseXml(String(svgText));
  } catch (e) {
    return { error: `could not read that SVG file: ${e.message}` };
  }
  const svg = (function find(el) {
    if (el.tag === 'svg') return el;
    for (const c of el.children) { const f = find(c); if (f) return f; }
    return null;
  })(doc);
  if (!svg) return { error: 'that file has no <svg> element' };

  const skipped = { stroke: 0, text: 0, image: 0, use: 0 };
  const elementSets = [];   // welded regions per drawable element, paint order

  const walk = (el, matrix, inherited) => {
    const props = styleProps(el, inherited);
    if (props.display === 'none' || props.visibility === 'hidden') return;
    if (parseFloat(props.opacity ?? 1) === 0) return;
    let m = matrix;
    if (el.attrs.transform) {
      try { m = mul(matrix, parseTransform(el.attrs.transform)); }
      catch { return; }   // an unreadable transform hides that subtree, like a renderer would
    }
    if (SKIP_SILENT.has(el.tag)) return;
    if (el.tag === 'text') { skipped.text++; return; }
    if (el.tag === 'image') { skipped.image++; return; }
    if (el.tag === 'use') { skipped.use++; return; }

    let contours = null;
    switch (el.tag) {
      case 'path': {
        if (!el.attrs.d) break;
        try {
          contours = parseSvgSubpaths(el.attrs.d).filter(s => s.points.length >= 3).map(s => s.points);
        } catch { contours = null; }
        break;
      }
      case 'rect': { const r = rectContour(el); contours = r ? [r] : null; break; }
      case 'circle': {
        const r = num(el, 'r');
        contours = r > 0 ? [ellipseRing(num(el, 'cx'), num(el, 'cy'), r, r)] : null;
        break;
      }
      case 'ellipse': {
        const rx = num(el, 'rx'), ry = num(el, 'ry');
        contours = rx > 0 && ry > 0 ? [ellipseRing(num(el, 'cx'), num(el, 'cy'), rx, ry)] : null;
        break;
      }
      case 'polygon': case 'polyline': { const p = pointsAttr(el); contours = p ? [p] : null; break; }
      // <line> can only ever be stroked — never filled geometry
      case 'line': skipped.stroke++; break;
    }

    if (contours && contours.length) {
      const fill = (props.fill ?? 'black').toLowerCase();
      if (fill === 'none' || parseFloat(props['fill-opacity'] ?? 1) === 0) {
        skipped.stroke++;
      } else {
        const placed = contours.map(ring => ring.map(q => applyM(m, q)));
        const rule = (props['fill-rule'] ?? 'nonzero').toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
        const { regions } = weldContours(placed, rule);
        if (regions.length) elementSets.push(regions);
      }
    }
    for (const c of el.children) walk(c, m, props);
  };
  for (const c of svg.children) walk(c, IDENT, {});

  const warnings = [];
  if (skipped.stroke) warnings.push(`${skipped.stroke} unfilled (stroke-only) element${skipped.stroke > 1 ? 's' : ''} skipped — only the filled artwork becomes shape geometry`);
  if (skipped.text) warnings.push(`${skipped.text} <text> element${skipped.text > 1 ? 's' : ''} skipped — convert text to paths/outlines in your SVG editor first`);
  if (skipped.image) warnings.push(`${skipped.image} embedded raster image${skipped.image > 1 ? 's' : ''} skipped — image carving is not in the catalog yet`);
  if (skipped.use) warnings.push(`${skipped.use} <use> reference${skipped.use > 1 ? 's' : ''} skipped — expand/flatten clones in your SVG editor first`);
  if (!elementSets.length) {
    return { error: `no filled geometry found in that SVG${warnings.length ? ` (${warnings.join('; ')})` : ''}` };
  }
  const out = elementSets.length === 1 ? { regions: elementSets[0] } : booleanRegions('union', elementSets);
  if (out.error || !out.regions.length) return { error: 'that SVG\'s filled geometry unions to nothing solid' };

  // declared physical size → inches per user unit (true-size uploads).
  // Needs BOTH a physical width and a viewBox to relate units to inches.
  const result = { regions: out.regions, warnings };
  const phys = /^\s*([\d.]+)\s*(in|mm|cm|pt|pc)\s*$/.exec(svg.attrs.width ?? '');
  const vb = (svg.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(parseFloat);
  if (phys && vb.length === 4 && vb[2] > 0) {
    const PER_INCH = { in: 1, mm: 25.4, cm: 2.54, pt: 72, pc: 6 };
    result.unitsPerInch = vb[2] / (parseFloat(phys[1]) / PER_INCH[phys[2]]);
  }
  return result;
}

// ------------------------------------------------- shop-frame placement

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return a / 2;
};
const ccw = (ring) => (ringArea(ring) > 0 ? ring : [...ring].reverse());

/**
 * Lower an uploaded SVG file to shop-frame regions: inches, centered on
 * the origin, y-up (mirrors pathToRegions for authored paths).
 * @param {{width?:number, height?:number}} size  target size in inches.
 *   width only → uniform (aspect kept); both → stretched. NEITHER →
 *   the file's declared physical size when it has one, else 3" wide
 *   with a warning to set a size.
 * @returns {{regions, w, h, warnings} | {error}}
 */
export function svgAssetToRegions(svgText, { width = 0, height = 0 } = {}) {
  const src = svgToRegions(svgText);
  if (src.error) return src;
  const warnings = [...src.warnings];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of src.regions) {
    for (const ring of [r.outer, ...r.holes]) {
      for (const q of ring) {
        if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
      }
    }
  }
  const bw = maxX - minX, bh = maxY - minY;
  if (bw < 1e-9 || bh < 1e-9) return { error: 'that SVG\'s artwork is degenerate (zero width or height)' };
  let sx, sy;
  if (width > 0 && height > 0) { sx = width / bw; sy = height / bh; }
  else if (width > 0) { sx = sy = width / bw; }
  else if (height > 0) { sx = sy = height / bh; }
  else if (src.unitsPerInch) { sx = sy = 1 / src.unitsPerInch; }
  else {
    sx = sy = 3 / bw;
    warnings.push(`no size given and the file declares none — scaled to 3" wide; set a width to size it`);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const place = ring => ccw(ring.map(q => ({ x: (q.x - cx) * sx, y: (cy - q.y) * sy })));
  const regions = src.regions.map(r => ({ outer: place(r.outer), holes: r.holes.map(place) }));
  return { regions, w: bw * sx, h: bh * sy, warnings };
}
