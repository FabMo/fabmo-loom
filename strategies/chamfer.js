// Chamfer — edge-break strategy on the canonical moves rail.
//
// Cuts a straight chamfer (horizontal leg `width` into the material, face
// angle `angleDeg` from horizontal, vertical leg v = width·tan(angle))
// along an edge chain, with two modalities chosen by the TOOL it is handed:
//
//   vee  (kind:'vee', angleDeg = included angle): the engraving geometry —
//        the bit's flank IS the chamfer face, so the tip simply rides the
//        edge chain in plan at depth v (multi-pass via depthPerPass; every
//        intermediate pass cuts a smaller chamfer sharing the same bottom
//        edge, converging to the full face). Only a bit whose included
//        angle is 180 − 2·angleDeg cuts that face; the strategy refuses a
//        mismatched bit — tool SELECTION is the caller's job, this is the
//        guard that a wrong selection can't silently cut the wrong angle.
//   ball (kind:'ball'): the simulation fallback when no matching V-bit is
//        available — scallop-limited passes march down the face top to
//        bottom, each one the edge chain offset so the ball sits tangent
//        to the face plane. Slower, leaves scallops, needs no special bit.
//
// Edge chain: { points: [{x,y}], closed } in op-local plan coordinates,
// tracing the edge being broken — which is also the BOTTOM edge of the
// finished face in plan (the face's top edge is inset `width` into the
// material). MATERIAL LIES TO THE LEFT OF TRAVEL: a CCW outer-profile
// contour chamfers the part's top rim; give a pocket rim CW for the same
// reason.
//
// Caveat the verifier owns (not this file): the ball tangent at the face
// bottom dips ~0.3R below the bottom edge and the vee rides exactly ON it —
// if the geometry past the edge is HIGHER than that (a pocket floor
// shallower than the chamfer's vertical leg), the declared heightmap
// target flags it. V-bit tips are modeled sharp; bits with a tip flat cut
// a slightly smaller face.
//
// Output follows the operation contract in ir/job.js: first move is a
// rapid XY positioning move, internal retracts go to params.safeZ, plunges
// are Z-only linears posted at the plunge feed by the rail.

import ClipperLib from '../vendor/clipper.js';

const SCALE = 1e6;
const ARC_TOL = 0.0005 * SCALE;
const toClip = ring => ring.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromClip = path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
const DEG = Math.PI / 180;

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return a / 2;
}

// the included V-bit angle that cuts a face at angleDeg from horizontal
export function veeAngleFor(faceAngleDeg) {
  return 180 - 2 * faceAngleDeg;
}

// dedupe consecutive duplicates; drop a repeated closing point
function normalizeChain(points, closed) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) pts.push({ x: p.x, y: p.y });
  }
  if (closed && pts.length > 1 &&
      Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) {
    pts.pop();
  }
  return pts;
}

// per-vertex lateral offset of an open chain along the RIGHT-of-travel
// normal (positive away from material), bisector-mitered, miter capped at
// 2× so a kink can't throw a vertex far off the band
function offsetOpenChain(pts, o) {
  const n = pts.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    segN.push(len < 1e-12 ? { x: 0, y: 0 } : { x: dy / len, y: -dx / len });
  }
  return pts.map((p, i) => {
    const a = segN[Math.max(0, i - 1)], b = segN[Math.min(n - 2, i)];
    let nx = a.x + b.x, ny = a.y + b.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) { nx = b.x; ny = b.y; } else { nx /= len; ny /= len; }
    const cosHalf = Math.max(0.5, Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2));
    return { x: p.x + nx * (o / cosHalf), y: p.y + ny * (o / cosHalf) };
  });
}

// Clipper offset of a closed ring by a RIGHT-of-travel-signed distance.
// Material-left ⇒ right of travel is outward for a CCW ring, inward for a
// CW one; Clipper's delta is outward after internal normalization, so the
// sign flips with the input orientation.
function offsetClosedRing(pts, o) {
  const delta = signedArea(pts) >= 0 ? o : -o;
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL);
  co.AddPath(toClip(pts), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  // CleanPolygons RETURNS the cleaned copy (does not mutate)
  return ClipperLib.Clipper.CleanPolygons(out, ARC_TOL)
    .filter(p => p.length >= 3)
    .map(fromClip);
}

