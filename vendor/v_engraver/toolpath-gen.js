// Toolpath generation from medial axis data
// Converts medial axis branches into CNC move sequences with V-bit Z mapping.

import { pointInPolygon, pointInRing, computeBounds, distanceToSegment, distanceToBoundary, signedArea } from './polygon-utils.js';

/**
 * Generate V-engraving toolpath moves from the medial axis.
 *
 * Uses depth-first traversal with backtracking: when a branch ends at a
 * dead-end, the tool retraces back to the junction (at cutting depth) and
 * continues down the next branch — avoiding retract/rapid/plunge cycles.
 *
 * @param {Object} medialAxis - { branches: [[ {x, y, radius}, ... ], ...] }
 * @param {Object} vBit - { includedAngle: degrees, maxDepth: inches }
 * @param {Object} machine - { feedRate, plungeRate, safeZ, rpm }
 * @returns {Array} Array of move objects
 */
export function generateVEngraveToolpath(medialAxis, vBit, machine) {
  const halfAngle = (vBit.includedAngle / 2) * Math.PI / 180;
  const tanHalfAngle = Math.tan(halfAngle);
  const maxRadius = vBit.maxDepth * tanHalfAngle;
  const safeZ = machine.safeZ;

  const moves = [];
  moves.push({ type: 'comment', text: 'V-Engrave toolpath' });
  moves.push({ type: 'comment', text: `V-bit: ${vBit.includedAngle} deg, max depth: ${vBit.maxDepth}` });

  const branches = medialAxis.branches;
  if (branches.length === 0) {
    moves.push({ type: 'rapid', z: safeZ });
    return moves;
  }

  // Build a graph of branch connectivity at junction/endpoint nodes.
  // Two branch endpoints are "the same node" if they're within a tolerance.
  const TOL = 1e-6;
  function ptKey(p) {
    // Snap to grid to merge nearby endpoints
    const gx = Math.round(p.x / TOL) * TOL;
    const gy = Math.round(p.y / TOL) * TOL;
    return `${gx.toFixed(8)},${gy.toFixed(8)}`;
  }

  // For each branch, record its two endpoint keys and the branch index.
  // adj maps nodeKey -> [{ branchIdx, otherEndKey, startEnd }]
  const adj = new Map();
  const branchEndpoints = []; // [{ startKey, endKey }]

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    if (b.length < 2) continue;
    const sk = ptKey(b[0]);
    const ek = ptKey(b[b.length - 1]);
    branchEndpoints[i] = { startKey: sk, endKey: ek };

    if (!adj.has(sk)) adj.set(sk, []);
    if (!adj.has(ek)) adj.set(ek, []);
    adj.get(sk).push({ branchIdx: i, otherEndKey: ek, enterFromStart: true });
    adj.get(ek).push({ branchIdx: i, otherEndKey: sk, enterFromStart: false });
  }

  // Group branches into connected components (trees/subgraphs).
  const visitedBranches = new Set();
  const components = []; // each is an array of branch indices

  for (let i = 0; i < branches.length; i++) {
    if (visitedBranches.has(i) || branches[i].length < 2) continue;
    const component = [];
    const stack = [i];
    while (stack.length > 0) {
      const bi = stack.pop();
      if (visitedBranches.has(bi)) continue;
      visitedBranches.add(bi);
      component.push(bi);
      const ep = branchEndpoints[bi];
      if (!ep) continue;
      for (const key of [ep.startKey, ep.endKey]) {
        const neighbors = adj.get(key);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (!visitedBranches.has(nb.branchIdx)) {
            stack.push(nb.branchIdx);
          }
        }
      }
    }
    components.push(component);
  }

  // Order components by nearest-neighbor from current position
  let currentPos = { x: 0, y: 0 };
  const remainingComponents = components.map((comp, i) => ({ comp, idx: i }));

  function emitPoint(p) {
    const r = Math.min(p.radius, maxRadius);
    const z = -r / tanHalfAngle;
    moves.push({ type: 'linear', x: p.x, y: p.y, z });
  }

  while (remainingComponents.length > 0) {
    // Find nearest component
    let bestCI = 0;
    let bestDist = Infinity;
    for (let ci = 0; ci < remainingComponents.length; ci++) {
      for (const bi of remainingComponents[ci].comp) {
        const b = branches[bi];
        const d0 = Math.hypot(b[0].x - currentPos.x, b[0].y - currentPos.y);
        const d1 = Math.hypot(b[b.length - 1].x - currentPos.x, b[b.length - 1].y - currentPos.y);
        if (d0 < bestDist) { bestDist = d0; bestCI = ci; }
        if (d1 < bestDist) { bestDist = d1; bestCI = ci; }
      }
    }

    const comp = remainingComponents[bestCI].comp;
    remainingComponents.splice(bestCI, 1);

    // Check if this component is point-like (e.g., small circle or dot).
    // The Voronoi skeleton of a circle produces a starburst of tiny branches
    // all clustered at the center. Detect this and replace with a single plunge.
    {
      let compMaxR = 0;
      let deepestPt = null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const bi of comp) {
        for (const pt of branches[bi]) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
          if (pt.radius > compMaxR) {
            compMaxR = pt.radius;
            deepestPt = pt;
          }
        }
      }
      const extent = Math.max(maxX - minX, maxY - minY);
      const isPointLike = deepestPt && comp.length >= 5 && compMaxR > extent * 0.49;
      console.log(`Component: ${comp.length} branches, extent=${extent.toFixed(6)}, maxR=${compMaxR.toFixed(4)}, ratio=${(compMaxR / Math.max(extent, 1e-9)).toFixed(3)}, pointLike=${isPointLike}`);
      if (isPointLike) {
        // Point-like (circle/dot) — single plunge to the deepest point
        console.log(`  → PLUNGE at (${deepestPt.x.toFixed(4)}, ${deepestPt.y.toFixed(4)}), r=${deepestPt.radius.toFixed(4)}`);
        moves.push({ type: 'rapid', z: safeZ });
        moves.push({ type: 'rapid', x: deepestPt.x, y: deepestPt.y });
        emitPoint(deepestPt);
        currentPos = { x: deepestPt.x, y: deepestPt.y };
        continue;
      }
    }

    // DFS traversal of this component's branch graph.
    // Start from a leaf node (degree 1) if possible, otherwise any node.
    const compBranches = new Set(comp);
    const compVisited = new Set();

    // Find a good starting node: prefer leaf (degree 1), and prefer nearest
    let startNode = null;
    let startDist = Infinity;
    for (const bi of comp) {
      const ep = branchEndpoints[bi];
      if (!ep) continue;
      for (const key of [ep.startKey, ep.endKey]) {
        // Count how many unvisited component branches connect here
        const neighbors = adj.get(key) || [];
        const compNeighbors = neighbors.filter(n => compBranches.has(n.branchIdx));
        const isLeaf = compNeighbors.length === 1;
        const b = branches[bi];
        const endPt = key === ep.startKey ? b[0] : b[b.length - 1];
        const d = Math.hypot(endPt.x - currentPos.x, endPt.y - currentPos.y);
        // Prefer leaves, then nearest
        const priority = isLeaf ? d : d + 1e6;
        if (priority < startDist) {
          startDist = priority;
          startNode = key;
        }
      }
    }

    if (!startNode) continue;

    // DFS with backtracking
    // We maintain a stack of (nodeKey). At each node, we pick an unvisited
    // branch, traverse it, then come back (retrace) to explore more branches.
    function dfsTraverse(startNodeKey) {
      // Rapid to start position
      const startNeighbors = adj.get(startNodeKey) || [];
      const firstEdge = startNeighbors.find(n => compBranches.has(n.branchIdx) && !compVisited.has(n.branchIdx));
      if (!firstEdge) return;

      const b0 = branches[firstEdge.branchIdx];
      const startPt = firstEdge.enterFromStart ? b0[0] : b0[b0.length - 1];

      moves.push({ type: 'rapid', z: safeZ });
      moves.push({ type: 'rapid', x: startPt.x, y: startPt.y });
      emitPoint(startPt);

      dfsFromNode(startNodeKey);
    }

    function dfsFromNode(nodeKey) {
      while (true) {
        const neighbors = adj.get(nodeKey) || [];
        // Find an unvisited branch in this component
        const next = neighbors.find(n => compBranches.has(n.branchIdx) && !compVisited.has(n.branchIdx));
        if (!next) return; // All branches from this node visited

        compVisited.add(next.branchIdx);
        const b = branches[next.branchIdx];

        // Traverse the branch forward (from this node's end to the other end)
        if (next.enterFromStart) {
          // We're at start, traverse 0 -> end
          for (let i = 1; i < b.length; i++) emitPoint(b[i]);
        } else {
          // We're at end, traverse end -> 0
          for (let i = b.length - 2; i >= 0; i--) emitPoint(b[i]);
        }

        // We're now at the other end of the branch
        const otherKey = next.otherEndKey;
        currentPos = { x: moves[moves.length - 1].x, y: moves[moves.length - 1].y };

        // Recurse into the other node (explore its branches)
        dfsFromNode(otherKey);

        // Backtrack: retrace this branch back to where we started
        if (next.enterFromStart) {
          for (let i = b.length - 2; i >= 0; i--) emitPoint(b[i]);
        } else {
          for (let i = 1; i < b.length; i++) emitPoint(b[i]);
        }
        currentPos = { x: moves[moves.length - 1].x, y: moves[moves.length - 1].y };
      }
    }

    dfsTraverse(startNode);
  }

  // Final retract
  moves.push({ type: 'rapid', z: safeZ });

  return moves;
}

