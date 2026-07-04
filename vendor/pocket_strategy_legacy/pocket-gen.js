// Pocket toolpath generation — contour-parallel and raster strategies
// Handles self-intersecting offsets by splitting into valid sub-regions.

import { pointInRing, signedArea, distanceToSegment } from './polygon-utils.js';

/**
 * Line-line intersection (2D). Returns {x, y, t, u} or null.
 * t is parameter along segment 1, u along segment 2.
 */
function segSegIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8) {
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
  }
  return null;
}

/**
 * Infinite line-line intersection for computing offset vertices.
 */
function lineLineIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/**
 * Compute raw offset vertices for a ring (vertex-bisector method).
 * Does NOT handle self-intersections — caller must check and split.
 */
function rawOffsetRing(ring, distance, edgeTypes) {
  const n = ring.length;
  if (n < 3) return null;

  const area = signedArea(ring);
  const ccw = area > 0;

  // Build offset edges
  const offsetEdges = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[j].x - ring[i].x;
    const dy = ring[j].y - ring[i].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) continue;

    let nx = -dy / len;
    let ny = dx / len;
    if (!ccw) { nx = -nx; ny = -ny; }

    const edgeType = edgeTypes && edgeTypes[i] ? edgeTypes[i] : 'wall';
    const d = edgeType === 'open' ? -distance : distance;

    offsetEdges.push({
      x1: ring[i].x + nx * d,
      y1: ring[i].y + ny * d,
      x2: ring[j].x + nx * d,
      y2: ring[j].y + ny * d,
      origIdx: i,
    });
  }

  if (offsetEdges.length < 3) return null;

  // Intersect consecutive offset edges to find new vertices
  const result = [];
  for (let i = 0; i < offsetEdges.length; i++) {
    const e1 = offsetEdges[i];
    const e2 = offsetEdges[(i + 1) % offsetEdges.length];
    const pt = lineLineIntersect(e1.x1, e1.y1, e1.x2, e1.y2, e2.x1, e2.y1, e2.x2, e2.y2);
    if (pt) {
      // Accept the miter vertex if it lands inside the polygon being offset.
      // For acute vertices the miter travels far along the bisector but is
      // still geometrically valid.  Only fall back to the edge-midpoint when
      // the miter escapes outside (degenerate / near-parallel edges).
      if (pointInRing(pt.x, pt.y, ring)) {
        result.push(pt);
      } else {
        result.push({ x: (e1.x2 + e2.x1) / 2, y: (e1.y2 + e2.y1) / 2 });
      }
    } else {
      result.push({ x: e1.x2, y: e1.y2 });
    }
  }

  if (result.length < 3) return null;
  return result;
}

/**
 * Find all self-intersection points in a polygon ring.
 * Returns array of { i, j, pt, ti, tj } where edge i and edge j cross.
 */
function findSelfIntersections(ring) {
  const n = ring.length;
  const crossings = [];

  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent edges (wrap)
      const j2 = (j + 1) % n;
      const hit = segSegIntersect(
        ring[i].x, ring[i].y, ring[i2].x, ring[i2].y,
        ring[j].x, ring[j].y, ring[j2].x, ring[j2].y
      );
      if (hit) {
        crossings.push({ i, j, pt: { x: hit.x, y: hit.y }, ti: hit.t, tj: hit.u });
      }
    }
  }

  return crossings;
}

/**
 * Recursively split a ring at self-intersections until all resulting
 * loops are simple (non-self-intersecting).
 *
 * For each crossing, extract the two loops on either side, then recurse
 * on any that still self-intersect.
 */
