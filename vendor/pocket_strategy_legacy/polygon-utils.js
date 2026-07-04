// Polygon utility functions

/**
 * Ray-casting point-in-polygon test.
 * polygon is an array of {x, y} forming a closed ring.
 */
export function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Test if point is inside polygon (outer boundary minus holes).
 */
export function pointInPolygon(px, py, polygon) {
  if (!pointInRing(px, py, polygon.outer)) return false;
  for (const hole of polygon.holes) {
    if (pointInRing(px, py, hole)) return false;
  }
  return true;
}

/**
 * Signed area of a polygon ring.
 * Positive = counter-clockwise, negative = clockwise.
 */
export function signedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return area / 2;
}

/**
 * Build a nesting tree from closed rings and group them into polygons
 * using the even-odd fill rule (containment-based, winding-independent).
 *
 * Each ring's nesting depth = how many other rings contain it.
 * Even depth (0, 2, 4...) = outer (carved region).
 * Odd depth  (1, 3, 5...) = hole (empty region, subtracted from parent).
 *
 * @param {Array<Array<{x:number, y:number}>>} rings
 * @returns {Array<{outer: Array<{x,y}>, holes: Array<Array<{x,y}>>}>}
 */
export function buildNestingTree(rings) {
  console.group('=== buildNestingTree ===');
  console.log('Input rings:', rings.length);

  if (rings.length === 0) { console.groupEnd(); return []; }
  if (rings.length === 1) {
    console.log('Single ring — returning as lone outer');
    console.groupEnd();
    return [{ outer: rings[0], holes: [] }];
  }

  // Compute metadata for each ring
  const ringData = rings.map((ring, index) => ({
    ring,
    index,
    area: Math.abs(signedArea(ring)),
    depth: 0,
    parentIndex: -1,
  }));

  for (let i = 0; i < ringData.length; i++) {
    console.log(`  Ring ${i}: ${ringData[i].ring.length} pts, area=${ringData[i].area.toFixed(2)}`);
  }

  // Determine nesting depth: count how many other rings contain this ring
  for (let i = 0; i < ringData.length; i++) {
    const testPoint = ringData[i].ring[0];
    let containCount = 0;
    for (let j = 0; j < ringData.length; j++) {
      if (i === j) continue;
      if (pointInRing(testPoint.x, testPoint.y, ringData[j].ring)) {
        containCount++;
      }
    }
    ringData[i].depth = containCount;
    console.log(`  Ring ${i}: depth=${containCount} (testPt: ${testPoint.x.toFixed(3)}, ${testPoint.y.toFixed(3)})`);
  }

  // Find each ring's parent: smallest-area containing ring at depth-1
  for (let i = 0; i < ringData.length; i++) {
    if (ringData[i].depth === 0) continue;
    const testPoint = ringData[i].ring[0];
    let bestParent = -1;
    let bestParentArea = Infinity;
    for (let j = 0; j < ringData.length; j++) {
      if (i === j) continue;
      if (ringData[j].depth !== ringData[i].depth - 1) continue;
      if (!pointInRing(testPoint.x, testPoint.y, ringData[j].ring)) continue;
      if (ringData[j].area < bestParentArea) {
        bestParentArea = ringData[j].area;
        bestParent = j;
      }
    }
    ringData[i].parentIndex = bestParent;
    console.log(`  Ring ${i}: parent=${bestParent}`);
  }

  // Build polygon groupings: even-depth rings are outers, odd-depth are holes
  const polygons = [];
  const outerIndexToPolyIndex = new Map();

  for (let i = 0; i < ringData.length; i++) {
    if (ringData[i].depth % 2 === 0) {
      outerIndexToPolyIndex.set(i, polygons.length);
      polygons.push({ outer: ringData[i].ring, holes: [] });
      console.log(`  Ring ${i} → OUTER (polygon ${polygons.length - 1})`);
    }
  }

  for (let i = 0; i < ringData.length; i++) {
    if (ringData[i].depth % 2 !== 1) continue;
    const parentIdx = ringData[i].parentIndex;
    if (parentIdx !== -1 && outerIndexToPolyIndex.has(parentIdx)) {
      const polyIdx = outerIndexToPolyIndex.get(parentIdx);
      polygons[polyIdx].holes.push(ringData[i].ring);
      console.log(`  Ring ${i} → HOLE of polygon ${polyIdx}`);
    } else {
      console.log(`  Ring ${i} → ORPHAN HOLE (parent=${parentIdx}), skipped`);
    }
  }

  console.log('Result:', polygons.length, 'polygon(s)');
  for (let i = 0; i < polygons.length; i++) {
    console.log(`  Polygon ${i}: outer=${polygons[i].outer.length} pts, holes=${polygons[i].holes.length}`);
  }
  console.groupEnd();
  return polygons;
}

/**
 * Bounding box of a set of points.
 */
export function computeBounds(points) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Bounding box of an array of polygons.
 */
export function computePolygonsBounds(polygons) {
  const allPoints = [];
  for (const poly of polygons) {
    allPoints.push(...poly.outer);
    for (const hole of poly.holes) {
      allPoints.push(...hole);
    }
  }
  return computeBounds(allPoints);
}

/**
 * Uniformly resample a polyline at the given spacing.
 * Returns an array of {x, y} points.
 */
export function samplePolyline(points, spacing) {
  if (points.length < 2) return [...points];

  const result = [{ x: points[0].x, y: points[0].y }];
  let accumulated = 0;

  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-10) continue;

    const ux = dx / segLen;
    const uy = dy / segLen;
    let remaining = segLen;
    let startX = points[i - 1].x;
    let startY = points[i - 1].y;

    // Distance needed to reach next sample point
    let needed = spacing - accumulated;

    while (remaining >= needed) {
      startX += ux * needed;
      startY += uy * needed;
      result.push({ x: startX, y: startY });
      remaining -= needed;
      accumulated = 0;
      needed = spacing;
    }

    accumulated += remaining;
  }

  return result;
}

/**
 * Distance from point (px, py) to the line segment (ax, ay)-(bx, by).
 */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Minimum distance from point to a polygon boundary (all edges of outer + holes).
 */
export function distanceToBoundary(px, py, polygon) {
  let minDist = Infinity;

  const checkRing = (ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distanceToSegment(px, py, ring[j].x, ring[j].y, ring[i].x, ring[i].y);
      if (d < minDist) minDist = d;
    }
  };

  checkRing(polygon.outer);
  for (const hole of polygon.holes) {
    checkRing(hole);
  }

  return minDist;
}

/**
 * Build a spatial grid for fast nearest-point queries.
 */
export function buildSpatialGrid(points, cellSize) {
  const grid = new Map();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = Math.floor(p.x / cellSize);
    const cy = Math.floor(p.y / cellSize);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }
  return { grid, cellSize };
}

/**
 * Find the nearest point in the spatial grid.
 */
export function nearestInGrid(spatialGrid, x, y) {
  const { grid, cellSize } = spatialGrid;
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  let minDist = Infinity;
  let nearest = null;

  for (let r = 0; r <= 5; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r && r > 0) continue;
        const key = `${cx + dx},${cy + dy}`;
        const cell = grid.get(key);
        if (!cell) continue;
        for (const p of cell) {
          const d = Math.hypot(x - p.x, y - p.y);
          if (d < minDist) {
            minDist = d;
            nearest = p;
          }
        }
      }
    }
    if (minDist < (r + 1) * cellSize) break;
  }

  return { point: nearest, dist: minDist };
}
