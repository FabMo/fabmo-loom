// Verifier v1 — the admission gate of the hourglass.
//
// Takes a Job and its composed moves and returns a report of MEASURED facts:
// every check is a number computed from the actual motion, not an assertion
// that something "should" be true. This is the piece a weights-only prompt
// structurally cannot do.
//
// v0 checks (program-level motion rules):
//   envelope     every XY position inside [0, stock.w] × [0, stock.h]
//   depth        every Z within [−stock.thickness, safeZ]; no rapid ends
//                below stock top (Z < 0)
//   boundaries   each operation is entered from safeZ, and every toolchange
//                happens at safeZ
//   feeds        every cutting move has a positive feed in effect
//
// v1 (this file) promotes the strategy gauntlets' geometry into runtime
// checks on every composed job:
//   footprints   per-op swept area = cutting polylines dilated by the tool
//                radius (Clipper), pairwise TRUE intersection area instead
//                of bbox overlap — interlocking ops no longer falsely
//                rejected, real overlaps reported with measured area.
//                Ops whose tool has no diameter fall back to bbox.
//   targets      an op may DECLARE what it intends to machine; the verifier
//                independently checks the motion against the declaration:
//                  { type:'region', outer, holes?, depth }   (or rings:[])
//                    - gouge: every cutting sample's tool center inside the
//                      region inset by (radius − tol)
//                    - depth: no cutting sample below −depth
//                    - coverage: swept area vs the region's machinable
//                      opening — residual % is a WARNING (quality), not an
//                      error (safety)
//                  { type:'heightmap', heightmap, mask? }
//                    - gouge: at every cutting sample the tool tip respects
//                      the ball/flat constraint vs the height grid,
//                      brute-forced here INDEPENDENTLY of the strategies'
//                      kernel code (a shared bug must not self-certify)
//                    - mask: tool center stays inside the declared mask
//
// Targets are op-local (like op.moves) and are transformed by the op's
// placement. Heightmap targets do not support rotated placements.
//
// Report: { ok, errors[], warnings[], stats } — stats always computed.

import { walkMoves } from './moves.js';
import { applyPlacement } from './placement.js';
import ClipperLib from '../vendor/clipper.js';

const EPS = 1e-6;
const SCALE = 1e6; // clipper integer grid: 1e-6 units

const toClip = ring => ring.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const pathsArea = paths => paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);

