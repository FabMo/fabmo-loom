// Stance A/B — does asking the model to COMMIT TO A DESIGN IDIOM before it
// authors make "make me a stool" stop converging on the same stool?
//
// Same underspecified ask, N samples each: the CURRENT prompt (which carries
// STANCE_RULE and the stance schema field, app/intent.mjs) vs. a baseline
// with the rule stripped out. Round 1 (2026-10-05) used a prompt-only rule
// that LISTED example idioms and read the idiom off a summary prefix: spread
// 8/20 → 14/20 but 11 of 20 picks were the list's first entry. Round 2 is
// the no-list rule + schema field. Each sample is fingerprinted from the RECIPE it produced
// (strategies, furniture box/panels/features, shape ids, control count),
// so "distinct designs per ask" is measured on what would be cut, not on
// prose. First call only (no closed loop) — spread is a parse-time property.
//
//   node stance-ab.mjs [samples=4] [asks=stool,bookshelf,...]
// Writes runs/stance-ab-<day>.jsonl; prints the tally.

import { readFileSync, appendFileSync } from 'node:fs';
import { makeCallModel } from './model-call.mjs';

const LOOM = new URL('../..', import.meta.url).pathname;
const { EMPTY_RECIPE } = await import(`${LOOM}/app/runtime.mjs`);
const { buildParseRequest, applyActions, STANCE_RULE } = await import(`${LOOM}/app/intent.mjs`);
const { registerCatalogEntries } = await import(`${LOOM}/app/catalog.mjs`);
for (const g of [
  '/var/opt/apps/contributors/brian.o/furniture_designer_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/braille_sign_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/furniture_compiler/shared/loom-guest.mjs',
]) registerCatalogEntries((await import(g)).entries);

const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)[1].trim();
const callModel = makeCallModel({ key, onRetry: (why, n) => console.log(`  model call: ${why} — retry ${n + 1}`) });

const ASKS = {
  stool: 'make me a stool',
  bookshelf: 'a bookshelf',
  coaster: 'a coaster with my name on it, Brian',
  birdhouse: 'a birdhouse',
  tray: 'a serving tray',
};


const argv = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const N = +(argv.samples ?? 4);
const askIds = (argv.asks ?? Object.keys(ASKS).join(',')).split(',');
const day = new Date().toISOString().slice(0, 10);
const outFile = new URL(`./runs/stance-ab-${day}${argv.tag ? '-' + argv.tag : ''}.jsonl`, import.meta.url).pathname;

const r2 = v => (Number.isFinite(v) ? Math.round(v * 2) / 2 : v);   // half-inch buckets
function fingerprint(recipe) {
  const parts = [];
  for (const op of recipe.pipeline ?? []) {
    if (op.strategy === 'furniture_design') {
      const d = op.params?.design ?? {};
      const box = Array.isArray(d.box) ? d.box.map(v => (typeof v === 'number' ? r2(v) : String(v))) : null;
      const panels = (d.panels ?? []).map(p => `${p.axis}${p.corners?.length ? '∠' : ''}${p.cutouts?.length ? '□' : ''}${p.rot ? '↻' : ''}`).sort().join('');
      parts.push(`furn[${box?.join('x')}|${(d.panels ?? []).length}p:${panels}|${d.joinery?.style ?? ''}]`);
    } else {
      const p = op.params ?? {};
      const bits = [op.strategy];
      for (const k of ['shape', 'texture', 'font', 'face', 'place']) if (p[k] !== undefined) bits.push(`${k}=${p[k]}`);
      for (const k of ['width', 'height', 'diameter', 'depth', 'letterHeight']) if (typeof p[k] === 'number') bits.push(`${k}=${r2(p[k])}`);
      parts.push(bits.join(','));
    }
  }
  const shapes = (recipe.shapes ?? []).map(s => Object.keys(s).filter(k => k !== 'id').join('/')).sort().join(';');
  return `${parts.join(' > ')} ‖ shapes:${shapes} ‖ ctrls:${(recipe.controls ?? []).length}`;
}

const results = [];
for (const askId of askIds) {
  const prompt = ASKS[askId] ?? askId;
  for (const variant of ['baseline', 'stance']) {
    for (let i = 0; i < N; i++) {
      const recipe = structuredClone(EMPTY_RECIPE);
      const req = buildParseRequest(recipe, prompt);
      if (!req.system.includes(STANCE_RULE)) throw new Error('STANCE_RULE is not in the live prompt — nothing to A/B');
      const system = variant === 'stance' ? req.system : req.system.replace(STANCE_RULE + '\n', '');
      req.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      let data;
      try { data = await callModel(req); }
      catch (e) { console.log(`  ${askId}/${variant}#${i}: API ERROR ${String(e?.message ?? e).slice(0, 120)}`); continue; }
      const tu = data.content?.find(b => b.type === 'tool_use');
      if (!tu) { console.log(`  ${askId}/${variant}#${i}: no tool call`); continue; }
      const out = applyActions(recipe, tu.input);
      const row = {
        ask: askId, prompt, variant, i,
        stance: out.stance?.idiom ?? null, stanceWhy: out.stance?.why ?? null, decisions: out.stance?.decisions ?? [],
        summary: tu.input.summary, fp: fingerprint(out.recipe),
        pipeline: out.recipe.pipeline.map(o => o.strategy), declined: out.declined.map(d => d.what),
        suggest: out.suggest ?? [], outTok: data.usage?.output_tokens,
      };
      results.push(row);
      appendFileSync(outFile, JSON.stringify(row) + '\n');
      console.log(`  ${askId}/${variant}#${i}: ${row.stance ? `[${row.stance}] ` : ''}${row.fp}`);
    }
  }
}

console.log('\n=== spread: distinct designs per ask (fingerprint of the recipe) ===');
for (const askId of askIds) {
  for (const variant of ['baseline', 'stance']) {
    const rows = results.filter(r => r.ask === askId && r.variant === variant);
    const distinct = new Set(rows.map(r => r.fp)).size;
    const stances = rows.map(r => r.stance).filter(Boolean);
    console.log(`${askId.padEnd(10)} ${variant.padEnd(9)} ${distinct}/${rows.length} distinct${stances.length ? ` — ${[...new Set(stances)].join(', ')}` : ''}`);
  }
}
console.log(`\nrows → ${outFile}`);
