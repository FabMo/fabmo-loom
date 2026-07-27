// Analytic V-carve surface for the 3D PREVIEW.
//
// The material-removal sim (sim.mjs) stamps the real toolpath — honest, but
// on a V-carve it renders the scallops of the raster-clearing passes and the
// quantization of point-sampled cone stamps, which read as beaded noise on a
// shallow carve. V-Engraver instead draws the IDEAL carved surface: the exact
// V cross-section from the medial axis, so the groove walls are perfectly
// smooth. This module is a DOM-free port of that computation (v_engraver
// modules/preview.js `showCarvedSurface`, pass 1), writing ideal depths into
// a caller-owned grid so view3d renders clean letters.
//
// Rewritten 2026-07-27 from per-cell polygon queries to raster passes — the
// old form (pointInPolygon + nearest-boundary-segment per grid cell) was
// ~80% of all preview CPU and froze the page for seconds on every retype:
//   1. groove cones: each medial segment stamps its own bbox window
//      (identical math to before — the lower envelope of cones along the
//      skeleton — minus the per-cell spatial-hash misses).
//   2. depth-limited profile wall: a scanline even-odd inside mask plus a
//      Felzenszwalb distance transform give distance-to-boundary for every
//      cell in O(cells). Cells within ~2 cells of the outline are seeded
//      with EXACT segment distances, so the visible wall slope is exact and
//      the transform's cell-quantization error (< one cell ≈ 0.004") is
//      confined to the flat bottom where it cannot show.
//
// Deliberately preview-only: sim.mjs stays the source of truth for the
// verifier and the gauntlet probes. The vee op carries `previewVee` (medial
// branches + regions + bit) alongside its moves; simulateJob uses THIS when
// asked for a display surface and the honest cone stamp otherwise.

import { distanceToSegment } from '../vendor/v_engraver/polygon-utils.js';

// Group branches into connected components (shared endpoints). A dot/circle's
// Voronoi skeleton is a starburst of many short branches meeting at a center;
// grouping lets us detect it and render a single smooth cone instead of a star.
function groupBranchComponents(branches) {
  const TOL = 1e-4;
  const ptKey = (p) => `${(Math.round(p.x / TOL) * TOL).toFixed(6)},${(Math.round(p.y / TOL) * TOL).toFixed(6)}`;
  const adj = new Map();
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    if (b.length < 2) continue;
    for (const key of [ptKey(b[0]), ptKey(b[b.length - 1])]) {
      if (!adj.has(key)) adj.set(key, []);
      adj.get(key).push(i);
    }
  }
  const visited = new Set();
  const components = [];
  for (let i = 0; i < branches.length; i++) {
    if (visited.has(i) || branches[i].length < 2) continue;
    const comp = [];
    const stack = [i];
    while (stack.length) {
      const bi = stack.pop();
      if (visited.has(bi)) continue;
      visited.add(bi);
      comp.push(bi);
      const b = branches[bi];
      for (const key of [ptKey(b[0]), ptKey(b[b.length - 1])]) {
        for (const ni of (adj.get(key) || [])) if (!visited.has(ni)) stack.push(ni);
      }
    }
    components.push(comp);
  }
  return components;
}

// closest point on a medial segment, with the inscribed radius linearly
// interpolated along it — the radius is what sets the V depth at that point
function closestOnSegment(px, py, seg) {
  const ex = seg.bx - seg.ax, ey = seg.by - seg.ay;
  const lenSq = ex * ex + ey * ey;
  let t = lenSq < 1e-12 ? 0 : ((px - seg.ax) * ex + (py - seg.ay) * ey) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.ax + t * ex, cy = seg.ay + t * ey;
  return { dist: Math.hypot(px - cx, py - cy), radius: seg.ar + t * (seg.br - seg.ar) };
}