export function verifyJob(job, composedMoves, opts = {}) {
  const gougeTol = opts.gougeTol ?? 2e-3;
  // heightmap checks sample BETWEEN toolpath vertices, where linear chords
  // legitimately dip below the curved constraint by up to ~grid-resolution
  // chordal error (measured ≤ 0.0044 on smooth surfaces at 0.02 grids) —
  // so the surface tolerance floor is higher than the region one
  const surfaceGougeTol = opts.surfaceGougeTol ?? Math.max(gougeTol, 6e-3);
  const coverageWarnPct = opts.coverageWarnPct ?? 2;
  // Two ops legitimately sharing a boundary (a pocket on the part edge and
  // the outer profile) graze each other's kerf by sub-tolerance slivers —
  // detection contours and traced silhouettes never agree to zero. A graze
  // this thin is not a defect; an intrusion DEEPER than it is. The overlap
  // check erodes the intersection by kerfGrazeTol/2 and errors only on
  // what survives.
  const kerfGrazeTol = opts.kerfGrazeTol ?? 5e-3;
  // global part-surface check (job.partSurface): tool-center samples may
  // not cut below the part's top-down surface anywhere. Pocket floors sit
  // exactly ON the surface, so the tolerance must absorb grid sampling
  // noise — but a tunnel/overhang collision violates by the full roof
  // height and is caught regardless.
  const partSurfaceTol = opts.partSurfaceTol ?? 0.02;
  const errors = [];
  const warnings = [];

  // ---- v0: global motion rules over the composed program ----
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let minZ = Infinity, maxZ = -Infinity;
  let cutLength = 0, rapidLength = 0, cutTimeMin = 0;
  let moveCount = 0, toolchangeCount = 0;
  let atSafeZ = false;
  let feedInEffect = null;
  let index = 0;

  walkMoves(composedMoves, (s, m) => {
    index++;
    if (m.type === 'feed') {
      feedInEffect = s.feedXY;
      return;
    }
    if (m.type === 'toolchange') {
      toolchangeCount++;
      if (!atSafeZ) {
        errors.push(`toolchange to T${m.tool} at move #${index} not at safeZ (Z=${fmt3(s.z)})`);
      }
      return;
    }
    moveCount++;
    bbox.minX = Math.min(bbox.minX, s.x); bbox.maxX = Math.max(bbox.maxX, s.x);
    bbox.minY = Math.min(bbox.minY, s.y); bbox.maxY = Math.max(bbox.maxY, s.y);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);

    const dist = Math.hypot(s.x - s.prev.x, s.y - s.prev.y, s.z - s.prev.z);
    if (m.type === 'rapid') {
      rapidLength += dist;
      if (s.z < -EPS) {
        errors.push(`rapid ends below stock top at move #${index}: Z=${fmt3(s.z)}`);
      }
    } else {
      cutLength += dist;
      if (feedInEffect == null || feedInEffect <= 0) {
        errors.push(`cutting move #${index} with no positive feed in effect`);
      } else {
        cutTimeMin += dist / feedInEffect;
      }
    }

    if (s.x < -EPS || s.x > job.stock.w + EPS || s.y < -EPS || s.y > job.stock.h + EPS) {
      errors.push(`move #${index} leaves stock envelope: (${fmt3(s.x)}, ${fmt3(s.y)}) vs ${job.stock.w} x ${job.stock.h}`);
    }
    if (s.z < -job.stock.thickness - EPS) {
      errors.push(`move #${index} cuts through stock bottom: Z=${fmt3(s.z)} < ${-job.stock.thickness}`);
    }
    if (s.z > job.safeZ + EPS) {
      warnings.push(`move #${index} above safeZ: Z=${fmt3(s.z)}`);
    }

    atSafeZ = s.z >= job.safeZ - EPS;
  });

  // ---- v1: per-operation geometry ----
  const footprints = [];
  const targetStats = [];

  job.operations.forEach((op, i) => {
    const name = op.name ?? `op${i}`;
    const unitScale = unitFactorOf(op, job);
    const placed = applyPlacement(op.moves, op.placement, unitScale);
    const tool = job.tools?.[op.tool] ?? {};
    // tool diameters live in the job's tool table, already in job units
    const radius = tool.diameter > 0 ? tool.diameter / 2 : null;

    const polylines = cuttingPolylines(placed);
    const fp = {
      name, allowOverlap: !!op.allowOverlap,
      // scoped alternative to the blanket flag: overlap permitted only
      // with the NAMED ops (e.g. an edge treatment and the cutout that
      // frees the same shape) — every other pairing is still checked
      allowOverlapWith: Array.isArray(op.allowOverlapWith) ? op.allowOverlapWith : [],
      cuts: polylines.length > 0,
      bbox: polylineBbox(polylines),
      paths: null, area: null, method: 'bbox',
    };
    if (fp.cuts && radius) {
      fp.paths = sweptArea(polylines, radius);
      fp.area = pathsArea(fp.paths);
      fp.method = 'polygon';
    } else if (fp.cuts) {
      warnings.push(`"${name}": tool T${op.tool} has no diameter — footprint checked at bbox precision`);
    }
    footprints.push(fp);

    // ---- global part-surface check ----
    // Targets are declared by the same planner that made the moves and
    // cannot catch planning errors; the part surface (top-down raycast
    // heightmap, attached by the app) is independent ground truth. A cut
    // below it means the tool is inside material the plan never owned —
    // e.g. a pocket reaching under a tunnel roof. Tool-CENTER samples
    // only (v1): periphery and holder are not modeled.
    if (job.partSurface?.heightmap && fp.cuts) {
      const ps = job.partSurface;
      const hm = ps.heightmap;
      let worst = 0, worstAt = null, violations = 0;
      samplePolylines(polylines, Math.max(hm.dx, hm.dy), (x, y, z) => {
        if (z >= -EPS) return; // at/above stock top: positioning
        // heights[i] sits at originX + i*dx (the producer put the origin on
        // cell (0,0)'s CENTER), so round() is the nearest actual sample
        const c = Math.round((x - (ps.x ?? 0) - hm.originX) / hm.dx);
        const r = Math.round((y - (ps.y ?? 0) - hm.originY) / hm.dy);
        if (c < 0 || c >= hm.cols || r < 0 || r >= hm.rows) return; // off the map: no material
        const s = hm.heights[r * hm.cols + c];
        if (z < s - partSurfaceTol) {
          violations++;
          if (s - z > worst) { worst = s - z; worstAt = { x, y }; }
        }
      });
      if (violations) {
        errors.push(`"${name}" cuts ${worst.toFixed(3)} below the part surface at (${worstAt.x.toFixed(2)}, ${worstAt.y.toFixed(2)}) — ${violations} sample(s); tool driven into material above the floor (tunnel/overhang?)`);
      }
    }

    // ---- declared target ----
    if (op.target && fp.cuts) {
      if (!radius) {
        errors.push(`"${name}" declares a target but tool T${op.tool} has no diameter — cannot verify`);
        return;
      }
      const target = transformTarget(op.target, op.placement, unitScale, errors, name);
      if (!target) return;

      if (target.type === 'region') {
        targetStats.push(checkRegionTarget(name, target, polylines, fp, radius, gougeTol, coverageWarnPct, errors, warnings));
      } else if (target.type === 'profile') {
        targetStats.push(checkProfileTarget(name, target, polylines, fp, radius, gougeTol, errors));
      } else if (target.type === 'heightmap') {
        targetStats.push(checkHeightmapTarget(name, target, polylines, radius, tool, surfaceGougeTol, errors));
      } else {
        errors.push(`"${name}": unknown target type "${target.type}"`);
      }
    }
  });

  // ---- pairwise footprint disjointness ----
  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i], b = footprints[j];
      if (!a.cuts || !b.cuts || a.allowOverlap || b.allowOverlap) continue;
      if (a.allowOverlapWith.includes(b.name) || b.allowOverlapWith.includes(a.name)) continue;

      if (a.paths && b.paths) {
        const c = new ClipperLib.Clipper();
        c.AddPaths(a.paths, ClipperLib.PolyType.ptSubject, true);
        c.AddPaths(b.paths, ClipperLib.PolyType.ptClip, true);
        const inter = new ClipperLib.Paths();
        c.Execute(ClipperLib.ClipType.ctIntersection, inter,
          ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        const area = pathsArea(inter);
        if (area > 1e-4) {
          // boundary-graze filter: slivers thinner than kerfGrazeTol vanish
          // under erosion; anything that survives is a real intrusion
          const co = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
          co.AddPaths(inter, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
          const eroded = new ClipperLib.Paths();
          co.Execute(eroded, -(kerfGrazeTol / 2) * SCALE);
          if (pathsArea(eroded) > 0) {
            errors.push(`cutting footprints overlap: "${a.name}" and "${b.name}" share ${area.toFixed(4)} sq units of swept area`);
          } else {
            warnings.push(`"${a.name}" and "${b.name}" graze along a shared boundary (${area.toFixed(4)} sq units, thinner than ${kerfGrazeTol}")`);
          }
        }
      } else {
        // bbox fallback (either op lacked a tool diameter)
        const overlapX = Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX);
        const overlapY = Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY);
        if (overlapX > EPS && overlapY > EPS) {
          errors.push(`cutting footprints overlap: "${a.name}" and "${b.name}" share ${fmt3(overlapX)} x ${fmt3(overlapY)} region (bbox precision)`);
        }
      }
    }
  }

  const stats = {
    moveCount,
    toolchangeCount,
    bbox: finite(bbox) ? bbox : null,
    zRange: minZ <= maxZ ? { min: minZ, max: maxZ } : null,
    cutLength: round3(cutLength),
    rapidLength: round3(rapidLength),
    estCutTimeMin: round3(cutTimeMin),
    footprints: footprints.map(f => ({
      name: f.name,
      cuts: f.cuts,
      method: f.cuts ? f.method : null,
      area: f.area != null ? round3(f.area) : null,
      bbox: f.cuts ? f.bbox : null,
    })),
    targets: targetStats,
  };

  return { ok: errors.length === 0, errors, warnings, stats };
}

