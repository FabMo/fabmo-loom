// Judge check — run the "did it build what was asked" gate (judgeBuild in
// app/intent.mjs) over RECORDED probe rows, so the judge itself can be
// measured: which builds it keeps, which it sends back, and why. Each row's
// final recipe is rebuilt from its recorded actions and woven for real.
//
//   node judge-check.mjs <results.jsonl> [--model id] [--ids a,b,c] [--tier0] [--out file.jsonl]
//
// --tier0  only rows a cascade kept at its first rung
// Prints one line per row; costs one small model call per row.

import { readFileSync, appendFileSync } from 'node:fs';
import { makeCallModel } from './model-call.mjs';
import { loadEnv } from './corpus-lib.mjs';

const HERE = new URL('./', import.meta.url).pathname;
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const file = process.argv[2];
const rows = readFileSync(file.startsWith('/') ? file : `${HERE}${file}`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const ids = arg('--ids')?.split(',') ?? null;
const out = arg('--out');
const env = await loadEnv();
const { judgeBuild, JUDGE_MODEL } = await import('../../app/intent.mjs');
const model = arg('--model') ?? JUDGE_MODEL;
const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
const call = makeCallModel({ key });
const log = console.log;
const quiet = (fn) => { console.log = console.warn = () => {}; try { return fn(); } finally { console.log = log; } };

let keep = 0, redo = 0, none = 0, tokIn = 0, tokOut = 0;
for (const row of rows) {
  if (ids && !ids.includes(row.id)) continue;
  if (process.argv.includes('--declined') && !(row.declined ?? []).length) continue;
  if (process.argv.includes('--tier0') && row.cascade?.tier !== 0) continue;
  if (!Array.isArray(row.rawActions) || !row.verified) continue;
  let recipe = structuredClone(row.context ?? env.EMPTY_RECIPE);
  recipe = env.applyActions(recipe, { summary: '', actions: row.rawActions }).recipe;
  if (row.revisedActions?.length) recipe = env.applyActions(recipe, { summary: '', actions: row.revisedActions }).recipe;
  if (!recipe.pipeline.length) continue;
  const weaveResult = quiet(() => env.runRecipe(recipe, env.controlDefaults(recipe), env.fonts, {}));
  const v = await judgeBuild(call, { utterance: row.prompt, recipe, weaveResult, declined: row.declined ?? [], model });
  tokIn += (v.usage?.input_tokens ?? 0) + (v.usage?.cache_read_input_tokens ?? 0); tokOut += v.usage?.output_tokens ?? 0;
  if (v.verdict === 'keep') keep++; else if (v.verdict === 'redo') redo++; else none++;
  if (process.argv.includes('--declined')) log(`      declined: ${(row.declined ?? []).map(d => String(d.what).slice(0, 70)).join(' | ')}`);
  log(`${(v.verdict ?? 'NONE').padEnd(5)} ${row.id.padEnd(30)} ${v.onSubject === false ? 'OFF-SUBJECT ' : ''}${v.reduced ? 'REDUCED ' : ''}${v.missing?.length ? `missing: ${v.missing.join('; ')} ` : ''}${v.makeable?.length ? `COULD HAVE MADE: ${v.makeable.join('; ')} ` : ''}| is: ${v.subject ?? ''} | ${v.why}`);
  if (out) appendFileSync(out, JSON.stringify({ id: row.id, file, model, ...v, usage: undefined }) + '\n');
}
log(`\n${keep} keep, ${redo} redo, ${none} unjudged — judge ${model}, ${tokIn} input + ${tokOut} output tokens`);