function splitToSimple(ring, depth) {
  if (depth > 20) return [ring]; // safety limit

  const crossings = findSelfIntersections(ring);
  if (crossings.length === 0) return [ring]; // already simple

  const n = ring.length;
  const candidates = [];

  for (const c of crossings) {
    // Loop 1: crossing → edges i+1 … j → close
    const loop1 = [{ x: c.pt.x, y: c.pt.y }];
    for (let k = (c.i + 1) % n; ; k = (k + 1) % n) {
      loop1.push({ x: ring[k].x, y: ring[k].y });
      if (k === c.j) break;
      if (loop1.length > n) break;
    }
    if (loop1.length >= 3) candidates.push(loop1);

    // Loop 2: crossing → edges j+1 … i → close
    const loop2 = [{ x: c.pt.x, y: c.pt.y }];
    for (let k = (c.j + 1) % n; ; k = (k + 1) % n) {
      loop2.push({ x: ring[k].x, y: ring[k].y });
      if (k === c.i) break;
      if (loop2.length > n) break;
    }
    if (loop2.length >= 3) candidates.push(loop2);
  }

  // Recurse on each candidate — simple ones return as-is,
  // complex ones get split further
  const results = [];
  for (const sub of candidates) {
    if (sub.length < 3) continue;
    if (Math.abs(signedArea(sub)) < 1e-6) continue;
    results.push(...splitToSimple(sub, depth + 1));
  }
  return results;
}

/**
 * Split a self-intersecting ring into valid sub-rings.
 * Uses recursive splitting to handle multiple crossings,
 * then filters by handedness and boundary containment.
 */
function splitAtIntersections(ring, crossings, originalBoundary, expectPositive, returnAll) {
  if (crossings.length === 0) return [ring];

  // Recursively split a ring at its self-intersections until all
  // resulting loops are simple (non-self-intersecting).
  const simpleLoops = splitToSimple(ring, 0);

  // Filter simple loops
  const validRings = [];
  for (const sub of simpleLoops) {
    if (sub.length < 3) continue;
    const area = signedArea(sub);
    if (Math.abs(area) < 1e-6) continue;

    if (!returnAll) {
      // Only keep sub-rings whose handedness matches the parent.
      if ((area > 0) !== expectPositive) continue;

      // Check that centroid is inside the original boundary
      if (originalBoundary) {
        const cx = sub.reduce((s, p) => s + p.x, 0) / sub.length;
        const cy = sub.reduce((s, p) => s + p.y, 0) / sub.length;
        if (!pointInRing(cx, cy, originalBoundary)) continue;
      }
    }

    // Deduplicate (same sub-ring can be extracted multiple times)
    const cx = sub.reduce((s, p) => s + p.x, 0) / sub.length;
    const cy = sub.reduce((s, p) => s + p.y, 0) / sub.length;
    let isDup = false;
    for (const existing of validRings) {
      if (Math.abs(Math.abs(signedArea(existing)) - Math.abs(area)) < 1e-4) {
        const ecx = existing.reduce((s, p) => s + p.x, 0) / existing.length;
        const ecy = existing.reduce((s, p) => s + p.y, 0) / existing.length;
        if (Math.hypot(cx - ecx, cy - ecy) < 1e-4) {
          isDup = true;
          break;
        }
      }
    }
    if (!isDup) validRings.push(sub);
  }

  return validRings;
}

/**
 * Offset a ring inward, handling self-intersections by splitting.
 * Returns an array of valid sub-rings (may be 0, 1, or multiple).
 */
export function offsetRingWithSplit(ring, distance, edgeTypes, originalBoundary, debugCollector) {
  const raw = rawOffsetRing(ring, distance, edgeTypes);
  if (!raw || raw.length < 3) return [];

  // Check for self-intersections
  const crossings = findSelfIntersections(raw);

  // Determine expected handedness from parent ring
  const parentPositive = signedArea(ring) > 0;

  if (crossings.length > 0 && debugCollector) {
    // Collect individual sub-rings tagged with handedness for debug visualization
    const allSubs = splitAtIntersections(raw, crossings, null, parentPositive, true);
    for (const sub of allSubs) {
      const area = signedArea(sub);
      const matches = (area > 0) === parentPositive;
      debugCollector.push({ ring: sub, valid: matches });
    }
  }

  if (crossings.length === 0) {
    // No self-intersection — only keep if handedness matches parent.
    // A flipped result means the offset inverted past center — reject it.
    const area = signedArea(raw);
    if (Math.abs(area) < 1e-6) return [];
    if ((area > 0) !== parentPositive) return [];

    // Validate inside original boundary
    if (originalBoundary) {
      const cx = raw.reduce((s, p) => s + p.x, 0) / raw.length;
      const cy = raw.reduce((s, p) => s + p.y, 0) / raw.length;
      if (!pointInRing(cx, cy, originalBoundary)) return [];
    }

    return [raw];
  }

  // Self-intersecting: split into valid sub-rings.
  // splitAtIntersections filters by handedness — only matching sub-rings survive.
  return splitAtIntersections(raw, crossings, originalBoundary, parentPositive);
}