// ---------------------------------------------------------------- motion

// chains of consecutive cutting motion (linear/arc touching material),
// resolved to absolute coordinates. Arcs contribute their chord — footprint
// and target sampling treat them as straight (current strategies emit none).
function cuttingPolylines(moves) {
  const chains = [];
  let chain = null;
  let pos = { x: 0, y: 0, z: 0 };
  for (const m of moves) {
    if (m.type === 'feed' || m.type === 'toolchange' || m.type === 'comment') continue;
    const next = {
      x: m.x !== undefined ? m.x : pos.x,
      y: m.y !== undefined ? m.y : pos.y,
      z: m.z !== undefined ? m.z : pos.z,
    };
    const cutting = (m.type === 'linear' || m.type === 'arc') && (next.z < -EPS || pos.z < -EPS);
    if (cutting) {
      if (!chain) chain = [{ ...pos }];
      chain.push(next);
    } else if (chain) {
      chains.push(chain);
      chain = null;
    }
    pos = next;
  }
  if (chain) chains.push(chain);
  return chains;
}

function polylineBbox(polylines) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const line of polylines) {
    for (const p of line) {
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
      b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
}

// swept area = polylines dilated by the tool radius (round joins/caps)
function sweptArea(polylines, radius) {
  const co = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
  for (const line of polylines) {
    const path = [];
    for (const p of line) {
      const cp = { X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) };
      const last = path[path.length - 1];
      if (!last || last.X !== cp.X || last.Y !== cp.Y) path.push(cp);
    }
    if (path.length === 1) path.push({ X: path[0].X + 1, Y: path[0].Y }); // lone plunge → dot
    if (path.length >= 2) co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  }
  const out = new ClipperLib.Paths();
  co.Execute(out, radius * SCALE);
  return ClipperLib.Clipper.SimplifyPolygons(out, ClipperLib.PolyFillType.pftNonZero);
}

