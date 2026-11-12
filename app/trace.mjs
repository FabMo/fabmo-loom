// Raster → outline. A user's own black-and-white picture (a logo scan, a
// clip-art silhouette, a stencil) becomes an SVG the existing asset path
// (app/svg.mjs → shapes) already knows how to lower, so "cut out my
// drawing" works from a PNG or JPEG and not only from an SVG.
//
// Pure and DOM-free: pixels in, SVG text out. The page decodes the file
// (a canvas) and hands the RGBA buffer over; nothing here touches the
// network, the DOM or the recipe. Deliberately NOT for photographs — a
// picture that is not two-tone is refused with a reason (photos of a
// subject go to the model as a picture, or to Relief Studio for carving).
//
//   traceBitmap({ data, width, height }, opts) → { svg, loops, pieces,
//     holes, ink, threshold } | { error }
//
// Steps: grey + Otsu threshold → which class is the paper (the border's
// majority) → crack-following of every ink/paper boundary into closed
// loops on the pixel-corner lattice → speckle removal → Douglas-Peucker
// simplification → one even-odd SVG path in pixel units.

const DEFAULTS = {
  minBimodal: 0.86,     // share of pixels that must sit near one of the two tones
  minLoopArea: 0,       // px²; 0 = auto (0.02% of the image, at least 9)
  tolerance: 0.8,       // Douglas-Peucker, pixels
  maxLoops: 400,        // more than this is a texture or a photo, not an outline
};

// luminance 0..255 of an RGBA buffer, transparent pixels treated as paper
function toGray(data, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    const lum = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    g[i] = Math.round(lum * a + 255 * (1 - a));
  }
  return g;
}

// Otsu's threshold over a grey histogram; also the two class means
function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sumB = 0, best = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  let nLo = 0, sLo = 0, nHi = 0, sHi = 0;
  for (let t = 0; t < 256; t++) {
    if (t <= thr) { nLo += hist[t]; sLo += t * hist[t]; } else { nHi += hist[t]; sHi += t * hist[t]; }
  }
  return { threshold: thr, lo: nLo ? sLo / nLo : 0, hi: nHi ? sHi / nHi : 255, nLo, nHi };
}

