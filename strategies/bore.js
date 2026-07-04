// Bore — a circular hole cut by a bit of (nearly) its own diameter.
//
// CAD-for-CNC convention: clearance holes are drawn a hair over the bit
// (0.126" for a 1/8" bit) so hole-recognition doesn't refuse the exact-size
// case. Contour-parallel pocketing collapses on that sliver of slack — the
// full-radius inset is empty and even the slot-graze retry survives only as
// a near-point ring the worth-cutting filter drops. The honest toolpath is
// a peck plunge down the hole's center: it cuts a bit-diameter hole and
// leaves the designed slack as the tolerance it is, instead of grazing the
// wall out to slack + SLOT_GRAZE the way a slot-fit pass would.
//
// When the slack is real (orbit radius ≥ MIN_ORBIT) each depth pass adds
// one circular orbit at (radius − R) so the hole comes out the designed
// size; below that the orbit would be Clipper noise and the plunge alone
// is truer.

import { generateDepths, SLOT_GRAZE } from './pocket.js';

const MIN_ORBIT = 0.002;   // below this, an orbit is noise — plunge only
const PECK_LIFT = 0.02;    // chip-break retract between plunge passes

/**
 * generateBore(hole, tool, params) → { moves, warnings, target, stats }
 *
 * hole:   { centerX, centerY, radius }      the designed hole
 * tool:   { diameter }
 * params: { totalDepth, depthPerPass, safeZ }
 *
 * Returns no moves (with a warning) when the bit is larger than the hole —
 * plunging would oversize a designed fit, which is never ours to decide.
 */
export function generateBore(hole, tool, params) {
  const R = tool.diameter / 2;
  const { centerX: cx, centerY: cy, radius } = hole;
  const warnings = [];

  // a hole within SLOT_GRAZE of the bit is the drill case — the same
  // few-thou graze generatePocket's slot-fit already accepts on grooves
  // nominally AT bit width (a 0.122" drill hole plunged by a 1/8" bit).
  // Anything smaller than that is a designed fit we must not oversize.
  if (R > radius + SLOT_GRAZE) {
    warnings.push(`hole R=${radius.toFixed(4)} is smaller than the ${tool.diameter} bit — not machinable without oversizing`);
    return { moves: [], warnings, target: null, stats: { plunges: 0, orbits: 0 } };
  }
  if (R > radius + 1e-4) {
    warnings.push(`hole ⌀${(radius * 2).toFixed(4)} plunged ${((R - radius) * 2).toFixed(4)}" over (drill graze, within slot tolerance)`);
  }

  const orbitR = Math.max(0, radius - R);
  const orbit = orbitR >= MIN_ORBIT;
  const depths = generateDepths(params.totalDepth, params.depthPerPass);
  const moves = [
    { type: 'rapid', z: params.safeZ },
    { type: 'rapid', x: cx, y: cy },
  ];
  let orbits = 0;
  for (let i = 0; i < depths.length; i++) {
    const z = -depths[i];
    moves.push({ type: 'linear', x: cx, y: cy, z });
    if (orbit) {
      // one ring at the designed radius: out along +X, around, back to center
      const n = Math.max(16, Math.min(64, Math.ceil((2 * Math.PI * orbitR) / 0.01)));
      moves.push({ type: 'linear', x: cx + orbitR, y: cy, z });
      for (let k = 1; k <= n; k++) {
        const a = (2 * Math.PI * k) / n;
        moves.push({ type: 'linear', x: cx + orbitR * Math.cos(a), y: cy + orbitR * Math.sin(a), z });
      }
      moves.push({ type: 'linear', x: cx, y: cy, z });
      orbits++;
    } else if (i < depths.length - 1) {
      // chip-break peck between straight plunges
      moves.push({ type: 'linear', x: cx, y: cy, z: z + PECK_LIFT });
    }
  }
  moves.push({ type: 'rapid', z: params.safeZ });

  if (!orbit && radius - R > 1e-4) {
    warnings.push(`bore leaves the designed ${((radius - R) * 2).toFixed(4)}" of diameter slack uncut (plunge cuts bit-size)`);
  }

  // what the bit actually sweeps: a circle of R + orbitR (= the designed
  // hole when orbiting, the bit itself when plunging)
  const sweptR = R + (orbit ? orbitR : 0);
  const ring = [];
  const nT = 48;
  for (let k = 0; k < nT; k++) {
    const a = (2 * Math.PI * k) / nT;
    ring.push({ x: cx + sweptR * Math.cos(a), y: cy + sweptR * Math.sin(a) });
  }
  const target = { type: 'region', rings: [ring], depth: params.totalDepth };

  return { moves, warnings, target, stats: { plunges: depths.length, orbits, sweptR } };
}
