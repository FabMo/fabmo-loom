// Procedural carving textures — the curated deck.
//
// A texture is a height function of stock position (inches): height(x, y, P)
// returns [0,1], where 1 is the uncut surface (stock top) and 0 is the deepest
// valley. `texture_field` (app/catalog.mjs) samples this into a heightmap over
// the field around the letters and cuts it with the verified ballnose
// surface-raster — the same primitive dish_shape uses. NO input data: the
// heightmap is authored from a family id + a feature size, so it is fully
// prompt-native (unlike a photo/DEM/STL heightmap).
//
// Ten families, curated from the contact sheet (guilloché and chiseled were
// dropped in review). Each carries a `defaultFeature` — the wavelength in
// inches that read as "cool" during art-direction — used when the caller
// leaves featureSize at 0. `feature` (inches) is the wavelength of the dominant
// element, so it is bit-aware: keep it >= 2x the ballnose radius or the cut
// goes muddy.
//
// WAVE-CLASS families (waves, ripples, fluting) are a `profile(u)` waveform
// over a scalar phase field u (in wavelengths). The phase field is the hidden
// lever: the family's native driver (`phase(x,y,P)`) can be overridden by
// P.origin — 'center' (radial from the field center), 'content' (distance to
// the letters: rings SPREADING FROM THE NAME), 'edge' (distance to the field
// boundary: contour-parallel flow that hugs any outline). 2D families keep a
// plain height(x,y,P) and ignore origin. All families take P.rot (pattern
// rotation about the field center) and, via sampleTexture: P.flow (bend the
// pattern around the content like water around a rock) and P.fade (calm the
// texture to a smooth pool near the content).
//
// DOM-free and dependency-free: runs in Node (gauntlet) and the browser.

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pmod = (a, n) => ((a % n) + n) % n;

// integer hash → [0,1); value noise; fbm; worley — all deterministic in a seed
function hash2(ix, iy, s) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(s | 0, 1013904223);
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, s, oct = 4) {
  let sum = 0, amp = 0.5, fr = 1, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * fr, y * fr, s + i * 37); norm += amp; fr *= 2; amp *= 0.5; }
  return sum / norm;
}
function worley(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y); let md = 1e9;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const cx = ix + ox, cy = iy + oy;
    const jx = cx + hash2(cx, cy, s), jy = cy + hash2(cx, cy, s + 91);
    const dx = x - jx, dy = y - jy, d = dx * dx + dy * dy; if (d < md) md = d;
  }
  return Math.sqrt(md);
}