/**
 * Generate zigzag pocket clearing passes for flat-bottom areas.
 * When max depth is limited, the V-bit bottoms out in wide regions.
 * This generates raster passes at z = -maxDepth to clear those areas.
 *
 * @param {Array} polygons - polygon array with { outer, holes }
 * @param {Object} vBit - { includedAngle, maxDepth }
 * @param {Object} machine - { safeZ, feedRate, ... }
 * @param {number} stepover - distance between raster lines (inches)
 * @returns {Array} move objects to append to the main toolpath
 */
export function generatePocketPasses(polygons, vBit, machine, stepover) {
  const halfAngle = (vBit.includedAngle / 2) * Math.PI / 180;
  const maxRadius = vBit.maxDepth * Math.tan(halfAngle);
  const z = -vBit.maxDepth;
  const safeZ = machine.safeZ;
  const sampleStep = Math.min(stepover * 0.5, 0.02);

  console.group('=== generatePocketPasses ===');
  console.log('V-bit angle:', vBit.includedAngle, 'deg');
  console.log('maxDepth:', vBit.maxDepth, ' maxRadius:', maxRadius);
  console.log('z:', z, ' safeZ:', safeZ, ' stepover:', stepover, ' sampleStep:', sampleStep);
  console.log('Polygons:', polygons.length);

  const moves = [];
  moves.push({ type: 'comment', text: `Pocket clearing: stepover ${stepover}` });

  for (const polygon of polygons) {
    const bounds = computeBounds(polygon.outer);
    console.group('Polygon: outer=' + polygon.outer.length + ' pts, holes=' + polygon.holes.length);
    console.log('Bounds:', JSON.stringify(bounds));

    // Build a spatial grid of boundary SEGMENTS for fast distance queries
    const segments = [];
    const addRingSegments = (ring) => {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        segments.push({
          ax: ring[j].x, ay: ring[j].y,
          bx: ring[i].x, by: ring[i].y,
        });
      }
    };
    addRingSegments(polygon.outer);
    for (const hole of polygon.holes) addRingSegments(hole);

    const cellSize = Math.max(maxRadius * 1.5, 0.2);
    const segGrid = new Map();
    for (const seg of segments) {
      const sMinX = Math.min(seg.ax, seg.bx) - maxRadius;
      const sMaxX = Math.max(seg.ax, seg.bx) + maxRadius;
      const sMinY = Math.min(seg.ay, seg.by) - maxRadius;
      const sMaxY = Math.max(seg.ay, seg.by) + maxRadius;
      for (let cx = Math.floor(sMinX / cellSize); cx <= Math.floor(sMaxX / cellSize); cx++) {
        for (let cy = Math.floor(sMinY / cellSize); cy <= Math.floor(sMaxY / cellSize); cy++) {
          const key = `${cx},${cy}`;
          if (!segGrid.has(key)) segGrid.set(key, []);
          segGrid.get(key).push(seg);
        }
      }
    }

    // Fast distance-to-boundary using segment grid
    function fastDistToBoundary(px, py) {
      const gcx = Math.floor(px / cellSize);
      const gcy = Math.floor(py / cellSize);
      let minDist = Infinity;
      // Check 3x3 neighborhood (sufficient since cellSize >= maxRadius * 1.5)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = segGrid.get(`${gcx + dx},${gcy + dy}`);
          if (!cell) continue;
          for (const seg of cell) {
            const d = distanceToSegment(px, py, seg.ax, seg.ay, seg.bx, seg.by);
            if (d < minDist) minDist = d;
          }
        }
      }
      return minDist;
    }

    // --- Step 1: Collect flat raster segments by row ---
    const rows = []; // [{ y, segs: [{ x1, x2 }] }]
    for (let y = bounds.minY; y <= bounds.maxY; y += stepover) {
      const flatSegs = [];
      let inFlat = false;
      let segStart = 0;

      for (let x = bounds.minX; x <= bounds.maxX; x += sampleStep) {
        const inside = pointInPolygon(x, y, polygon);
        const flat = inside && fastDistToBoundary(x, y) >= maxRadius;

        if (flat && !inFlat) {
          segStart = x;
          inFlat = true;
        } else if (!flat && inFlat) {
          if (x - sampleStep - segStart >= sampleStep) {
            flatSegs.push({ x1: segStart, x2: x - sampleStep });
          }
          inFlat = false;
        }
      }
      if (inFlat && bounds.maxX - segStart >= sampleStep) {
        flatSegs.push({ x1: segStart, x2: bounds.maxX });
      }

      if (flatSegs.length > 0) {
        rows.push({ y, segs: flatSegs });
      }
    }

    console.log('Rows with flat segments:', rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const segStr = row.segs.map(s => `[${s.x1.toFixed(3)}..${s.x2.toFixed(3)}]`).join(', ');
      console.log(`  Row ${r}: y=${row.y.toFixed(4)} segs(${row.segs.length}): ${segStr}`);
    }

    // --- Step 2: Flatten into indexed segments with adjacency ---
    const allSegs = []; // [{ x1, x2, y, rowIdx, neighbors: [] }]
    const rowStart = []; // index into allSegs where each row begins

    for (let r = 0; r < rows.length; r++) {
      rowStart.push(allSegs.length);
      for (const seg of rows[r].segs) {
        allSegs.push({ x1: seg.x1, x2: seg.x2, y: rows[r].y, rowIdx: r, neighbors: [], visited: false });
      }
    }
    rowStart.push(allSegs.length); // sentinel

    // Two segments on adjacent rows are connected if their X ranges overlap
    for (let r = 0; r < rows.length - 1; r++) {
      const nextR = r + 1;
      // Only connect rows that are actually adjacent in Y
      if (Math.abs(rows[nextR].y - rows[r].y - stepover) > stepover * 0.5) continue;

      for (let i = rowStart[r]; i < rowStart[r + 1]; i++) {
        for (let j = rowStart[nextR]; j < rowStart[nextR + 1]; j++) {
          if (allSegs[i].x1 <= allSegs[j].x2 && allSegs[j].x1 <= allSegs[i].x2) {
            allSegs[i].neighbors.push(j);
            allSegs[j].neighbors.push(i);
          }
        }
      }
    }

    console.log('Total segments:', allSegs.length);
    for (let i = 0; i < allSegs.length; i++) {
      const s = allSegs[i];
      console.log(`  Seg ${i}: row=${s.rowIdx} y=${s.y.toFixed(4)} x=[${s.x1.toFixed(3)}..${s.x2.toFixed(3)}] neighbors=[${s.neighbors.join(',')}]`);
    }

    // --- Step 3: Group into connected pocket regions ---
    const regions = [];
    for (let i = 0; i < allSegs.length; i++) {
      if (allSegs[i].visited) continue;
      const region = [];
      const stack = [i];
      while (stack.length > 0) {
        const idx = stack.pop();
        if (allSegs[idx].visited) continue;
        allSegs[idx].visited = true;
        region.push(idx);
        for (const ni of allSegs[idx].neighbors) {
          if (!allSegs[ni].visited) stack.push(ni);
        }
      }
      regions.push(region);
    }

    console.log('Regions:', regions.length);
    for (let ri = 0; ri < regions.length; ri++) {
      console.log(`  Region ${ri}: ${regions[ri].length} segments [${regions[ri].join(',')}]`);
    }

    // --- Step 4: Cut each region as a continuous zigzag ---
    for (let ri = 0; ri < regions.length; ri++) {
      const region = regions[ri];
      console.group(`Cutting region ${ri} (${region.length} segs)`);

      // Group region segments by row and sort rows by Y
      const byRow = new Map();
      for (const idx of region) {
        const s = allSegs[idx];
        if (!byRow.has(s.rowIdx)) byRow.set(s.rowIdx, []);
        byRow.get(s.rowIdx).push(s);
      }
      const sortedRowKeys = [...byRow.keys()].sort((a, b) => a - b);

      // Check if a straight link between two points stays inside the polygon
      function linkStaysInside(x1, y1, x2, y2) {
        const dist = Math.hypot(x2 - x1, y2 - y1);
        if (dist < 1e-6) return true;
        const steps = Math.max(4, Math.ceil(dist / sampleStep));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const px = x1 + t * (x2 - x1);
          const py = y1 + t * (y2 - y1);
          // Must stay inside polygon AND inside the flat pocket zone
          // (far enough from boundary that the bit at maxDepth fits)
          if (!pointInPolygon(px, py, polygon)) return false;
          if (distanceToBoundary(px, py, polygon) < maxRadius - 1e-6) return false;
        }
        return true;
      }

      /**
       * Emit a validated raster cut from (fromX, y) to (toX, y) at depth z.
       * Samples along the line and splits at boundary crossings so we never
       * cut through material outside the polygon.
       */
      function emitValidatedCut(fromX, fromY, toX, toY) {
        const dist = Math.abs(toX - fromX);
        if (dist < 1e-6) return;
        const step = sampleStep;
        const steps = Math.max(4, Math.ceil(dist / step));

        let inSafe = true; // currently in a valid cutting zone
        let segStartX = fromX;

        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = fromX + t * (toX - fromX);
          const inside = pointInPolygon(px, toY, polygon)
                         && fastDistToBoundary(px, toY) >= maxRadius;

          if (inside && !inSafe) {
            // Entering valid zone — start a new cut segment
            segStartX = px;
            inSafe = true;
          } else if (!inside && inSafe && s > 0) {
            // Leaving valid zone — emit the cut so far, then retract
            const endX = fromX + ((s - 1) / steps) * (toX - fromX);
            moves.push({ type: 'linear', x: endX, y: toY, z });
            moves.push({ type: 'rapid', z: safeZ });
            inSafe = false;
          }
        }

        if (inSafe) {
          // Final (or only) valid segment — cut to the end
          moves.push({ type: 'linear', x: toX, y: toY, z });
        }

        return inSafe; // true if we ended at cutting depth
      }

      // Strip-based traversal: follow one continuous arm of the pocket,
      // zigzagging row-to-row via neighbors reachable at cutting depth.
      // When the strip dead-ends, retract and start the next unvisited strip.
      const visited = new Set();
      let moveCountBefore = moves.length;
      let atDepth = false; // track whether the tool is currently at cutting depth

      while (visited.size < region.length) {
        // Find unvisited starting segment: prefer lowest row, then leftmost
        let startIdx = null;
        for (const idx of region) {
          if (visited.has(idx)) continue;
          if (startIdx === null ||
              allSegs[idx].rowIdx < allSegs[startIdx].rowIdx ||
              (allSegs[idx].rowIdx === allSegs[startIdx].rowIdx && allSegs[idx].x1 < allSegs[startIdx].x1)) {
            startIdx = idx;
          }
        }
        if (startIdx === null) break;

        const startSeg = allSegs[startIdx];
        let dir = 1; // 1 = L→R, -1 = R→L

        // Rapid to strip start
        const startX = dir > 0 ? startSeg.x1 : startSeg.x2;
        moves.push({ type: 'rapid', z: safeZ });
        moves.push({ type: 'rapid', x: startX, y: startSeg.y });
        moves.push({ type: 'linear', x: startX, y: startSeg.y, z });
        atDepth = true;
        console.log(`  STRIP START: rapid to (${startX.toFixed(3)}, ${startSeg.y.toFixed(4)}), plunge to z=${z}`);

        let currentIdx = startIdx;

        while (currentIdx !== null) {
          visited.add(currentIdx);
          const seg = allSegs[currentIdx];
          const sx = dir > 0 ? seg.x1 : seg.x2;
          const ex = dir > 0 ? seg.x2 : seg.x1;

          // If we retracted during the previous cut, re-plunge at this segment's start
          if (!atDepth) {
            moves.push({ type: 'rapid', x: sx, y: seg.y });
            moves.push({ type: 'linear', x: sx, y: seg.y, z });
          }

          // Cut the raster line — validated to stay inside the polygon
          atDepth = emitValidatedCut(sx, seg.y, ex, seg.y);
          console.log(`  row=${seg.rowIdx} dir=${dir > 0 ? 'L→R' : 'R→L'}: y=${seg.y.toFixed(4)} x=[${seg.x1.toFixed(3)}..${seg.x2.toFixed(3)}] z=${z}${atDepth ? '' : ' (split!)'}`);

          // Find the best unvisited neighbor reachable at cutting depth.
          // After cutting, we're at (ex, seg.y). Next dir will be -dir,
          // so the next segment's start is: (-dir > 0) ? x1 : x2
          let bestNext = null;
          let bestDist = Infinity;
          for (const ni of seg.neighbors) {
            if (visited.has(ni)) continue;
            const ns = allSegs[ni];
            const nextSx = dir > 0 ? ns.x2 : ns.x1; // opposite dir start
            if (atDepth && linkStaysInside(ex, seg.y, nextSx, ns.y)) {
              const d = Math.hypot(ex - nextSx, seg.y - ns.y);
              if (d < bestDist) {
                bestDist = d;
                bestNext = ni;
              }
            }
          }

          if (bestNext !== null) {
            const ns = allSegs[bestNext];
            const nextSx = dir > 0 ? ns.x2 : ns.x1;
            // Link at cutting depth to next segment's start
            moves.push({ type: 'linear', x: nextSx, y: ns.y, z });
            atDepth = true;
            currentIdx = bestNext;
            dir *= -1;
          } else {
            // Dead end — strip is complete
            if (atDepth) {
              moves.push({ type: 'rapid', z: safeZ });
              atDepth = false;
            }
            console.log(`  STRIP END: no reachable unvisited neighbor`);
            currentIdx = null;
          }
        }
      }

      console.log(`  Moves emitted for region: ${moves.length - moveCountBefore}`);
      console.groupEnd();
    }
    console.groupEnd(); // polygon
  }

  if (moves.length > 1) {
    moves.push({ type: 'rapid', z: safeZ });
  }

  console.log('Total pocket moves:', moves.length);
  console.groupEnd(); // generatePocketPasses

  return moves;
}

