// Side-by-side tallies for N probe result files over the SAME prompt set —
// the model-generation comparison. Deterministic (no API); the LLM triage
// and a human reading the failing rows remain the judges of overclaims.
//
//   node compare-models.mjs label=file.jsonl [label=file.jsonl ...]
//
// first-turn verified = the loop's first observation was ok (built right
// before any second look); confident-on-failure = summary reads as a
// success while the pipeline is empty / failed (word-list proxy).

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 2) { console.error('usage: node compare-models.mjs label=file.jsonl label=file.jsonl ...'); process.exit(1); }
const HEDGE = /\b(fail|failed|failing|could not|couldn't|cannot|can't|not (yet )?(built|building|possible|supported|in the catalog)|declin|unable|skipped|did not|didn't|won't|does not (yet )?post|nothing was built)\b/i;
const read = (p) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const sets = args.map(a => { const [label, file] = a.split('='); return { label, rows: read(file) }; });
function tally(rows) {
  const t = { n: rows.length, verified: 0, firstTurnOk: 0, firstTurnObserved: 0, empty: 0, cof: 0, declined: 0, fixes: 0, looks: 0, revised: 0, calls: 0, inTok: 0, cacheTok: 0, outTok: 0, errors: 0, priorMiss: 0, declinePriorBuilt: 0, firstSkips: 0 };
  for (const r of rows) {
    if (r.outcome === 'ERROR' || /CRASH/.test(r.outcome)) t.errors++;
    if (r.verified) t.verified++;
    const empty = !(r.pipeline?.length);
    if (empty) t.empty++;
    if (r.declined?.length) t.declined++;
    if ((r.verified === false || empty) && r.summary && !HEDGE.test(r.summary) && !r.declined?.length) t.cof++;
    const pt = r.loop?.perTurn?.[0];
    if (pt && pt.ok !== null && pt.ok !== undefined) { t.firstTurnObserved++; if (pt.ok) t.firstTurnOk++; }
    t.fixes += r.loop?.fixes || 0;
    if ((r.loop?.turns ?? 1) > 1) t.looks++;
    if (r.loop?.summaryChanged) t.revised++;
    t.firstSkips += (r.firstSkipped ?? r.skipped ?? []).length;
    t.calls += r.usage?.calls ?? 1;
    t.inTok += r.usage?.input_tokens ?? 0;
    t.cacheTok += (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0);
    t.outTok += r.usage?.output_tokens ?? 0;
    if (r.prior === 'covered' && !/FULFILLED/.test(r.outcome ?? '')) t.priorMiss++;
    if (r.prior === 'decline' && r.verified && r.pipeline?.length && !r.declined?.length) t.declinePriorBuilt++;
  }
  return t;
}
const T = sets.map(s => ({ label: s.label, t: tally(s.rows) }));
const pct = (k) => T.map(({ t }) => `${t[k]}/${t.n}`);
const raw = (k, f = (x) => String(x)) => T.map(({ t }) => f(t[k]));
const rows = [
  ['verified (final)', pct('verified')],
  ['verified on the FIRST turn', T.map(({ t }) => `${t.firstTurnOk}/${t.firstTurnObserved}`)],
  ['empty pipeline', pct('empty')],
  ['confident-on-failure (proxy)', pct('cof')],
  ['rows with declines', pct('declined')],
  ['decline-prior built w/o decline', pct('declinePriorBuilt')],
  ['covered-prior misses', pct('priorMiss')],
  ['first-turn skipped actions', raw('firstSkips')],
  ['second looks / corrections', T.map(({ t }) => `${t.looks} / ${t.fixes}`)],
  ['errors / crashes', raw('errors')],
  ['model calls', raw('calls')],
  ['uncached input tokens', raw('inTok', (x) => x.toLocaleString())],
  ['cached input tokens', raw('cacheTok', (x) => x.toLocaleString())],
  ['output tokens', raw('outTok', (x) => x.toLocaleString())],
];
const w0 = Math.max(...rows.map(r => r[0].length));
const cw = Math.max(14, ...T.map(x => x.label.length));
console.log(`${''.padEnd(w0)}  ${T.map(x => x.label.padEnd(cw)).join(' ')}`);
for (const [k, vals] of rows) console.log(`${k.padEnd(w0)}  ${vals.map(v => String(v).padEnd(cw)).join(' ')}`);

// per-prompt matrix: outcome glyphs per model
const ids = [...new Set(sets.flatMap(s => s.rows.map(r => r.id)))];
const glyph = (r) => !r ? '   -   ' : /ERROR|CRASH/.test(r.outcome) ? '  ERR  ' : r.verified ? (r.declined?.length ? ' ✓ dec ' : '   ✓   ') : !(r.pipeline?.length) ? (r.declined?.length ? '  dec  ' : ' empty ') : ' FAIL  ';
console.log(`\n${'prompt'.padEnd(28)} ${T.map(x => x.label.slice(0, 7).padEnd(8)).join('')}`);
for (const id of ids) {
  console.log(`${id.padEnd(28)} ${sets.map(s => glyph(s.rows.find(r => r.id === id))).map(g => g.padEnd(8)).join('')}`);
}
console.log('\n✓ verified · ✓ dec verified + honest decline · dec declined, nothing built · empty no ops, no decline · FAIL verify failed · ERR crash');