// P = { F: feature wavelength (in), seed, cx, cy: field center (in) } plus,
// via sampleTexture: rot {c,s}, origin, flow, fade, distContent?, distEdge?
export const TEXTURES = {
  waves: {
    name: 'Waves', seeded: false, defaultFeature: 0.56, wave: true,
    doc: 'Parallel flowing ridges (the default "wavy"). Calm, directional; the safe first choice for "a wavy texture around the name".',
    phase(x, y, P) { const bend = 0.08 * P.F * Math.sin(x / (4 * P.F) * TAU); return (y + bend) / P.F; },
    profile(u) { return 0.5 + 0.5 * Math.sin(u * TAU); },
    height(x, y, P) { return this.profile(this.phase(x, y, P)); },
  },
  ripples: {
    name: 'Ripples', seeded: false, defaultFeature: 0.42, wave: true,
    doc: 'Concentric rings spreading from the field center. Pond-drop, sonar, target. With origin "content" the rings spread from the LETTERS instead.',
    phase(x, y, P) { return Math.hypot(x - P.cx, y - P.cy) / P.F; },
    profile(u) { return 0.5 + 0.5 * Math.sin(u * TAU); },
    height(x, y, P) { return this.profile(this.phase(x, y, P)); },
  },
  interference: {
    name: 'Interference', seeded: false, defaultFeature: 0.67,
    doc: 'Two wave sets crossing — a soft organic moiré that never reads as repeating.',
    height(x, y, P) { const a = Math.sin((0.88 * x + 0.48 * y) / P.F * TAU), b = Math.sin((0.82 * x - 0.57 * y) / P.F * TAU); return 0.5 + 0.25 * (a + b); },
  },
  fluting: {
    name: 'Fluting', seeded: false, defaultFeature: 0.42, wave: true,
    doc: 'Rounded parallel reeds (semicircular flutes). Column-and-frame classic; reads as machined and precise.',
    phase(x, y, P) { return x / P.F; },
    profile(u) { const t = pmod(u, 1); return Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1))); },
    height(x, y, P) { return this.profile(this.phase(x, y, P)); },
  },
  basketweave: {
    name: 'Basketweave', seeded: false, defaultFeature: 0.67,
    doc: 'Over-and-under woven strands. Warm, crafted, tactile.',
    height(x, y, P) {
      const cx = Math.floor(x / P.F), cy = Math.floor(y / P.F), over = ((cx + cy) & 1) === 0;
      const a = 0.5 + 0.5 * Math.cos(pmod(x / P.F, 1) * TAU - Math.PI);
      const b = 0.5 + 0.5 * Math.cos(pmod(y / P.F, 1) * TAU - Math.PI);
      return over ? 0.35 + 0.65 * b : 0.35 + 0.65 * a;
    },
  },
  woodgrain: {
    name: 'Woodgrain', seeded: false, defaultFeature: 0.21,
    doc: 'Stretched rings with fine fiber — faux-bois. Texture that looks like the stock; subtle at small feature sizes.',
    height(x, y, P) {
      const X = x - P.cx, Y = (y - P.cy) * 0.16;
      const warp = 0.9 * P.F * fbm(x / (9 * P.F), y / (9 * P.F), 11, 3);
      let g = 0.5 + 0.5 * Math.sin((Math.hypot(X, Y) + warp) / P.F * TAU);
      g = g * 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(y / (0.16 * P.F) + fbm(x / (2 * P.F), y / (6 * P.F), 5, 2) * 8));
      return g;
    },
  },
  crosshatch: {
    name: 'Crosshatch', seeded: false, defaultFeature: 0.48,
    doc: 'Carved lattice — a grid of rounded channels leaving square pads. Woven/tartan feel; graphic and orderly. (A ballnose rounds the grooves; use a vee bit outside Loom for hairline engraving.)',
    height(x, y, P) {
      const gx = 0.5 + 0.5 * Math.cos(x / P.F * TAU);
      const gy = 0.5 + 0.5 * Math.cos(y / P.F * TAU);
      return 0.15 + 0.85 * Math.sqrt(gx * gy);
    },
  },
  hammered: {
    name: 'Hammered', seeded: true, defaultFeature: 0.48,
    doc: 'Peened dimples (cellular). Planished-metal look; lively without being busy. Seeded — reseed for a different scatter.',
    height(x, y, P) { return clamp01(worley(x / P.F, y / P.F, P.seed) * 1.25); },
  },
  flowing: {
    name: 'Flowing', seeded: true, defaultFeature: 0.83,
    doc: 'Warped turbulence — marbled, liquid, no two areas alike. Seeded. Organic; best at larger feature sizes.',
    height(x, y, P) {
      const cx = x / (2.4 * P.F), cy = y / (2.4 * P.F);
      const wx = fbm(cx, cy, P.seed, 4), wy = fbm(cx + 5.2, cy + 1.3, P.seed + 7, 4);
      return clamp01((fbm(cx + 1.5 * wx, cy + 1.5 * wy, P.seed + 3, 4) - 0.5) * 1.7 + 0.5);
    },
  },
  slate: {
    name: 'Slate', seeded: true, defaultFeature: 0.83,
    doc: 'Ridged stone — riven, rocky, natural. Seeded. A good matte ground behind bold letters.',
    height(x, y, P) {
      const cx = x / (2.6 * P.F), cy = y / (2.6 * P.F);
      const r = 1 - Math.abs(2 * fbm(cx, cy, P.seed, 4) - 1);
      return clamp01(r * r * 1.15);
    },
  },
};

export const TEXTURE_IDS = Object.keys(TEXTURES);