/**
 * Legacy single-ring offset (for backward compatibility).
 */
export function offsetRing(ring, distance, edgeTypes) {
  const results = offsetRingWithSplit(ring, distance, edgeTypes, null);
  return results.length > 0 ? results[0] : null;
}

/**
 * Generate depth passes array.
 */
export function generateDepths(totalDepth, depthPerPass) {
  const n = Math.max(1, Math.ceil(totalDepth / depthPerPass));
  const actual = totalDepth / n;
  const depths = [];
  for (let i = 1; i <= n; i++) {
    depths.push(Math.min(i * actual, totalDepth));
  }
  return depths;
}

/**
 * Compute the perimeter (total edge length) of a ring.
 */
function ringPerimeter(ring) {
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    len += Math.hypot(ring[j].x - ring[i].x, ring[j].y - ring[i].y);
  }
  return len;
}

/**
 * Approximate average half-width of a region: area / perimeter.
 * For a strip of width W and length L: area≈WL, perimeter≈2L, so area/perimeter≈W/2.
 * When this is less than bitRadius, the parent's cutting band already covers
 * the full width of this region — no inner passes needed.
 */
function hydraulicRadius(ring) {
  const perim = ringPerimeter(ring);
  if (perim < 1e-10) return 0;
  return Math.abs(signedArea(ring)) / perim;
}

/**
 * Find the index of the vertex in `ring` closest to (px, py).
 */
function closestVertexIndex(ring, px, py) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - px, ring[i].y - py);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Emit linear moves tracing a contour starting from index 0.
 */
function traceContour(moves, contour, z, feedRate) {
  for (let i = 1; i < contour.length; i++) {
    moves.push({ type: 'linear', x: contour[i].x, y: contour[i].y, z, feedRate });
  }
  moves.push({ type: 'linear', x: contour[0].x, y: contour[0].y, z, feedRate });
}

/**
 * Emit linear moves tracing a contour starting from a given index,
 * wrapping around to close the loop back to that index.
 */
function traceContourFrom(moves, contour, startIdx, z, feedRate) {
  const n = contour.length;
  for (let step = 1; step < n; step++) {
    const i = (startIdx + step) % n;
    moves.push({ type: 'linear', x: contour[i].x, y: contour[i].y, z, feedRate });
  }
  // Close loop back to start
  moves.push({ type: 'linear', x: contour[startIdx].x, y: contour[startIdx].y, z, feedRate });
}

/**
 * Contour-parallel pocket with recursive subdivision.
 *
 * When an offset self-intersects, it splits into sub-regions (islands).
 * Each island is completed fully before moving to the next, avoiding
 * back-and-forth travel between distant areas.
 *
 * Ordering:
 *   1. Shared outer contours (before any split) — outside-in
 *   2. First island's contours — outside-in
 *   3. Second island's contours — outside-in
 *   (islands may recursively subdivide further)
 */
