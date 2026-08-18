// The single-LINE font shelf — stroke fonts for line_text, where each
// letter is a pen path the bit tip traces once (no outline, no fill).
// Deliberately a separate shelf from fonts.mjs: an outline font has no
// centerline to trace, and a stroke font has no region to pocket or
// V-carve, so the two families are not interchangeable and each text
// entry names the shelf it draws from. Data is vendored (no fetch, no
// buffers): pure module import works in the browser, the weave worker,
// and node tests alike.
import { HERSHEY } from './fonts/hershey-line-fonts.mjs';

export const LINE_FONTS = [
  {
    id: 'line-sans',
    label: 'Line Sans (Hershey Simplex)',
    data: HERSHEY.futural,
    blurb: 'the classic machine-engraved nameplate letterform; clean and legible at any size',
  },
  {
    id: 'line-script',
    label: 'Line Script (Hershey Script)',
    data: HERSHEY.scripts,
    blurb: 'flowing single-stroke cursive; the engraved-invitation look',
  },
];

export const DEFAULT_LINE_FONT = 'line-sans';

export function lineFontById(id) {
  return LINE_FONTS.find(f => f.id === id) ?? null;
}

// Lay a string out as open polylines. Glyph data is normalized to cap
// height 1.0 with baseline y = 0 (descenders dip below), so letterHeight
// is the CAP height in inches — same convention the outline shelf's
// letterHeight carries. Returns { polylines, bbox, warnings }; unknown
// characters are skipped with a warning rather than failing the weave
// (the strokes that do exist still cut).
export function textToStrokes(font, text, letterHeight) {
  const polylines = [];
  const warnings = [];
  let penX = 0;
  const missing = new Set();
  for (const ch of String(text)) {
    const glyph = font.data[ch];
    if (!glyph) { missing.add(ch); continue; }
    for (const stroke of glyph.s) {
      polylines.push(stroke.map(([x, y]) => ({
        x: (penX + x) * letterHeight,
        y: y * letterHeight,
      })));
    }
    penX += glyph.w;
  }
  if (missing.size) {
    warnings.push(`no single-line strokes for ${[...missing].map(c => `"${c}"`).join(', ')} — skipped`);
  }
  if (!polylines.length) return { polylines, bbox: null, warnings };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pl of polylines) {
    for (const q of pl) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
  }
  return { polylines, bbox: { minX, minY, maxX, maxY }, warnings };
}