// band rings between two right-normal offsets (oInner < oOuter), as plain
// rings for claiming and as an even-odd {outer, holes} mask
function bandRings(pts, closed, oInner, oOuter) {
  if (closed) {
    const outer = offsetClosedRing(pts, oOuter);
    const inner = offsetClosedRing(pts, oInner);
    if (!outer.length) return null;
    const biggest = outer.reduce((m, r) => Math.abs(signedArea(r)) > Math.abs(signedArea(m)) ? r : m);
    return {
      mask: { outer: biggest, holes: [...outer.filter(r => r !== biggest), ...inner] },
      // nonzero-fill claim set: inner rings reversed so the annulus, not
      // the whole disk, is claimed
      rings: [...outer, ...inner.map(r => r.slice().reverse())],
    };
  }
  // extend the chain ends longitudinally so endpoint samples (and the
  // swept cone's end wrap) sit strictly inside the band, not on its cap
  const cap = 0.01;
  const ext = pts.slice();
  {
    const [p0, p1] = [ext[0], ext[1]];
    const l0 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    ext[0] = { x: p0.x - ((p1.x - p0.x) / l0) * cap, y: p0.y - ((p1.y - p0.y) / l0) * cap };
    const [q1, q0] = [ext[ext.length - 2], ext[ext.length - 1]];
    const l1 = Math.hypot(q0.x - q1.x, q0.y - q1.y) || 1;
    ext[ext.length - 1] = { x: q0.x + ((q0.x - q1.x) / l1) * cap, y: q0.y + ((q0.y - q1.y) / l1) * cap };
  }
  const a = offsetOpenChain(ext, oOuter);
  const b = offsetOpenChain(ext, oInner).reverse();
  let ring = [...a, ...b];
  if (signedArea(ring) < 0) ring = ring.reverse();
  return { mask: { outer: ring, holes: [] }, rings: [ring] };
}

/**
 * generateChamfer(edge, tool, params) → { moves, stats, warnings, target, band }
 *
 * edge:   { points: [{x,y}], closed }  (material LEFT of travel)
 * tool:   { kind:'vee', diameter, angleDeg } | { kind:'ball', diameter }
 * params: { width, angleDeg=45, depthPerPass=null, scallop=0.003, safeZ,
 *           feedRate?, plungeRate?,
 *           surface?, outsideZ? }   // intended FINAL surface heightmap —
 *                                   // when given, the op declares a
 *                                   // heightmap target over the band
 *
 * band: plan rings of the swept footprint (for residual claiming).
 */
