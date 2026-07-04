// Surface raster — ballnose-compensated 3D raster over a heightmap.
//
// The catch-all strategy of the hourglass: any surface a heightmap can
// represent (top-down visible, no undercuts) gets a verified toolpath,
// however the geometry got there — raycast STEP mesh, DEM, image. The
// efficient strategies (pocket, profile, V-carve) claim the regions they
// recognize; this one sweeps whatever is left, restricted by an XY mask.
//
// Core math lifted from 3d_carver/modules/toolpath-gen.js (the same
// derivation lives in terrain_carver's kernel/src/ballnose.rs): a ballnose
// tip at (x, y, Z_tip) is gouge-free iff for every surface sample within
// horizontal distance d <= R of the tip,
//     Z_tip >= h(sample) + sqrt(R^2 - d^2) - R
// so the compensated tip height is the max of that constraint over the ball
// footprint. Compensation always samples the FULL heightmap — the mask only
// restricts where the tool center travels — so overlapping a neighboring
// region is safe by construction.
//
// What this adds over the 3d_carver original:
//   - depth passes: pass k clamps Z to -k*depthPerPass, and only rasters
//     the runs where material remains (no full-area air passes)
//   - XY mask {outer, holes[]}: even-odd scanline segments per raster row
//   - ridge-safe row links: the surface-following link height is the max
//     compensated Z sampled ALONG the link, not just at its endpoints
//   - flat/collinear point decimation, op-contract conformance, warnings
//
// Heightmap contract: heights[row*cols + col] = surface Z at
// (originX + col*dx, originY + row*dy), Z=0 stock top, negative into
// material. Cells outside the grid clamp to params.outsideZ (default 0 =
// uncut stock — conservative). The grid should extend >= R past the mask.
//
// Known limitation: a constant-XY-stepover raster stretches along-surface
// spacing by sqrt(1+slope^2), so scallop grows on steep flanks (the
// gauntlet measures and skips cells where stretched bands stop
// overlapping). Steep regions want a cross-raster or constant-Z finishing
// pass — future strategy, same rail.

export function buildBallKernel(radius, dx, dy) {
  const kr = Math.ceil(radius / dx);
  const krr = Math.ceil(radius / dy);
  const rSq = radius * radius;
  const entries = [];
  for (let dj = -krr; dj <= krr; dj++) {
    for (let di = -kr; di <= kr; di++) {
      const distSq = di * dx * di * dx + dj * dy * dj * dy;
      if (distSq <= rSq) {
        entries.push({ di, dj, dz: Math.sqrt(rSq - distSq) - radius });
      }
    }
  }
  return entries;
}

// even-odd scanline segments of a {outer, holes[]} mask at height y
function maskSegmentsAt(mask, y) {
  const xs = [];
  for (const ring of [mask.outer, ...(mask.holes ?? [])]) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
  }
  xs.sort((p, q) => p - q);
  const segs = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] > xs[i] + 1e-9) segs.push({ x1: xs[i], x2: xs[i + 1] });
  }
  return segs;
}

function pointInMask(mask, x, y) {
  let inside = false;
  for (const ring of [mask.outer, ...(mask.holes ?? [])]) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) &&
          x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * generateSurfaceRaster(heightmap, tool, params)
 *
 * heightmap: { heights, cols, rows, dx, dy, originX, originY }
 * tool:      { diameter }   (ballnose)
 * params:    { stepoverPct=40, depthPerPass=null (null: single finish pass),
 *              safeZ, mask=null, outsideZ=0, feedRate?, plungeRate?,
 *              linkClearance=0.02,
 *              minRunDepth=0.02, minRunLen=2*diameter (run economy: skip
 *              runs that are both shallower AND shorter — edge whiskers) }
 *
 * Returns { moves, stats, warnings }. Moves follow the operation contract:
 * first move is a rapid XY positioning move, internal retracts go to safeZ.
 */
