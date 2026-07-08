// Analytic V-carve surface for the 3D PREVIEW.
//
// The material-removal sim (sim.mjs) stamps the real toolpath — honest, but
// on a V-carve it renders the scallops of the raster-clearing passes and the
// quantization of point-sampled cone stamps, which read as beaded noise on a
// shallow carve. V-Engraver instead draws the IDEAL carved surface: for every
// grid cell it evaluates the exact V cross-section from the medial axis, so the
// groove walls are perfectly smooth. This module is a DOM-free port of that
// computation (v_engraver modules/preview.js `showCarvedSurface`, pass 1),
// writing ideal depths into a caller-owned grid so view3d renders clean letters.
//
// Deliberately preview-only: sim.mjs stays the source of truth for the verifier
// and the gauntlet probes. The vee op carries `previewVee` (medial branches +
// regions + bit) alongside its moves; simulateJob uses THIS when asked for a
// display surface and the honest cone stamp otherwise.

import { distanceToSegment, pointInPolygon } from '../vendor/v_engraver/polygon-utils.js';

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

  // spatial hash of segments for O(1)-ish nearest lookup
  const cell = Math.max(maxRadius * 2, dx * 4, 0.1);
  const segGrid = new Map();
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const seg of segments) {
    const aMinX = Math.min(seg.ax, seg.bx) - maxRadius, aMaxX = Math.max(seg.ax, seg.bx) + maxRadius;
    const aMinY = Math.min(seg.ay, seg.by) - maxRadius, aMaxY = Math.max(seg.ay, seg.by) + maxRadius;
    if (aMinX < sMinX) sMinX = aMinX; if (aMaxX > sMaxX) sMaxX = aMaxX;
    if (aMinY < sMinY) sMinY = aMinY; if (aMaxY > sMaxY) sMaxY = aMaxY;
    for (let cx = Math.floor(aMinX / cell); cx <= Math.floor(aMaxX / cell); cx++)
      for (let cy = Math.floor(aMinY / cell); cy <= Math.floor(aMaxY / cell); cy++) {
        const k = `${cx},${cy}`;
        if (!segGrid.has(k)) segGrid.set(k, []);
        segGrid.get(k).push(seg);
      }
  }

  // spatial hash of region boundary segments for the depth-limited profile wall
  let bGrid = null, bCell = 0;
  const regions = pv.regions || [];
  if (depthLimited && regions.length) {
    bCell = Math.max(maxRadius * 1.5, 0.2);
    bGrid = new Map();
    const push = (ax, ay, bx, by) => {
      const s = { ax, ay, bx, by };
      for (let cx = Math.floor((Math.min(ax, bx) - maxRadius) / bCell); cx <= Math.floor((Math.max(ax, bx) + maxRadius) / bCell); cx++)
        for (let cy = Math.floor((Math.min(ay, by) - maxRadius) / bCell); cy <= Math.floor((Math.max(ay, by) + maxRadius) / bCell); cy++) {
          const k = `${cx},${cy}`;
          if (!bGrid.has(k)) bGrid.set(k, []);
          bGrid.get(k).push(s);
        }
    };
    for (const poly of regions) {
      const addRing = (ring) => { for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) push(ring[j].x, ring[j].y, ring[i].x, ring[i].y); };
      addRing(poly.outer);
      for (const h of poly.holes) addRing(h);
    }
  }
  const fastDistToBoundary = (px, py) => {
    if (!bGrid) return 0;
    const gcx = Math.floor(px / bCell), gcy = Math.floor(py / bCell);
    let min = Infinity;
    for (let dcx = -1; dcx <= 1; dcx++) for (let dcy = -1; dcy <= 1; dcy++) {
      const arr = bGrid.get(`${gcx + dcx},${gcy + dcy}`);
      if (!arr) continue;
      for (const s of arr) { const d = distanceToSegment(px, py, s.ax, s.ay, s.bx, s.by); if (d < min) min = d; }
    }
    return min;
  };

  // iterate only the cells the carve can touch (segment bbox + radius),
  // mapped from op-local into stock cell indices
  const c0 = Math.max(0, Math.ceil((sMinX + placement.x) / dx));
  const c1 = Math.min(cols - 1, Math.floor((sMaxX + placement.x) / dx));
  const r0 = Math.max(0, Math.ceil((sMinY + placement.y) / dx));
  const r1 = Math.min(rows - 1, Math.floor((sMaxY + placement.y) / dx));
  let contributed = 0;

  for (let r = r0; r <= r1; r++) {
    const py = r * dx - placement.y;
    for (let c = c0; c <= c1; c++) {
      const px = c * dx - placement.x;
      let z = 0;

      const arr = segGrid.get(`${Math.floor(px / cell)},${Math.floor(py / cell)}`);
      if (arr) for (const seg of arr) {
        const cs = closestOnSegment(px, py, seg);
        if (cs.dist < cs.radius) {
          const gz = -(cs.radius - cs.dist) / tanHA;
          if (gz < z) z = gz;
        }
      }

      if (depthLimited && regions.length) {
        if (z < -maxDepth) z = -maxDepth;
        for (const poly of regions) {
          if (pointInPolygon(px, py, poly)) {
            const profileZ = -Math.min(fastDistToBoundary(px, py), maxRadius) / tanHA;
            if (profileZ < z) z = profileZ;
            break;
          }
        }
      }

      if (z >= -1e-9) continue;
      if (z < floorZ) z = floorZ;
      const i = r * cols + c;
      if (z < grid[i]) { grid[i] = z; if (z < contributed) contributed = z; }
    }
  }
  return contributed;
}