/**
 * Inset (or outset) a polygon ring by a given distance.
 *
 * Positive distance = inward for CCW rings, outward for CW rings.
 * At convex corners (where the rolling circle rounds the vertex),
 * arc segments are inserted.  At concave corners the offset edges
 * are intersected and clipped.
 *
 * Returns an array of {x, y} forming the offset ring, or [] if the
 * ring collapses entirely.
 *
 * @param {Array} ring  - [{x,y}, ...] closed polygon ring
 * @param {number} dist - offset distance (positive = shrink CCW outer)
 * @param {number} [arcSteps=8] - line segments per 90 deg of arc
 * @returns {Array} offset ring
 */
function insetRing(ring, dist, arcSteps = 8) {
  const n = ring.length;
  if (n < 3) return [];

  // Determine winding: signedArea > 0 → CCW
  const area = signedArea(ring);
  // We want to offset toward the interior.
  // For a CCW outer ring the interior is to the LEFT of each edge.
  // Left-normal of edge direction (dx,dy) is (-dy, dx).
  // Flip sign if CW.
  const sign = area > 0 ? 1 : -1;

  // Build offset edges: each edge shifted inward by dist
  const edges = []; // { p1, p2, nx, ny } — offset segment + unit inward normal
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[j].x - ring[i].x;
    const dy = ring[j].y - ring[i].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;

    // Inward unit normal
    const nx = (-dy / len) * sign;
    const ny = (dx / len) * sign;

    edges.push({
      p1: { x: ring[i].x + nx * dist, y: ring[i].y + ny * dist },
      p2: { x: ring[j].x + nx * dist, y: ring[j].y + ny * dist },
      nx, ny,
      origIdx: i,
    });
  }

  if (edges.length < 2) return [];

  // Walk consecutive offset edges and produce vertices.
  const result = [];
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[i];
    const e2 = edges[(i + 1) % edges.length];

    // Direction vectors
    const d1x = e1.p2.x - e1.p1.x;
    const d1y = e1.p2.y - e1.p1.y;
    const d2x = e2.p2.x - e2.p1.x;
    const d2y = e2.p2.y - e2.p1.y;

    // Cross product of directions: positive = left turn (convex for CCW)
    const cross = (d1x * d2y - d1y * d2x) * sign;

    if (cross > 1e-10) {
      // Compute actual turn angle to distinguish sharp corners from
      // smooth curve segments (many small segments ≈ near-180° joints).
      const len1 = Math.hypot(d1x, d1y);
      const len2 = Math.hypot(d2x, d2y);
      const sinTurn = cross / (len1 * len2); // sin of the convex turn angle

      if (sinTurn < 0.26) {
        // Small turn (<~15°) — smooth curve joint, not a real corner.
        // Average the two offset endpoints to stay on the smooth offset curve.
        result.push({
          x: (e1.p2.x + e2.p1.x) / 2,
          y: (e1.p2.y + e2.p1.y) / 2,
        });
      } else {
        // Sharp convex corner — the V-bit dives into the corner vertex
        // and back out. The intersection of the two offset edge LINES is
        // the point equidistant from both original edges (at full depth).
        // From there the bit ramps into the corner vertex (depth → 0)
        // and back out. emitContour's depthAt() computes correct Z.
        const vertex = ring[(e1.origIdx + 1) % n];

        // Intersect the two offset edge lines to get the transition point
        const transition = lineLineIntersect(e1.p1, e1.p2, e2.p1, e2.p2);
        if (!transition) {
          // Parallel edges — fall back to endpoint
          result.push({ x: e1.p2.x, y: e1.p2.y });
          continue;
        }

        // Sample points: transition → near-vertex → transition
        // Stop ~0.001" short of the vertex to keep points strictly inside the
        // ring (the vertex itself is ON the boundary, unreliable for ray-cast
        // pointInRing).  At 0.001" the Z is essentially 0 anyway.
        const d1 = Math.hypot(vertex.x - transition.x, vertex.y - transition.y);
        const stepSize = 0.02;
        const steps1 = Math.max(2, Math.ceil(d1 / stepSize));
        const tMax = d1 > 0.002 ? 1 - 0.001 / d1 : 0.5; // stop just short of vertex

        // Ramp in: transition → near-vertex
        for (let s = 0; s <= steps1; s++) {
          const t = (s / steps1) * tMax;
          result.push({
            x: transition.x + t * (vertex.x - transition.x),
            y: transition.y + t * (vertex.y - transition.y),
          });
        }
        // Ramp out: near-vertex → transition (skip s=0, already at apex)
        for (let s = 1; s <= steps1; s++) {
          const t = 1 - ((s / steps1) * tMax);
          result.push({
            x: transition.x + t * (vertex.x - transition.x),
            y: transition.y + t * (vertex.y - transition.y),
          });
        }
      }
    } else {
      // Concave corner or collinear — intersect the two offset edges
      const pt = lineLineIntersect(e1.p1, e1.p2, e2.p1, e2.p2);
      if (pt) {
        result.push(pt);
      } else {
        // Parallel edges — just use the endpoint
        result.push({ x: e1.p2.x, y: e1.p2.y });
      }
    }
  }

  // Remove self-intersections: discard points that ended up outside the
  // original ring.  pointInRing is winding-independent (ray-cast parity),
  // so inside = true for both CW and CCW rings.
  const cleaned = result.filter(p => pointInRing(p.x, p.y, ring));
  if (cleaned.length < 3) return [];

  return cleaned;
}

