// Machinability gate — the second admission check, beside verifyJob.
//
// verifyJob proves the motion MATCHES ITS DECLARATION and stays in the
// stock. It has no opinion on whether the cut is physically sound: a job
// that frees a 2" piece with nothing holding it, or buries a 1/16" bit
// 1/4" deep in one pass, matches its target perfectly. This file measures
// those things from the placed motion, independently of the strategies
// that planned it (same rule as the verifier: a planner bug must not
// certify itself).
//
//   reach       deepest cut of each op vs the bit's flute reach
//               (tool.maxDepth, default REACH_RATIO × diameter)
//   pass depth  the most material a flat or ball bit meets in one pass,
//               measured by replaying the op into a height grid and
//               reading the uncut stock ahead of the cutter
//   retention   every piece a through outside-profile frees: its size, and
//               the BRIDGES actually left across its kerf (tabs are found
//               in the motion, never taken from a flag)
//   thin webs   material left narrower than it is deep between a feature
//               and its part's edge, or between two features of one part
//
// The policy half lives here too, so planner and gate read one table:
// RETENTION / retentionNeed (which pieces need holding, by declared
// hold-down), tabSpecFor (tabs that really span the kerf of the bit that
// cuts them) and passDepthFor (pass depth from the bit, not a constant).
//
// Report: { ok, errors[], warnings[], ops[], pieces[], webs[] }.
// opts.levels picks error / warn / off per check.

import { applyPlacement } from './placement.js';
import { MATERIALS } from './tools.js';
import ClipperLib from '../vendor/clipper.js';

const EPS = 1e-6;
const SCALE = 1e6;
const ARC_TOL = 0.0005 * SCALE;

// ------------------------------------------------------------------ policy

/** flute reach assumed for a bit that declares none (matches tool-select) */
export const REACH_RATIO = 4;
/** most material one pass may meet, in bit diameters */
export const PASS_RATIO = 1;

/**
 * Which freed pieces need holding, by what the shop declared holds the work.
 *   undeclared — nothing known: the sheet is assumed clamped or screwed at
 *                its edges, so a freed piece is held by its own weight only
 *   vacuum     — a vacuum table holds big pieces; small ones break the seal
 *   fixed      — the PART itself is taped or screwed down; nothing to add
 * A piece needs holding when its area OR its narrow dimension is under the
 * threshold. null = never.
 */
export const RETENTION = {
  undeclared: { area: 36, minWidth: 3 },
  vacuum: { area: 9, minWidth: 1.5 },
  fixed: null,
};
export const HOLD_DOWNS = Object.keys(RETENTION);
/** a bridge counts when the thinnest spot across the kerf is this tall */
export const MIN_BRIDGE = 0.015;
/** bridges needed to call a piece held */
export const MIN_BRIDGES = 2;