// 1D squared-distance transform (Felzenszwalb & Huttenlocher): the lower
// envelope of parabolas rooted at each sample's initial value. INF cells use
// a large finite sentinel so the envelope arithmetic never produces NaN.
const EDT_INF = 1e20;
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// in-place 2D squared-distance transform over a w×h window (cell units)
function edt2d(field, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let r = 0; r < h; r++) {
    const off = r * w;
    for (let c = 0; c < w; c++) f[c] = field[off + c];
    edt1d(f, d, v, z, w);
    for (let c = 0; c < w; c++) field[off + c] = d[c];
  }
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) f[r] = field[r * w + c];
    edt1d(f, d, v, z, h);
    for (let r = 0; r < h; r++) field[r * w + c] = d[r];
  }
  return field;
}

/**
 * Rasterize the ideal V-carve surface of one vee op into `grid` (deeper wins).
 * @param {Float32Array} grid   grid[r*cols+c] = surface Z (0 = untouched)
 * @param {number} cols @param {number} rows @param {number} dx  stock grid
 * @param {{x:number,y:number}} placement   op-local → stock coords
 * @param {{branches:Array, regions:Array, includedAngle:number, maxDepth:number}} pv
 * @param {number} floorZ       -stock.thickness (deepest a cut can reach)
 * @returns {number} minZ contributed (<= 0)
 */
