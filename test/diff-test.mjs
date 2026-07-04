// Differential test: terrain_carver's native posts vs passesToMoves + the
// shared moves-rail posts, on identical kernel output.
//
// Comparison is SEMANTIC, not byte-level: both outputs are parsed into a
// normalized motion list (resolved sticky coordinates, no-op moves dropped)
// and compared position-by-position. Formatting differences (4 vs 6
// decimals, F-on-every-line vs F-on-change) are exactly what the shared
// rail is allowed to normalize; motion is not.
//
// Known, intentional semantic difference (SBP only): the native sbp.rs
// expresses the first plunge as M3 (runs at XY speed); the moves rail emits
// a Z-only linear → MZ (runs at the MS Z speed, i.e. the plunge rate). Same
// endpoint, more correct feed. Positions are compared for SBP; feeds are
// compared for G-code where both sides express them per-move.
//
// Usage:  cd test/diff && cargo run --release   # writes out/
//         node test/diff-test.mjs               # from seams/

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passesToMoves } from '../adapters/terrain.js';
import { movesToGcode, movesToSbp } from '../ir/moves.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = p => join(here, 'diff', 'out', p);

const TOL = 1e-3;

// ---------- parsers → normalized motion lists ----------

function pushIfMoved(list, pos, kind, feed) {
  const last = list.length ? list[list.length - 1] : { x: 0, y: 0, z: 0 };
  if (
    Math.abs(pos.x - last.x) < TOL &&
    Math.abs(pos.y - last.y) < TOL &&
    Math.abs(pos.z - last.z) < TOL
  ) {
    return; // no-op move (e.g. double retract in native footer)
  }
  list.push({ x: pos.x, y: pos.y, z: pos.z, kind, feed });
}

function parseGcode(text) {
  const motions = [];
  const pos = { x: 0, y: 0, z: 0 };
  let feed = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\(.*?\)/g, '').trim();
    if (!line) continue;
    const m = line.match(/^G([01])\b/);
    if (!m) continue; // setup/footer words: G90 G20 M3 M5 M30 G4 ...
    const get = axis => {
      const am = line.match(new RegExp(`${axis}(-?[\\d.]+)`));
      return am ? parseFloat(am[1]) : undefined;
    };
    const [x, y, z, f] = [get('X'), get('Y'), get('Z'), get('F')];
    if (f !== undefined) feed = f;
    if (x !== undefined) pos.x = x;
    if (y !== undefined) pos.y = y;
    if (z !== undefined) pos.z = z;
    pushIfMoved(motions, pos, m[1] === '0' ? 'rapid' : 'feed', m[1] === '0' ? null : feed);
  }
  return motions;
}

function parseSbp(text) {
  const motions = [];
  const pos = { x: 0, y: 0, z: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith("'")) continue;
    const parts = line.split(',').map(s => s.trim());
    const cmd = parts[0];
    const num = i => (parts[i] !== undefined && parts[i] !== '' ? parseFloat(parts[i]) : undefined);
    let kind = null;
    if (cmd === 'J2') { pos.x = num(1); pos.y = num(2); kind = 'rapid'; }
    else if (cmd === 'J3') { pos.x = num(1); pos.y = num(2); pos.z = num(3); kind = 'rapid'; }
    else if (cmd === 'JZ') { pos.z = num(1); kind = 'rapid'; }
    else if (cmd === 'M2') { pos.x = num(1); pos.y = num(2); kind = 'feed'; }
    else if (cmd === 'M3') { pos.x = num(1); pos.y = num(2); pos.z = num(3); kind = 'feed'; }
    else if (cmd === 'MZ') { pos.z = num(1); kind = 'feed'; }
    else continue; // SA TR C6 C7 MS PAUSE END ...
    pushIfMoved(motions, pos, kind, null);
  }
  return motions;
}

// ---------- comparison ----------

function compare(label, native, seam, { compareFeeds }) {
  const problems = [];
  const n = Math.max(native.length, seam.length);
  for (let i = 0; i < n; i++) {
    const a = native[i], b = seam[i];
    if (!a || !b) {
      problems.push(`#${i}: native=${fmt(a)} seam=${fmt(b)} (length mismatch ${native.length} vs ${seam.length})`);
      break;
    }
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(a[axis] - b[axis]) > TOL) {
        problems.push(`#${i} ${axis}: native=${a[axis]} seam=${b[axis]}`);
      }
    }
    if (a.kind !== b.kind) problems.push(`#${i} kind: native=${a.kind} seam=${b.kind}`);
    if (compareFeeds && a.kind === 'feed' && a.feed != null && b.feed != null &&
        Math.abs(a.feed - b.feed) > TOL) {
      problems.push(`#${i} feed: native=${a.feed} seam=${b.feed}`);
    }
  }
  if (problems.length) {
    console.log(`FAIL ${label}`);
    problems.slice(0, 10).forEach(p => console.log('  ' + p));
    return false;
  }
  console.log(`PASS ${label}: ${native.length} motions identical (tol ${TOL})`);
  return true;
}

const fmt = m => (m ? `${m.kind}(${m.x},${m.y},${m.z}${m.feed != null ? ',F' + m.feed : ''})` : '∅');

// ---------- run ----------

const tp = JSON.parse(readFileSync(out('toolpath.json'), 'utf8'));
const md = tp.metadata;

// Mirror the native posts' program-level moves (the part the Job composer
// will own): initial retract to safeZ, and footer retract + XY home.
const seamMoves = [
  { type: 'rapid', z: md.safeZ },
  ...passesToMoves(tp),
  { type: 'rapid', z: md.safeZ },
  { type: 'rapid', x: 0, y: 0 },
];

const okG = compare(
  'G-code',
  parseGcode(readFileSync(out('native.gcode'), 'utf8')),
  parseGcode(movesToGcode(seamMoves)),
  { compareFeeds: true },
);
const okS = compare(
  'SBP',
  parseSbp(readFileSync(out('native.sbp'), 'utf8')),
  parseSbp(movesToSbp(seamMoves)),
  { compareFeeds: false },
);

process.exit(okG && okS ? 0 : 1);