// signed area of a closed loop of [x, y] points (shoelace)
function loopArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Douglas-Peucker on a CLOSED loop: split at the two mutually farthest
// points (approximately — the farthest from the first, then from that)
// and simplify each half as an open run.
function simplifyClosed(pts, tol) {
  if (pts.length <= 4) return pts;
  const far = (from) => {
    let bi = 0, bd = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - pts[from][0]) ** 2 + (pts[i][1] - pts[from][1]) ** 2;
      if (d > bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const a = far(0), b = far(a);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const run1 = pts.slice(lo, hi + 1);
  const run2 = [...pts.slice(hi), ...pts.slice(0, lo + 1)];
  const s1 = simplifyOpen(run1, tol), s2 = simplifyOpen(run2, tol);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}
function simplifyOpen(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e <= s + 1) continue;
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let bi = -1, bd = tol;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi > 0) { keep[bi] = 1; stack.push([s, bi], [bi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Trace a two-tone bitmap into an SVG outline.
 * @param {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }} bitmap RGBA, row-major
 */
export function traceBitmap(bitmap, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const W = bitmap?.width | 0, H = bitmap?.height | 0;
  if (!(W >= 8 && H >= 8) || !bitmap.data || bitmap.data.length < W * H * 4) return { error: 'no usable pixels (the image is too small or did not decode)' };
  if (W * H > 4e6) return { error: 'image too large to trace — downscale it first' };
  const n = W * H;
  const gray = toGray(bitmap.data, n);
  const cls = otsu(gray);
  if (cls.hi - cls.lo < 60 || !cls.nLo || !cls.nHi) return { error: 'the image has no clear dark-on-light (or light-on-dark) shape to trace' };
  // two-tone test: how much of the picture sits near one of the two tones
  const band = (cls.hi - cls.lo) * 0.28;
  let near = 0;
  for (let i = 0; i < n; i++) if (Math.abs(gray[i] - cls.lo) <= band || Math.abs(gray[i] - cls.hi) <= band) near++;
  const bimodal = near / n;
  if (bimodal < o.minBimodal) return { error: `this looks like a photograph or a shaded drawing (only ${Math.round(bimodal * 100)}% of it is plain dark or light) — tracing needs a two-tone picture: a silhouette, a stencil, black artwork on white` };

  // paper = the tone most of the border is; ink = the other
  let darkBorder = 0, border = 0;
  const isDark = (i) => gray[i] <= cls.threshold;
  for (let x = 0; x < W; x++) { border += 2; if (isDark(x)) darkBorder++; if (isDark((H - 1) * W + x)) darkBorder++; }
  for (let y = 1; y < H - 1; y++) { border += 2; if (isDark(y * W)) darkBorder++; if (isDark(y * W + W - 1)) darkBorder++; }
  const inkIsDark = darkBorder * 2 <= border;
  const ink = new Uint8Array(n);
  let inkCount = 0;
  for (let i = 0; i < n; i++) if (isDark(i) === inkIsDark) { ink[i] = 1; inkCount++; }
  if (!inkCount) return { error: 'nothing to trace — the picture is blank' };
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? ink[y * W + x] : 0);

  // Directed boundary edges on the corner lattice, ink on the LEFT of
  // travel (y down): keyed by start corner. A corner where two ink pixels
  // touch only diagonally has two outgoing edges; the turn rule below
  // keeps such pixels SEPARATE (4-connected ink), so loops never cross.
  const VW = W + 1;
  const out = new Map();   // start corner → [dir, …]; dir 0 = +x, 1 = +y, 2 = −x, 3 = −y
  const add = (x, y, dir) => { const k = y * VW + x; const l = out.get(k); if (l) l.push(dir); else out.set(k, [dir]); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ink[y * W + x]) continue;
    if (!at(x, y - 1)) add(x + 1, y, 2);        // top edge, travelling −x
    if (!at(x, y + 1)) add(x, y + 1, 0);        // bottom edge, travelling +x
    if (!at(x - 1, y)) add(x, y, 1);            // left edge, travelling +y
    if (!at(x + 1, y)) add(x + 1, y + 1, 3);    // right edge, travelling −y
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const loops = [];
  for (const [k0, dirs0] of out) {
    while (dirs0.length) {
      const pts = [];
      let k = k0, dir = dirs0.pop();
      for (let guard = 0; guard < 8 * n + 16; guard++) {
        const x = k % VW, y = (k - x) / VW;
        // record only corners (direction changes), not every lattice step
        pts.push([x, y, dir]);
        const nk = (y + DY[dir]) * VW + (x + DX[dir]);
        if (nk === k0) break;
        const cand = out.get(nk);
        if (!cand?.length) break;   // cannot happen on a consistent edge set
        // prefer the turn that hugs the ink on the left: left of travel
        // first, then straight, then right — keeps diagonal pixels apart
        const pref = [(dir + 3) % 4, dir, (dir + 1) % 4];
        let pick = -1;
        for (const d of pref) { const ix = cand.indexOf(d); if (ix >= 0) { pick = ix; break; } }
        if (pick < 0) pick = 0;
        dir = cand.splice(pick, 1)[0];
        k = nk;
      }
      // drop collinear lattice steps
      const corners = pts.filter((p, i) => p[2] !== pts[(i - 1 + pts.length) % pts.length][2]).map(p => [p[0], p[1]]);
      if (corners.length >= 4) loops.push(corners);
    }
  }

  const minArea = o.minLoopArea > 0 ? o.minLoopArea : Math.max(9, n * 0.0002);
  const kept = [];
  for (const lp of loops) {
    const a = loopArea(lp);
    if (Math.abs(a) < minArea) continue;
    const s = simplifyClosed(lp, o.tolerance);
    if (s.length >= 3 && Math.abs(loopArea(s)) >= minArea * 0.5) kept.push({ pts: s, area: a });
  }
  if (!kept.length) return { error: 'nothing big enough to trace — only specks were found' };
  if (kept.length > o.maxLoops) return { error: `too many separate outlines (${kept.length}) — this is a texture or a busy picture, not a shape to cut` };
  // with ink on the left and y down, an ink island's outer boundary has
  // NEGATIVE shoelace area and a hole's is positive
  const pieces = kept.filter(l => l.area < 0).length, holes = kept.length - pieces;
  const r1 = (v) => Math.round(v * 10) / 10;
  const d = kept.map(l => `M${l.pts.map(p => `${r1(p[0])} ${r1(p[1])}`).join('L')}Z`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path fill="#000" fill-rule="evenodd" d="${d}"/></svg>`;
  return { svg, loops: kept.length, pieces, holes, ink: inkCount / n, threshold: cls.threshold, inkIsDark, bimodal };
}