// sample points along cutting polylines (vertices + midpoints at ~step)
function samplePolylines(polylines, step, cb) {
  for (const line of polylines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const n = Math.min(32, Math.max(1, Math.ceil(len / step)));
      for (let s = i === 1 ? 0 : 1; s <= n; s++) {
        const t = s / n;
        cb(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.z + t * (b.z - a.z));
      }
    }
  }
}

// ---------------------------------------------------------------- targets

function transformTarget(target, placement = {}, unitScale = 1, errors, name) {
  const { x: tx = 0, y: ty = 0, rotateDeg = 0, scale = 1 } = placement;
  const sxy = unitScale * scale;
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const pt = p => ({
    x: (p.x * sxy) * cos - (p.y * sxy) * sin + tx,
    y: (p.x * sxy) * sin + (p.y * sxy) * cos + ty,
  });

  if (target.type === 'region' || target.type === 'profile') {
    const rings = target.rings
      ? target.rings.map(r => r.map(pt))
      : [target.outer.map(pt), ...(target.holes ?? []).map(h => h.map(pt))];
    const base = { rings, depth: target.depth * unitScale };
    return target.type === 'profile'
      ? { type: 'profile', side: target.side ?? 'outside', ...base }
      : { type: 'region', ...base };
  }
  if (target.type === 'heightmap') {
    if (rotateDeg !== 0) {
      errors.push(`"${name}": heightmap target does not support rotated placement`);
      return null;
    }
    const hm = target.heightmap;
    const scaled = {
      heights: unitScale === 1 ? hm.heights : Float64Array.from(hm.heights, v => v * unitScale),
      cols: hm.cols, rows: hm.rows,
      dx: hm.dx * sxy, dy: hm.dy * sxy,
      originX: hm.originX * sxy + tx, originY: hm.originY * sxy + ty,
    };
    const mask = target.mask
      ? { outer: target.mask.outer.map(pt), holes: (target.mask.holes ?? []).map(h => h.map(pt)) }
      : null;
    return { type: 'heightmap', heightmap: scaled, mask, outsideZ: (target.outsideZ ?? 0) * unitScale };
  }
  return { type: target.type };
}

