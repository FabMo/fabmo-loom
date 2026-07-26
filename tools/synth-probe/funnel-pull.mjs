// Pull NEW real-user activity from the intent funnel log since the last
// pull (cursor in ./funnel-cursor.json). Real declines are the
// priority stream of the improvement loop — synthetic probes are only
// the coverage stream.
//
// Usage: node funnel-pull.mjs [--app loom] [--peek]
//   --app:  loom (default) | furniture | step_toolpath | all
//   --peek: report without advancing the cursor or writing a runs file
//
// Writes runs/funnel-YYYY-MM-DD.jsonl (the new rows, replayable and
// corpus-ready via corpus-add.mjs) and prints a triage summary.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const FUNNEL = '/var/opt/apps/.intent-funnel.jsonl';
const CURSOR = new URL('./funnel-cursor.json', import.meta.url).pathname;
const RUNS = new URL('./runs/', import.meta.url).pathname;

const appArg = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : 'loom';
const peek = process.argv.includes('--peek');

if (!existsSync(FUNNEL)) { console.log('[funnel] no funnel log at ' + FUNNEL); process.exit(0); }
const cursor = existsSync(CURSOR) ? JSON.parse(readFileSync(CURSOR, 'utf8')) : { lastTs: '' };

const rows = readFileSync(FUNNEL, 'utf8').trim().split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const fresh = rows.filter(r =>
  (r.ts ?? '') > cursor.lastTs && (appArg === 'all' || r.app === appArg));

console.log(`[funnel] ${rows.length} total entries; ${fresh.length} new for app "${appArg}" since ${cursor.lastTs || '(beginning)'}`);

const withDeclines = fresh.filter(r => r.declined?.length);
for (const r of withDeclines) {
  console.log(`\n  ${r.id} ${r.ts}  "${(r.utterance ?? '').slice(0, 100)}"`);
  for (const d of r.declined) console.log(`    declined: ${d.what} → ${(d.why ?? '').slice(0, 140)}`);
}
console.log(`\n[funnel] ${withDeclines.length} of ${fresh.length} new entries carry declines`);

if (!peek && fresh.length) {
  mkdirSync(RUNS, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const outPath = `${RUNS}funnel-${day}.jsonl`;
  writeFileSync(outPath, fresh.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[funnel] wrote ${outPath}`);
}
if (!peek) {
  const lastTs = rows.reduce((m, r) => ((r.ts ?? '') > m ? r.ts : m), cursor.lastTs);
  writeFileSync(CURSOR, JSON.stringify({ lastTs, pulledAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`[funnel] cursor → ${lastTs}`);
}