export function generateContourPocket(boundary, edgeTypes, tool, totalDepth, depthPerPass, stepoverPct, safeZ) {
  const bitRadius = tool.diameter / 2;
  const stepover = tool.diameter * (stepoverPct / 100);
  const depths = generateDepths(totalDepth, depthPerPass);
  const moves = [];

  // Each contour is tagged with a groupId:
  //   group 0 = shared outer contours (before any split)
  //   group N = all contours belonging to island N
  // When a ring produces multiple sub-rings, each gets a new group.
  // When it produces exactly one, the child inherits the parent's group.

  const contours = []; // { ring, groupId }
  const failedOffsets = []; // raw self-intersecting offsets (for debug visualization)
  const MAX_LEVELS = 500;
  let nextGroupId = 1;

  let activeRings = [{ ring: boundary, edgeTypes, groupId: 0 }];

  for (let level = 0; level < MAX_LEVELS; level++) {
    const dist = level === 0 ? bitRadius : stepover;
    const nextActive = [];

    for (const { ring, edgeTypes: et, groupId } of activeRings) {
      const subRings = offsetRingWithSplit(ring, dist, et, boundary, failedOffsets);

      // Filter sub-rings: must actually shrink, and must enclose enough
      // area to be worth cutting.  The overlap area is the portion of the
      // bit cross-section that re-cuts already-machined material:
      //   overlapArea = (1 - stepoverPct/100) × π × bitRadius²
      // Loops smaller than 50% of this are too tiny to matter.
      const valid = [];
      const parentArea = Math.abs(signedArea(ring));
      const overlapArea = (1 - stepoverPct / 100) * Math.PI * bitRadius * bitRadius;
      const minArea = overlapArea * 0.5;

      for (const sub of subRings) {
        if (Math.abs(signedArea(sub)) >= parentArea - 1e-6) continue; // didn't shrink
        if (Math.abs(signedArea(sub)) < minArea) continue; // too small to matter
        if (hydraulicRadius(sub) < bitRadius * 0.5) {
          // Too narrow for further offsets, but trace as a final contour
          valid.push(sub);
          continue;
        }
        valid.push(sub);
      }

      if (valid.length === 0) {
        // No children at all — parent is done
      } else if (valid.length === 1) {
        // Single child inherits parent's group
        contours.push({ ring: valid[0], groupId });
        nextActive.push({ ring: valid[0], edgeTypes: null, groupId });
      } else if (valid.length > 1) {
        // Split produced multiple sub-rings.  All go into the parent
        // group — the move generator will decide which to approach at
        // depth (nearest to tool) vs rapid (orphans), based on tool
        // position at cut time.
        // Only wide-enough sub-rings continue offsetting.
        for (const sub of valid) {
          contours.push({ ring: sub, groupId });
          if (hydraulicRadius(sub) >= bitRadius * 0.5) {
            nextActive.push({ ring: sub, edgeTypes: null, groupId });
          }
        }
      }
    }

    if (nextActive.length === 0) break;
    activeRings = nextActive;
  }

  if (contours.length === 0) {
    const cx = boundary.reduce((s, p) => s + p.x, 0) / boundary.length;
    const cy = boundary.reduce((s, p) => s + p.y, 0) / boundary.length;
    for (const depth of depths) {
      moves.push({ type: 'comment', text: `Depth pass z=${(-depth).toFixed(4)}` });
      moves.push({ type: 'rapid', z: safeZ });
      moves.push({ type: 'rapid', x: cx, y: cy });
      moves.push({ type: 'linear', z: -depth, feedRate: tool.plungeRate });
      moves.push({ type: 'rapid', z: safeZ });
    }
    return { moves, contours: contours.map(c => c.ring) };
  }

  // Group contours by groupId, preserving generation order (outside-in)
  const groupMap = new Map();
  for (const c of contours) {
    if (!groupMap.has(c.groupId)) groupMap.set(c.groupId, []);
    groupMap.get(c.groupId).push(c.ring);
  }

  const mainContours = (groupMap.get(0) || []).slice().reverse(); // inside-out order
  const islandGroups = [];
  for (const [gid, rings] of groupMap) {
    if (gid !== 0) islandGroups.push(rings.slice().reverse());
  }

  // Flat contour list for preview
  const orderedContours = [...mainContours, ...islandGroups.flat()];

  // Generate moves: cut contours inside-out, interleaving islands when
  // the tool passes near them.
  for (const depth of depths) {
    const z = -depth;
    moves.push({ type: 'comment', text: `Depth pass z=${z.toFixed(4)}` });

    const pendingIslands = islandGroups.map((rings, i) => ({ rings, idx: i }));
    let toolPos = null;

    // Helper: cut an island group inline (step in, clear all rings, step out)
    function cutIslandInline(island) {
      for (const contour of island.rings) {
        const startIdx = closestVertexIndex(contour, toolPos.x, toolPos.y);
        const entry = contour[startIdx];
        moves.push({ type: 'linear', x: entry.x, y: entry.y, z, feedRate: tool.feedRate });
        traceContourFrom(moves, contour, startIdx, z, tool.feedRate);
        toolPos = { x: entry.x, y: entry.y };
      }
    }

    // Helper: find the nearest pending island to the current tool position
    function findNearestIsland() {
      if (pendingIslands.length === 0 || !toolPos) return null;
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < pendingIslands.length; i++) {
        const outerRing = pendingIslands[i].rings[0];
        const ci = closestVertexIndex(outerRing, toolPos.x, toolPos.y);
        const d = Math.hypot(outerRing[ci].x - toolPos.x, outerRing[ci].y - toolPos.y);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx >= 0 ? bestIdx : null;
    }

    // Cut main contours.  After a split, multiple contours exist at the
    // same level.  Pick the nearest to the tool for at-depth approach;
    // orphans farther away get rapid/plunge when reached later.
    const pendingMain = mainContours.map((ring, i) => ({ ring, idx: i }));

    while (pendingMain.length > 0) {
      let pickIdx = 0;

      if (toolPos !== null) {
        // Find nearest pending contour to current tool position
        let bestDist = Infinity;
        for (let i = 0; i < pendingMain.length; i++) {
          const ci = closestVertexIndex(pendingMain[i].ring, toolPos.x, toolPos.y);
          const d = Math.hypot(pendingMain[i].ring[ci].x - toolPos.x,
                               pendingMain[i].ring[ci].y - toolPos.y);
          if (d < bestDist) { bestDist = d; pickIdx = i; }
        }
      }

      const contour = pendingMain[pickIdx].ring;
      pendingMain.splice(pickIdx, 1);

      if (toolPos === null) {
        // First contour: retract + rapid + plunge
        moves.push({ type: 'rapid', z: safeZ });
        moves.push({ type: 'rapid', x: contour[0].x, y: contour[0].y });
        moves.push({ type: 'linear', z, feedRate: tool.plungeRate });
        traceContour(moves, contour, z, tool.feedRate);
        toolPos = { x: contour[0].x, y: contour[0].y };
      } else {
        const startIdx = closestVertexIndex(contour, toolPos.x, toolPos.y);
        const entry = contour[startIdx];
        const dist = Math.hypot(entry.x - toolPos.x, entry.y - toolPos.y);

        if (dist < stepover * 3) {
          // Close enough — move at depth (inline continuation)
          moves.push({ type: 'linear', x: entry.x, y: entry.y, z, feedRate: tool.feedRate });
        } else {
          // Orphan — rapid to it
          moves.push({ type: 'rapid', z: safeZ });
          moves.push({ type: 'rapid', x: entry.x, y: entry.y });
          moves.push({ type: 'linear', z, feedRate: tool.plungeRate });
        }
        traceContourFrom(moves, contour, startIdx, z, tool.feedRate);
        toolPos = { x: entry.x, y: entry.y };
      }

      // After this ring, check if any pending island is nearby — clear it now
      const nearIdx = findNearestIsland();
      if (nearIdx !== null) {
        const island = pendingIslands[nearIdx];
        const outerRing = island.rings[0];
        const closestPt = outerRing[closestVertexIndex(outerRing, toolPos.x, toolPos.y)];
        const d = Math.hypot(closestPt.x - toolPos.x, closestPt.y - toolPos.y);

        if (d < stepover * 3) {
          moves.push({ type: 'comment', text: `Inline island detour` });
          cutIslandInline(island);
          pendingIslands.splice(nearIdx, 1);
        }
      }
    }

    // Any remaining islands that weren't close enough to interleave
    for (const island of pendingIslands) {
      moves.push({ type: 'rapid', z: safeZ });
      const outerRing = island.rings[0];
      moves.push({ type: 'rapid', x: outerRing[0].x, y: outerRing[0].y });
      moves.push({ type: 'linear', z, feedRate: tool.plungeRate });
      traceContour(moves, outerRing, z, tool.feedRate);
      toolPos = { x: outerRing[0].x, y: outerRing[0].y };

      for (let ri = 1; ri < island.rings.length; ri++) {
        const contour = island.rings[ri];
        const startIdx = closestVertexIndex(contour, toolPos.x, toolPos.y);
        const entry = contour[startIdx];
        moves.push({ type: 'linear', x: entry.x, y: entry.y, z, feedRate: tool.feedRate });
        traceContourFrom(moves, contour, startIdx, z, tool.feedRate);
        toolPos = { x: entry.x, y: entry.y };
      }
    }

    if (toolPos) {
      moves.push({ type: 'rapid', z: safeZ });
    }
  }

  return { moves, contours: orderedContours, failedOffsets };
}

