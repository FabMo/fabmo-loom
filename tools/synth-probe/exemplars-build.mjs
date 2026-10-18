#!/usr/bin/env node
// exemplars-build — distill the recorded-model-output corpus into
// app/exemplars.json, the worked-example index pickExemplars() searches.
//
//   node exemplars-build.mjs            # corpus.jsonl + corpus.local.jsonl → ../../app/exemplars.json
//   node exemplars-build.mjs --dry      # report only
//
// Funnel rows (real users' prompts) never go in: the index is served to
// every visitor. A row qualifies when it is a FIRST-TURN build (empty starting recipe —
// edit rows act on a prior document and would mislead a fresh ask), it
// replayed VERIFIED at bless time, and nothing it asked for was skipped
// (a FULFILLED row, or a PARTIAL whose declines were honest). The quoted
// actions are the first turn's followed by any corrective actions the
// loop emitted: applying them in order is what produced the verified
// recipe. One row per distinct prompt AND per probe id (the nightly
// re-probes the same ids in fresh wordings; the phone fetches this file,
// so one row per subject) — FULFILLED beats PARTIAL, an uncorrected build
// beats a corrected one, newer beats older.
//
// Run nightly after corpus-add so the index grows with the corpus.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOM = path.resolve(HERE, '..', '..');
const OUT = path.join(LOOM, 'app', 'exemplars.json');
const dry = process.argv.includes('--dry');

const { actionList } = await import(`${LOOM}/app/intent.mjs`);
const { normPrompt } = await import(`${LOOM}/app/exemplars.mjs`);

const read = (f) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const rows = [...read(path.join(HERE, 'corpus.jsonl')), ...read(path.join(HERE, 'corpus.local.jsonl'))];

const isFresh = (ctx) => !ctx || (!(ctx.pipeline?.length) && !(ctx.controls?.length) && !(ctx.shapes?.length));
const firstSentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{20,240}?[.!?](?=\s|$)/);
  return (m ? m[0] : t.slice(0, 240)).trim();
};

const stats = { rows: rows.length, funnel: 0, notFresh: 0, notVerified: 0, skipped: 0, empty: 0, dupes: 0, kept: 0 };
const byPrompt = new Map(), bySubject = new Map();
for (const r of rows) {
  // the index is SERVED to every visitor of the page: real users' prompts
  // (funnel rows, corpus.local.jsonl) stay out of it — synthetic rows only
  if (r.source === 'funnel' || /^funnel-/.test(r.key)) { stats.funnel++; continue; }
  if (!isFresh(r.context)) { stats.notFresh++; continue; }
  const b = r.blessed ?? {};
  if (b.verified !== true || !['FULFILLED', 'PARTIAL'].includes(b.outcome)) { stats.notVerified++; continue; }
  if ((b.skipped ?? 0) > 0) { stats.skipped++; continue; }
  const first = actionList(r.payload);
  const revised = actionList({ actions: r.revisedActions ?? [] });
  const actions = [...first, ...revised];
  if (!actions.some(a => a.kind === 'add_operation')) { stats.empty++; continue; }
  const kinds = [...new Set(actions.map(a => a.operation?.strategy).filter(Boolean))];
  const date = String(r.recordedAt ?? r.key).slice(0, 10);
  const cand = {
    key: r.key, date, prompt: r.prompt.trim(), actions, summary: firstSentence(r.payload?.summary),
    kinds, outcome: b.outcome, ...(r.photo ? { photo: true } : {}),
    _rank: [b.outcome === 'FULFILLED' ? 1 : 0, revised.length ? 0 : 1, date],
  };
  // probe rows share a subject id across nights ("2026-10-02/shoe-rack-angled");
  // funnel rows (q_…, timestamps) have none and dedupe by prompt only
  const slug = r.key.replace(/^[^/]*\//, '');
  const subject = r.source === 'funnel' || /^q_|^\d{4}-\d{2}-\d{2}T/.test(slug) ? null : slug;
  // picture rows share the default utterance; each picture is its own subject
  const np = r.photo ? r.key : normPrompt(cand.prompt);
  const better = (a, b2) => { const d = a._rank.map((v, i) => [v, b2._rank[i]]).find(([x, y]) => x !== y); return !!d && d[0] > d[1]; };
  const prevP = byPrompt.get(np), prevS = subject && bySubject.get(subject);
  if (prevP || prevS) {
    stats.dupes++;
    if (prevP && !better(cand, prevP)) continue;
    if (prevS && !better(cand, prevS)) continue;
    if (prevP) byPrompt.delete(prevP._np), prevP._subject && bySubject.delete(prevP._subject);
    if (prevS) bySubject.delete(prevS._subject), byPrompt.delete(prevS._np);
  }
  cand._subject = subject; cand._np = np;
  byPrompt.set(np, cand);
  if (subject) bySubject.set(subject, cand);
}

const out = [...byPrompt.values()].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
  .map(({ _rank, _subject, _np, ...row }) => row);
stats.kept = out.length;
const bytes = Buffer.byteLength(JSON.stringify(out));
const kindCount = {};
for (const r of out) for (const k of r.kinds) kindCount[k] = (kindCount[k] ?? 0) + 1;

console.log(`exemplars: ${stats.kept} rows from ${stats.rows} (${stats.funnel} funnel rows kept private, ${stats.notFresh} edit rows, ${stats.notVerified} unverified, ${stats.skipped} with skips, ${stats.empty} without ops, ${stats.dupes} duplicate prompts) — ${(bytes / 1024).toFixed(0)} KB, ${out.filter(r => r.photo).length} photo rows`);
console.log('  by strategy: ' + Object.entries(kindCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
if (!dry) {
  const json = JSON.stringify(out);
  writeFileSync(OUT, json);
  writeFileSync(`${OUT}.gz`, gzipSync(json, { level: 9 }));   // the phone fetches this one (see loadExemplars)
}
