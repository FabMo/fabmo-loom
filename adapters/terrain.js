// Lowering adapter: terrain_carver pass-structured JSON → canonical moves.
//
// terrain_carver's kernel exports {metadata, passes:[{index, direction,
// points:[[x,y,z],...]}]} (kernel/src/json_export.rs). Its cut geometry is
// pass-structured; rapids/plunge/linking live hardcoded in its two posts
// (gcode.rs / sbp.rs). This adapter reproduces exactly those motion
// semantics on the moves rail, which makes both native posts redundant:
//
//   first pass:        rapid XY to pass start (caller must already be at
//                      safe Z), then feed-plunge straight down at plungeRate
//   subsequent passes: one 3D linear at feedRate direct to next pass start
//                      (matches gcode.rs:61 / sbp.rs:63)
//   within a pass:     3D linears at feedRate
//
// Deliberately NOT emitted: preamble/footer (spindle, initial retract,
// homing). Those belong to the Job composer — an operation's moves must be
// composable, so they start and end mid-program.

export function passesToMoves(toolpathJson, opts = {}) {
  const { comments = true } = opts;
  const md = toolpathJson.metadata;
  const moves = [];
  let firstPassDone = false;

  for (const pass of toolpathJson.passes) {
    const pts = pass.points;
    if (!pts || pts.length === 0) continue;

    const [x0, y0, z0] = pts[0];
    if (comments) moves.push({ type: 'comment', text: `Pass ${pass.index + 1}` });

    if (!firstPassDone) {
      moves.push({ type: 'rapid', x: x0, y: y0 });
      moves.push({ type: 'feed', xy: md.plungeRate, z: md.plungeRate });
      moves.push({ type: 'linear', z: z0 });
      moves.push({ type: 'feed', xy: md.feedRate, z: md.plungeRate });
      firstPassDone = true;
    } else {
      moves.push({ type: 'linear', x: x0, y: y0, z: z0 });
    }

    for (let i = 1; i < pts.length; i++) {
      const [x, y, z] = pts[i];
      moves.push({ type: 'linear', x, y, z });
    }
  }

  return moves;
}

// Convenience: the operation-level facts the composer needs, pulled from the
// JSON metadata in one place so callers don't reach into it ad hoc.
export function terrainOpInfo(toolpathJson) {
  const md = toolpathJson.metadata;
  return {
    units: md.units === 'mm' ? 'mm' : 'in',
    feedRate: md.feedRate,
    plungeRate: md.plungeRate,
    safeZ: md.safeZ,
    spindleSpeed: md.spindleSpeed,
    bitDiameter: md.bitDiameter,
    extent: { w: md.workWidth, h: md.workHeight },
    zRange: { min: md.minZ, max: md.maxZ },
  };
}
