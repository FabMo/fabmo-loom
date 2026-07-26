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
// Usage: node test-corpus.mjs [--bless]
//   --bless: rewrite blessed outcomes to current behavior (run after a
//            deliberate improvement; review the IMPROVED lines first)

import { writeFileSync } from 'node:fs';
import { loadEnv, replayRow, blessOf, compareToBlessed, readCorpus, usesGuestStrategy } from './corpus-lib.mjs';

// Two corpus files, same schema: corpus.jsonl (synthetic probe rows —
// committed, public) and corpus.local.jsonl (funnel rows — REAL USER
// prompt text, gitignored, never enters the public repo; the same
// public-mechanism/private-mount split as app/guests.local.mjs).
const FILES = ['./corpus.jsonl', './corpus.local.jsonl']
  .map(f => new URL(f, import.meta.url).pathname);
const bless = process.argv.includes('--bless');

const sources = FILES.map(path => ({ path, rows: readCorpus(path) })).filter(s => s.rows);
if (!sources.length) {
  console.log('[corpus] SKIP — no corpus.jsonl here (probe runs create it)');
  process.exit(0);
}
const env = await loadEnv();

let total = 0, ok = 0, improved = 0, regressions = 0, guestSkips = 0;
for (const src of sources) {
  const out = [];
  for (const row of src.rows) {
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

console.log(`[corpus] ${total} rows: ${ok} ok, ${improved} improved${bless ? ' (re-blessed)' : improved ? ' (run --bless after review)' : ''}, ${guestSkips} guest-skipped, ${regressions} REGRESSION(S)`);
process.exit(regressions ? 1 : 0);
