// Corpus regression gauntlet — replays every recorded model response
// against the CURRENT pipeline (applyActions → runRecipe → verify) and
// fails on any row the pipeline now handles WORSE than at bless time.
// No API calls, no cost: the model's answers are already on disk.
//
// This is the test the hand-written gauntlet can't be: real model
// output, including the malformed, the truncated-adjacent, and the
// creatively wrong — accumulated from every probe run and funnel pull.
//
// Skips cleanly when no corpus exists (public clones). Guest rows skip
// where the guest modules aren't mounted.
//
// Usage: node test-corpus.mjs [--bless] [--workers N]
//   --bless: rewrite blessed outcomes to current behavior (run after a
//            deliberate improvement; review the IMPROVED lines first)
//   --workers N: replay in N child processes at a time (default: one per
//            CPU, max 4). The rows go out in CHUNKS of --chunk rows (default
//            100), each chunk a short-lived child: a replay is seconds of
//            synchronous weave per row and a single process grew past
//            1.5 GB over 900 rows (the box has 3 GB), which is what
//            stretched the check to 28 minutes and past the nightly's
//            window — seven "regression" nights in Oct 2026 were timeouts.
//            --bless always runs single-file (it rewrites the files).
//   --range a:b: internal — this process replays global rows a ≤ i < b.

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnv, replayRow, blessOf, compareToBlessed, readCorpus, usesGuestStrategy } from './corpus-lib.mjs';

// Two corpus files, same schema: corpus.jsonl (synthetic probe rows —
// committed, public) and corpus.local.jsonl (funnel rows — REAL USER
// prompt text, gitignored, never enters the public repo; the same
// public-mechanism/private-mount split as app/guests.local.mjs).
const FILES = ['./corpus.jsonl', './corpus.local.jsonl']
  .map(f => new URL(f, import.meta.url).pathname);
const bless = process.argv.includes('--bless');

const argAfter = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const rangeSpec = argAfter('--range');
const range = rangeSpec ? rangeSpec.split(':').map(Number) : null;   // [a, b)
const workersArg = Number(argAfter('--workers'));
const workers = bless || range ? 1 : (workersArg > 0 ? workersArg : Math.min(4, cpus().length));
const CHUNK = Number(argAfter('--chunk')) > 0 ? Number(argAfter('--chunk')) : 100;

const sources = FILES.map(path => ({ path, rows: readCorpus(path) })).filter(s => s.rows);
if (!sources.length) {
  console.log('[corpus] SKIP — no corpus.jsonl here (probe runs create it)');
  process.exit(0);
}

// ---- parent: hand out chunks to short-lived children, sum their tallies ----
if (workers > 1) {
  const self = fileURLToPath(import.meta.url);
  const rowCount = sources.reduce((n, src) => n + src.rows.length, 0);
  const chunks = [];
  for (let a = 0; a < rowCount; a += CHUNK) chunks.push([a, Math.min(rowCount, a + CHUNK)]);
  const runChunk = ([a, b]) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=1024', self, '--range', `${a}:${b}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '', tally = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith('[corpus-chunk] ')) tally = JSON.parse(line.slice(15));
        else if (line) console.log(line);   // the REGRESSION / improved lines, verbatim
      }
    });
    child.on('close', (code) => resolve(tally ?? { crashed: true, code, range: `${a}:${b}` }));
  });
  const tallies = [];
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < chunks.length) tallies.push(await runChunk(chunks[next++]));
  }));
  const crashed = tallies.filter(t => t.crashed);
  const sum = (k) => tallies.reduce((n, t) => n + (t[k] ?? 0), 0);
  const total = sum('total'), ok = sum('ok'), improved = sum('improved'), regressions = sum('regressions'), guestSkips = sum('guestSkips');
  if (crashed.length) console.log(`  ✗ ${crashed.length} chunk(s) CRASHED (${crashed.map(c => `rows ${c.range} exit ${c.code}`).join(', ')}) — their rows were not judged`);
  console.log(`[corpus] ${total} rows: ${ok} ok, ${improved} improved${improved ? ' (run --bless after review)' : ''}, ${guestSkips} guest-skipped, ${regressions} REGRESSION(S) (${chunks.length} chunks × ${CHUNK}, ${workers} workers)`);
  process.exit(regressions || crashed.length ? 1 : 0);
}

const env = await loadEnv();

let total = 0, ok = 0, improved = 0, regressions = 0, guestSkips = 0;
let index = -1;
for (const src of sources) {
  const out = [];
  for (const row of src.rows) {
    index++;
    if (range && (index < range[0] || index >= range[1])) continue;
    total++;
    if (usesGuestStrategy(row, env) && !env.guestsLoaded) { guestSkips++; out.push(row); continue; }
    const replay = replayRow(row, env);
    const cmp = compareToBlessed(replay, row.blessed);
    if (cmp.verdict === 'REGRESSION') {
      regressions++;
      console.log(`  ✗ REGRESSION ${row.key}: ${cmp.why}`);
      console.log(`      "${(row.prompt ?? '').slice(0, 90)}"`);
    } else if (cmp.verdict === 'IMPROVED') {
      improved++;
      console.log(`  ↑ improved ${row.key}: ${cmp.why}${bless ? ' (re-blessed)' : ''}`);
    } else ok++;
    out.push(bless ? { ...row, blessed: blessOf(replay) } : row);
  }
  if (bless) {
    writeFileSync(src.path, out.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
}

if (range) {
  console.log(`[corpus-chunk] ${JSON.stringify({ total, ok, improved, regressions, guestSkips })}`);
  process.exit(0);   // the parent decides; a chunk's exit code only signals a crash
}
console.log(`[corpus] ${total} rows: ${ok} ok, ${improved} improved${bless ? ' (re-blessed)' : improved ? ' (run --bless after review)' : ''}, ${guestSkips} guest-skipped, ${regressions} REGRESSION(S)`);
process.exit(regressions ? 1 : 0);
