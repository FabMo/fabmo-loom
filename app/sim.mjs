// Material-removal simulation: stamp every cutting move's cutter footprint
// into a depth grid over the stock. The result is the SURFACE the machine
// would leave — what the 3D preview renders and what tests can probe
// ("the coaster's well is 0.125 deep at center, through at the ring,
// untouched at the rim").
//
// Cutter models match the strategies' physics:
//   flat  — cylinder end: full depth within the radius
//   vee   — cone: tip depth at the centerline, rising d/tan(halfAngle)
//           with radial distance d (60° included → 30° half-angle)
//   ball  — sphere end: tip depth at the centerline, surface rising
//           R − sqrt(R² − d²) with radial distance d
//
// DOM-free and dependency-free: runs in the browser (feeding Three.js)
// and in Node (feeding the gauntlet). Sampling steps at half a cell so a
// footprint cannot skip cells.

import { walkMoves } from '../ir/moves.js';

/**
 * @param {Array<{r:{moves,cutter?,tool}}>} built  runtime preview.built
 * @param {{x,y}} placement                        op-local → stock coords
 * @param {{w,h,thickness}} stock
 * @returns {{ grid:Float32Array, cols, rows, dx, minZ }}  grid[r*cols+c] = surface Z (0 = untouched)
 */
export function simulateJob(built, placement, stock, opts = {}) {
  // resolution sized for V-carve grooves: an engraving stroke is a few
  // hundredths wide, so the grid must resolve a few thousandths or the
  // 3D preview renders carves as flat tinted lines
  const maxCells = opts.maxCells ?? 1200000;
  const dx = Math.max(0.004, Math.sqrt((stock.w * stock.h) / maxCells));
  const cols = Math.max(2, Math.round(stock.w / dx) + 1);
  const rows = Math.max(2, Math.round(stock.h / dx) + 1);
  const grid = new Float32Array(cols * rows); // 0 = stock top
  const floorZ = -stock.thickness;
  let minZ = 0;

  const stampFlat = (x, y, z, radius) => {
    const zc = Math.max(z, floorZ);
    const c0 = Math.max(0, Math.ceil((x - radius) / dx));
    const c1 = Math.min(cols - 1, Math.floor((x + radius) / dx));
    const r0 = Math.max(0, Math.ceil((y - radius) / dx));
    const r1 = Math.min(rows - 1, Math.floor((y + radius) / dx));
    const rr = radius * radius;
    for (let r = r0; r <= r1; r++) {
      const dy = r * dx - y;
      for (let c = c0; c <= c1; c++) {
        const dxx = c * dx - x;
        if (dxx * dxx + dy * dy > rr) continue;
        const i = r * cols + c;
        if (zc < grid[i]) { grid[i] = zc; if (zc < minZ) minZ = zc; }
      }
    }
  };

  const stampBall = (x, y, z, radius) => {
    if (z > -1e-9) return;
    const c0 = Math.max(0, Math.ceil((x - radius) / dx));
    const c1 = Math.min(cols - 1, Math.floor((x + radius) / dx));
    const r0 = Math.max(0, Math.ceil((y - radius) / dx));
    const r1 = Math.min(rows - 1, Math.floor((y + radius) / dx));
    const rr = radius * radius;
    for (let r = r0; r <= r1; r++) {
      const dy = r * dx - y;
      for (let c = c0; c <= c1; c++) {
        const dxx = c * dx - x;
        const dsq = dxx * dxx + dy * dy;
        if (dsq > rr) continue;
        const zc = Math.max(z + radius - Math.sqrt(rr - dsq), floorZ);
        if (zc > -1e-9) continue;
        const i = r * cols + c;
        if (zc < grid[i]) { grid[i] = zc; if (zc < minZ) minZ = zc; }
      }
    }
  };

  const stampVee = (x, y, z, tanHalf) => {
    const depth = -Math.max(z, floorZ);
    if (depth <= 0) return;
    const radius = depth * tanHalf;
    const c0 = Math.max(0, Math.ceil((x - radius) / dx));
    const c1 = Math.min(cols - 1, Math.floor((x + radius) / dx));
    const r0 = Math.max(0, Math.ceil((y - radius) / dx));
    const r1 = Math.min(rows - 1, Math.floor((y + radius) / dx));
    for (let r = r0; r <= r1; r++) {
      const dy = r * dx - y;
      for (let c = c0; c <= c1; c++) {
        const dxx = c * dx - x;
        const d = Math.hypot(dxx, dy);
        if (d > radius) continue;
        const zc = -(depth - d / tanHalf) + 0; // cone surface at this cell
        const i = r * cols + c;
        if (zc < grid[i]) { grid[i] = zc; if (zc < minZ) minZ = zc; }
      }
    }
  };

  for (const { r } of built) {
    const cutter = r.cutter ?? { type: 'flat', diameter: r.tool?.diameter || 0.01 };
    const isVee = cutter.type === 'vee';
    const isBall = cutter.type === 'ball';
    const tanHalf = isVee ? Math.tan(((cutter.includedAngle ?? 60) / 2) * Math.PI / 180) : 0;
    const radius = isVee ? 0 : (cutter.diameter ?? 0.01) / 2;

    walkMoves(r.moves, (state, move) => {
      if (move.type !== 'linear') return;
      const from = state.prev, to = state;
      if (from.z > -1e-9 && to.z > -1e-9) return; // above the surface
      const x0 = from.x + placement.x, y0 = from.y + placement.y;
      const x1 = to.x + placement.x, y1 = to.y + placement.y;
      const len = Math.hypot(x1 - x0, y1 - y0, to.z - from.z);
      const n = Math.max(1, Math.ceil(len / (dx / 2)));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const z = from.z + (to.z - from.z) * t;
        if (z > -1e-9) continue;
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        isVee ? stampVee(x, y, z, tanHalf)
          : isBall ? stampBall(x, y, z, radius)
          : stampFlat(x, y, z, radius);
      }
    });
  }

  return { grid, cols, rows, dx, minZ };
}

// convenience for tests and probes: surface Z at a stock coordinate
export function surfaceAt(sim, x, y) {
  const c = Math.min(sim.cols - 1, Math.max(0, Math.round(x / sim.dx)));
  const r = Math.min(sim.rows - 1, Math.max(0, Math.round(y / sim.dx)));
  return sim.grid[r * sim.cols + c];
}