/** Point-to-segment distance (2D). */
function ptSegDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Raster/zigzag pocket: horizontal scan lines within the boundary.
 */
export function generateRasterPocket(boundary, edgeTypes, tool, totalDepth, depthPerPass, stepoverPct, safeZ) {
  const bitRadius = tool.diameter / 2;
  const stepover = tool.diameter * (stepoverPct / 100);
  const depths = generateDepths(totalDepth, depthPerPass);
  const moves = [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of boundary) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const scanMinY = minY + bitRadius;
  const scanMaxY = maxY - bitRadius;

  const rasterLines = [];
  let y = scanMinY;
  while (y <= scanMaxY + 1e-6) {
    const segments = scanLineIntersections(boundary, edgeTypes, y, bitRadius);
    if (segments.length > 0) {
      rasterLines.push({ y, segments });
    }
    y += stepover;
  }

  for (const depth of depths) {
    const z = -depth;
    moves.push({ type: 'comment', text: `Raster depth pass z=${z.toFixed(4)}` });

    let forward = true;
    let firstMove = true;

    for (const line of rasterLines) {
      for (const seg of line.segments) {
        const x1 = forward ? seg.x1 : seg.x2;
        const x2 = forward ? seg.x2 : seg.x1;

        if (firstMove) {
          moves.push({ type: 'rapid', z: safeZ });
          moves.push({ type: 'rapid', x: x1, y: line.y });
          moves.push({ type: 'linear', z, feedRate: tool.plungeRate });
          firstMove = false;
        } else {
          moves.push({ type: 'rapid', z: safeZ });
          moves.push({ type: 'rapid', x: x1, y: line.y });
          moves.push({ type: 'linear', z, feedRate: tool.plungeRate });
        }

        moves.push({ type: 'linear', x: x2, y: line.y, z, feedRate: tool.feedRate });
      }
      forward = !forward;
    }
  }

  moves.push({ type: 'rapid', z: safeZ });

  return { moves, contours: [] };
}

/**
 * Find X-range segments where a horizontal scan line at Y is inside the boundary.
 */
function scanLineIntersections(boundary, edgeTypes, y, bitRadius) {
  const n = boundary.length;
  const xCrossings = [];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const yi = boundary[i].y, yj = boundary[j].y;
    if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
      const t = (y - yi) / (yj - yi);
      const x = boundary[i].x + t * (boundary[j].x - boundary[i].x);
      xCrossings.push(x);
    }
  }

  xCrossings.sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < xCrossings.length - 1; i += 2) {
    let x1 = xCrossings[i] + bitRadius;
    let x2 = xCrossings[i + 1] - bitRadius;
    if (x2 > x1) {
      segments.push({ x1, x2 });
    }
  }

  return segments;
}