export function pieceMetrics(rings) {
  const list = Array.isArray(rings[0]) ? rings : [rings];
  let area = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of list) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a += p.x * q.y - q.x * p.y;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    area += Math.abs(a) / 2;
  }
  const w = maxX - minX, h = maxY - minY;
  return { area, w, h, minWidth: Math.min(w, h), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** → { need:boolean, why:string } for a piece of this size under this hold-down */
export function retentionNeed(metrics, holdDown = 'undeclared') {
  const key = HOLD_DOWNS.includes(holdDown) ? holdDown : 'undeclared';
  const rule = RETENTION[key];
  if (!rule) return { need: false, holdDown: key, why: 'the part itself is fixed down' };
  const size = `${metrics.w.toFixed(1)}" × ${metrics.h.toFixed(1)}"`;
  const held = key === 'vacuum' ? 'too small for vacuum alone' : 'no hold-down is declared for the part';
  if (metrics.minWidth < rule.minWidth) return { need: true, holdDown: key, why: `${size} piece (under ${rule.minWidth}" across) — ${held}` };
  if (metrics.area < rule.area) return { need: true, holdDown: key, why: `${size} piece (under ${rule.area} sq in) — ${held}` };
  return { need: false, holdDown: key, why: `${size} piece is big enough to stay put` };
}

/**
 * Tab geometry for generateProfile that leaves a real bridge under THIS bit.
 * A triangular tab shorter than the bit is wide is cut away along the kerf
 * centre by the bit's own leading and trailing edge (a flat cutter of
 * radius R lowers the centre to the ramp height R away from the peak), so
 * the tab must be longer than the bit by a margin.
 */
export function tabSpecFor(diameter, { height = 0.08, spacing = 6 } = {}) {
  // 1.5 bit diameters + 0.15" leaves about 0.035–0.05" standing at the kerf
  // centre under 1/8" to 1/2" bits at the default height
  return { height, spacing, length: Math.max(0.3, 2 * height, 1.5 * diameter + 0.15) };
}

/**
 * Depth per pass for a bit: the strategy's usual step, never more than the
 * bit's own diameter, and never more than a DECLARED material allows.
 */
export function passDepthFor(diameter, base, materialKey = null) {
  let d = Math.min(base, PASS_RATIO * diameter);
  const mat = materialKey ? MATERIALS[materialKey] : null;
  if (mat) d = Math.min(d, mat.depthFactor * diameter);
  return Math.max(0.01, +d.toFixed(4));
}

// -------------------------------------------------------------- the gate

const LEVELS = { reach: 'error', passDepth: 'error', retention: 'warn', web: 'warn' };

export function checkMachinability(job, opts = {}) {
  const levels = { ...LEVELS, ...(opts.levels ?? {}) };
  const holdDown = opts.holdDown ?? 'undeclared';
  const errors = [], warnings = [];
  const say = (check, msg) => {
    if (levels[check] === 'error') errors.push(msg);
    else if (levels[check] === 'warn') warnings.push(msg);
  };
  const T = job.stock.thickness;
  const opsOut = [], pieces = [], webs = [];
  const ms = { pass: 0, retention: 0, web: 0 };
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const flatFeatures = [];   // { name, paths, depth, through } for the web check
  const freed = [];          // { name, rings, paths } outside-through profiles

  job.operations.forEach((op, i) => {
    const name = op.name ?? `op${i}`;
    const unit = unitFactorOf(op, job);
    const tool = job.tools?.[op.tool] ?? {};
    // a V-carve posts its bit as a POINT (a nominal 0.002" diameter — the
    // verifier's tip model); depth there follows the geometry, so none of
    // the diameter-based checks apply
    const point = tool.diameter > 0 && tool.diameter < 0.02;
    const D = tool.diameter > 0 && !point ? tool.diameter : null;
    const kind = point ? 'vee' : (tool.kind ?? 'flat');
    const placed = applyPlacement(op.moves, op.placement, unit);
    const segs = cuttingSegments(placed);
    const rec = { name, tool: op.tool, kind, diameter: D, deepest: 0, reach: null, maxPass: null, passLimit: null, passChecked: false };
    opsOut.push(rec);
    if (!segs.length || !D) return;

    let deepest = 0;
    for (const s of segs) deepest = Math.min(deepest, s.z0, s.z1);
    rec.deepest = round4(-deepest);

    // ---- reach ----
    if (kind !== 'vee' && levels.reach !== 'off') {
      const reach = tool.maxDepth > 0 ? tool.maxDepth : REACH_RATIO * D;
      rec.reach = round4(reach);
      if (-deepest > reach + 1e-3) {
        say('reach', `"${name}" cuts ${fmt3(-deepest)}" deep with a ${fmtD(D)}" bit that reaches ${fmt3(reach)}" (${tool.maxDepth > 0 ? 'its declared cutting length' : `${REACH_RATIO}× its diameter`}) — above that the shank rubs the wall; use a bit at least ${fmtD(Math.ceil((-deepest / REACH_RATIO) * 32) / 32)}" or cut shallower`);
      }
    }

    // ---- pass depth ----
    if (kind !== 'vee' && levels.passDepth !== 'off') {
      const t0 = now();
      const m = measurePassDepth(segs, D / 2, kind, opts.maxCells ?? 6e6);
      ms.pass += now() - t0;
      if (m) {
        rec.passChecked = true;
        rec.maxPass = round4(m.max);
        rec.passLimit = round4(PASS_RATIO * D);
        if (m.max > PASS_RATIO * D + Math.max(0.01, 0.05 * D)) {
          say('passDepth', `"${name}" meets ${fmt3(m.max)}" of material in one pass with a ${fmtD(D)}" bit (${(m.max / D).toFixed(1)}× its diameter, limit ${PASS_RATIO}×) near (${fmt2(m.at.x)}, ${fmt2(m.at.y)}) — small bits snap; take shallower passes`);
        }
      } else {
        warnings.push(`"${name}": pass depth not measured (the op is too large for the check at this bit size)`);
      }
    }

    // ---- collect geometry for retention and webs ----
    const target = op.target;
    const ringsOf = (t) => (t.rings ?? [t.outer, ...(t.holes ?? [])]).map(r => r.map(placePoint(op.placement, unit)));
    const through = target && (target.type === 'profile') && (target.side ?? 'outside') === 'outside'
      && target.depth * unit >= T - 0.01;
    if (through) {
      const rings = ringsOf(target);
      freed.push({ name, rings, paths: simplify(rings.map(toClip)), segs, R: D / 2 });
    } else if (kind === 'flat' && levels.web !== 'off') {
      // the declared region stands in for the swept area where there is one:
      // verifyJob has already proved the motion stays inside it, and it is
      // a handful of vertices where a pocket's sweep is tens of thousands
      const paths = target?.type === 'region'
        ? ClipperLib.Clipper.SimplifyPolygons(ringsOf(target).map(toClip), ClipperLib.PolyFillType.pftEvenOdd)
        : sweptPaths(segs, D / 2);
      flatFeatures.push({ name, paths, depth: -deepest, bbox: segBbox(segs, D / 2),
        allow: op.allowOverlap ? '*' : (Array.isArray(op.allowOverlapWith) ? op.allowOverlapWith : []) });
    }
  });

  // ---- retention ----
  const tR = now();
  if (levels.retention !== 'off') {
    for (const f of freed) {
      const m = pieceMetrics(f.rings);
      const need = retentionNeed(m, holdDown);
      const b = measureBridges(f, T);
      const held = b.uncut || b.count >= MIN_BRIDGES;
      pieces.push({
        name: f.name, area: round2(m.area), w: round2(m.w), h: round2(m.h),
        need: need.need, bridges: b.uncut ? null : b.count, weakest: b.count ? round4(b.weakest) : null, held,
      });
      if (need.need && !held) {
        say('retention', `"${f.name}" frees a ${need.why}, and the cut leaves ${b.count ? `only ${b.count} bridge` : 'no tabs'} across its kerf — a loose piece this size can shift into the bit; add tabs, or declare how the part is held`);
      }
    }
  }

  ms.retention = now() - tR;

  // ---- thin webs (within one freed part) ----
  const tW = now();
  if (levels.web !== 'off') {
    for (const part of freed) {
      const pb = pathsBbox(part.paths);
      const mine = flatFeatures.filter(f => bboxOverlap(f.bbox, pb) && area(intersect(f.paths, part.paths)) > 1e-4);
      for (const f of mine) {
        // a feature that already runs out through the part's edge (a dado
        // to the edge, a rabbet) is open there by design
        if (area(difference(f.paths, offset(part.paths, 0.01))) > 1e-4) continue;
        const w = webLimit(Math.min(f.depth, T));
        const poke = difference(offset(f.paths, w), part.paths);
        const a = area(poke);
        if (a > w * 0.05) {
          const at = pathsBbox(poke);
          const rec = { a: f.name, b: part.name, limit: round4(w), at: { x: round2((at.minX + at.maxX) / 2), y: round2((at.minY + at.maxY) / 2) } };
          webs.push(rec);
          say('web', `"${f.name}" (${fmt3(f.depth)}" deep) comes within ${fmt3(w)}" of the edge of the part "${part.name}" frees, near (${rec.at.x}, ${rec.at.y}) — a wall that thin breaks out; move it in or make it shallower`);
        }
      }
      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          const a = mine[i], b = mine[j];
          if (a.allow === '*' || b.allow === '*' || a.allow.includes(b.name) || b.allow.includes(a.name)) continue;
          if (!bboxOverlap(grow(a.bbox, 0.2), b.bbox)) continue;
          if (area(intersect(a.paths, b.paths)) > 1e-5) continue;   // touching/overlapping is the verifier's business
          const w = webLimit(Math.min(a.depth, b.depth, T));
          const close = intersect(offset(a.paths, w / 2), offset(b.paths, w / 2));
          if (area(close) > w * 0.05) {
            const at = pathsBbox(close);
            const rec = { a: a.name, b: b.name, limit: round4(w), at: { x: round2((at.minX + at.maxX) / 2), y: round2((at.minY + at.maxY) / 2) } };
            webs.push(rec);
            say('web', `"${a.name}" and "${b.name}" leave a wall thinner than ${fmt3(w)}" between them near (${rec.at.x}, ${rec.at.y}) — it will break out; space them apart`);
          }
        }
      }
    }
  }

  ms.web = now() - tW;
  return { ok: errors.length === 0, errors, warnings, holdDown, ops: opsOut, pieces, webs, ms };
}