export function generateSurfaceRaster(heightmap, tool, params) {
  const { heights, cols, rows, dx, dy, originX, originY } = heightmap;
  const R = tool.diameter / 2;
  const stepoverPct = params.stepoverPct ?? 40;
  const stepover = tool.diameter * (stepoverPct / 100);
  const safeZ = params.safeZ;
  const outsideZ = params.outsideZ ?? 0;
  const linkClearance = params.linkClearance ?? 0.02;
  const mask = params.mask ?? null;
  // minimum engagement: skip cells whose compensated height is within
  // this of the stock top — sub-tolerance skims, not real cutting
  const minEngage = params.minEngage ?? 0.005;
  // a run must EARN its motion: each one costs a retract + jog, so a
  // whisker that only shaves a few thou where the ball noses into an edge
  // round-over is pure wasted travel. Skip runs that are BOTH shallower
  // than minRunDepth (below the previous pass floor) and shorter than
  // minRunLen — short deep slots and long shallow skims both still cut.
  const minRunDepth = params.minRunDepth ?? 0.02;
  const minRunLen = params.minRunLen ?? 2 * tool.diameter;
  // adjacent-sample Z jump beyond which a straight cut is replaced by a
  // stair (see the cliff comment in the run sampler)
  const cliffDz = params.cliffDz ?? Math.max(0.03, 1.5 * Math.max(heightmap.dx, heightmap.dy));
  const warnings = [];

  const kernel = buildBallKernel(R, dx, dy);

  // memoized compensated tip height at a grid cell
  const compCache = new Float64Array(cols * rows).fill(NaN);
  const compAt = (row, col) => {
    const idx = row * cols + col;
    const cached = compCache[idx];
    if (!Number.isNaN(cached)) return cached;
    let maxZ = -Infinity;
    for (const k of kernel) {
      const c = col + k.di;
      const r = row + k.dj;
      const h = (c < 0 || c >= cols || r < 0 || r >= rows) ? outsideZ : heights[r * cols + c];
      const tip = h + k.dz;
      if (tip > maxZ) maxZ = tip;
    }
    compCache[idx] = maxZ;
    return maxZ;
  };

  // continuous compensated tip height at an arbitrary point (not just a
  // cell center) — the exact constraint the verifier re-derives
  const compAtXY = (x, y) => {
    const c0 = Math.floor((x - R - originX) / dx), c1 = Math.ceil((x + R - originX) / dx);
    const r0 = Math.floor((y - R - originY) / dy), r1 = Math.ceil((y + R - originY) / dy);
    let maxZ = -Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dsq = (originX + c * dx - x) ** 2 + (originY + r * dy - y) ** 2;
        if (dsq > R * R) continue;
        const h = (c < 0 || c >= cols || r < 0 || r >= rows) ? outsideZ : heights[r * cols + c];
        const tip = h + Math.sqrt(R * R - dsq) - R;
        if (tip > maxZ) maxZ = tip;
      }
    }
    return maxZ;
  };

  // ---- raster rows (grid rows spaced ~stepover apart, both ends included)
  const rowStep = Math.max(1, Math.round(stepover / dy));
  if (rowStep * dy > stepover * 1.5) {
    warnings.push(`heightmap row spacing ${dy} too coarse for stepover ${stepover.toFixed(4)} — scallop will exceed theory`);
  }
  const rasterRows = [];
  for (let r = 0; r < rows; r += rowStep) rasterRows.push(r);
  if (rasterRows[rasterRows.length - 1] !== rows - 1) rasterRows.push(rows - 1);

  // ---- per-row active columns (inside mask; clipped to grid)
  const rowCols = rasterRows.map(row => {
    const y = originY + row * dy;
    let ranges;
    if (mask) {
      ranges = maskSegmentsAt(mask, y).map(s => ({
        c1: Math.max(0, Math.ceil((s.x1 - originX) / dx)),
        c2: Math.min(cols - 1, Math.floor((s.x2 - originX) / dx)),
      })).filter(r2 => r2.c2 >= r2.c1);
    } else {
      ranges = [{ c1: 0, c2: cols - 1 }];
    }
    return ranges;
  });

  // ---- depth pass planning
  let minComp = 0;
  for (let i = 0; i < rasterRows.length; i++) {
    for (const { c1, c2 } of rowCols[i]) {
      for (let c = c1; c <= c2; c++) minComp = Math.min(minComp, compAt(rasterRows[i], c));
    }
  }
  const dpp = params.depthPerPass ?? null;
  const passCount = dpp ? Math.max(1, Math.ceil(-minComp / dpp)) : 1;

  // ---- emit moves
  const moves = [];
  let toolPos = null;          // {x, y, z} after last motion
  let atSurface = false;       // tool is engaged (not retracted)
  let cutLength = 0, points = 0, retracts = 0, surfaceLinks = 0, skimsSkipped = 0;
  const EPS = 1e-9;

  const pushCut = (x, y, z) => {
    const m = { type: 'linear', x, y, z };
    if (params.feedRate) m.feedRate = params.feedRate;
    moves.push(m);
    if (toolPos) cutLength += Math.hypot(x - toolPos.x, y - toolPos.y, z - toolPos.z);
    toolPos = { x, y, z };
    points++;
  };

  const retractTo = (x, y, z) => {
    if (toolPos === null) {
      moves.push({ type: 'rapid', x, y }); // op contract: first move is rapid XY
    } else {
      moves.push({ type: 'rapid', z: safeZ });
      moves.push({ type: 'rapid', x, y });
    }
    const plunge = { type: 'linear', z };
    if (params.plungeRate) plunge.feedRate = params.plungeRate;
    moves.push(plunge);
    toolPos = { x, y, z };
    atSurface = true;
    retracts++;
  };

  // surface-following link: max compensated Z sampled along the straight
  // XY path (a ridge between two rows must not be plowed through)
  const surfaceLinkTo = (x, y, z, passFloor) => {
    const from = toolPos;
    const len = Math.hypot(x - from.x, y - from.y);
    let linkZ = Math.max(from.z, z);
    const nSamp = Math.max(2, Math.ceil(len / Math.min(dx, dy)));
    for (let s = 0; s <= nSamp; s++) {
      const t = s / nSamp;
      const col = Math.min(cols - 1, Math.max(0, Math.round((from.x + t * (x - from.x) - originX) / dx)));
      const row = Math.min(rows - 1, Math.max(0, Math.round((from.y + t * (y - from.y) - originY) / dy)));
      const c = Math.max(compAt(row, col), passFloor);
      if (c > linkZ) linkZ = c;
    }
    linkZ = Math.min(safeZ, linkZ + linkClearance);
    const f = params.feedRate;
    const up = { type: 'linear', z: linkZ }; if (f) up.feedRate = f;
    const over = { type: 'linear', x, y, z: linkZ }; if (f) over.feedRate = f;
    const down = { type: 'linear', x, y, z }; if (f) down.feedRate = f;
    moves.push(up, over, down);
    toolPos = { x, y, z };
    surfaceLinks++;
  };

  for (let pass = 0; pass < passCount; pass++) {
    const floor = dpp ? -Math.min((pass + 1) * dpp, -minComp) : minComp;
    const prevFloor = pass === 0 ? 0 : -pass * dpp;
    const finishing = pass === passCount - 1;
    moves.push({
      type: 'comment',
      text: `Surface pass ${pass + 1}/${passCount} floor=${floor.toFixed(6)}${finishing ? ' (finish)' : ''}`,
    });

    let reverse = false;
    for (let ri = 0; ri < rasterRows.length; ri++) {
      const row = rasterRows[ri];
      const y = originY + row * dy;

      // runs of columns this pass still needs: material below the previous
      // pass floor (final pass: everything not already at finish height),
      // and deep enough to be worth touching — comp heights a hair below
      // zero are silhouette-boundary artifacts (cells straddling a
      // diagonal part edge mix h=0 top hits with no-material misses, so
      // the compensated tip dips a fraction of a thou), and cutting them
      // is just tapping the bit along the edge
      const runs = [];
      for (const { c1, c2 } of rowCols[ri]) {
        let runStart = -1;
        for (let c = c1; c <= c2 + 1; c++) {
          const active = c <= c2 && compAt(row, c) < Math.min(prevFloor - EPS, -minEngage);
          if (active && runStart < 0) runStart = c;
          if (!active && runStart >= 0) {
            runs.push({ c1: Math.max(c1, runStart - 1), c2: Math.min(c2, c) }); // 1-sample blend margin
            runStart = -1;
          }
        }
      }
      if (!runs.length) continue;
      if (reverse) runs.reverse();

      for (const run of runs) {
        // sample the run, clamped to this pass's floor, decimating
        // collinear-Z points (flat floors collapse to segment endpoints)
        const pts = [];
        const from = reverse ? run.c2 : run.c1;
        const to = reverse ? run.c1 : run.c2;
        const step = reverse ? -1 : 1;
        for (let c = from; ; c += step) {
          const z = Math.max(compAt(row, c), floor);
          const x = originX + c * dx;
          // stair across comp CLIFFS — a diagonal chord between adjacent
          // columns with very different compensated heights dips the ball
          // below the true constraint mid-span (a measured 17-thou gouge
          // where a roll-off band met a corner: one column constrained at
          // -0.28, its neighbor past ball reach at full depth). The stair
          // is safe by construction: the high column's Z is above BOTH
          // columns' constraints. Descend after moving over; ascend
          // before moving over.
          const prev = pts[pts.length - 1];
          if (prev && Math.abs(z - prev.z) > cliffDz) {
            pts.push(z < prev.z ? { x, z: prev.z } : { x: prev.x, z });
          }
          const np = pts.length;
          if (np >= 2) {
            const a = pts[np - 2], b = pts[np - 1];
            const slopePrev = (b.z - a.z) / (b.x - a.x);
            const slopeNew = (z - b.z) / (x - b.x);
            if (Math.abs(slopeNew - slopePrev) < 1e-6) pts.pop();
          }
          pts.push({ x, z });
          if (c === to) break;
        }
        if (pts.length < 2) continue;

        // chord refinement: between cell centers the constraint is an ARC
        // (the ball rolling onto a step edge), and a straight chord dips
        // below it mid-span — up to 14 thou measured on a 0.06 grid at a
        // pocket-wall base whose jump sits UNDER the cliff-stair threshold.
        // Wherever a chord's midpoint falls below the true continuous
        // constraint, lift a new point onto it and re-check both halves.
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          const span = Math.abs(b.x - a.x);
          if (span < dx / 4) continue; // stair verticals & converged spans
          const mx = (a.x + b.x) / 2;
          const cz = Math.max(compAtXY(mx, y), floor);
          if (cz - (a.z + b.z) / 2 > 0.001) {
            pts.splice(i + 1, 0, { x: mx, z: cz });
            i--; // re-check the left half against the arc
          }
        }

        // run economy: engagement measured below the PREVIOUS pass floor
        // (what this pass actually removes), length along the row
        let deepest = Infinity;
        for (const p of pts) deepest = Math.min(deepest, p.z);
        const runLen = Math.abs(pts[pts.length - 1].x - pts[0].x);
        if (prevFloor - deepest < minRunDepth && runLen < minRunLen) {
          skimsSkipped++;
          continue;
        }

        const entry = { x: pts[0].x, y, z: pts[0].z };
        if (!atSurface || toolPos === null) {
          retractTo(entry.x, y, entry.z);
        } else {
          const linkLen = Math.hypot(entry.x - toolPos.x, y - toolPos.y);
          const linkOk = linkLen <= 3 * stepover &&
            (!mask || pointInMask(mask, (entry.x + toolPos.x) / 2, (y + toolPos.y) / 2));
          if (linkOk) surfaceLinkTo(entry.x, y, entry.z, floor);
          else retractTo(entry.x, y, entry.z);
        }
        for (let i = 1; i < pts.length; i++) pushCut(pts[i].x, y, pts[i].z);
      }
      reverse = !reverse;
    }

    // between depth passes the floor changes — re-enter explicitly
    moves.push({ type: 'rapid', z: safeZ });
    atSurface = false;
  }

  if (points === 0) {
    warnings.push(skimsSkipped
      ? `nothing worth cutting — only ${skimsSkipped} sub-threshold edge skim run(s) in mask (< ${minRunDepth}" deep and < ${minRunLen}" long), all skipped`
      : 'nothing to cut — surface at or above stock top everywhere in mask');
    return { moves: [], stats: { passes: 0, points: 0, cutLength: 0, minZ: 0, retracts: 0, surfaceLinks: 0, skimsSkipped }, warnings };
  }

  const stats = {
    passes: passCount,
    rasterRows: rasterRows.length,
    points,
    cutLength: Math.round(cutLength * 1000) / 1000,
    minZ: minComp,
    retracts,
    surfaceLinks,
    skimsSkipped,
  };

  // declared target for the verifier (ir/verify.js): the surface this op
  // promises not to gouge, and the mask its tool center promised to stay in
  const target = { type: 'heightmap', heightmap, mask, outsideZ };

  return { moves, stats, warnings, target };
}
