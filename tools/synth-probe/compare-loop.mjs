// Compare two probe result files over the SAME prompt set — typically
// LOOP=off vs LOOP=always (or two models) — and tally what the second
// look changed. Deterministic: no API. The nightly LLM triage remains the
// judge of semantic overclaims; this script measures the mechanical
// proxies that are visible without a judge.
//
//   node compare-loop.mjs results-off.jsonl results-loop.jsonl
//
// "confident-on-failure" = the summary reads like a success while the
// pipeline is empty or the weave failed: the overclaim shape the loop
// exists to remove. Word-list heuristic; read the rows before quoting it.

import { readFileSync } from 'node:fs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) { console.error('usage: node compare-loop.mjs <results-A.jsonl> <results-B.jsonl>'); process.exit(1); }
const read = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const A = read(aPath), B = read(bPath);
const byId = (rows) => new Map(rows.map(r => [r.id, r]));
const HEDGE = /\b(fail|failed|could not|couldn't|cannot|can't|not (yet )?(built|possible|supported|in the catalog)|declin|unable|skipped|did not|didn't|won't)\b/i;

function tally(rows) {
  const t = { n: rows.length, outcomes: {}, verified: 0, emptyPipeline: 0, confidentOnFailure: 0, declined: 0, fixes: 0, secondLook: 0, summaryRevised: 0, calls: 0, inTok: 0, outTok: 0 };
  for (const r of rows) {
    t.outcomes[r.outcome] = (t.outcomes[r.outcome] ?? 0) + 1;
    if (r.verified) t.verified++;
    const empty = !(r.pipeline?.length);
    if (empty) t.emptyPipeline++;
    if (r.declined?.length) t.declined++;
    const failing = r.verified === false || empty;
    if (failing && r.summary && !HEDGE.test(r.summary) && !r.declined?.length) t.confidentOnFailure++;
    if (r.loop) {
      t.fixes += r.loop.fixes || 0;
      if (r.loop.turns > 1) t.secondLook++;
      if (r.loop.summaryChanged) t.summaryRevised++;
    }
    t.calls += r.usage?.calls ?? 1;
    t.inTok += (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0);
    t.outTok += r.usage?.output_tokens ?? 0;
  }
  return t;
}

const ta = tally(A), tb = tally(B);
const pct = (k, t) => `${t[k]} (${t.n ? Math.round(100 * t[k] / t.n) : 0}%)`;
console.log(`A = ${aPath} (${ta.n} rows)   B = ${bPath} (${tb.n} rows)\n`);
const rows = [
  ['verified', pct('verified', ta), pct('verified', tb)],
  ['empty pipeline', pct('emptyPipeline', ta), pct('emptyPipeline', tb)],
  ['confident-on-failure (proxy)', pct('confidentOnFailure', ta), pct('confidentOnFailure', tb)],
  ['rows with declines', pct('declined', ta), pct('declined', tb)],
  ['second looks taken', `${ta.secondLook}`, `${tb.secondLook}`],
  ['corrections applied', `${ta.fixes}`, `${tb.fixes}`],
  ['summaries revised', `${ta.summaryRevised}`, `${tb.summaryRevised}`],
  ['model calls', `${ta.calls}`, `${tb.calls}`],
  ['input tokens (incl. cached)', ta.inTok.toLocaleString(), tb.inTok.toLocaleString()],
  ['output tokens', ta.outTok.toLocaleString(), tb.outTok.toLocaleString()],
];
const w = Math.max(...rows.map(r => r[0].length));
console.log(`${'metric'.padEnd(w)}  ${'A'.padEnd(16)} B`);
for (const [k, a, b] of rows) console.log(`${k.padEnd(w)}  ${String(a).padEnd(16)} ${b}`);
console.log(`\noutcomes A: ${JSON.stringify(ta.outcomes)}\noutcomes B: ${JSON.stringify(tb.outcomes)}`);

// per-prompt deltas worth reading
const mb = byId(B);
const moved = [];
for (const a of A) {
  const b = mb.get(a.id); if (!b) continue;
  const av = !!a.verified, bv = !!b.verified;
  const ae = !(a.pipeline?.length), be = !(b.pipeline?.length);
  if (av !== bv || ae !== be || (a.outcome !== b.outcome)) moved.push(`  ${a.id}: ${a.outcome}${av ? '✓' : ''}${ae ? ' ∅' : ''} → ${b.outcome}${bv ? '✓' : ''}${be ? ' ∅' : ''}${b.loop?.fixes ? ` (${b.loop.fixes} fixes)` : ''}`);
}
if (moved.length) console.log(`\nrows whose outcome/verify/pipeline changed (${moved.length}):\n${moved.join('\n')}`);