// a wall should be at least a third as wide as the cut beside it is deep
const webLimit = (depth) => Math.max(0.03, Math.min(0.125, depth / 3));

// ------------------------------------------------------------ motion → segs

// Cutting segments (either end below the stock top), arcs flattened, with a
// `brk` flag where the cutter stopped cutting sideways (a rapid or a plunge)
function cuttingSegments(moves) {
  const out = [];
  let pos = { x: 0, y: 0, z: 0 };
  let brk = true;
  for (const m of moves) {
    if (m.type !== 'rapid' && m.type !== 'linear' && m.type !== 'arc') continue;
    const next = {
      x: m.x !== undefined ? m.x : pos.x,
      y: m.y !== undefined ? m.y : pos.y,
      z: m.z !== undefined ? m.z : pos.z,
    };
    const cutting = m.type !== 'rapid' && (next.z < -EPS || pos.z < -EPS);
    const dxy = Math.hypot(next.x - pos.x, next.y - pos.y);
    if (!cutting || dxy < 1e-9) { brk = true; pos = next; continue; }
    if (m.type === 'arc') {
      const cx = pos.x + (m.i ?? 0), cy = pos.y + (m.j ?? 0);
      const r = Math.hypot(pos.x - cx, pos.y - cy);
      let a0 = Math.atan2(pos.y - cy, pos.x - cx), a1 = Math.atan2(next.y - cy, next.x - cx);
      let sweep = a1 - a0;
      if (m.cw) { if (sweep >= -1e-12) sweep -= 2 * Math.PI; } else if (sweep <= 1e-12) sweep += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
      let p = pos;
      for (let k = 1; k <= n; k++) {
        const t = k / n, a = a0 + sweep * t;
        const q = k === n ? next : { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: pos.z + (next.z - pos.z) * t };
        out.push({ x0: p.x, y0: p.y, z0: p.z, x1: q.x, y1: q.y, z1: q.z, brk });
        brk = false; p = q;
      }
    } else {
      out.push({ x0: pos.x, y0: pos.y, z0: pos.z, x1: next.x, y1: next.y, z1: next.z, brk });
      brk = false;
    }
    pos = next;
  }
  return out;
}

