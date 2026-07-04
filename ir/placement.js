// Placement transform: op-local moves → job coordinates.
//
// The missing primitive the seam recon identified: terrain fills its whole
// work area from a bottom-left origin, v_engraver inherits its input
// geometry's coordinates — neither can place itself into a sub-region of a
// shared job. This transform is how an operation gets a home.
//
//   placement = { x=0, y=0, rotateDeg=0, scale=1 }
//
// Order: unit-scale → placement.scale (XY only) → rotate about op-local
// origin → translate by (x, y).
//
// IMPORTANT scale caveat: placement.scale applies to XY ONLY, and scaling
// already-lowered moves is only valid for ops whose Z is independent of XY
// extent (e.g. a raster relief). For a V-carve, depth is a function of the
// XY geometry (inscribed radius / tan(half-angle)) — scaling XY at the
// moves rail silently invalidates Z. Scale V-carve INPUT geometry before
// lowering instead. unitScale (mm↔in conversion) applies to all three axes
// because it rescales the whole coordinate system, depths included.

export function applyPlacement(moves, placement = {}, unitScale = 1) {
  const { x: tx = 0, y: ty = 0, rotateDeg = 0, scale = 1 } = placement;

  if (scale <= 0) throw new Error('placement.scale must be > 0 (mirroring is not supported at the moves rail)');

  const identity = tx === 0 && ty === 0 && rotateDeg === 0 && scale === 1 && unitScale === 1;
  if (identity) return moves.slice();

  const sxy = unitScale * scale;
  const sz = unitScale;

  // Fast path (no rotation): sparse moves can be transformed axis-by-axis,
  // preserving JZ/M2/MZ economy in the posted output.
  if (rotateDeg === 0) {
    return moves.map(m => {
      if (!isMotion(m)) return m;
      const out = { ...m };
      if (m.x !== undefined) out.x = m.x * sxy + tx;
      if (m.y !== undefined) out.y = m.y * sxy + ty;
      if (m.z !== undefined) out.z = m.z * sz;
      if (m.type === 'arc') {
        if (m.i !== undefined) out.i = m.i * sxy;
        if (m.j !== undefined) out.j = m.j * sxy;
      }
      return out;
    });
  }

  // Rotation mixes X and Y, so sticky (omitted) axes must be resolved first;
  // transformed motion moves are emitted with full coordinates. A leading
  // Z-only move before any XY is resolved against op-local origin (0,0).
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pos = { x: 0, y: 0, z: 0 };

  return moves.map(m => {
    if (!isMotion(m)) return m;
    if (m.x !== undefined) pos.x = m.x;
    if (m.y !== undefined) pos.y = m.y;
    if (m.z !== undefined) pos.z = m.z;
    const lx = pos.x * sxy;
    const ly = pos.y * sxy;
    const out = {
      ...m,
      x: lx * cos - ly * sin + tx,
      y: lx * sin + ly * cos + ty,
      z: pos.z * sz,
    };
    if (m.type === 'arc') {
      const li = (m.i ?? 0) * sxy;
      const lj = (m.j ?? 0) * sxy;
      out.i = li * cos - lj * sin;
      out.j = li * sin + lj * cos;
    }
    return out;
  });
}

function isMotion(m) {
  return m.type === 'rapid' || m.type === 'linear' || m.type === 'arc';
}
