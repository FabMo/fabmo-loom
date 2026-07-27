// Live re-probe of named prompt ids after a capability lands — the
// decline→feature conversion check (AGENTS.md integration checklist #5).
//
// Usage: node live-retest.mjs hex-trivet chess-board cribbage

import { readFileSync, readdirSync } from 'node:fs';
import { PROMPTS, FAKE_SVG } from './prompts.mjs';

// prompt ids resolve from the pilot set first, then any nightly batch
// (runs/<day>-prompts.json) — nightly finds are retestable by id too
const RUNS = new URL('./runs/', import.meta.url).pathname;
const NIGHTLY = readdirSync(RUNS).filter(f => f.endsWith('-prompts.json'))
  .flatMap(f => JSON.parse(readFileSync(RUNS + f, 'utf8')));

const LOOM = new URL('../..', import.meta.url).pathname;
const { EMPTY_RECIPE, runRecipe, controlDefaults } = await import(`${LOOM}/app/runtime.mjs`);
const { buildParseRequest, applyActions } = await import(`${LOOM}/app/intent.mjs`);
const { registerCatalogEntries } = await import(`${LOOM}/app/catalog.mjs`);
const { FONTS } = await import(`${LOOM}/app/fonts.mjs`);

for (const g of [
  '/var/opt/apps/contributors/brian.o/furniture_designer_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/braille_sign_app/shared/loom-guest.mjs',
]) registerCatalogEntries((await import(g)).entries);

const fonts = {};
for (const f of FONTS) {
  const buf = readFileSync(new URL(f.file, `file://${LOOM}/app/`).pathname);
  fonts[f.id] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)[1].trim();

const quiet = (fn) => {
  const o = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = o; console.warn = w; }
};

const ids = process.argv.slice(2);
for (const id of ids) {
  const p = PROMPTS.find(x => x.id === id) ?? NIGHTLY.find(x => x.id === id);
  if (!p) { console.log(`${id}: no such prompt (pilot or nightly)`); continue; }
  const recipe = structuredClone(EMPTY_RECIPE);
  if (p.asset === 'svg') recipe.assets.push({ id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: FAKE_SVG });
  const req = buildParseRequest(recipe, p.prompt);
  req.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  console.log(`\n=== ${id} — stop ${data.stop_reason}, ${data.usage?.output_tokens} out tokens`);
  const tu = data.content?.find(b => b.type === 'tool_use');
  if (!tu || data.stop_reason === 'max_tokens') { console.log('  STILL TRUNCATED/EMPTY'); continue; }
  const out = applyActions(recipe, tu.input);
  console.log(`  summary: ${tu.input.summary}`);
  console.log(`  pipeline: ${out.recipe.pipeline.map(o => o.strategy).join(', ') || '(none)'}`);
  console.log(`  patterns: ${(out.recipe.shapes ?? []).filter(s => s.pattern).map(s => `${s.id}=pattern(${JSON.stringify(s.pattern)})`).join('; ') || '(none)'}`);
  if (out.skipped.length) console.log(`  skipped: ${out.skipped.join(' | ')}`);
  if (out.declined.length) console.log(`  declined: ${out.declined.map(d => d.what).join(' ; ')}`);
  try {
    const r = quiet(() => runRecipe(out.recipe, controlDefaults(out.recipe), fonts));
    console.log(`  verified: ${r.ok}${r.ok ? ' → SBP' : ' — ' + (r.errors ?? []).join(' | ')}`);
  } catch (e) {
    console.log(`  WEAVE CRASH: ${String(e).slice(0, 200)}`);
  }
}