function segBbox(segs, pad = 0) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of segs) {
    b.minX = Math.min(b.minX, s.x0, s.x1); b.maxX = Math.max(b.maxX, s.x0, s.x1);
    b.minY = Math.min(b.minY, s.y0, s.y1); b.maxY = Math.max(b.maxY, s.y0, s.y1);
  }
  return grow(b, pad);
}

// ------------------------------------------------------------- pass depth

// Replay the op into a height grid (stock top = 0) and, at every step, read
// the uncut material standing in the forward half of the cutter. Stamps lag
// the cutter by more than its diameter so the reading is the stock as the
// pass FOUND it, not as its own last few steps left it; the lag is flushed
// whenever sideways cutting stops (a plunge or a rapid), so a pass that
// retraces the one before it reads that pass's floor.
function measurePassDepth(segs, R, kind, maxCells) {
  const b = segBbox(segs, R + 0.05);
  let cell = (2 * R) / 8;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if ((w / cell) * (h / cell) > maxCells) cell = Math.sqrt((w * h) / maxCells);
  if (cell > (2 * R) / 5) return null;
  const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  const top = new Float32Array(cols * rows);   // 0 = uncut stock top
  const rc = Math.ceil(R / cell);
  // cutter surface height above its tip at horizontal distance d
  const lift = kind === 'ball' ? (d2) => R - Math.sqrt(Math.max(0, R * R - d2)) : () => 0;

  const stamp = (x, y, z) => {
    const ci = Math.round((x - b.minX) / cell), ri = Math.round((y - b.minY) / cell);
    for (let dr = -rc; dr <= rc; dr++) {
      const r = ri + dr; if (r < 0 || r >= rows) continue;
      const yy = b.minY + r * cell - y;
      for (let dc = -rc; dc <= rc; dc++) {
        const c = ci + dc; if (c < 0 || c >= cols) continue;
        const xx = b.minX + c * cell - x;
        const d2 = xx * xx + yy * yy;
        if (d2 > R * R) continue;
        const zc = z + lift(d2);
        const k = r * cols + c;
        if (zc < top[k]) top[k] = zc;
      }
    }
  };
  const read = (x, y) => {
    const c = Math.round((x - b.minX) / cell), r = Math.round((y - b.minY) / cell);
    return (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : top[r * cols + c];
  };

  const rho = Math.max(0, R - 1.5 * cell);
  const fan = [-60, -30, 0, 30, 60].map(d => (d * Math.PI) / 180);
  const lag = Math.ceil((2 * R + 2 * cell) / cell);
  const pending = [];
  const flush = () => { for (const p of pending) stamp(p.x, p.y, p.z); pending.length = 0; };
  let max = 0, at = null;

  for (const s of segs) {
    if (s.brk) flush();
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const n = Math.max(1, Math.ceil(len / cell));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = s.x0 + dx * t, y = s.y0 + dy * t, z = s.z0 + (s.z1 - s.z0) * t;
      if (z < -EPS) {
        for (const a of fan) {
          const ca = Math.cos(a), sa = Math.sin(a);
          const qx = x + rho * (ux * ca - uy * sa), qy = y + rho * (ux * sa + uy * ca);
          const eng = read(qx, qy) - (z + lift(rho * rho));
          if (eng > max) { max = eng; at = { x, y }; }
        }
      }
      pending.push({ x, y, z });
      if (pending.length > lag) { const p = pending.shift(); stamp(p.x, p.y, p.z); }
    }
  }
  return { max, at, cell };
}