export function generateChamfer(edge, tool, params) {
  const warnings = [];
  const empty = stats => ({ moves: [], stats: { passes: 0, cutLength: 0, ...stats }, warnings, target: null, band: null });

  const pts = normalizeChain(edge.points ?? [], !!edge.closed);
  if (pts.length < 2 || (edge.closed && pts.length < 3)) {
    warnings.push('chamfer edge chain degenerate — nothing to cut');
    return empty({});
  }
  const width = params.width;
  const faceDeg = params.angleDeg ?? 45;
  if (!(width > 0) || !(faceDeg > 5) || !(faceDeg < 85)) {
    warnings.push(`chamfer spec out of range (width=${width}, angle=${faceDeg}°)`);
    return empty({});
  }
  const vleg = width * Math.tan(faceDeg * DEG);
  const R = tool.diameter / 2;
  const safeZ = params.safeZ;
  const moves = [];
  let toolPos = null;
  let cutLength = 0;

  const cut = (x, y, z) => {
    const m = { type: 'linear', x, y, z };
    if (params.feedRate) m.feedRate = params.feedRate;
    moves.push(m);
    if (toolPos) cutLength += Math.hypot(x - toolPos.x, y - toolPos.y, z - toolPos.z);
    toolPos = { x, y, z };
  };
  const plunge = z => {
    const m = { type: 'linear', z };
    if (params.plungeRate) m.feedRate = params.plungeRate;
    moves.push(m);
    if (toolPos) toolPos = { ...toolPos, z };
  };

  let passes = 0;
  let centerBand, sweptBand;

  if (tool.kind === 'vee') {
    const included = tool.angleDeg;
    const bitFaceDeg = 90 - included / 2;     // face angle this bit cuts
    if (Math.abs(bitFaceDeg - faceDeg) > 0.75) {
      warnings.push(`V-bit included angle ${included}° cuts a ${bitFaceDeg}° face — cannot cut the requested ${faceDeg}° chamfer (needs ${veeAngleFor(faceDeg)}°)`);
      return empty({ tool: 'vee' });
    }
    const tanBeta = Math.tan((included / 2) * DEG); // cone halfwidth per depth
    let depth = vleg;
    const maxDepth = R / tanBeta;
    if (depth > maxDepth + 1e-9) {
      warnings.push(`chamfer needs ${depth.toFixed(3)} depth but a ${tool.diameter}" ${included}° V-bit only reaches ${maxDepth.toFixed(3)} — clamped (face top will be left uncut)`);
      depth = maxDepth;
    }

    const dpp = params.depthPerPass ?? null;
    const nPass = dpp ? Math.max(1, Math.ceil(depth / dpp)) : 1;
    moves.push({ type: 'rapid', x: pts[0].x, y: pts[0].y });
    let reversed = false;
    for (let k = 0; k < nPass; k++) {
      const d = dpp ? Math.min((k + 1) * dpp, depth) : depth;
      moves.push({ type: 'comment', text: `Chamfer pass ${k + 1}/${nPass} Z=${(-d).toFixed(4)}` });
      if (edge.closed) {
        plunge(-d);
        toolPos = { x: pts[0].x, y: pts[0].y, z: -d };
        for (let i = 1; i < pts.length; i++) cut(pts[i].x, pts[i].y, -d);
        cut(pts[0].x, pts[0].y, -d);          // close the loop; next pass plunges here
      } else {
        const order = reversed ? [...pts].reverse() : pts;
        plunge(-d);
        toolPos = { x: order[0].x, y: order[0].y, z: -d };
        for (let i = 1; i < order.length; i++) cut(order[i].x, order[i].y, -d);
        reversed = !reversed;                  // cut back deeper from this end
      }
      passes++;
    }
    moves.push({ type: 'rapid', z: safeZ });

    const sweep = depth * tanBeta;            // cone halfwidth at the stock top
    centerBand = [-0.005, 0.005];
    sweptBand = [-sweep - 0.005, sweep + 0.005];
  } else if (tool.kind === 'ball') {
    // contact point at face parameter u∈[0,1] (top→bottom):
    //   plan offset  o(u)  = −width·(1−u)        (along right normal)
    //   contact z    z(u)  = −vleg·u
    // ball tangent to the face plane (normal (vleg, width)/L in (o,z)):
    //   center offset oC = o + R·vleg/L,  tip Z = z + R·width/L − R
    const L = Math.hypot(width, vleg);
    const scallop = params.scallop ?? 0.003;
    const step = Math.min(R, Math.max(0.005, Math.sqrt(8 * R * scallop)));
    const nPass = Math.max(2, Math.ceil(L / step) + 1);
    const oCof = u => -width * (1 - u) + (R * vleg) / L;
    const tipZof = u => -vleg * u + (R * width) / L - R;

    for (let k = 0; k < nPass; k++) {
      const u = k / (nPass - 1);
      const oC = oCof(u), tipZ = tipZof(u);
      const contours = edge.closed
        ? offsetClosedRing(pts, oC)
        : [offsetOpenChain(pts, oC)];
      if (!contours.length || contours.every(c => c.length < 2)) {
        warnings.push(`ball pass ${k + 1}: offset contour collapsed — edge too tight for a ${tool.diameter}" ball at offset ${oC.toFixed(3)}`);
        continue;
      }
      moves.push({ type: 'comment', text: `Chamfer ball pass ${k + 1}/${nPass} u=${u.toFixed(2)} Z=${tipZ.toFixed(4)}` });
      for (let ring of contours) {
        if (ring.length < 2) continue;
        if (edge.closed && toolPos) {
          // rotate the ring to start nearest the tool (Clipper rotates
          // start points arbitrarily between offsets)
          let best = 0, bestD = Infinity;
          ring.forEach((p, i) => {
            const d = Math.hypot(p.x - toolPos.x, p.y - toolPos.y);
            if (d < bestD) { bestD = d; best = i; }
          });
          ring = [...ring.slice(best), ...ring.slice(0, best)];
        }
        const start = ring[0];
        if (toolPos === null) {
          moves.push({ type: 'rapid', x: start.x, y: start.y });
          plunge(tipZ);
          toolPos = { x: start.x, y: start.y, z: tipZ };
        } else if (Math.hypot(start.x - toolPos.x, start.y - toolPos.y) <= 2 * R) {
          // stay-down: passes run top→bottom and outward, so the final
          // surface under the link is at or below the CURRENT tip Z —
          // moving over at max(current, next)+clearance never gouges
          const linkZ = Math.min(safeZ, Math.max(toolPos.z, tipZ) + 0.02);
          cut(toolPos.x, toolPos.y, linkZ);
          cut(start.x, start.y, linkZ);
          cut(start.x, start.y, tipZ);
        } else {
          moves.push({ type: 'rapid', z: safeZ });
          moves.push({ type: 'rapid', x: start.x, y: start.y });
          plunge(tipZ);
          toolPos = { x: start.x, y: start.y, z: tipZ };
        }
        for (let i = 1; i < ring.length; i++) cut(ring[i].x, ring[i].y, tipZ);
        if (edge.closed) cut(ring[0].x, ring[0].y, tipZ);
      }
      passes++;
    }
    moves.push({ type: 'rapid', z: safeZ });

    centerBand = [oCof(0) - 0.005, oCof(1) + 0.005];
    sweptBand = [centerBand[0] - R, centerBand[1] + R];
  } else {
    warnings.push(`chamfer: unsupported tool kind "${tool.kind}" (vee or ball)`);
    return empty({});
  }

  if (!moves.some(m => m.type === 'linear')) {
    warnings.push('chamfer produced no cutting moves');
    return empty({ passes });
  }

  const band = bandRings(pts, !!edge.closed, sweptBand[0], sweptBand[1]);
  const center = bandRings(pts, !!edge.closed, centerBand[0], centerBand[1]);

  let target = null;
  if (params.surface && center) {
    target = {
      type: 'heightmap',
      heightmap: params.surface,
      mask: center.mask,
      outsideZ: params.outsideZ ?? 0,
    };
  } else if (!params.surface) {
    warnings.push('no intended-surface heightmap given — chamfer op has no declared target');
  }

  return {
    moves,
    stats: {
      passes,
      cutLength: Math.round(cutLength * 1000) / 1000,
      mode: tool.kind,
      vleg: Math.round(vleg * 1e4) / 1e4,
    },
    warnings,
    target,
    band: band ? band.rings : null,
  };
}

