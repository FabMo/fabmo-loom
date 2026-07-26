// Append recorded model responses to the corpus, blessing each with its
// CURRENT replay outcome. Accepts probe results rows AND funnel-log rows
// (they differ only in field names). Duplicate keys are skipped, so
// re-running on the same file is safe.
//
// Usage: node corpus-add.mjs <rows.jsonl> <runKey> [--prompts <file.mjs>]
//   runKey: namespaces the rows, e.g. "2026-07-26-pilot" or "funnel"
//   --prompts: reconstruct missing context from a prompts file's asset
//              specs (needed only for the pilot results, which predate
//              context recording)

import { readFileSync, appendFileSync } from 'node:fs';
import { loadEnv, replayRow, blessOf, readCorpus, usesGuestStrategy } from './corpus-lib.mjs';

const [, , inPath, runKey] = process.argv;
if (!inPath || !runKey) { console.error('usage: node corpus-add.mjs <rows.jsonl> <runKey> [--prompts <file>]'); process.exit(1); }
const promptsFlag = process.argv.indexOf('--prompts');
const promptsFile = promptsFlag > 0 ? process.argv[promptsFlag + 1] : null;

const CORPUS = new URL('./corpus.jsonl', import.meta.url).pathname;
// funnel rows carry REAL USER prompt text — they append to the gitignored
// local overlay, never to the committed (public) corpus.jsonl
const LOCAL = new URL('./corpus.local.jsonl', import.meta.url).pathname;
const env = await loadEnv();

let promptSpecs = null, FAKE_SVG = null;
if (promptsFile) {
  const m = await import(new URL(promptsFile, import.meta.url).href);
  promptSpecs = Object.fromEntries(m.PROMPTS.map(p => [p.id, p]));
  FAKE_SVG = m.FAKE_SVG;
}

const existing = new Set([...(readCorpus(CORPUS) ?? []), ...(readCorpus(LOCAL) ?? [])].map(r => r.key));
const rows = readFileSync(new URL(inPath, import.meta.url).pathname, 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

let added = 0, skippedDup = 0, skippedBad = 0, guestless = 0;
for (const [idx, raw] of rows.entries()) {
  // normalize probe-results and funnel-log shapes into a corpus row;
  // early funnel entries predate query ids — fall back to timestamp
  const actions = raw.rawActions ?? raw.actions;
  const id = raw.id ?? raw.ts ?? `row-${idx}`;
  const key = `${runKey}/${id}`;
  if (!Array.isArray(actions)) { skippedBad++; continue; }        // truncated/malformed responses aren't replayable
  if (existing.has(key)) { skippedDup++; continue; }
  let context = raw.context ?? null;
  if (!context && promptSpecs?.[id]?.asset === 'svg') {
    context = structuredClone(env.EMPTY_RECIPE);
    context.assets.push({ id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: FAKE_SVG });
  }
  const row = {
    key,
    source: raw.utterance ? 'funnel' : 'synthetic',
    prompt: raw.prompt ?? raw.utterance,
    prior: raw.prior,
    context,
    payload: { summary: raw.summary ?? '', actions, declined: raw.declined ?? [] },
    recordedAt: raw.ts ?? new Date().toISOString().slice(0, 10),
  };
  if (usesGuestStrategy(row, env) && !env.guestsLoaded) { guestless++; continue; }
  row.blessed = blessOf(replayRow(row, env));
  appendFileSync(row.source === 'funnel' ? LOCAL : CORPUS, JSON.stringify(row) + '\n');
  existing.add(key);
  added++;
}
console.log(`corpus-add: ${added} added, ${skippedDup} duplicate, ${skippedBad} unreplayable (no action list)${guestless ? `, ${guestless} guest rows skipped (guests unavailable)` : ''}`);
console.log(`corpus now: ${readCorpus(CORPUS)?.length ?? 0} rows`);