// ---------------------------------------------------------------------
// sampleTexture — the single evaluation entry point. Applies, in order:
// pattern rotation (P.rot = {c, s}, about the field center; all families),
// origin override + flow warp (wave-class families), fade (all families).
//
//   origin: '' native | 'center' | 'content' | 'edge' — which scalar field
//           drives a wave-class family's phase. 'content'/'edge' need the
//           matching P.distContent / P.distEdge sampler (inches).
//   flow:   0..1 — near the content, crossfade the phase toward the
//           content-distance field so ridges bend around the letters like
//           streamlines around a rock; decays over ~1.5 wavelengths.
//   fade:   inches — scale cut amplitude by smoothstep(distContent/fade):
//           the texture calms to a smooth pool right around the letters.
export function sampleTexture(fam, x, y, P) {
  let sx = x, sy = y;
  if (P.rot) {
    const dx = x - P.cx, dy = y - P.cy;
    sx = P.cx + dx * P.rot.c + dy * P.rot.s;
    sy = P.cy - dx * P.rot.s + dy * P.rot.c;
  }
  let h;
  if (fam.wave) {
    let u;
    if (P.origin === 'center') u = Math.hypot(x - P.cx, y - P.cy) / P.F;
    else if (P.origin === 'content' && P.distContent) u = P.distContent(x, y) / P.F;
    else if (P.origin === 'edge' && P.distEdge) u = P.distEdge(x, y) / P.F;
    else u = fam.phase(sx, sy, P);
    if (P.flow > 0 && P.distContent && P.origin !== 'content') {
      const d = P.distContent(x, y);
      const w = P.flow * Math.exp(-d / (1.5 * P.F));
      u += w * (d / P.F - u);
    }
    h = fam.profile(u);
  } else {
    h = fam.height(sx, sy, P);
  }
  if (P.fade > 0 && P.distContent) {
    const t = Math.min(1, P.distContent(x, y) / P.fade);
    const s = t * t * (3 - 2 * t);
    h = 1 - (1 - h) * s;
  }
  return clamp01(h);
}

// ---------------------------------------------------------------------
// Grid utilities for the distance-driven origins. grid = { cols, rows,
// cell, ox, oy } — the same lattice the heightmap is sampled on.

/** Unsigned distance (inches) from each cell center to the nearest point
 * of any ring. Seeds cells within one cell of the walked ring segments
 * with their true distance, then propagates with a two-pass 3-4 chamfer
 * transform (error < ~6% — plenty for driving a texture phase). */
export function distanceGridForRings(rings, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  const d = new Float64Array(cols * rows).fill(Infinity);
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const px = a.x + (s / steps) * (b.x - a.x), py = a.y + (s / steps) * (b.y - a.y);
        const c0 = Math.round((px - ox) / cell), r0 = Math.round((py - oy) / cell);
        for (let rr = Math.max(0, r0 - 1); rr <= Math.min(rows - 1, r0 + 1); rr++) {
          for (let cc = Math.max(0, c0 - 1); cc <= Math.min(cols - 1, c0 + 1); cc++) {
            const dd = Math.hypot(ox + cc * cell - px, oy + rr * cell - py);
            if (dd < d[rr * cols + cc]) d[rr * cols + cc] = dd;
          }
        }
      }
    }
  }
  const D1 = cell, D2 = cell * Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0 && d[i - 1] + D1 < d[i]) d[i] = d[i - 1] + D1;
      if (r > 0) {
        if (d[i - cols] + D1 < d[i]) d[i] = d[i - cols] + D1;
        if (c > 0 && d[i - cols - 1] + D2 < d[i]) d[i] = d[i - cols - 1] + D2;
        if (c < cols - 1 && d[i - cols + 1] + D2 < d[i]) d[i] = d[i - cols + 1] + D2;
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1 && d[i + 1] + D1 < d[i]) d[i] = d[i + 1] + D1;
      if (r < rows - 1) {
        if (d[i + cols] + D1 < d[i]) d[i] = d[i + cols] + D1;
        if (c < cols - 1 && d[i + cols + 1] + D2 < d[i]) d[i] = d[i + cols + 1] + D2;
        if (c > 0 && d[i + cols - 1] + D2 < d[i]) d[i] = d[i + cols - 1] + D2;
      }
    }
  }
  return d;
}

/** Clamped bilinear sampler over a grid array — (x, y) in inches. */
export function gridSampler(values, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  return (x, y) => {
    const fx = Math.min(Math.max((x - ox) / cell, 0), cols - 1.001);
    const fy = Math.min(Math.max((y - oy) / cell, 0), rows - 1.001);
    const c = Math.floor(fx), r = Math.floor(fy), tx = fx - c, ty = fy - r;
    const i = r * cols + c;
    const a = values[i], b = values[i + 1], p = values[i + cols], q = values[i + cols + 1];
    return a + (b - a) * tx + (p - a) * ty + (a - b - p + q) * tx * ty;
  };
}

/** Even-odd scanline rasterization of a set of rings onto the grid:
 * 1 where the cell center is inside. Disjoint rings compose (letter
 * outers + their counters), matching the surface-raster mask rule. */
export function insideGridEvenOdd(rings, grid) {
  const { cols, rows, cell, ox, oy } = grid;
  const inside = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = oy + r * cell;
    const xs = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - ox) / cell));
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - ox) / cell));
      for (let c = c0; c <= c1; c++) inside[r * cols + c] = 1;
    }
  }
  return inside;
}