/**
 * Imprint a chamfer band into a heightmap (returns a copy): the intended
 * FINAL surface after an ADDED (not modeled) chamfer is cut. Used both as
 * the op's declared target and as job.partSurface, so the verifier checks
 * intent rather than the pre-chamfer geometry.
 */
export function imprintChamfer(heightmap, edge, width, angleDeg) {
  const pts = normalizeChain(edge.points ?? [], !!edge.closed);
  if (pts.length < 2) return heightmap;
  const vleg = width * Math.tan(angleDeg * DEG);
  const hm = { ...heightmap, heights: Float64Array.from(heightmap.heights) };
  const n = pts.length;
  const segCount = edge.closed ? n : n - 1;

  for (let s = 0; s < segCount; s++) {
    const a = pts[s], b = pts[(s + 1) % n];
    const dxs = b.x - a.x, dys = b.y - a.y;
    const len = Math.hypot(dxs, dys);
    if (len < 1e-9) continue;
    const ux = dxs / len, uy = dys / len;        // travel
    const rx = uy, ry = -ux;                      // right normal (away from material)
    // grid cells within the band slab of this segment
    const pad = Math.max(hm.dx, hm.dy);
    const minX = Math.min(a.x, b.x) - width - pad, maxX = Math.max(a.x, b.x) + width + pad;
    const minY = Math.min(a.y, b.y) - width - pad, maxY = Math.max(a.y, b.y) + width + pad;
    const c0 = Math.max(0, Math.floor((minX - hm.originX) / hm.dx));
    const c1 = Math.min(hm.cols - 1, Math.ceil((maxX - hm.originX) / hm.dx));
    const r0 = Math.max(0, Math.floor((minY - hm.originY) / hm.dy));
    const r1 = Math.min(hm.rows - 1, Math.ceil((maxY - hm.originY) / hm.dy));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const px = hm.originX + c * hm.dx - a.x;
        const py = hm.originY + r * hm.dy - a.y;
        const t = px * ux + py * uy;
        if (t < -1e-9 || t > len + 1e-9) continue;
        const o = px * rx + py * ry;              // signed offset, +away from material
        // material side (o<0): the declared face. Air side (o>0): the
        // cone continuation — the chain is a traced contour, so real
        // material can poke a sub-cell sliver past it, and the tool
        // legitimately cuts that sliver to the cone surface. Same
        // formula by symmetry; min() leaves no-material cells deep.
        if (Math.abs(o) > width) continue;
        const face = -vleg * ((width - Math.abs(o)) / width);
        const idx = r * hm.cols + c;
        if (face < hm.heights[idx]) hm.heights[idx] = face;
      }
    }
  }

  // vertex fans: at a corner (and at open-chain ends) the swept cone wraps
  // the vertex radially — cells diagonal to both segment slabs are cut by
  // Euclidean distance from the vertex. Off-band sides are harmless: the
  // min() only ever lowers cells the tool genuinely reaches.
  for (const v of pts) {
    const c0 = Math.max(0, Math.floor((v.x - width - hm.originX) / hm.dx));
    const c1 = Math.min(hm.cols - 1, Math.ceil((v.x + width - hm.originX) / hm.dx));
    const r0 = Math.max(0, Math.floor((v.y - width - hm.originY) / hm.dy));
    const r1 = Math.min(hm.rows - 1, Math.ceil((v.y + width - hm.originY) / hm.dy));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(hm.originX + c * hm.dx - v.x, hm.originY + r * hm.dy - v.y);
        if (d > width) continue;
        const face = -vleg * ((width - d) / width);
        const idx = r * hm.cols + c;
        if (face < hm.heights[idx]) hm.heights[idx] = face;
      }
    }
  }
  return hm;
}