function checkRegionTarget(name, target, polylines, fp, radius, gougeTol, coverageWarnPct, errors, warnings) {
  // legal tool-center region: declared rings inset by (radius − tol)
  const co = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
  const subject = ClipperLib.Clipper.SimplifyPolygons(target.rings.map(toClip), ClipperLib.PolyFillType.pftNonZero);
  co.AddPaths(subject, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const legal = new ClipperLib.Paths();
  co.Execute(legal, -(radius - gougeTol) * SCALE);

  let samples = 0, gouges = 0, deepest = 0, depthViolations = 0;
  let firstGouge = null;
  const legalIdx = buildPointInPathsIndex(legal);
  samplePolylines(polylines, radius / 2, (x, y, z) => {
    samples++;
    if (z >= -EPS) return; // above stock top: positioned, not cutting
    if (z < -target.depth - gougeTol) { depthViolations++; deepest = Math.min(deepest, z); }
    if (!pointInPathsIndexed(x, y, legalIdx)) {
      gouges++;
      if (!firstGouge) firstGouge = { x, y, z };
    }
  });
  if (gouges > 0) {
    errors.push(`"${name}" gouges outside its declared region: ${gouges}/${samples} samples, first at (${fmt3(firstGouge.x)}, ${fmt3(firstGouge.y)}, ${fmt3(firstGouge.z)})`);
  }
  if (depthViolations > 0) {
    errors.push(`"${name}" cuts below its declared depth ${fmt3(-target.depth)}: ${depthViolations} samples, deepest Z=${fmt3(deepest)}`);
  }

  // coverage (quality, warning): swept vs the machinable opening of the region
  let coveragePct = null;
  if (fp.paths) {
    const co2 = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
    co2.AddPaths(legal, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const machinable = new ClipperLib.Paths();
    co2.Execute(machinable, radius * SCALE);
    const c = new ClipperLib.Clipper();
    c.AddPaths(machinable, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(fp.paths, ClipperLib.PolyType.ptClip, true);
    const resid = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctDifference, resid,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const machinableArea = pathsArea(machinable);
    coveragePct = machinableArea > 0 ? (100 * pathsArea(resid)) / machinableArea : 0;
    if (coveragePct > coverageWarnPct) {
      warnings.push(`"${name}" leaves ${coveragePct.toFixed(2)}% of its declared region uncut`);
    }
  }

  return {
    name, type: 'region', samples, gouges, depthViolations,
    coverageResidualPct: coveragePct != null ? round3(coveragePct) : null,
  };
}

// A PROFILE op cuts a single offset contour to free a part (or open a window),
// not to clear an area — so its target is keep-OUT, not keep-IN:
//   outside → the tool's swept disc must not intrude the PART BODY (the region).
//   inside  → the swept disc must not escape the window region into the part.
//   on      → straddles the line; depth-only.
// The tool rides tangent to the boundary, so sub-tol boundary grazes are eroded
// away; a real wrong-side / wrong-offset cut overlaps by a full kerf band and is
// caught with a measured area.
function checkProfileTarget(name, target, polylines, fp, radius, gougeTol, errors) {
  // depth (all sides)
  let samples = 0, deepest = 0, depthViolations = 0;
  samplePolylines(polylines, radius / 2, (x, y, z) => {
    samples++;
    if (z >= -EPS) return;
    if (z < -target.depth - gougeTol) { depthViolations++; deepest = Math.min(deepest, z); }
  });
  if (depthViolations > 0) {
    errors.push(`"${name}" cuts below its declared depth ${fmt3(-target.depth)}: ${depthViolations} samples, deepest Z=${fmt3(deepest)}`);
  }

  // keep-out / keep-in: measure how much swept area lands on the wrong side of
  // the part boundary, then erode sub-tol grazes before erroring.
  let intrusionArea = 0;
  const side = target.side ?? 'outside';
  if (fp.paths && side !== 'on') {
    const part = ClipperLib.Clipper.SimplifyPolygons(target.rings.map(toClip), ClipperLib.PolyFillType.pftNonZero);
    const c = new ClipperLib.Clipper();
    c.AddPaths(fp.paths, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(part, ClipperLib.PolyType.ptClip, true);
    const bad = new ClipperLib.Paths();
    // outside: swept ∩ part (cut into the body). inside: swept − part (escaped the window).
    const clip = side === 'inside' ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctIntersection;
    c.Execute(clip, bad, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const rawArea = pathsArea(bad);
    const co = new ClipperLib.ClipperOffset(2, 0.0005 * SCALE);
    co.AddPaths(bad, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const eroded = new ClipperLib.Paths();
    co.Execute(eroded, -(gougeTol / 2) * SCALE);
    intrusionArea = pathsArea(eroded);
    if (intrusionArea > 0) {
      const what = side === 'inside' ? 'escapes the window into the part body' : 'intrudes the part body';
      errors.push(`"${name}" profile cut ${what} by ${rawArea.toFixed(4)} sq units — the cut would damage the part`);
    }
  }

  return { name, type: 'profile', side, samples, depthViolations, intrusionArea: round3(intrusionArea) };
}

function checkHeightmapTarget(name, target, polylines, radius, tool, gougeTol, errors) {
  const hm = target.heightmap;
  const { heights, cols, rows, dx, dy, originX, originY } = hm;
  const outsideZ = target.outsideZ;
  const kind = tool.kind ?? 'ball';
  // vee: cone surface at horizontal distance d from the axis sits d/tanβ
  // above the tip (β = half the included angle), so tip ≥ h − d/tanβ
  const veeTan = kind === 'vee' ? Math.tan(((tool.angleDeg ?? 90) / 2) * Math.PI / 180) : null;
  // a vee tip legitimately rides ON sloped faces (chamfer bands), where a
  // cell-center height differs from the true surface under the tip by up
  // to (cell/2)·slope — 0.014 measured on a 45° band at a 0.028 grid. The
  // tolerance floor scales with the grid so a finer grid stays a tighter
  // gate; real misplacement spans whole cells and still trips it.
  if (kind === 'vee') gougeTol = Math.max(gougeTol, 0.6 * Math.max(hm.dx, hm.dy));

  // independent brute-force tip constraint (NOT the strategies' kernel)
  const constraint = (x, y) => {
    const c0 = Math.floor((x - radius - originX) / dx), c1 = Math.ceil((x + radius - originX) / dx);
    const r0 = Math.floor((y - radius - originY) / dy), r1 = Math.ceil((y + radius - originY) / dy);
    let zmin = -Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dsq = (originX + c * dx - x) ** 2 + (originY + r * dy - y) ** 2;
        if (dsq > radius * radius) continue;
        const h = (c < 0 || c >= cols || r < 0 || r >= rows) ? outsideZ : heights[r * cols + c];
        const tip = kind === 'flat' ? h
          : kind === 'vee' ? h - Math.sqrt(dsq) / veeTan
          : h + Math.sqrt(radius * radius - dsq) - radius;
        if (tip > zmin) zmin = tip;
      }
    }
    return zmin;
  };

  const inMask = (x, y) => {
    if (!target.mask) return true;
    let ins = false;
    for (const ring of [target.mask.outer, ...target.mask.holes]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if ((ring[i].y > y) !== (ring[j].y > y) &&
            x < ((ring[j].x - ring[i].x) * (y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) ins = !ins;
      }
    }
    return ins;
  };

  let samples = 0, gouges = 0, worst = 0, maskViolations = 0;
  let firstGouge = null;
  samplePolylines(polylines, Math.min(dx, dy), (x, y, z) => {
    samples++;
    const pen = constraint(x, y) - z;
    if (pen > gougeTol) {
      gouges++;
      if (pen > worst) worst = pen;
      if (!firstGouge) firstGouge = { x, y, z };
    }
    if (z < -EPS && !inMask(x, y) && !inMask(x - 1e-7, y) && !inMask(x + 1e-7, y)) maskViolations++;
  });
  if (gouges > 0) {
    errors.push(`"${name}" gouges its declared surface: ${gouges}/${samples} samples, worst ${worst.toFixed(4)} deep, first at (${fmt3(firstGouge.x)}, ${fmt3(firstGouge.y)})`);
  }
  if (maskViolations > 0) {
    errors.push(`"${name}" cuts outside its declared mask: ${maskViolations}/${samples} samples`);
  }

  return { name, type: 'heightmap', samples, gouges, worstPenetration: Math.round(worst * 1e5) / 1e5, maskViolations };
}

// winding-aware point-in-paths (boundary counts inside)
function pointInPaths(x, y, paths) {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let winding = 0;
  for (const path of paths) {
    const r = ClipperLib.Clipper.PointInPolygon(pt, path);
    if (r === -1) return true;
    if (r === 1) winding += ClipperLib.Clipper.Orientation(path) ? 1 : -1;
  }
  return winding > 0;
}

// Row-indexed pointInPaths for hot sample loops: identical verdicts
// (winding-aware, boundary counts inside, same integer space as Clipper),
// but each query touches only the edges whose y-span crosses its row —
// a welded-text legal region has ~10k edges and a V-carve ~10^5 samples,
// which made the exact-but-linear scan the slowest thing in the pipeline.
function buildPointInPathsIndex(paths) {
  let minY = Infinity, maxY = -Infinity, edgeCount = 0;
  for (const p of paths) {
    edgeCount += p.length;
    for (const q of p) { if (q.Y < minY) minY = q.Y; if (q.Y > maxY) maxY = q.Y; }
  }
  if (!edgeCount) return { empty: true };
  const rows = Math.max(1, Math.min(4096, edgeCount));
  const h = Math.max(1, Math.ceil((maxY - minY + 1) / rows));
  const buckets = Array.from({ length: rows }, () => []);
  const signs = paths.map(p => (ClipperLib.Clipper.Orientation(p) ? 1 : -1));
  paths.forEach((path, pi) => {
    for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[(i + 1) % path.length];
      const lo = Math.max(0, Math.floor((Math.min(a.Y, b.Y) - minY) / h));
      const hi = Math.min(rows - 1, Math.floor((Math.max(a.Y, b.Y) - minY) / h));
      for (let r = lo; r <= hi; r++) buckets[r].push({ ax: a.X, ay: a.Y, bx: b.X, by: b.Y, pi });
    }
  });
  return { minY, h, rows, buckets, signs, parity: new Uint8Array(paths.length), touched: [] };
}

function pointInPathsIndexed(x, y, idx) {
  if (idx.empty) return false;
  const X = Math.round(x * SCALE), Y = Math.round(y * SCALE);
  const r = Math.floor((Y - idx.minY) / idx.h);
  if (r < 0 || r >= idx.rows) return false;
  const { parity, touched } = idx;
  touched.length = 0;
  for (const e of idx.buckets[r]) {
    // boundary counts inside (Clipper's -1): exact integer colinearity
    const cross = (e.bx - e.ax) * (Y - e.ay) - (e.by - e.ay) * (X - e.ax);
    if (cross === 0 &&
        X >= Math.min(e.ax, e.bx) && X <= Math.max(e.ax, e.bx) &&
        Y >= Math.min(e.ay, e.by) && Y <= Math.max(e.ay, e.by)) {
      for (const pi of touched) parity[pi] = 0;
      return true;
    }
    // half-open crossing test toward +x
    if ((e.ay > Y) !== (e.by > Y)) {
      const xi = e.ax + ((Y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax);
      if (xi > X) {
        if (!parity[e.pi]) touched.push(e.pi);
        parity[e.pi] ^= 1;
      }
    }
  }
  let winding = 0;
  for (const pi of touched) {
    if (parity[pi]) winding += idx.signs[pi];
    parity[pi] = 0;
  }
  return winding > 0;
}

function unitFactorOf(op, job) {
  const from = op.units ?? job.units;
  if (from === job.units) return 1;
  return from === 'mm' ? 1 / 25.4 : 25.4;
}

const fmt3 = n => Number(n).toFixed(3);
const round3 = n => Math.round(n * 1000) / 1000;
const finite = b => Number.isFinite(b.minX);