// --------------------------------------------------------------- retention

// Walk the kerf of a freed piece (the piece outline grown by the bit
// radius = where the bit's centre ran) and, at each station, find the floor
// the op left ACROSS the kerf: the lowest any cutting sample within one bit
// radius reached. A station is bridged when even the thinnest spot across
// the kerf still stands MIN_BRIDGE above the stock bottom. Bridges are runs
// of bridged stations. Only deep samples are indexed — a shallow pass
// cannot lower a floor a deep one did not.
function measureBridges(f, T) {
  const R = f.R;
  const deepZ = -T + 0.25;
  const hcell = R;
  const hash = new Map();
  const key = (cx, cy) => cx * 73856093 ^ cy * 19349663;
  const step = 0.01;
  let any = false;
  for (const s of f.segs) {
    if (Math.min(s.z0, s.z1) > deepZ) continue;
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n, z = s.z0 + (s.z1 - s.z0) * t;
      if (z > deepZ) continue;
      const x = s.x0 + dx * t, y = s.y0 + dy * t;
      const kk = key(Math.floor(x / hcell), Math.floor(y / hcell));
      let arr = hash.get(kk); if (!arr) hash.set(kk, arr = []);
      arr.push(x, y, z); any = true;
    }
  }
  if (!any) return { uncut: true, count: 0, weakest: T };
  const floorAt = (x, y) => {
    const cx = Math.floor(x / hcell), cy = Math.floor(y / hcell);
    let lo = 0;   // 0 = untouched above the deep band
    let hit = false;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const arr = hash.get(key(cx + a, cy + c)); if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const ddx = arr[i] - x, ddy = arr[i + 1] - y;
        if (ddx * ddx + ddy * ddy <= R * R && (!hit || arr[i + 2] < lo)) { lo = arr[i + 2]; hit = true; }
      }
    }
    return hit ? lo : deepZ;
  };

  const lat = [-0.9, -0.45, 0, 0.45, 0.9];
  let count = 0, weakest = Infinity, stations = 0, bridgedStations = 0;
  for (const path of offset(f.paths, R)) {
    const ring = path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
    const flags = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = -dy / len, ny = dx / len;
      const n = Math.max(1, Math.ceil(len / 0.04));
      for (let k = 0; k < n; k++) {
        const t = k / n, x = a.x + dx * t, y = a.y + dy * t;
        let thin = Infinity;
        for (const l of lat) thin = Math.min(thin, floorAt(x + nx * l * R, y + ny * l * R) + T);
        flags.push(thin >= MIN_BRIDGE ? thin : 0);
      }
    }
    stations += flags.length;
    const N = flags.length;
    if (!N) continue;
    if (flags.every(v => v > 0)) { bridgedStations += N; continue; }
    // runs of bridged stations, circular; start just after an unbridged one
    const start = flags.findIndex(v => v === 0);
    let run = 0, runMax = 0;
    for (let j = 1; j <= N; j++) {
      const v = flags[(start + j) % N];
      if (v > 0) { run++; runMax = Math.max(runMax, v); bridgedStations++; }
      else {
        if (run >= 2) { count++; weakest = Math.min(weakest, runMax); }
        run = 0; runMax = 0;
      }
    }
  }
  if (stations && bridgedStations === stations) return { uncut: true, count: 0, weakest: T };
  return { uncut: false, count, weakest: count ? weakest : 0 };
}