/**
 * Line-line intersection of two segments (treated as infinite lines).
 * Returns {x, y} or null if parallel.
 */
function lineLineIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Generate a profile-pass toolpath that traces the inset contour of each
 * polygon at z = -maxDepth.  This is the path a rolling circle of radius
 * maxRadius would trace along the inside of the vector boundary.
 *
 * @param {Array} polygons - [{ outer, holes }]
 * @param {Object} vBit    - { includedAngle, maxDepth }
 * @param {Object} machine - { safeZ, feedRate, ... }
 * @returns {Array} move objects
 */
export function generateProfilePass(polygons, vBit, machine) {
  const halfAngle = (vBit.includedAngle / 2) * Math.PI / 180;
  const tanHA = Math.tan(halfAngle);
  const maxRadius = vBit.maxDepth * tanHA;
  const maxDepth = vBit.maxDepth;
  const safeZ = machine.safeZ;

  console.group('=== generateProfilePass ===');
  console.log('maxRadius:', maxRadius.toFixed(4), ' maxDepth:', maxDepth, ' safeZ:', safeZ);

  const moves = [];
  moves.push({ type: 'comment', text: `Profile pass: inset ${maxRadius.toFixed(4)}, maxDepth ${maxDepth.toFixed(4)}` });

  // Compute depth at a point: limited by distance to nearest boundary
  // so the V-bit cone never extends outside the polygon.
  function depthAt(px, py, polygon) {
    const dist = distanceToBoundary(px, py, polygon);
    return -Math.min(dist / tanHA, maxDepth);
  }

  // Emit a contour with per-point depth
  function emitContour(contour, polygon) {
    if (contour.length < 3) return;

    const z0 = depthAt(contour[0].x, contour[0].y, polygon);
    moves.push({ type: 'rapid', z: safeZ });
    moves.push({ type: 'rapid', x: contour[0].x, y: contour[0].y });
    moves.push({ type: 'linear', x: contour[0].x, y: contour[0].y, z: z0 });

    for (let i = 1; i < contour.length; i++) {
      const zi = depthAt(contour[i].x, contour[i].y, polygon);
      moves.push({ type: 'linear', x: contour[i].x, y: contour[i].y, z: zi });
    }
    // Close the loop
    moves.push({ type: 'linear', x: contour[0].x, y: contour[0].y, z: z0 });
  }

  for (let pi = 0; pi < polygons.length; pi++) {
    const polygon = polygons[pi];
    console.group(`Polygon ${pi}: outer=${polygon.outer.length} pts, holes=${polygon.holes.length}`);

    // Inset the outer boundary.  If maxRadius is too large for the
    // geometry (narrow features), reduce until a valid inset is found.
    let inset = [];
    let insetDist = maxRadius;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = insetRing(polygon.outer, insetDist);
      if (candidate.length >= 3) {
        inset = candidate;
        break;
      }
      // Reduce inset distance by half and retry
      insetDist *= 0.5;
      console.log(`Outer inset collapsed at dist=${(insetDist * 2).toFixed(4)}, retrying at ${insetDist.toFixed(4)}`);
    }
    console.log(`Outer inset: ${inset.length} pts (from ${polygon.outer.length} original, insetDist=${insetDist.toFixed(4)})`);
    if (inset.length >= 3) {
      for (let i = 0; i < Math.min(inset.length, 10); i++) {
        const zi = depthAt(inset[i].x, inset[i].y, polygon);
        console.log(`  pt ${i}: (${inset[i].x.toFixed(4)}, ${inset[i].y.toFixed(4)}) z=${zi.toFixed(4)}`);
      }
      if (inset.length > 10) console.log(`  ... (${inset.length - 10} more)`);

      emitContour(inset, polygon);
      console.log(`Outer profile moves emitted`);
    } else {
      console.log('Outer inset collapsed — polygon too narrow for this maxRadius');
    }

    // Outset each hole boundary (profile around holes)
    for (let hi = 0; hi < polygon.holes.length; hi++) {
      const hole = polygon.holes[hi];
      let holeInset = [];
      let holeDist = maxRadius;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = insetRing(hole, holeDist);
        if (candidate.length >= 3) {
          holeInset = candidate;
          break;
        }
        holeDist *= 0.5;
      }
      console.log(`Hole ${hi} outset: ${holeInset.length} pts (from ${hole.length} original, dist=${holeDist.toFixed(4)})`);
      if (holeInset.length >= 3) {
        emitContour(holeInset, polygon);
      }
    }
    console.groupEnd(); // polygon
  }

  if (moves.length > 1) {
    moves.push({ type: 'rapid', z: safeZ });
  }

  console.log('Total profile moves:', moves.length);
  console.groupEnd(); // generateProfilePass

  return moves;
}

/**
 * Calculate toolpath statistics.
 */
export function calculateStats(moves, feedRate) {
  let cutLength = 0;
  let rapidLength = 0;
  let moveCount = 0;
  let lastPos = { x: 0, y: 0, z: 0 };
  let minZ = 0;

  for (const move of moves) {
    if (move.type === 'comment') continue;

    const x = move.x ?? lastPos.x;
    const y = move.y ?? lastPos.y;
    const z = move.z ?? lastPos.z;

    const dist = Math.hypot(x - lastPos.x, y - lastPos.y, z - lastPos.z);

    if (move.type === 'rapid') {
      rapidLength += dist;
    } else if (move.type === 'linear') {
      cutLength += dist;
      moveCount++;
    }

    if (z < minZ) minZ = z;
    lastPos = { x, y, z };
  }

  const estTime = cutLength / feedRate; // minutes

  return {
    cutLength: cutLength.toFixed(2),
    rapidLength: rapidLength.toFixed(2),
    moveCount,
    maxDepth: Math.abs(minZ).toFixed(4),
    estTimeMin: estTime.toFixed(1),
  };
}
