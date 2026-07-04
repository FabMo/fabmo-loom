// Medial Axis computation using Voronoi diagram
// Computes the skeleton of maximal inscribed circles within each polygon.

import { Delaunay } from 'd3-delaunay';
import { pointInPolygon, samplePolyline, distanceToBoundary, computeBounds } from './polygon-utils.js';

/**
 * Compute the medial axis for all polygons.
 * Returns { branches: [{ points: [{x, y, radius}...] }...] }
 */
export function computeMedialAxis(polygons, options = {}) {
  const { maxRadius = Infinity, samplingDensity = 500 } = options;
  const allBranches = [];

  for (const polygon of polygons) {
    const branches = computePolygonMedialAxis(polygon, samplingDensity);
    for (const branch of branches) {
      const clipped = clipBranch(branch, maxRadius);
      if (clipped.length >= 2) {
        allBranches.push(clipped);
      }
    }
  }

  return { branches: allBranches };
}

/**
 * Compute medial axis for a single polygon.
 */
function computePolygonMedialAxis(polygon, samplingDensity) {
  // Step 1: Sample boundary points
  const bounds = computeBounds(polygon.outer);
  const perimeter = computePerimeter(polygon.outer);
  for (const hole of polygon.holes) {
    // perimeter already calculated for outer
  }

  const totalPerimeter = perimeter + polygon.holes.reduce((sum, h) => sum + computePerimeter(h), 0);
  const spacing = totalPerimeter / samplingDensity;

  const boundaryPoints = [];
  addSampledRing(boundaryPoints, polygon.outer, spacing);
  for (const hole of polygon.holes) {
    addSampledRing(boundaryPoints, hole, spacing);
  }

  if (boundaryPoints.length < 4) return [];

  // Step 2: Compute Delaunay triangulation
  const coords = new Float64Array(boundaryPoints.length * 2);
  for (let i = 0; i < boundaryPoints.length; i++) {
    coords[i * 2] = boundaryPoints[i].x;
    coords[i * 2 + 1] = boundaryPoints[i].y;
  }

  const delaunay = new Delaunay(coords);

  // Step 3: Extract Voronoi edges via circumcenters
  const { halfedges, triangles } = delaunay;
  const numTriangles = Math.floor(triangles.length / 3);

  // Compute circumcenters for each triangle
  const circumcenters = new Float64Array(numTriangles * 2);
  for (let t = 0; t < numTriangles; t++) {
    const i0 = triangles[t * 3];
    const i1 = triangles[t * 3 + 1];
    const i2 = triangles[t * 3 + 2];

    const x0 = coords[i0 * 2], y0 = coords[i0 * 2 + 1];
    const x1 = coords[i1 * 2], y1 = coords[i1 * 2 + 1];
    const x2 = coords[i2 * 2], y2 = coords[i2 * 2 + 1];

    const cc = circumcenter(x0, y0, x1, y1, x2, y2);
    circumcenters[t * 2] = cc.x;
    circumcenters[t * 2 + 1] = cc.y;
  }

  // Step 4: Extract and filter Voronoi edges
  const edges = [];
  const seen = new Set();

  for (let e = 0; e < halfedges.length; e++) {
    const opp = halfedges[e];
    if (opp === -1) continue; // hull edge
    if (opp < e) continue;   // avoid duplicates

    const t1 = Math.floor(e / 3);
    const t2 = Math.floor(opp / 3);

    const key = t1 < t2 ? `${t1},${t2}` : `${t2},${t1}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const x1 = circumcenters[t1 * 2], y1 = circumcenters[t1 * 2 + 1];
    const x2 = circumcenters[t2 * 2], y2 = circumcenters[t2 * 2 + 1];

    // Skip degenerate edges
    if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;

    // Filter: both endpoints must be inside the polygon
    if (pointInPolygon(x1, y1, polygon) && pointInPolygon(x2, y2, polygon)) {
      edges.push({ x1, y1, x2, y2, t1, t2 });
    }
  }

  if (edges.length === 0) return [];

  // Step 5: Compute radius at each vertex (distance to nearest boundary)
  const vertexMap = new Map();

  for (const edge of edges) {
    for (const [vx, vy] of [[edge.x1, edge.y1], [edge.x2, edge.y2]]) {
      const key = vertexKey(vx, vy);
      if (!vertexMap.has(key)) {
        const radius = distanceToBoundary(vx, vy, polygon);
        vertexMap.set(key, { x: vx, y: vy, radius });
      }
    }
  }

  // Step 5.5: Filter out edges where either endpoint is too close to the
  // boundary.  Voronoi circumcenters within a fraction of the sampling
  // spacing are artefacts of adjacent sample points on converging edges,
  // not true medial-axis vertices.  Removing them collapses the dense
  // "ladder" mesh that forms near polygon vertices.
  // Use a small fraction of spacing so thin script strokes (where the
  // medial axis legitimately has tiny radius) are preserved.
  const minRadius = spacing * 0.1;
  const filteredEdges = edges.filter(edge => {
    const r1 = vertexMap.get(vertexKey(edge.x1, edge.y1)).radius;
    const r2 = vertexMap.get(vertexKey(edge.x2, edge.y2)).radius;
    return r1 >= minRadius && r2 >= minRadius;
  });

  if (filteredEdges.length === 0) return [];

  // Step 6: Build adjacency graph and extract branches
  const rawBranches = extractBranches(filteredEdges, vertexMap);

  // Step 7: Iteratively prune short leaf branches (sampling noise).
  // Remove dead-end branches shorter than 1% of perimeter, then recalculate
  // degrees — removing a leaf may expose a new leaf underneath. Repeat until
  // stable. This peels away entire spurious sub-trees near polygon vertices
  // without breaking main skeleton connectivity.
  const minLen = totalPerimeter * 0.01;
  let current = rawBranches.filter(b => b.length >= 2);
  let changed = true;
  let pass = 0;

  while (changed) {
    changed = false;
    pass++;
    const deg = new Map();
    for (const branch of current) {
      const sk = vertexKey(branch[0].x, branch[0].y);
      const ek = vertexKey(branch[branch.length - 1].x, branch[branch.length - 1].y);
      deg.set(sk, (deg.get(sk) || 0) + 1);
      deg.set(ek, (deg.get(ek) || 0) + 1);
    }
    const next = [];
    for (const branch of current) {
      let len = 0;
      for (let i = 1; i < branch.length; i++) {
        len += Math.hypot(branch[i].x - branch[i - 1].x, branch[i].y - branch[i - 1].y);
      }
      if (len >= minLen) { next.push(branch); continue; }
      const sk = vertexKey(branch[0].x, branch[0].y);
      const ek = vertexKey(branch[branch.length - 1].x, branch[branch.length - 1].y);
      if (deg.get(sk) === 1 || deg.get(ek) === 1) {
        changed = true;
      } else {
        next.push(branch);
      }
    }
    current = next;
  }

  // Step 8: Smooth branches to remove Voronoi zigzag noise.
  // Apply 3-point moving average to interior points (preserves endpoints
  // so junction connectivity isn't broken). Radius is smoothed too so
  // the V-bit depth follows the smoothed centerline.
  current = current.map(branch => smoothBranch(branch, 2));

  return current;
}

/**
 * Build adjacency graph from edges and extract ordered branches.
 */
function extractBranches(edges, vertexMap) {
  const adj = new Map();

  for (const edge of edges) {
    const k1 = vertexKey(edge.x1, edge.y1);
    const k2 = vertexKey(edge.x2, edge.y2);
    if (k1 === k2) continue;

    if (!adj.has(k1)) adj.set(k1, new Set());
    if (!adj.has(k2)) adj.set(k2, new Set());
    adj.get(k1).add(k2);
    adj.get(k2).add(k1);
  }

  const visitedEdges = new Set();
  const branches = [];

  // Find all branch start points (degree != 2 vertices, or any unvisited)
  const startPoints = [];
  for (const [key, neighbors] of adj) {
    if (neighbors.size !== 2) {
      startPoints.push(key);
    }
  }

  // If all vertices have degree 2, it's a cycle — start from any vertex
  if (startPoints.length === 0 && adj.size > 0) {
    startPoints.push(adj.keys().next().value);
  }

  for (const startKey of startPoints) {
    const neighbors = adj.get(startKey);
    if (!neighbors) continue;

    for (const nextKey of neighbors) {
      const edgeKey = startKey < nextKey ? `${startKey}|${nextKey}` : `${nextKey}|${startKey}`;
      if (visitedEdges.has(edgeKey)) continue;

      const branch = [vertexMap.get(startKey)];
      let prevKey = startKey;
      let currKey = nextKey;

      while (true) {
        const ek = prevKey < currKey ? `${prevKey}|${currKey}` : `${currKey}|${prevKey}`;
        if (visitedEdges.has(ek)) break;
        visitedEdges.add(ek);

        branch.push(vertexMap.get(currKey));

        const currNeighbors = adj.get(currKey);
        if (!currNeighbors || currNeighbors.size !== 2) break; // Junction or endpoint

        // Find the next vertex (not the one we came from)
        let nextNext = null;
        for (const n of currNeighbors) {
          if (n !== prevKey) { nextNext = n; break; }
        }
        if (!nextNext) break;

        prevKey = currKey;
        currKey = nextNext;
      }

      if (branch.length >= 2) {
        branches.push(branch);
      }
    }
  }

  return branches;
}

/**
 * Clip a branch at maxRadius with interpolation.
 */
function clipBranch(branch, maxRadius) {
  if (maxRadius === Infinity) return branch;

  const result = [];

  for (let i = 0; i < branch.length; i++) {
    const curr = branch[i];
    const prev = i > 0 ? branch[i - 1] : null;

    if (curr.radius <= maxRadius) {
      // Current point is within range
      if (prev && prev.radius > maxRadius) {
        // Interpolate entry point
        const t = (maxRadius - prev.radius) / (curr.radius - prev.radius);
        result.push(lerpPoint(prev, curr, t, maxRadius));
      }
      result.push(curr);
    } else {
      // Current point exceeds max radius
      if (prev && prev.radius <= maxRadius) {
        // Interpolate exit point
        const t = (maxRadius - prev.radius) / (curr.radius - prev.radius);
        result.push(lerpPoint(prev, curr, t, maxRadius));
      }
    }
  }

  return result;
}

function lerpPoint(a, b, t, radius) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    radius: radius,
  };
}

/**
 * Smooth a branch by repeated 3-point averaging of interior points.
 * Endpoints are preserved to maintain junction connectivity.
 * @param {Array} branch - [{x, y, radius}, ...]
 * @param {number} passes - number of smoothing passes
 */
function smoothBranch(branch, passes) {
  if (branch.length <= 2) return branch;

  let pts = branch;
  for (let p = 0; p < passes; p++) {
    const smoothed = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      smoothed.push({
        x: (pts[i - 1].x + pts[i].x + pts[i + 1].x) / 3,
        y: (pts[i - 1].y + pts[i].y + pts[i + 1].y) / 3,
        radius: (pts[i - 1].radius + pts[i].radius + pts[i + 1].radius) / 3,
      });
    }
    smoothed.push(pts[pts.length - 1]);
    pts = smoothed;
  }
  return pts;
}

function vertexKey(x, y) {
  return `${x.toFixed(8)},${y.toFixed(8)}`;
}

function computePerimeter(ring) {
  let len = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    len += Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
  }
  return len;
}

function addSampledRing(result, ring, spacing) {
  // Close the ring by adding first point at end
  const closed = [...ring, ring[0]];
  const sampled = samplePolyline(closed, spacing);
  result.push(...sampled);
}

/**
 * Compute circumcenter of triangle (x0,y0), (x1,y1), (x2,y2).
 */
function circumcenter(x0, y0, x1, y1, x2, y2) {
  const ax = x1 - x0, ay = y1 - y0;
  const bx = x2 - x0, by = y2 - y0;
  const D = 2 * (ax * by - ay * bx);

  if (Math.abs(D) < 1e-12) {
    // Degenerate (collinear) — return midpoint
    return { x: (x0 + x1 + x2) / 3, y: (y0 + y1 + y2) / 3 };
  }

  const ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / D;
  const uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / D;

  return { x: x0 + ux, y: y0 + uy };
}