export function stampVeeSurface(grid, cols, rows, dx, placement, pv, floorZ) {
  const halfAngle = (pv.includedAngle / 2) * Math.PI / 180;
  const tanHA = Math.tan(halfAngle);
  const depthLimited = Number.isFinite(pv.maxDepth);
  const maxDepth = depthLimited ? pv.maxDepth : Infinity;
  let maxRadius = depthLimited ? pv.maxDepth * tanHA : 0;
  if (!depthLimited) {
    for (const branch of pv.branches) for (const q of branch) if (q.radius > maxRadius) maxRadius = q.radius;
  }
  if (maxRadius <= 0) return 0;

  // segments (op-local), collapsing point-like components to a single cone
  const segments = [];
  for (const comp of groupBranchComponents(pv.branches)) {
    let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxR = 0, deepest = null;
    for (const bi of comp) for (const q of pv.branches[bi]) {
      if (q.x < cMinX) cMinX = q.x; if (q.y < cMinY) cMinY = q.y;
      if (q.x > cMaxX) cMaxX = q.x; if (q.y > cMaxY) cMaxY = q.y;
      if (q.radius > cMaxR) { cMaxR = q.radius; deepest = q; }
    }
    const extent = Math.max(cMaxX - cMinX, cMaxY - cMinY);
    if (deepest && comp.length >= 5 && cMaxR > extent * 0.49) {
      const rr = Math.min(cMaxR, maxRadius);
      segments.push({ ax: deepest.x, ay: deepest.y, ar: rr, bx: deepest.x, by: deepest.y, br: rr });
      continue;
    }
    for (const bi of comp) {
      const branch = pv.branches[bi];
      for (let i = 0; i < branch.length - 1; i++) {
        segments.push({
          ax: branch[i].x, ay: branch[i].y, ar: Math.min(branch[i].radius, maxRadius),
          bx: branch[i + 1].x, by: branch[i + 1].y, br: Math.min(branch[i + 1].radius, maxRadius),
        });
      }
    }
  }
  if (!segments.length) return 0;

  // the op's cell window: every segment bbox inflated by the global
  // maxRadius — the same bounds the per-cell iteration used, so coverage
  // is unchanged
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const seg of segments) {
    if (Math.min(seg.ax, seg.bx) - maxRadius < sMinX) sMinX = Math.min(seg.ax, seg.bx) - maxRadius;
    if (Math.max(seg.ax, seg.bx) + maxRadius > sMaxX) sMaxX = Math.max(seg.ax, seg.bx) + maxRadius;
    if (Math.min(seg.ay, seg.by) - maxRadius < sMinY) sMinY = Math.min(seg.ay, seg.by) - maxRadius;
    if (Math.max(seg.ay, seg.by) + maxRadius > sMaxY) sMaxY = Math.max(seg.ay, seg.by) + maxRadius;
  }
  const c0 = Math.max(0, Math.ceil((sMinX + placement.x) / dx));
  const c1 = Math.min(cols - 1, Math.floor((sMaxX + placement.x) / dx));
  const r0 = Math.max(0, Math.ceil((sMinY + placement.y) / dx));
  const r1 = Math.min(rows - 1, Math.floor((sMaxY + placement.y) / dx));
  if (c1 < c0 || r1 < r0) return 0;
  let contributed = 0;
  const stampMin = (i, z) => {
    if (z < grid[i]) { grid[i] = z; if (z < contributed) contributed = z; }
  };

  // ---- pass 1: groove cones, one bbox window per medial segment ----
  for (const seg of segments) {
    const rr = Math.max(seg.ar, seg.br);
    if (rr <= 0) continue;
    const gc0 = Math.max(c0, Math.ceil((Math.min(seg.ax, seg.bx) - rr + placement.x) / dx));
    const gc1 = Math.min(c1, Math.floor((Math.max(seg.ax, seg.bx) + rr + placement.x) / dx));
    const gr0 = Math.max(r0, Math.ceil((Math.min(seg.ay, seg.by) - rr + placement.y) / dx));
    const gr1 = Math.min(r1, Math.floor((Math.max(seg.ay, seg.by) + rr + placement.y) / dx));
    for (let r = gr0; r <= gr1; r++) {
      const py = r * dx - placement.y;
      for (let c = gc0; c <= gc1; c++) {
        const px = c * dx - placement.x;
        const cs = closestOnSegment(px, py, seg);
        if (cs.dist >= cs.radius) continue;
        let z = -(cs.radius - cs.dist) / tanHA;
        if (depthLimited && z < -maxDepth) z = -maxDepth;
        if (z < floorZ) z = floorZ;
        if (z >= -1e-9) continue;
        stampMin(r * cols + c, z);
      }
    }
  }

  // ---- pass 2: depth-limited profile wall over the region interiors ----
  const regions = pv.regions || [];
  if (depthLimited && regions.length) {
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    const rings = [];
    for (const poly of regions) {
      rings.push(poly.outer);
      for (const hole of poly.holes) rings.push(hole);
    }

    // inside mask: even-odd scanline over every ring (regions arrive
    // unioned and disjoint, holes inside their outers — the same answer
    // pointInPolygon gave, minus the per-cell cost)
    const mask = new Uint8Array(w * h);
    const xs = [];
    for (let r = 0; r < h; r++) {
      const py = (r0 + r) * dx - placement.y;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j], b = ring[i];
          if ((a.y > py) === (b.y > py)) continue;
          xs.push(a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let cA = Math.ceil((xs[k] + placement.x) / dx) - c0;
        let cB = Math.floor((xs[k + 1] + placement.x) / dx) - c0;
        if (cA < 0) cA = 0;
        if (cB > w - 1) cB = w - 1;
        for (let c = cA; c <= cB; c++) mask[r * w + c] = 1;
      }
    }

    // distance field: exact segment distances seed a ~2-cell band around
    // every ring, the transform propagates them to the rest in O(cells)
    const field = new Float64Array(w * h).fill(EDT_INF);
    const band = 2 * dx;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const bc0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - band + placement.x) / dx) - c0);
        const bc1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x) + band + placement.x) / dx) - c0);
        const br0 = Math.max(0, Math.ceil((Math.min(a.y, b.y) - band + placement.y) / dx) - r0);
        const br1 = Math.min(h - 1, Math.floor((Math.max(a.y, b.y) + band + placement.y) / dx) - r0);
        for (let r = br0; r <= br1; r++) {
          const py = (r0 + r) * dx - placement.y;
          for (let c = bc0; c <= bc1; c++) {
            const px = (c0 + c) * dx - placement.x;
            const d = distanceToSegment(px, py, a.x, a.y, b.x, b.y) / dx;
            const d2 = d * d;
            const i2 = r * w + c;
            if (d2 < field[i2]) field[i2] = d2;
          }
        }
      }
    }
    edt2d(field, w, h);

    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i2 = r * w + c;
        if (!mask[i2]) continue;
        const dist = Math.sqrt(field[i2]) * dx;
        let z = -Math.min(dist, maxRadius) / tanHA;
        if (z < floorZ) z = floorZ;
        if (z >= -1e-9) continue;
        stampMin((r0 + r) * cols + (c0 + c), z);
      }
    }
  }

  return contributed;
}