// ------------------------------------------------------------------ clipper

const toClip = ring => ring.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const simplify = paths => ClipperLib.Clipper.SimplifyPolygons(paths, ClipperLib.PolyFillType.pftNonZero);
const area = paths => paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);

function offset(paths, d) {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, d * SCALE);
  return out;
}
function boolean(type, a, b) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}
const intersect = (a, b) => boolean(ClipperLib.ClipType.ctIntersection, a, b);
const difference = (a, b) => boolean(ClipperLib.ClipType.ctDifference, a, b);

// swept footprint of cutting segments under a round cutter
function sweptPaths(segs, R) {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL);
  let path = null;
  const end = () => {
    if (path && path.length === 1) path.push({ X: path[0].X + 1, Y: path[0].Y });
    if (path && path.length >= 2) co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    path = null;
  };
  for (const s of segs) {
    if (s.brk) end();
    const a = { X: Math.round(s.x0 * SCALE), Y: Math.round(s.y0 * SCALE) };
    const b = { X: Math.round(s.x1 * SCALE), Y: Math.round(s.y1 * SCALE) };
    if (!path) path = [a];
    const last = path[path.length - 1];
    if (last.X !== b.X || last.Y !== b.Y) path.push(b);
  }
  end();
  const out = new ClipperLib.Paths();
  co.Execute(out, R * SCALE);
  return simplify(out);
}

function pathsBbox(paths) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of paths) for (const q of p) {
    b.minX = Math.min(b.minX, q.X / SCALE); b.maxX = Math.max(b.maxX, q.X / SCALE);
    b.minY = Math.min(b.minY, q.Y / SCALE); b.maxY = Math.max(b.maxY, q.Y / SCALE);
  }
  return b;
}
const grow = (b, d) => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d });
const bboxOverlap = (a, b) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

// ------------------------------------------------------------------- misc

function placePoint(placement = {}, unit = 1) {
  const { x: tx = 0, y: ty = 0, rotateDeg = 0, scale = 1 } = placement ?? {};
  const s = unit * scale, rad = (rotateDeg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  return p => ({ x: p.x * s * cos - p.y * s * sin + tx, y: p.x * s * sin + p.y * s * cos + ty });
}
function unitFactorOf(op, job) {
  const from = op.units ?? job.units;
  if (from === job.units) return 1;
  return from === 'mm' ? 1 / 25.4 : 25.4;
}
const fmt3 = n => Number(n).toFixed(3);
const fmt2 = n => Number(n).toFixed(2);
const fmtD = n => String(+Number(n).toFixed(4));
const round4 = n => Math.round(n * 1e4) / 1e4;
const round2 = n => Math.round(n * 100) / 100;
