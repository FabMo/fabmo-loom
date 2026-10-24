// The picture of the cut — a small grayscale PNG of what a weave will
// machine, rasterized from the lowered geometry (cutout rings, pocket
// regions, bores) so the model's second look can COMPARE its build with
// the picture the user attached. Pure JS, no canvas, no zlib: the PNG
// uses stored (uncompressed) deflate blocks, so it runs identically in
// the browser, in Node and in the guest-job worker. The verifier never
// sees this; it is an observation, computed by the app from the geometry
// that will actually be cut — never from the model's own description.

const SHADE = { board: 255, part: 205, pocket: 70, hole: 30, line: 110 };

// bbox of every ring in a list of fill groups
function bboxOf(groups) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of groups) for (const ring of g.rings) for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Scanline-fill ring groups into a grayscale buffer. Each group's rings
 * are filled together under the even-odd rule (holes stay unfilled), in
 * order, so later groups paint over earlier ones. Shop y-up becomes image
 * y-down. Returns { pixels: Uint8Array(w*h), w, h, scale, bbox }.
 */
export function rasterRings(groups, { w = 480, margin = 12 } = {}) {
  const bb = bboxOf(groups);
  if (!bb) return null;
  const bw = Math.max(bb.maxX - bb.minX, 1e-6), bh = Math.max(bb.maxY - bb.minY, 1e-6);
  const scale = (w - 2 * margin) / bw;
  const h = Math.max(16, Math.round(bh * scale) + 2 * margin);
  const pixels = new Uint8Array(w * h).fill(SHADE.board);
  const X = (x) => margin + (x - bb.minX) * scale;
  const Y = (y) => h - margin - (y - bb.minY) * scale;   // y-flip
  for (const g of groups) {
    const shade = SHADE[g.shade] ?? g.shade;
    const edges = [];
    for (const ring of g.rings) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const ax = X(a.x), ay = Y(a.y), bx = X(b.x), by = Y(b.y);
        if (ay === by) continue;
        edges.push(ay < by ? { x0: ax, y0: ay, x1: bx, y1: by } : { x0: bx, y0: by, x1: ax, y1: ay });
      }
    }
    for (let row = 0; row < h; row++) {
      const sy = row + 0.5;
      const xs = [];
      for (const e of edges) if (sy >= e.y0 && sy < e.y1) xs.push(e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0));
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.round(xs[k])), to = Math.min(w, Math.round(xs[k + 1]));
        for (let x = from; x < to; x++) pixels[row * w + x] = shade;
      }
    }
  }
  return { pixels, w, h, scale, bbox: bb };
}

// ---- PNG, grayscale 8-bit, stored deflate (no compression library) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function be32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function chunk(type, data) {
  const t = [...type].map(ch => ch.charCodeAt(0));
  const body = new Uint8Array(t.length + data.length);
  body.set(t, 0); body.set(data, t.length);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

/** Encode a grayscale pixel buffer as a PNG. Returns Uint8Array. */
export function encodePngGray(pixels, w, h) {
  // raw scanlines, filter byte 0 each
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
  // zlib stream of stored blocks
  const blocks = [];
  for (let off = 0; off < raw.length || off === 0; off += 65535) {
    const len = Math.min(65535, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    blocks.push(last, len & 255, len >>> 8, (~len) & 255, ((~len) >>> 8) & 255, ...raw.subarray(off, off + len));
    if (last) break;
  }
  const z = [0x78, 0x01, ...blocks, ...be32(adler32(raw))];
  const ihdr = [...be32(w), ...be32(h), 8, 0, 0, 0, 0];   // depth 8, color type 0 (gray)
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr), ...chunk('IDAT', z), ...chunk('IEND', [])];
  return Uint8Array.from(png);
}

export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// a bore as a 16-gon ring
const disc = (c, r) => Array.from({ length: 16 }, (_, i) => ({ x: c.x + r * Math.cos((i / 16) * 2 * Math.PI), y: c.y + r * Math.sin((i / 16) * 2 * Math.PI) }));

/**
 * The lowered geometry of a weave as fill groups: cutout outlines as the
 * part, pocket regions and V-carve areas dark, bores darker. Built
 * entries' preview* fields are the source — the same data the canvas
 * draws. Returns [] when nothing in the weave has a shape to show.
 */
export function weaveGroups(weaveResult) {
  const built = weaveResult?.preview?.built ?? [];
  const parts = [], marks = [], holes = [];
  for (const b of built) {
    const r = b?.r ?? {};
    if (Array.isArray(r.previewRing) && r.previewRing.length >= 3) parts.push(r.previewRing);
    for (const reg of r.previewRegions ?? []) {
      if (reg?.outer?.length >= 3) marks.push({ rings: [reg.outer, ...(reg.holes ?? [])], shade: 'pocket' });
    }
    // V-carve text/shape preview: { branches, regions } — the regions are
    // the carved letterform areas
    for (const reg of r.previewVee?.regions ?? []) {
      if (reg?.outer?.length >= 3) marks.push({ rings: [reg.outer, ...(reg.holes ?? [])], shade: 'pocket' });
    }
    for (const hh of r.previewHoles ?? []) {
      const c = hh?.x != null ? hh : hh?.center ?? hh?.at;
      const rad = hh?.r ?? (hh?.diameter ?? hh?.d ?? 0.25) / 2;
      if (c?.x != null) holes.push(disc(c, rad));
    }
  }
  const groups = [];
  if (parts.length) groups.push({ rings: parts, shade: 'part' });
  groups.push(...marks);
  if (holes.length) groups.push({ rings: holes, shade: 'hole' });
  return groups;
}

/**
 * The picture of the cut for a weave: { media_type, data (base64 PNG), w,
 * h, parts, marks } or null when the weave has nothing shaped to show.
 */
export function snapshotWeave(weaveResult, { w = 480 } = {}) {
  const groups = weaveGroups(weaveResult);
  if (!groups.length) return null;
  const ras = rasterRings(groups, { w });
  if (!ras) return null;
  const png = encodePngGray(ras.pixels, ras.w, ras.h);
  return {
    media_type: 'image/png', data: toBase64(png), w: ras.w, h: ras.h,
    parts: groups.filter(g => g.shade === 'part').reduce((n, g) => n + g.rings.length, 0),
    marks: groups.filter(g => g.shade !== 'part').length,
  };
}
