// Loom app gauntlet — the mother app proven without an LLM in the loop.
//
// The intent layer's OUTPUT is data (recipe actions), so the whole path
// below the model is testable headlessly: scripted action payloads play
// Brian's three-prompt story ("an app to engrave names" → "cut them out"
// → "add tabs"), the validator rejects malformed actions, and the
// verifier gate is shown to hold against recipe states a prompt could
// reach.
//
// Usage: node app/test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_RECIPE, runRecipe, controlDefaults, migrateRecipe, buildVars, buildShapes } from './runtime.mjs';
import { applyActions, buildParseRequest, buildObservation, observationText, observationTroubled, buildReviseRequest, runIntentLoop, IntentError } from './intent.mjs';
import { simulateJob, surfaceAt } from './sim.mjs';
import { FONTS } from './fonts.mjs';
import { pathToRegions, expandTemplate } from './shape.mjs';
import { svgToRegions, svgAssetToRegions } from './svg.mjs';
import { recommendFeeds } from '../ir/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const FONT_SHELF = {};
for (const f of FONTS) {
  const b = readFileSync(join(here, f.file));
  FONT_SHELF[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};
// synthetic DEM fixture — a meandering canyon through a high plain, fully
// deterministic. Stands in for the browser-fetched elevation grid so the
// terrain lowering (a pure function of grid + params) tests offline.
const TERRAIN_FIXTURE = (() => {
  const cols = 240, rows = 180;
  const elev = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c / (cols - 1), y = r / (rows - 1);
      const meander = 0.5 + 0.18 * Math.sin(x * 5.2) + 0.08 * Math.sin(x * 13.7 + 1.3);
      const gorge = 950 * Math.exp(-((y - meander) ** 2) / (2 * 0.06 ** 2));
      const ridges = 120 * Math.sin(x * 21 + y * 7) * Math.sin(y * 17 - x * 3);
      elev[r * cols + c] = 2100 - gorge + ridges;
    }
  }
  return { gc: { grid: { elev, cols, rows }, meta: { name: 'Test Canyon', centerLat: 36.06, centerLng: -112.14 } } };
})();

const run = (recipe, values, terrains = TERRAIN_FIXTURE) =>
  quiet(() => runRecipe(recipe, values ?? controlDefaults(recipe), FONT_SHELF, terrains));

// ---------------- 1. empty recipe is honest ----------------

console.log('--- empty recipe ---');
{
  const r = run(EMPTY_RECIPE);
  if (!r.ok && r.errors[0].includes('no operations')) pass('empty recipe: friendly nothing-here error');
  else fail(`unexpected: ${JSON.stringify(r.errors)}`);
}

// ---------------- 2. prompt one: "an app to engrave names" ----------------

console.log('--- prompt 1 (scripted): an app to engrave names ---');
let recipe = structuredClone(EMPTY_RECIPE);
{
  const payload = {
    summary: 'Created a name-engraving app.',
    actions: [
      { kind: 'set_name', name: 'Name engraver' },
      { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'Brian' } },
      { kind: 'add_control', control: { id: 'letterHeight', type: 'number', label: 'Letter height (in)', default: 1, min: 0.2, max: 4, step: 0.125 } },
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: { ctrl: 'letterHeight' } } } },
    ],
    declined: [],
  };
  const res = applyActions(recipe, payload);
  recipe = res.recipe;
  if (res.applied.length === 4 && res.skipped.length === 0) pass(`4 actions applied: ${res.applied.join('; ')}`);
  else fail(`apply mismatch: applied=${res.applied.length} skipped=${JSON.stringify(res.skipped)}`);

  const r = run(recipe);
  const t = r.report?.stats.targets?.[0];
  if (r.ok && t?.gouges === 0 && r.sbp?.includes('MS,')) pass(`recipe runs verified: ${t.samples} samples, 0 gouges → SBP`);
  else fail(`recipe rejected: ${r.errors.join(' | ')}`);
}

// ---------------- 3. prompt two: "cut them out as tags" ----------------

console.log('--- prompt 2 (scripted): a cutout around the names ---');
{
  const payload = {
    summary: 'Added a rounded-corner tag cutout.',
    actions: [
      { kind: 'add_control', control: { id: 'buffer', type: 'number', label: 'Tag buffer (in)', default: 0.25, min: 0.125, max: 1, step: 0.125 } },
      { kind: 'add_operation', operation: { id: 'cutout', strategy: 'tag_cutout', params: { buffer: { ctrl: 'buffer' }, cornerRadius: 0.5 }, after: 'engrave' } },
    ],
    declined: [],
  };
  const res = applyActions(recipe, payload);
  recipe = res.recipe;
  const r = run(recipe);
  const prof = r.report?.stats.targets?.find(t => t.type === 'profile');
  const mounts = (r.sbp?.match(/C9/g) ?? []).length;
  if (r.ok && prof?.intrusionArea === 0 && mounts === 2) pass(`two-tool recipe verified (profile target clean, C9 × 2)`);
  else fail(`cutout recipe failed: ok=${r.ok} ${r.errors.join(' | ')}`);
}

// ---------------- suggested next prompts ride through sanitized ----------------
// The model returns `suggest` alongside its actions (same call — targeted
// chips cost no extra request); applyActions passes it through as clean
// strings only. Model output is data: junk entries drop, never throw.

console.log('--- suggest: targeted chips sanitized on the way through ---');
{
  const res = applyActions(recipe, {
    summary: 'noop', actions: [], declined: [{ what: 'x', why: 'y' }],
    suggest: ['  remove the grab handle  ', 42, '', '   ', 'carve ___ in the seat',
              'x'.repeat(200), 'make the handle ___ inches wide', 'a fourth suggestion past the cap'],
  });
  const want = ['remove the grab handle', 'carve ___ in the seat', 'make the handle ___ inches wide'];
  if (JSON.stringify(res.suggest) === JSON.stringify(want)) pass(`junk dropped, trimmed, capped at 3: ${res.suggest.join(' | ')}`);
  else fail(`suggest sanitation: got ${JSON.stringify(res.suggest)}`);

  const none = applyActions(recipe, { summary: 'noop', actions: [], declined: [] });
  if (Array.isArray(none.suggest) && none.suggest.length === 0) pass('absent suggest field → empty array (old payloads unaffected)');
  else fail(`absent suggest: got ${JSON.stringify(none.suggest)}`);
}

// ---------------- 4. prompt three: "add tabs" → now a FEATURE ----------------
// (Until 2026-07-05 this was the honest-decline case; then the tab skill
// graduated from the step app into seams/strategies/profile.js, synced in,
// and the catalog learned it. The decline → feature conversion is the
// whole platform loop in one test.)

console.log('--- prompt 3 (scripted): add holding tabs → woven, verified ---');
{
  const payload = {
    summary: 'Added holding tabs to the cutout.',
    actions: [{ kind: 'set_operation', operation: { id: 'cutout', params: { tabs: true } } }],
    declined: [],
  };
  const res = applyActions(recipe, payload);
  recipe = res.recipe;
  const r = run(recipe);
  const cut = r.preview?.built?.find(x => x.op.id === 'cutout');
  const nTabs = cut?.r.previewTabs?.length ?? 0;
  if (res.applied.length === 1 && r.ok && nTabs >= 4) {
    pass(`tabs woven: ${nTabs} tabs placed (cardinal coverage), job still verifies`);
  } else fail(`tabs failed: applied=${res.applied.length} ok=${r.ok} tabs=${nTabs} ${r.errors?.join(' | ')}`);
}

// ---------------- 4b. genuinely out-of-scope → honest decline ----------------

console.log('--- decline: engrave a photo → recipe unchanged ---');
{
  const before = JSON.stringify(recipe);
  const payload = {
    summary: 'Photographic engraving is not available.',
    actions: [],
    declined: [{ what: 'engrave a photo', why: 'no image/heightmap source in the catalog yet' }],
  };
  const res = applyActions(recipe, payload);
  recipe = res.recipe;
  if (JSON.stringify(recipe) === before && res.declined.length === 1) pass(`declined cleanly: ${res.declined[0].what}`);
  else fail('decline mutated the recipe');
}

// ---------------- 5. the validator: malformed model output is data, not damage ----------------

console.log('--- validator: bad actions are skipped with reasons ---');
{
  const before = JSON.stringify(recipe);
  const payload = {
    summary: 'mixed garbage',
    actions: [
      { kind: 'add_operation', operation: { id: 'x1', strategy: 'helical_thread_mill', params: {} } },
      { kind: 'add_operation', operation: { id: 'x2', strategy: 'tag_cutout', params: { dogbone: true } } },
      { kind: 'add_operation', operation: { id: 'x3', strategy: 'vcarve_text', params: { text: { ctrl: 'no_such_control' } } } },
      { kind: 'remove_control', id: 'name' },
      { kind: 'teleport', id: 'engrave' },
    ],
    declined: [],
  };
  const res = applyActions(recipe, payload);
  if (res.applied.length === 0 && res.skipped.length === 5 && JSON.stringify(res.recipe) === before) {
    pass(`all 5 rejected: ${res.skipped.map(s => s.split(':')[0]).join(', ')}`);
  } else fail(`validator leaked: applied=${JSON.stringify(res.applied)} skipped=${res.skipped.length}`);
}

// ---------------- 6. the gate holds against prompt-reachable states ----------------

console.log('--- verifier gate on recipe states ---');
{
  // a scary-looking parameter whose MOTION is safe: maxDepth 0.6" on 0.5"
  // stock, but the medial axis never gets wide enough to reach it — the
  // verifier measures the actual deepest Z and passes. Measured, not assumed.
  const deepCap = structuredClone(recipe);
  deepCap.pipeline.find(o => o.id === 'engrave').params.maxDepth = 0.6;
  const rc = run(deepCap);
  if (rc.ok) pass('maxDepth cap beyond stock but motion never reaches it: verifier measures, passes');
  else fail(`clamped-depth recipe wrongly rejected: ${rc.errors.join(' | ')}`);

  // and a state whose motion GENUINELY violates: outline cuts AT its depth,
  // so 0.6" on 0.5" stock is below the stock bottom on every stroke
  const deep = structuredClone(recipe);
  deep.pipeline = [{ id: 'outline', strategy: 'outline_text', params: { text: { ctrl: 'name' }, letterHeight: { ctrl: 'letterHeight' }, depth: 0.6 } }];
  const r = run(deep);
  if (!r.ok && !r.sbp) pass(`outline below stock bottom: REJECTED, no file (${(r.errors[0] ?? '').slice(0, 60)}...)`);
  else fail('below-stock recipe produced a file');

  // big text no longer "doesn't fit" — the stock grows to hold it and the
  // user is told the minimum board
  const big = run(recipe, { ...controlDefaults(recipe), name: 'Congratulations', letterHeight: 2 });
  if (big.ok && big.preview.stock.w > 18) pass(`big text auto-sizes the stock: minimum board ${big.preview.stock.w}" × ${big.preview.stock.h}"`);
  else fail(`auto-size failed: ok=${big.ok} stock=${JSON.stringify(big.preview?.stock)} ${big.errors?.join(' | ')}`);
}

// ---------------- 7. catalog breadth: outline style swap ----------------

console.log('--- outline_text: strategy swap by prompt ---');
{
  const alt = structuredClone(recipe);
  const res = applyActions(alt, {
    summary: 'Outline style instead of V-carve.',
    actions: [
      { kind: 'remove_operation', id: 'engrave' },
      { kind: 'add_operation', operation: { id: 'outline', strategy: 'outline_text', params: { text: { ctrl: 'name' }, letterHeight: { ctrl: 'letterHeight' } } } },
    ],
    declined: [],
  });
  // outline must come BEFORE the cutout (remove+add appends after it) — reorder
  res.recipe.pipeline.sort((a, b) => (a.strategy === 'tag_cutout') - (b.strategy === 'tag_cutout'));
  const r = run(res.recipe);
  const on = r.report?.stats.targets?.find(t => t.side === 'on');
  if (r.ok && on && on.depthViolations === 0) pass(`outline recipe verified ('on' profile target, 0 depth violations)`);
  else fail(`outline swap failed: ${r.errors?.join(' | ')}`);
}

// ---------------- 8. request shape sanity ----------------

console.log('--- buildParseRequest ---');
{
  const req = buildParseRequest(recipe, 'make the letters taller');
  if (req.tools?.[0]?.name === 'apply_recipe_actions' && req.system.includes('vcarve_text')
      && req.system.includes('AUTO-SIZED') && req.system.includes(String(recipe.stock.thickness))) {
    pass('request carries catalog doc + auto-size rule + thickness + forced tool choice');
  } else fail('parse request malformed');
}

// ---------------- 8b. the closed loop: act → observe → revise ----------------
// The model's second look is driven by a scripted fake `call`, so the
// whole act/observe/revise choreography tests offline: what the model is
// shown, how the conversation is threaded, when the loop stops, and that
// the summary the user reads is the one written with the weave in view.

console.log('--- intent loop: observation ---');
{
  const rec0 = structuredClone(EMPTY_RECIPE);
  const applyOut = applyActions(rec0, {
    summary: 'Built a sign with a rabbet.',
    actions: [
      { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Word', default: 'Hi' } },
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1 } } },
      { kind: 'add_operation', operation: { id: 'bogus', strategy: 'vcarve_text', params: { text: 'x', roundover: 0.25 } } },
    ],
    declined: [],
  });
  const r = run(applyOut.recipe);
  const obs = buildObservation(applyOut, r, applyOut.recipe);
  const txt = observationText(obs);
  if (obs.applied.length === 2 && obs.skipped.length === 1 && /unknown param "roundover"/.test(obs.skipped[0])) pass('observation carries applied + skipped with reasons');
  else fail(`observation apply bookkeeping: ${JSON.stringify({ a: obs.applied, s: obs.skipped })}`);
  if (obs.ok === true && obs.pipeline.length === 1 && obs.pipeline[0].id === 'engrave' && obs.stock?.w > 0) pass('observation carries verify verdict, pipeline, auto-sized board');
  else fail(`observation weave fields: ${JSON.stringify({ ok: obs.ok, p: obs.pipeline, st: obs.stock })}`);
  if (/SKIPPED \(1\) — these did NOT happen/.test(txt) && /PIPELINE \(machining order\): engrave \(vcarve_text\)/.test(txt) && /WEAVE: VERIFIED/.test(txt) && /board \d/.test(txt)) pass('observation text: skips flagged as not-happened, pipeline, verdict, board');
  else fail(`observation text:\n${txt}`);
  if (observationTroubled(obs)) pass('a skip counts as trouble'); else fail('skip not troubled');
  const clean = buildObservation({ applied: ['x'], skipped: [], recipe: applyOut.recipe }, r, applyOut.recipe);
  if (!observationTroubled(clean)) pass('clean verified weave is not trouble'); else fail('clean weave flagged as trouble');
  const empty = buildObservation({ applied: [], skipped: [], recipe: rec0 }, run(rec0), rec0);
  if (observationTroubled(empty) && /PIPELINE: EMPTY/.test(observationText(empty))) pass('empty pipeline is trouble and says so'); else fail('empty pipeline observation');
  const nowe = buildObservation(applyOut, null, applyOut.recipe);
  if (nowe.ok === null && /WEAVE: not run/.test(observationText(nowe))) pass('no weave → observation says so'); else fail('no-weave observation');
}

console.log('--- intent loop: revise request threading ---');
{
  const req = buildParseRequest(structuredClone(EMPTY_RECIPE), 'a sign');
  const content = [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'apply_recipe_actions', input: { summary: 's', actions: [] } }];
  const obs = buildObservation({ applied: [], skipped: [], recipe: EMPTY_RECIPE }, null, EMPTY_RECIPE);
  const r2 = buildReviseRequest(req, content, 'tu_1', obs);
  const m = r2.messages;
  if (m.length === 3 && m[1].role === 'assistant' && m[1].content === content && m[2].role === 'user'
      && m[2].content[0].type === 'tool_result' && m[2].content[0].tool_use_id === 'tu_1' && /Look before you speak/.test(m[2].content[1].text)
      && r2.system === req.system && r2.tool_choice.name === 'apply_recipe_actions') pass('revise request threads assistant + tool_result on the same system/tools');
  else fail(`revise request shape: ${JSON.stringify(m.map(x => x.role))}`);
  const r3 = buildReviseRequest(r2, content, 'tu_2', obs, { final: true });
  if (r3.messages.length === 5 && /LAST call: emit NO actions/.test(r3.messages[4].content[1].text)) pass('final turn asks for no actions');
  else fail('final revise request');
}

console.log('--- intent loop: act → observe → fix → final ---');
{
  const recipe = structuredClone(EMPTY_RECIPE);
  const seen = [];   // what the fake model was shown each call
  const script = [
    // turn 0: overclaims a cutout it never authored, and one param is bogus
    { summary: 'Built a nameplate with a v-carved name and a rounded tag cutout.', actions: [
      { kind: 'set_name', name: 'Nameplate' },
      { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Name', default: 'Ada' } },
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1, roundover: 1 } } },
    ], declined: [], suggest: ['make the letters taller', 'add a border'] },
    // turn 1: sees the skip + missing cutout, fixes both, rewrites summary
    { summary: 'Built a nameplate: the name v-carved, cut out as a rounded tag.', actions: [
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1 } } },
      { kind: 'add_operation', operation: { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } } },
    ], declined: [], suggest: ['make the tag buffer bigger'] },
    // turn 2 (final): no actions, honest summary
    { summary: 'Nameplate: v-carved name on a rounded tag, verified.', actions: [], declined: [], suggest: ['make the letters taller ___'] },
  ];
  let call = 0;
  const fake = async (req) => {
    seen.push(req);
    const p = script[call++];
    return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: `tu_${call}`, name: 'apply_recipe_actions', input: p }] };
  };
  const out = await runIntentLoop({ recipe, utterance: 'a nameplate for Ada, cut out as a tag', call: fake, weave: async (r) => run(r) });
  if (out.turns.length === 3 && out.usage.calls === 3) pass('three calls: act, fix, final'); else fail(`turn count ${out.turns.length}, calls ${out.usage.calls}`);
  if (out.summary === script[2].summary && out.firstSummary === script[0].summary) pass('user reads the FINAL summary; first is kept for measurement'); else fail(`summaries: ${out.summary} / ${out.firstSummary}`);
  if (out.fixes === 2 && out.revised && out.recipe.pipeline.map(o => o.id).join(',') === 'engrave,tag') pass('corrections applied on top: engrave re-added clean, tag added'); else fail(`fixes ${out.fixes}, pipeline ${out.recipe.pipeline.map(o => o.id)}`);
  const shown1 = seen[1].messages[2].content[0].content;
  if (/SKIPPED \(1\)/.test(shown1) && /roundover/.test(shown1) && /PIPELINE: EMPTY/.test(shown1)) pass('turn 1 was shown the skip and the empty pipeline'); else fail(`turn-1 observation:\n${shown1}`);
  const shown2 = seen[2].messages[4].content[0].content;
  if (/WEAVE: VERIFIED/.test(shown2) && /engrave \(vcarve_text\) → tag \(tag_cutout\)/.test(shown2) && /LAST call/.test(seen[2].messages[4].content[1].text)) pass('turn 2 was shown the verified pipeline and told it is the last call'); else fail(`turn-2 observation:\n${shown2}`);
  if (out.suggest[0] === 'make the letters taller ___') pass('chips come from the final turn'); else fail(`suggest ${out.suggest}`);
  if (out.usage.input_tokens === 300 && out.usage.output_tokens === 30) pass('usage summed across calls'); else fail(`usage ${JSON.stringify(out.usage)}`);
  if (run(out.recipe).ok) pass('final recipe verifies'); else fail('final recipe does not verify');
}

console.log('--- intent loop: stop conditions ---');
{
  const mk = (payload) => async () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'tu', name: 'apply_recipe_actions', input: payload }] });
  // a pure decline never gets a second call — nothing to look at
  let calls = 0;
  const decl = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'carve my dog',
    call: async (r) => { calls++; return mk({ summary: 'no', actions: [], declined: [{ what: 'a dog likeness', why: 'blob' }] })(r); }, weave: async (r) => run(r) });
  if (calls === 1 && decl.declined.length === 1 && !decl.revised) pass('pure decline: one call'); else fail(`decline calls ${calls}`);
  // a clean turn 0 still gets ONE look in 'always' mode; the look with no actions ends it
  calls = 0;
  const good = { summary: 'Sign built.', actions: [
    { kind: 'add_control', control: { id: 'w', type: 'text', label: 'W', default: 'Hi' } },
    { kind: 'add_operation', operation: { id: 'e', strategy: 'vcarve_text', params: { text: { ctrl: 'w' }, letterHeight: 1 } } },
  ], declined: [] };
  const conf = { summary: 'Sign built and verified: Hi v-carved.', actions: [], declined: [] };
  const two = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'a sign', call: async (r) => { calls++; return mk(calls === 1 ? good : conf)(r); }, weave: async (r) => run(r) });
  if (calls === 2 && two.summary === conf.summary && two.fixes === 0) pass("'always': clean build → one confirming look, summary from it"); else fail(`always calls ${calls}`);
  // 'trouble' mode skips the look when the weave is clean
  calls = 0;
  const tr = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'a sign', mode: 'trouble', call: async (r) => { calls++; return mk(good)(r); }, weave: async (r) => run(r) });
  if (calls === 1 && tr.summary === good.summary) pass("'trouble': clean build → no second call"); else fail(`trouble calls ${calls}`);
  // 'off' is the one-shot
  calls = 0;
  const off = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'a sign', mode: 'off', call: async (r) => { calls++; return mk(good)(r); }, weave: async (r) => run(r) });
  if (calls === 1 && !off.revised) pass("'off': one call, no observation"); else fail(`off calls ${calls}`);
  // cap: a model that keeps emitting actions is cut off at maxTurns, last actions still applied
  calls = 0;
  const forever = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'a sign', maxTurns: 3, call: async (r) => { calls++; return mk(calls === 1 ? good : { summary: `again ${calls}`, actions: [{ kind: 'set_name', name: `n${calls}` }], declined: [] })(r); }, weave: async (r) => run(r) });
  if (calls === 3 && forever.recipe.name === 'n3' && forever.summary === 'again 3') pass('cap at maxTurns; final actions applied'); else fail(`cap calls ${calls}, name ${forever.recipe.name}`);
  // first-turn failures throw the same messages the app always showed
  let err = null;
  try { await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'x', call: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'apply_recipe_actions', input: { actions: [{ kind: 'set_name', name: 'partial' }] } }] }) }); }
  catch (e) { err = e; }
  if (err instanceof IntentError && /overran its budget/.test(err.message)) pass('truncated first turn refused whole'); else fail(`truncation: ${err?.message}`);
  err = null;
  try { await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'x', call: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'apply_recipe_actions', input: {} }] }) }); }
  catch (e) { err = e; }
  if (err instanceof IntentError && /empty-handed/.test(err.message)) pass('empty first turn surfaced as retryable'); else fail(`empty: ${err?.message}`);
  // a truncated REVISE turn keeps the applied state and the first summary
  calls = 0;
  const trunc = await runIntentLoop({ recipe: structuredClone(EMPTY_RECIPE), utterance: 'a sign', call: async (r) => { calls++; return calls === 1 ? mk(good)(r) : { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't2', name: 'apply_recipe_actions', input: { actions: [{ kind: 'remove_operation', id: 'e' }] } }] }; }, weave: async (r) => run(r) });
  if (trunc.recipe.pipeline.length === 1 && trunc.summary === good.summary && !trunc.revised) pass('truncated revise turn: state kept, nothing half-applied'); else fail(`trunc revise: ${trunc.recipe.pipeline.length} ops, revised ${trunc.revised}`);
}

// ---------------- 9. pocket_text: paint-fill pockets + rest corners ----------------
// One catalog verb lowering to TWO machine operations (bulk bit + smaller
// rest bit = a toolchange), the rest op declaring allowOverlap (it recuts
// the cleared envelope at blob edges by design).

console.log('--- pocket_text: bulk + rest corners, one verb, two tools ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, {
    summary: 'Created a paint-fill sign app.',
    actions: [
      { kind: 'set_name', name: 'Paint-fill sign' },
      { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Word', default: 'Anna' } },
      { kind: 'add_operation', operation: { id: 'pocket', strategy: 'pocket_text', params: { text: { ctrl: 'word' }, letterHeight: 1.5 } } },
    ],
    declined: [],
  });
  rec = res.recipe;
  const r1 = run(rec);
  const t1 = r1.report?.stats.targets ?? [];
  if (r1.ok && t1.length === 1 && t1[0].gouges === 0) pass(`bulk pocket verified: ${t1[0].samples} samples, 0 gouges`);
  else fail(`bulk pocket failed: ${r1.errors?.join(' | ')}`);

  const res2 = applyActions(rec, {
    summary: 'Added a rest pass for the corners.',
    actions: [{ kind: 'set_operation', operation: { id: 'pocket', params: { restDiameter: 0.0625 } } }],
    declined: [],
  });
  rec = res2.recipe;
  const r2 = run(rec);
  const t2 = r2.report?.stats.targets ?? [];
  const mounts = (r2.sbp?.match(/C9/g) ?? []).length;
  if (r2.ok && t2.length === 2 && mounts === 2 && t2.every(t => t.gouges === 0)) {
    pass(`rest pass woven: 2 targets, 2 tool mounts, 0 gouges (rest declares allowOverlap)`);
  } else fail(`rest failed: ok=${r2.ok} targets=${t2.length} mounts=${mounts} ${r2.errors?.join(' | ')}`);

  // too narrow for the bit → advice, not motion
  const r3 = run({ ...rec, pipeline: [{ id: 'pocket', strategy: 'pocket_text', params: { text: { ctrl: 'word' }, letterHeight: 0.35 } }] });
  if (!r3.ok && r3.errors[0]?.includes('does not fit')) pass(`too-narrow text: "${r3.errors[0].slice(0, 70)}..."`);
  else fail(`too-narrow not caught: ${JSON.stringify(r3.errors)}`);
}

// ---------------- 10. the coaster gap report, filled ----------------
// From live testing 2026-07-05: "round coasters, 2.5 inch diameter with a
// 2 inch pocket at the center 0.125 deep" — declined when only text-based
// pocketing existed. pocket_shape + disc_cutout are the fill.

console.log('--- coaster story: geometric pocket + round disc cutout ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, {
    summary: 'Created a round-coaster app.',
    actions: [
      { kind: 'set_name', name: 'Drink coasters' },
      { kind: 'set_thickness', thickness: 0.375 },
      { kind: 'add_control', control: { id: 'discDia', type: 'number', label: 'Coaster diameter (in)', default: 2.5, min: 2, max: 4, step: 0.25 } },
      { kind: 'add_control', control: { id: 'wellDia', type: 'number', label: 'Well diameter (in)', default: 2, min: 1, max: 3.5, step: 0.25 } },
      { kind: 'add_operation', operation: { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: { ctrl: 'wellDia' }, depth: 0.125 } } },
      { kind: 'add_operation', operation: { id: 'disc', strategy: 'disc_cutout', params: { diameter: { ctrl: 'discDia' }, tabs: true } } },
    ],
    declined: [],
  });
  rec = res.recipe;
  const r = run(rec);
  const targets = r.report?.stats.targets ?? [];
  const disc = r.preview?.built?.find(x => x.op.id === 'disc');
  const st = r.preview?.stock;
  if (r.ok && targets.length === 2 && targets.every(t => (t.gouges ?? t.intrusionArea) === 0 && t.depthViolations === 0)
      && (disc?.r.previewTabs?.length ?? 0) >= 4 && st?.w === 3.5 && st?.h === 3.5 && st?.thickness === 0.375) {
    pass(`coaster verified on AUTO-SIZED stock ${st.w}" × ${st.h}" × ${st.thickness}" — no stock ever specified`);
  } else fail(`coaster failed: ok=${r.ok} targets=${targets.length} stock=${JSON.stringify(st)} ${r.errors?.join(' | ')}`);

  // true-geometry reach: a 2.2" disc over the 2" round well is legal (0.1"
  // rim) even though the well's BBOX corner is 1.41" out — boxes would ban it
  const snug = run(rec, { discDia: 2.2, wellDia: 2 });
  if (snug.ok) pass('2.2" disc over 2" round well: reach measured from real outlines, not bbox corners');
  else fail(`snug disc wrongly rejected: ${snug.errors?.join(' | ')}`);

  // and a disc genuinely smaller than the content fails with the number
  const tight = run(rec, { discDia: 1.9, wellDia: 2 });
  if (!tight.ok && tight.errors[0]?.includes('needs ≥ 2.00')) pass(`too-small disc: "${tight.errors[0].slice(0, 60)}..."`);
  else fail(`too-small disc not caught: ${JSON.stringify(tight.errors)}`);

  // "a monogram at the center of the pocket" (live-tested): text used to
  // land with its bbox CORNER on the content center — a human means the
  // letter's visual middle. All content ops now center on the content.
  {
    const mono = run({
      ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.375 },
      pipeline: [
        { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.125 } },
        { id: 'monogram', strategy: 'vcarve_text', params: { text: 'B', letterHeight: 1 } },
        { id: 'disc', strategy: 'disc_cutout', params: { diameter: 2.5, tabs: true } },
      ],
    });
    const m = mono.preview?.built?.find(x => x.op.id === 'monogram');
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const g of m?.r.previewRegions ?? []) for (const q of g.outer) {
      mnx = Math.min(mnx, q.x); mxx = Math.max(mxx, q.x); mny = Math.min(mny, q.y); mxy = Math.max(mxy, q.y);
    }
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    if (mono.ok && Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6 && mono.report.stats.targets.length === 3) {
      pass('monogram centers its visual middle on the pocket center (three-op coaster verified)');
    } else fail(`monogram off-center: (${cx.toFixed(3)}, ${cy.toFixed(3)}) ok=${mono.ok}`);
  }

  // strategy conversion: the live-tested stumble — a recipe holding an old
  // tag_cutout op named "cutout" gets converted to a disc by set_operation
  // with a new strategy (params replaced, not merged)
  {
    let old = structuredClone(EMPTY_RECIPE);
    old = applyActions(old, {
      summary: 'old state', declined: [],
      actions: [
        { kind: 'add_operation', operation: { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.125 } } },
        { kind: 'add_operation', operation: { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.25 } } },
      ],
    }).recipe;
    const conv = applyActions(old, {
      summary: 'Converted the tag to a 2.5" disc.',
      declined: [],
      actions: [{ kind: 'set_operation', operation: { id: 'cutout', strategy: 'disc_cutout', params: { diameter: 2.5, tabs: true } } }],
    });
    const op = conv.recipe.pipeline.find(o => o.id === 'cutout');
    const rr = run(conv.recipe);
    if (conv.applied[0]?.includes('converted to disc_cutout') && op.strategy === 'disc_cutout'
        && !('buffer' in op.params) && rr.ok) {
      pass('set_operation converts tag_cutout → disc_cutout (stale params dropped), verified');
    } else fail(`conversion failed: ${JSON.stringify(conv.applied)} ${JSON.stringify(op?.params)} ok=${rr.ok}`);

    const badConv = applyActions(old, {
      summary: 'x', declined: [],
      actions: [{ kind: 'set_operation', operation: { id: 'cutout', strategy: 'laser_cut', params: {} } }],
    });
    if (badConv.skipped[0]?.includes('unknown strategy')) pass('conversion to unknown strategy skipped with reason');
    else fail(`bad conversion leaked: ${JSON.stringify(badConv.applied)}`);
  }

  // rectangle pocket with sharp corners exercises rest cleanup on shapes
  const tray = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'tray', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 3, height: 2, cornerRadius: 0, depth: 0.25, restDiameter: 0.0625 } }],
  });
  const trayTargets = tray.report?.stats.targets ?? [];
  if (tray.ok && trayTargets.length === 2) pass('rectangle tray with sharp corners: bulk + rest corners, verified');
  else fail(`tray failed: ok=${tray.ok} targets=${trayTargets.length} ${tray.errors?.join(' | ')}`);
}

// ---------------- 11. material-removal simulation (feeds the 3D preview) ----------------
// The simulator is DOM-free, so the surface the user will SEE is asserted
// here with physical numbers: the coaster's well floor, the through kerf,
// the untouched rim, the tab bridges standing in the kerf.

console.log('--- simulation: the 3D preview surface, measured ---');
{
  const r = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.375 },
    pipeline: [
      { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.125 } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 2.5, tabs: true } },
    ],
  });
  const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
  const cx = r.preview.stock.w / 2, cy = r.preview.stock.h / 2;
  const well = surfaceAt(sim, cx, cy);
  const rim = surfaceAt(sim, cx + 1.1, cy);
  const waste = surfaceAt(sim, 0.05, 0.05);
  if (Math.abs(well + 0.125) < 0.002 && rim === 0 && waste === 0) {
    pass(`surface measured: well ${well.toFixed(3)}, rim ${rim}, waste ${waste}`);
  } else fail(`surface wrong: well=${well} rim=${rim} waste=${waste}`);

  // the kerf: mostly through, but tab bridges must stand in it
  let through = 0, kerfMax = -Infinity, samples = 0;
  for (let a = 0; a < 360; a += 2) {
    const z = surfaceAt(sim, cx + 1.31 * Math.cos(a * Math.PI / 180), cy + 1.31 * Math.sin(a * Math.PI / 180));
    samples++;
    if (z < -0.374) through++;
    if (z > kerfMax) kerfMax = z;
  }
  const bridges = samples - through;
  if (through > samples * 0.6 && bridges >= 4 && kerfMax > -0.37) {
    pass(`kerf mostly through (${through}/${samples}) with ${bridges} bridge samples standing (highest ${kerfMax.toFixed(3)})`);
  } else fail(`kerf wrong: through=${through}/${samples} bridges=${bridges} kerfMax=${kerfMax}`);

  // vee cone model: an outline pass cuts exactly its depth at the centerline
  const o = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'outline', strategy: 'outline_text', params: { text: 'O', letterHeight: 1.5, depth: 0.04 } }],
  });
  const osim = simulateJob(o.preview.built, o.preview.placement, o.preview.stock);
  const ring = o.preview.built[0].r.previewRegions[0].outer;
  const q = ring[0], p2 = o.preview.placement;
  const z = surfaceAt(osim, q.x + p2.x, q.y + p2.y);
  if (Math.abs(z + 0.04) < 0.006) pass(`vee centerline depth measured: ${z.toFixed(4)} (declared -0.04)`);
  else fail(`vee sim off: ${z}`);
}

// ---------------- 12. bore_hole: the "add a hole" decline, converted ----------------
// From the funnel log (2026-06-11, step app): "Add another hole in a random
// spot" — declined. bore_hole is the fill: positioned holes, through by
// default, honest about bits that can't cut the designed size.

console.log('--- bore_hole: hang hole + corner holes + honest refusals ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1 } },
      { id: 'hole', strategy: 'bore_hole', params: { diameter: 0.25, position: 'above' } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.25 } },
    ],
  };
  const r = run(rec);
  const holeT = r.report?.stats.targets?.find(t => t.name.startsWith('hole'));
  if (r.ok && holeT?.gouges === 0 && holeT.depthViolations === 0) pass(`hang-hole tag verified (${holeT.samples} samples, 0 gouges)`);
  else fail(`hang hole failed: ok=${r.ok} ${r.errors?.join(' | ')}`);

  // the hole is THROUGH and the tag wrapped it: simulate and probe
  const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
  const hole = r.preview.built.find(x => x.op.id === 'hole').r.previewHoles[0];
  const z = surfaceAt(sim, hole.x + r.preview.placement.x, hole.y + r.preview.placement.y);
  if (z <= -0.5 + 1e-6) pass(`hole is through the 0.5" stock at its center (sim z=${z.toFixed(3)})`);
  else fail(`hole not through: sim z=${z}`);

  // 4 mounting holes around the content
  const rc = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Shop', letterHeight: 1 } },
      { id: 'holes', strategy: 'bore_hole', params: { diameter: 0.1875, position: 'corners' } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.25 } },
    ],
  });
  const nHoles = rc.preview?.built?.find(x => x.op.id === 'holes')?.r.previewHoles?.length;
  if (rc.ok && nHoles === 4) pass('corners: 4 mounting holes, tag wraps them, verified');
  else fail(`corners failed: ok=${rc.ok} holes=${nHoles} ${rc.errors?.join(' | ')}`);

  // a hole smaller than the bit is a designed fit we must not oversize
  const small = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'h', strategy: 'bore_hole', params: { diameter: 0.08, position: 'center', toolDiameter: 0.125 } }],
  });
  if (!small.ok && small.errors[0]?.includes('not machinable without oversizing')) pass(`too-small hole refused: "${small.errors[0].slice(0, 60)}..."`);
  else fail(`too-small hole leaked: ${JSON.stringify(small.errors)}`);

  // a hole much bigger than the bit would leave a standing core
  const big = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'h', strategy: 'bore_hole', params: { diameter: 0.75, position: 'center', toolDiameter: 0.125 } }],
  });
  if (!big.ok && big.errors[0]?.includes('standing')) pass(`too-big hole refused with advice: "${big.errors[0].slice(0, 60)}..."`);
  else fail(`too-big hole leaked: ${JSON.stringify(big.errors)}`);
}

// ---------------- 13. chamfer: "chamfer the edges", converted ----------------
// From the funnel log (2026-06-11): "chamfer all edges" / "round all edges"
// — declined. The cutouts now take a chamfer param: a 90° V-bit eases the
// top rim before the part is freed, with the INTENDED surface (flat stock
// imprinted with the cone) as an independently checked heightmap target.

console.log('--- chamfer: eased rim on cutouts, measured in the simulation ---');
{
  const r = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.375 },
    pipeline: [
      { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.125 } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 3, tabs: true, chamfer: 0.06 } },
    ],
  });
  const ch = r.report?.stats.targets?.find(t => t.name.includes('chamfer'));
  const mounts = (r.sbp?.match(/C9/g) ?? []).length;
  if (r.ok && ch?.type === 'heightmap' && ch.gouges === 0 && ch.maskViolations === 0 && mounts === 3) {
    pass(`chamfered coaster verified: heightmap target ${ch.samples} samples, 0 gouges, V-bit is mount 3 of 3`);
  } else fail(`chamfer failed: ok=${r.ok} ch=${JSON.stringify(ch)} mounts=${mounts} ${r.errors?.join(' | ')}`);

  // the 45° face, measured mid-band in the simulated surface
  const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
  const cx = r.preview.stock.w / 2, cy = r.preview.stock.h / 2;
  const mid = surfaceAt(sim, cx + 1.5 - 0.03, cy); // halfway down a 0.06 face
  const inside = surfaceAt(sim, cx + 1.3, cy);     // inboard of the band
  if (Math.abs(mid + 0.03) < 0.012 && inside === 0) {
    pass(`45° face measured: mid-band ${mid.toFixed(3)} (expect ≈ -0.030), inboard untouched`);
  } else fail(`face wrong: mid=${mid} inside=${inside}`);

  // tag rim chamfers too
  const tag = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Anna', letterHeight: 1 } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.3, chamfer: 0.05 } },
    ],
  });
  if (tag.ok && tag.report.stats.targets.some(t => t.type === 'heightmap' && t.gouges === 0)) pass('chamfered tag rim verified');
  else fail(`chamfered tag failed: ${tag.errors?.join(' | ')}`);
}

// ---------------- 14. dish_shape: the ballnose bowl, measured against the sphere ----------------

console.log('--- dish_shape: spherical dish, sim vs analytic sphere ---');
{
  const r = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'dish', strategy: 'dish_shape', params: { diameter: 2.5, depth: 0.25 } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 3.25, tabs: true } },
    ],
  });
  const t = r.report?.stats.targets?.find(x => x.name.startsWith('dish'));
  if (r.ok && t?.type === 'heightmap' && t.gouges === 0 && t.maskViolations === 0) {
    pass(`dished coaster verified: ${t.samples} samples against the declared surface, 0 gouges`);
  } else fail(`dish failed: ok=${r.ok} ${r.errors?.join(' | ')}`);

  // the simulated bowl matches the sphere the strategy promised
  const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
  const cx = r.preview.stock.w / 2, cy = r.preview.stock.h / 2;
  const Rs = (1.25 * 1.25 + 0.25 * 0.25) / (2 * 0.25);
  const zAt = (rho) => (Rs - 0.25) - Math.sqrt(Rs * Rs - rho * rho);
  const zc = surfaceAt(sim, cx, cy), zm = surfaceAt(sim, cx + 0.6, cy);
  if (Math.abs(zc - zAt(0)) < 0.005 && Math.abs(zm - zAt(0.6)) < 0.005) {
    pass(`sphere measured: center ${zc.toFixed(4)} (theory ${zAt(0).toFixed(4)}), ρ=0.6 ${zm.toFixed(4)} (theory ${zAt(0.6).toFixed(4)})`);
  } else fail(`sphere off: center=${zc} vs ${zAt(0)}, mid=${zm} vs ${zAt(0.6)}`);

  // deeper than a hemisphere is not a dish
  const deep = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'd', strategy: 'dish_shape', params: { diameter: 1, depth: 0.6 } }],
  });
  if (!deep.ok && deep.errors[0]?.includes('hemisphere')) pass(`hemisphere guard: "${deep.errors[0].slice(0, 60)}..."`);
  else fail(`hemisphere guard missing: ${JSON.stringify(deep.errors)}`);
}

// ---------------- 15. auto tool selection: toolDiameter 0 shops the drawer ----------------

console.log('--- auto tool: coverage knee picks the chain, pick is reported ---');
{
  const r = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'pocket', strategy: 'pocket_text', params: { text: 'Anna', letterHeight: 1.5, toolDiameter: 0 } }],
  });
  // the pick reports through the decision record now, not the warnings
  const note = r.rationale?.ops.flatMap(o => o.why ?? []).find(w => w.includes('auto tool:'));
  const nOps = r.report?.stats.targets?.length ?? 0;
  if (r.ok && nOps >= 2 && note?.includes('1/4"') && !r.warnings.some(w => w.includes('auto tool:'))) {
    pass(`text chain picked and reported: "${note.slice(note.indexOf('auto'), note.indexOf('auto') + 60)}..." (${nOps} ops)`);
  } else fail(`auto text failed: ok=${r.ok} ops=${nOps} note=${note} ${r.errors?.join(' | ')}`);

  // a plain circle needs exactly one bit — no gratuitous toolchanges
  const circle = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.125, toolDiameter: 0 } }],
  });
  if (circle.ok && circle.report.stats.targets.length === 1) pass('round pocket: knee stops at the 1/4" (no rest pass invented)');
  else fail(`auto circle failed: targets=${circle.report?.stats.targets?.length}`);

  // sharp rectangle corners earn a rest bit
  const tray = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'tray', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 3, height: 2, cornerRadius: 0, depth: 0.25, toolDiameter: 0 } }],
  });
  if (tray.ok && tray.report.stats.targets.length === 2) pass('sharp-cornered tray: corner blobs earn a rest pass');
  else fail(`auto tray failed: targets=${tray.report?.stats.targets?.length} ${tray.errors?.join(' | ')}`);

  // when nothing earns a cut, say so with the drawer in hand
  const none = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'w', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 0.04, depth: 0.5, toolDiameter: 0 } }],
  });
  if (!none.ok && none.errors[0]?.includes('drawer')) pass(`nothing earns: "${none.errors[0].slice(0, 70)}..."`);
  else fail(`no-bit case leaked: ${JSON.stringify(none.errors)}`);
}

// ---------------- 15b. the decision record: choices explain themselves ----------------
// Every exported job carries result.rationale — the deterministic evidence
// behind each choice (auto-tool coverage curve, rest-pass economics,
// chipload feed derivations with their binding constraint, rack matches).
// The why-these-choices panel renders it verbatim, so the record itself is
// gauntleted: the numbers must MATCH the job, not merely exist.

console.log('--- decision record: rationale matches the posted job ---');
{
  const rack = {
    machine: { minRPM: 6000, maxRPM: 24000, maxFeed: 360 },
    tools: [
      { number: 2, kind: 'flat', diameter: 0.25, flutes: 2 },
      { number: 5, kind: 'flat', diameter: 0.0625, flutes: 1 },
    ],
  };
  const shop = { material: 'plywood', toolLibrary: rack };
  const r = quiet(() => runRecipe({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'tray', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 3, height: 2, cornerRadius: 0, depth: 0.25, toolDiameter: 0.25, restDiameter: 0.0625 } }],
  }, {}, FONT_SHELF, {}, shop));
  const ra = r.rationale;
  if (!r.ok || !ra) fail(`no rationale on a verified job: ok=${r.ok} ${r.errors?.join(' | ')}`);
  else {
    // rack bits post under their real numbers, with chipload feeds attached
    const bulk = ra.tools.find(t => t.diameter === 0.25);
    const rest = ra.tools.find(t => t.diameter === 0.0625);
    if (bulk?.number === 2 && bulk.rackMatch && rest?.number === 5 && rest.rackMatch) {
      pass('both bits matched the rack under their real &Tool numbers');
    } else fail(`rack match wrong: ${JSON.stringify(ra.tools)}`);
    // the recorded derivation IS recommendFeeds — same numbers, named
    // binding. This bit is the shed-rpm case: 18k × 2 × 0.011 = 396 in/min
    // outruns the 360 cap, so rpm comes down to keep the chipload
    const want = recommendFeeds(rack.tools[0], 'plywood', rack.machine);
    if (bulk?.feeds && bulk.feeds.feedRate === want.feedRate && bulk.feeds.rpm === want.rpm
        && bulk.feeds.binding === want.binding && want.binding === 'feed-cap' && want.rpm < 18000
        && Math.abs(want.rpm * want.flutes * want.chipload - want.feedRate) < 2) {
      pass(`chipload derivation recorded: ${want.rpm} rpm × ${want.flutes} fl × ${want.chipload}"/t ≈ ${want.feedRate} in/min (${want.binding})`);
    } else fail(`feeds derivation mismatch: got=${JSON.stringify(bulk?.feeds)} want=${JSON.stringify(want)}`);
    // the job posts the SAME feeds the record explains
    const opFeeds = r.job.operations.map(o => o.feedRate);
    const raFeeds = ra.ops.map(o => o.feedRate);
    if (opFeeds.join() === raFeeds.join() && ra.ops.every(o => o.feedSource === 'chipload')) {
      pass(`recorded feeds are the posted feeds: [${opFeeds.join(', ')}] in/min`);
    } else fail(`rationale feeds diverge from job: job=[${opFeeds}] rationale=[${raFeeds}]`);
    // rest-pass economics narrated on the rest op
    if (ra.ops.some(o => o.why.some(w => w.startsWith('rest pass:')))) pass('rest pass explains its toolchange');
    else fail(`no rest-pass why: ${JSON.stringify(ra.ops.map(o => o.why))}`);
  }

  // auto tool: the coverage curve rides along, knee marked
  const auto = quiet(() => runRecipe({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'tray', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 3, height: 2, cornerRadius: 0, depth: 0.25, toolDiameter: 0 } }],
  }, {}, FONT_SHELF, {}, {}));
  const curve = auto.rationale?.ops.find(o => o.toolCurve)?.toolCurve;
  if (auto.ok && curve?.length >= 4 && curve.some(e => e.picked) && curve.every(e => e.excluded || (e.pct >= 0 && e.pct <= 100))) {
    pass(`coverage curve recorded: ${curve.map(e => `${e.label} ${e.excluded ? '—' : e.pct + '%'}${e.picked ? '✓' : ''}`).join(' · ')}`);
  } else fail(`curve missing/malformed: ${JSON.stringify(curve)}`);
  // no material, no rack: feeds honestly attributed to the strategy
  if (auto.rationale?.ops.every(o => o.feedSource === 'strategy') && auto.rationale.tools.every(t => !t.synthetic && !t.rackMatch)) {
    pass('no shop declared: feeds attributed to strategy defaults, no rack claims');
  } else fail(`bare-shop attribution wrong: ${JSON.stringify(auto.rationale?.tools)}`);
}

// ---------------- 16. the font shelf: every face carves verified ----------------
// The union pass is what makes this safe: connected scripts (Pacifico)
// overlap between letters — without the union the medial axis would
// double-carve every join. Overlap collapse is measured, not assumed.

console.log('--- fonts: whole shelf V-carves verified; script overlaps union ---');
{
  for (const f of FONTS) {
    const r = run({
      ...structuredClone(EMPTY_RECIPE),
      pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: 'Beryl', letterHeight: 1, font: f.id } }],
    });
    const t = r.report?.stats.targets?.[0];
    if (r.ok && t?.gouges === 0) pass(`${f.id}: "Beryl" verified (${t.samples} samples, 0 gouges)`);
    else fail(`${f.id} failed: ok=${r.ok} ${r.errors?.join(' | ')}`);
  }

  // connected script: the weld must FUSE letters without deleting strokes
  // or counters (regression: containment-depth hole classification read
  // Pacifico's overlapping contours as giant "holes" — words came out
  // with missing letters, negative net area, and filled counters). The
  // nonzero weld of authored contours is measured here: one fused region,
  // the loop counters SURVIVE as holes, and the ink area is sane.
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
    }
    return a / 2;
  };
  const inkArea = (regs) => regs.reduce((s, r) =>
    s + Math.abs(ringArea(r.outer)) - r.holes.reduce((h, x) => h + Math.abs(ringArea(x)), 0), 0);
  const script = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: 'hello', letterHeight: 1, font: 'script' } }],
  });
  const regs = script.preview?.built?.[0]?.r.previewRegions ?? [];
  const nHoles = regs.reduce((s, r) => s + r.holes.length, 0);
  const ink = inkArea(regs);
  if (script.ok && regs.length === 1 && nHoles >= 4 && ink > 0.8 && ink < 1.2) {
    pass(`Pacifico "hello": welded to 1 region, ${nHoles} counters survive, ink area ${ink.toFixed(3)} sq in`);
  } else fail(`script weld failed: ok=${script.ok} regions=${regs.length} holes=${nHoles} ink=${ink.toFixed(3)} ${script.errors?.join(' | ')}`);

  // counters in upright faces too: serif "Bob" = B(2) + o(1) + b(1)
  const bob = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'e', strategy: 'outline_text', params: { text: 'Bob', letterHeight: 1, font: 'serif' } }],
  });
  const bobHoles = (bob.preview?.built?.[0]?.r.previewRegions ?? []).reduce((s, r) => s + r.holes.length, 0);
  if (bob.ok && bobHoles === 4) pass('serif "Bob": all 4 counters present after the weld');
  else fail(`Bob counters: ok=${bob.ok} holes=${bobHoles}`);

  // regression (caught live in the browser 2026-07-05): the Voronoi
  // medial axis plus branch smoothing strays a few thou outside at the
  // pinch waists a script weld creates — clampMedialAxis enforces the
  // inside/radius invariant per point and per chord, and the full tag
  // recipe verifies
  const amelia = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Amelia', font: 'script' } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.25, tabs: true, chamfer: 0.05 } },
    ],
  });
  if (amelia.ok) pass('script "Amelia" + chamfered tab tag: invariant-clamped medial axis verifies');
  else fail(`Amelia regression: ${amelia.errors?.join(' | ')}`);

  // unknown font: friendly error naming the shelf
  const bad = run({
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: 'Hi', font: 'comic-sans' } }],
  });
  if (!bad.ok && bad.errors[0]?.includes('available:')) pass(`unknown font refused: "${bad.errors[0].slice(0, 60)}..."`);
  else fail(`unknown font leaked: ${JSON.stringify(bad.errors)}`);
}

// ---------------- 17. choice controls: dropdowns for fixed sets ----------------

console.log('--- choice control: font picker as a dropdown ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, {
    summary: 'Name tags with a font picker.',
    actions: [
      { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'Ida' } },
      { kind: 'add_control', control: { id: 'face', type: 'choice', label: 'Font', default: 'script', options: FONTS.map(f => ({ value: f.id, label: f.label })) } },
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, font: { ctrl: 'face' } } } },
    ],
    declined: [],
  });
  rec = res.recipe;
  const r = run(rec);
  if (res.applied.length === 3 && r.ok) pass('font bound to a choice control, default "script", verified');
  else fail(`choice control failed: applied=${res.applied.length} ok=${r.ok} ${r.errors?.join(' | ')}`);

  // switching the dropdown re-runs with the other face
  const swapped = run(rec, { ...controlDefaults(rec), face: 'condensed' });
  if (swapped.ok) pass('dropdown switch to "condensed" re-verifies');
  else fail(`font switch failed: ${swapped.errors?.join(' | ')}`);

  // a choice control without options is rejected; a bad default snaps to
  // the first option
  const bad = applyActions(rec, {
    summary: 'x', declined: [],
    actions: [{ kind: 'add_control', control: { id: 'c2', type: 'choice', label: 'X' } }],
  });
  if (bad.skipped[0]?.includes('needs options')) pass('optionless choice control skipped with reason');
  else fail(`optionless choice leaked: ${JSON.stringify(bad.applied)}`);
  const snap = applyActions(rec, {
    summary: 'x', declined: [],
    actions: [{ kind: 'add_control', control: { id: 'c3', type: 'choice', options: [{ value: 'a' }, { value: 'b' }], default: 'zzz' } }],
  });
  const c3 = snap.recipe.controls.find(c => c.id === 'c3');
  if (c3?.default === 'a') pass('out-of-set default snaps to the first option');
  else fail(`bad default kept: ${JSON.stringify(c3)}`);
}

// ---------------- 18. uploaded assets: stored, surfaced, bytes elided ----------------
// Upload happens in the browser; here we assert the document and prompt
// sides: assets ride the recipe, the LLM sees their names but never their
// bytes, SVGs are announced usable while rasters keep decline guidance,
// and a recipe that doesn't reference its assets runs as if they weren't
// there. (Consuming an SVG asset is section 27.)

console.log('--- assets: in the document, out of the prompt ---');
{
  const rec = structuredClone(EMPTY_RECIPE);
  rec.assets.push(
    { id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: '<svg>' + 'x'.repeat(5000) + '</svg>' },
    { id: 'dog.png', name: 'dog.png', kind: 'image', data: 'data:image/png;base64,' + 'A'.repeat(20000), width: 640, height: 480 },
  );
  rec.pipeline.push({ id: 'e', strategy: 'vcarve_text', params: { text: 'Rex' } });

  const req = buildParseRequest(rec, 'engrave the dog photo');
  const sys = req.system;
  if (sys.includes('"dog.png" (image, 640×480px)') && sys.includes('"logo.svg" (svg)') && sys.includes('DECLINE')) {
    pass('prompt lists both assets; raster decline guidance retained');
  } else fail('asset section missing from prompt');
  if (sys.includes('IS usable') && sys.includes('asset {of:') && !sys.includes('no strategy in the catalog can carve images or graphics yet')) {
    pass('prompt teaches the SVG-asset shape instead of declining SVGs');
  } else fail('prompt still declines SVG assets');
  if (!sys.includes('AAAAA') && !sys.includes('xxxxx') && sys.includes('chars omitted')) {
    pass(`asset bytes elided from the prompt (${sys.length.toLocaleString()} chars total)`);
  } else fail(`asset bytes leaked into the prompt (${sys.length} chars)`);

  // the runtime runs the recipe as if the assets were not there
  const r = run(rec);
  if (r.ok) pass('runtime ignores assets: recipe still verifies');
  else fail(`assets broke the runtime: ${r.errors?.join(' | ')}`);

  // and they survive the apply cycle untouched
  const out = applyActions(rec, { summary: 'rename', actions: [{ kind: 'set_name', name: 'Rex tag' }], declined: [] });
  if (out.recipe.assets.length === 2 && out.recipe.assets[1].data.length === rec.assets[1].data.length) {
    pass('assets ride through applyActions intact');
  } else fail('applyActions disturbed assets');
}

// ---------------- 19. custom shapes: any outline as an SVG path ----------------
// The "elliptical plaque" decline, converted — and every other outline
// with it: the model AUTHORS the shape as an svg path (the one 2D
// language it speaks natively); pathToRegions lowers it
// deterministically to the same welded regions everything else uses.

console.log('--- custom shapes from svg paths ---');
{
  // parsing: relative commands, implicit lineto, uniform scale from width
  const rect = pathToRegions('m 0 0 l 10 0 0 5 l -10 0 z', { width: 4 });
  if (!rect.error && rect.regions.length === 1 && Math.abs(rect.w - 4) < 1e-9 && Math.abs(rect.h - 2) < 1e-9) {
    pass(`relative/implicit path parses: 10×5 box → ${rect.w}" × ${rect.h}" at width 4 (aspect kept)`);
  } else fail(`rect path wrong: ${JSON.stringify({ error: rect.error, w: rect.w, h: rect.h })}`);

  // an ellipse from two arcs, stretched to 5×3 — area must match πab
  const ell = pathToRegions('M 0 30 A 50 30 0 1 1 100 30 A 50 30 0 1 1 0 30 Z', { width: 5, height: 3 });
  const area = (ring) => Math.abs(ring.reduce((a, q, i) => {
    const j = (i + 1) % ring.length;
    return a + q.x * ring[j].y - ring[j].x * q.y;
  }, 0) / 2);
  const wantA = Math.PI * 2.5 * 1.5;
  if (!ell.error && ell.regions.length === 1 && Math.abs(area(ell.regions[0].outer) - wantA) / wantA < 0.02) {
    pass(`ellipse via A arcs: area ${area(ell.regions[0].outer).toFixed(3)} vs πab ${wantA.toFixed(3)} (<2% off)`);
  } else fail(`ellipse wrong: ${ell.error ?? `${ell.regions.length} regions, area ${area(ell.regions[0]?.outer ?? [])}`}`);

  // a self-crossing pentagram welds SOLID under nonzero (no phantom hole)
  const star5 = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;   // connect every 2nd point
    star5.push(`${(50 + 45 * Math.cos(a)).toFixed(3)} ${(50 + 45 * Math.sin(a)).toFixed(3)}`);
  }
  const gram = pathToRegions(`M ${star5.join(' L ')} Z`, { width: 3 });
  // nonzero keeps the core filled: the welded region must match the
  // SOLID star (10-gon alternating tip/crossing radius), not the
  // even-odd star-with-a-pentagonal-hole
  const rIn = 45 * Math.cos(2 * Math.PI / 5) / Math.cos(Math.PI / 5);
  const solid10 = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 === 0 ? 45 : rIn;
    solid10.push({ x: 50 + rr * Math.cos(a), y: 50 + rr * Math.sin(a) });
  }
  const xs = solid10.map(q => q.x);
  const sxg = 3 / (Math.max(...xs) - Math.min(...xs));
  const wantStar = area(solid10) * sxg * sxg;
  const gotStar = gram.error ? 0 : area(gram.regions[0].outer);
  if (!gram.error && gram.regions.length === 1 && gram.regions[0].holes.length === 0
      && Math.abs(gotStar - wantStar) / wantStar < 0.01) {
    pass(`self-crossing pentagram welds SOLID: area ${gotStar.toFixed(3)} vs filled star ${wantStar.toFixed(3)} (nonzero, no phantom hole)`);
  } else fail(`pentagram weld wrong: ${JSON.stringify({ error: gram.error, n: gram.regions?.length, holes: gram.regions?.[0]?.holes.length, got: gotStar, want: wantStar })}`);

  // garbage in → a readable error out, not a throw
  const bad = pathToRegions('M 1 2 L', { width: 3 });
  if (bad.error && bad.error.includes('path')) pass(`bad path fails clean: "${bad.error}"`);
  else fail(`bad path: ${JSON.stringify(bad)}`);
}

console.log('--- 7-pointed star pocket (shape "custom") ---');
{
  const pts = [];
  for (let k = 0; k < 14; k++) {
    const r = k % 2 === 0 ? 48 : 22;
    const a = -Math.PI / 2 + (k * Math.PI) / 7;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)}`);
  }
  const starPath = `M ${pts.join(' L ')} Z`;
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'star', strategy: 'pocket_shape', params: { shape: 'custom', path: starPath, width: 3, depth: 0.2, toolDiameter: 0.125 } }],
  };
  const r = run(rec);
  if (r.ok) pass('7-pointed star pocket verifies');
  else fail(`star pocket rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const cx = r.preview.stock.w / 2, cy = r.preview.stock.h / 2;
    const center = surfaceAt(sim, cx, cy);
    // the y-flip puts the path's -90° TIP at shop +y, so the VALLEY
    // bisector (k=7, +90° in path coords) lands at shop -y; a point
    // beyond the valley radius but inside the tip radius is UNCUT
    const scale = 3 / 96;   // path box spans 96 units → 3"
    const between = surfaceAt(sim, cx, cy - 35 * scale);
    if (Math.abs(center + 0.2) < 0.003 && between === 0) {
      pass(`star measured: center ${center.toFixed(3)} (declared -0.2), between points ${between} (uncut)`);
    } else fail(`star surface wrong: center=${center} between=${between}`);
  }
}

console.log('--- elliptical plaque (the decline, converted end-to-end) ---');
{
  const ellipse = 'M 0 50 A 50 30 0 1 1 100 50 A 50 30 0 1 1 0 50 Z';
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    controls: [{ id: 'name', type: 'text', label: 'Name', default: 'Amelia' }],
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 0.8 } },
      { id: 'cut', strategy: 'shape_cutout', params: { path: ellipse, width: 5, height: 3, tabs: true, chamfer: 0.06 } },
    ],
  };
  const r = run(rec);
  const cut = r.preview?.built?.find(x => x.op.id === 'cut' && x.r.previewRing);
  if (r.ok && cut && r.sbp) pass(`elliptical plaque VERIFIED → SBP (${r.report.stats.targets.length} targets checked)`);
  else fail(`elliptical plaque rejected: ${r.errors?.join(' | ')}`);
  if (r.ok && cut) {
    const nTabs = cut.r.previewTabs?.length ?? 0;
    if (nTabs >= 4) pass(`tabs ride the elliptical profile: ${nTabs} placed`);
    else fail(`tabs missing on ellipse: ${nTabs}`);
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const ring = cut.r.previewRing;
    const cx = ring.reduce((s, q) => s + q.x, 0) / ring.length + p2.x;
    const cy = ring.reduce((s, q) => s + q.y, 0) / ring.length + p2.y;
    // kerf centerline: ellipse right edge + tool/2 → cut through
    const kerf = surfaceAt(sim, cx + 2.5 + 0.125, cy);
    // inside the ellipse above the text: untouched top
    const inside = surfaceAt(sim, cx, cy + 1.2);
    if (kerf < -0.49 && inside === 0) {
      pass(`surface measured: kerf ${kerf.toFixed(3)} (through), inside face ${inside} (untouched)`);
    } else fail(`plaque surface wrong: kerf=${kerf} inside=${inside}`);
  }

  // content that doesn't fit the shape → clean refusal, not a bad cut
  const tiny = structuredClone(rec);
  tiny.pipeline[1].params.width = 1.2;
  tiny.pipeline[1].params.height = 0.7;
  const t = run(tiny);
  if (!t.ok && t.errors.some(e => e.includes('pokes outside'))) {
    pass(`undersized shape refused: "${t.errors.find(e => e.includes('pokes outside'))}"`);
  } else fail(`undersized shape not caught: ok=${t.ok} ${t.errors?.join(' | ')}`);

  // interior holes are ignored for a cutout, with a warning
  const donut = structuredClone(rec);
  donut.pipeline[1].params.path =
    'M 0 50 A 50 50 0 1 1 100 50 A 50 50 0 1 1 0 50 Z M 30 50 A 20 20 0 1 0 70 50 A 20 20 0 1 0 30 50 Z';
  donut.pipeline[1].params.width = 5;
  donut.pipeline[1].params.height = 5;
  const dn = run(donut);
  if (dn.ok && dn.warnings.some(w => w.includes('interior holes'))) {
    pass('donut path: hole ignored for the cutout, warned honestly');
  } else fail(`donut handling wrong: ok=${dn.ok} warnings=${JSON.stringify(dn.warnings)}`);
}

// ---------------- 20. parametric shapes: {expressions} bind geometry to sliders ----------------
// The "arch with adjustable thickness and radius" decline, converted:
// path coordinates may be {arithmetic} of control ids, so the shape's
// INTERNAL geometry — not just its overall scale — rides the sliders.

console.log('--- template expressions ---');
{
  const vars = { r: 2, t: 0.5 };
  const cases = [
    ['{r}', '2'],
    ['{-r}', '-2'],
    ['{r-t}', '1.5'],
    ['{t-r}', '-1.5'],
    ['{r+t*2}', '3'],           // precedence: * before +
    ['{(r+t)*2}', '5'],
    ['{r/2 - t}', '0.5'],
    ['M {-r} 0 A {r} {r} 0 0 1 {r} 0', 'M -2 0 A 2 2 0 0 1 2 0'],
  ];
  let bad = 0;
  for (const [tpl, want] of cases) {
    const got = expandTemplate(tpl, vars);
    if (got.value !== want) { bad++; fail(`template ${tpl} → ${JSON.stringify(got)}, want "${want}"`); }
  }
  if (!bad) pass(`${cases.length} template expressions evaluate (precedence, parens, unary minus)`);

  const unknown = expandTemplate('{radius}', vars);
  if (unknown.error?.includes('unknown name "radius"') && unknown.error.includes('r, t')) {
    pass(`unknown control named with the available list: "${unknown.error}"`);
  } else fail(`unknown-name error wrong: ${JSON.stringify(unknown)}`);
  const mangled = expandTemplate('{r+}', vars);
  if (mangled.error) pass(`malformed expression fails clean: "${mangled.error}"`);
  else fail(`malformed expression not caught: ${JSON.stringify(mangled)}`);
  const nonNum = expandTemplate('{name}', { name: 'Brian' });
  if (nonNum.error?.includes('not a number')) pass('text control in arithmetic refused');
  else fail(`text control not caught: ${JSON.stringify(nonNum)}`);
}

console.log('--- the arch app: adjustable radius and band thickness ---');
{
  const archPath = 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {r-t} 0 A {r-t} {r-t} 0 0 0 {t-r} 0 Z';
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Arch cutter',
    controls: [
      { id: 'r', type: 'number', label: 'Arch radius (in)', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Band thickness (in)', default: 0.6, min: 0.25, max: 2, step: 0.125 },
    ],
    pipeline: [{ id: 'cut', strategy: 'shape_cutout', params: { path: archPath, width: 0, height: 0, tabs: true } }],
  };
  const r = run(rec);
  if (r.ok && r.sbp) pass('arch VERIFIED → SBP at defaults (r=2, t=0.6)');
  else fail(`arch rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    // true size: no width/height scaling — the sliders own the geometry
    const cut = r.preview.built.find(x => x.r.previewRing);
    const ring = cut.r.previewRing;
    const w = Math.max(...ring.map(q => q.x)) - Math.min(...ring.map(q => q.x));
    const h = Math.max(...ring.map(q => q.y)) - Math.min(...ring.map(q => q.y));
    if (Math.abs(w - 4) < 0.01 && Math.abs(h - 2) < 0.01) {
      pass(`arch is true-size: ${w.toFixed(2)}" span × ${h.toFixed(2)}" rise (2r × r)`);
    } else fail(`arch size wrong: ${w} × ${h}`);

    // the band is a band: solid at mid-band on the crown, open in the middle
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const cx = (Math.max(...ring.map(q => q.x)) + Math.min(...ring.map(q => q.x))) / 2 + p2.x;
    const baseY = Math.min(...ring.map(q => q.y)) + p2.y;
    const crownBand = surfaceAt(sim, cx, baseY + 2 - 0.3);   // mid-band at the crown
    const opening = surfaceAt(sim, cx, baseY + 0.3);         // under the arch
    const kerf = surfaceAt(sim, cx, baseY + 2 + 0.125);      // outside the crown
    if (crownBand === 0 && opening === 0 && kerf < -0.49) {
      pass(`band measured: crown face ${crownBand}, opening ${opening} (both faces), kerf ${kerf.toFixed(3)} (through)`);
    } else fail(`band wrong: crown=${crownBand} opening=${opening} kerf=${kerf}`);
  }

  // ADJUSTABLE: move the sliders, the part follows
  const r2 = run(rec, { r: 3, t: 1 });
  if (r2.ok) {
    const ring2 = r2.preview.built.find(x => x.r.previewRing).r.previewRing;
    const w2 = Math.max(...ring2.map(q => q.x)) - Math.min(...ring2.map(q => q.x));
    if (Math.abs(w2 - 6) < 0.01) pass(`sliders drive geometry: r 2→3 makes the span ${w2.toFixed(2)}" (was 4")`);
    else fail(`slider change wrong span: ${w2}`);
  } else fail(`arch at r=3,t=1 rejected: ${r2.errors?.join(' | ')}`);

  // degenerate slider combos fail as data, not as a bad cut
  const r3 = run(rec, { r: 0.75, t: 2 });   // t > r: band swallows the arch
  if (!r3.ok || r3.ok) {
    // whatever the geometry does, the gate holds: either a clean error or a verified job
    const clean = !r3.ok ? r3.errors.length > 0 : r3.report.ok;
    if (clean) pass(`degenerate combo (t > r) stays gated: ${!r3.ok ? `error "${r3.errors[0]}"` : 'still verifies as a disc'}`);
    else fail('degenerate combo escaped the gate');
  }

  // literal braces in NON-template params stay literal (engraved text)
  const lit = {
    ...structuredClone(EMPTY_RECIPE),
    pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: '{r}', letterHeight: 1 } }],
  };
  const rl = run(lit);
  if (rl.ok) pass('literal "{r}" engraves as text — template expansion is opt-in per param');
  else fail(`literal braces broke text: ${rl.errors?.join(' | ')}`);
}

// ---------------- 21. edge treatments: a rabbet on the arch's inside edge ----------------
// The "add a rabbet" decline, converted by COMPOSITION, not a new
// strategy: the rabbet is a parametric band pocket sharing the arch's
// own controls ({r-t-0.05} to {r-t+w}), overrunning the future edge so
// no sliver wall remains (edgeTreatment permits the kerf overlap; the
// cutout's fit check grants a small grace for the overrun).

console.log('--- rabbet on the arch inside edge ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Arch with rabbet',
    controls: [
      { id: 'r', type: 'number', label: 'Arch radius (in)', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Band thickness (in)', default: 0.6, min: 0.25, max: 2, step: 0.125 },
      { id: 'rw', type: 'number', label: 'Rabbet width (in)', default: 0.25, min: 0.125, max: 0.5, step: 0.0625 },
      { id: 'rd', type: 'number', label: 'Rabbet depth (in)', default: 0.25, min: 0.0625, max: 0.4, step: 0.0625 },
    ],
    pipeline: [
      { id: 'rabbet', strategy: 'pocket_shape', params: {
        shape: 'custom', width: 0, height: 0, toolDiameter: 0.125, edgeTreatment: true,
        depth: { ctrl: 'rd' },
        path: 'M {-(r-t-0.05)} 0 A {r-t-0.05} {r-t-0.05} 0 0 1 {r-t-0.05} 0 L {r-t+rw} 0 A {r-t+rw} {r-t+rw} 0 0 0 {-(r-t+rw)} 0 Z',
      } },
      { id: 'cut', strategy: 'shape_cutout', params: {
        path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {r-t} 0 A {r-t} {r-t} 0 0 0 {t-r} 0 Z',
        width: 0, height: 0, tabs: true,
      } },
    ],
  };
  const r = run(rec);
  if (r.ok && r.sbp) pass('arch + inside-edge rabbet VERIFIED → SBP');
  else fail(`rabbet arch rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const cut = r.preview.built.find(x => x.r.previewRing);
    const ring = cut.r.previewRing;
    const p2 = r.preview.placement;
    const cx = (Math.max(...ring.map(q => q.x)) + Math.min(...ring.map(q => q.x))) / 2 + p2.x;
    const baseY = Math.min(...ring.map(q => q.y)) + p2.y;
    // at the crown (r=2, t=0.6): inner edge at 1.4, rabbet ledge to 1.65,
    // untouched band face from 1.65 to 2
    const ledge = surfaceAt(sim, cx, baseY + 1.4 + 0.125);   // mid-rabbet
    const face = surfaceAt(sim, cx, baseY + 1.4 + 0.25 + 0.15); // past the rabbet
    const kerfIn = surfaceAt(sim, cx, baseY + 1.4 - 0.126);  // inner kerf centerline
    if (Math.abs(ledge + 0.25) < 0.005 && face === 0 && kerfIn < -0.49) {
      pass(`rabbet measured at the crown: ledge ${ledge.toFixed(3)} (declared -0.25), band face ${face}, inner kerf ${kerfIn.toFixed(3)} (through)`);
    } else fail(`rabbet surface wrong: ledge=${ledge} face=${face} kerfIn=${kerfIn}`);
  }

  // the rabbet follows the arch's sliders — one control moves both ops
  const r2 = run(rec, { r: 3, t: 0.8, rw: 0.25, rd: 0.2 });
  if (r2.ok) {
    const sim2 = simulateJob(r2.preview.built, r2.preview.placement, r2.preview.stock);
    const ring2 = r2.preview.built.find(x => x.r.previewRing).r.previewRing;
    const p2 = r2.preview.placement;
    const cx2 = (Math.max(...ring2.map(q => q.x)) + Math.min(...ring2.map(q => q.x))) / 2 + p2.x;
    const baseY2 = Math.min(...ring2.map(q => q.y)) + p2.y;
    const ledge2 = surfaceAt(sim2, cx2, baseY2 + 2.2 + 0.125);  // inner edge now at r-t = 2.2
    if (Math.abs(ledge2 + 0.2) < 0.005) {
      pass(`sliders move the rabbet with the arch: ledge at the new inner edge reads ${ledge2.toFixed(3)}`);
    } else fail(`rabbet did not follow sliders: ${ledge2}`);
  } else fail(`rabbet arch at r=3 rejected: ${r2.errors?.join(' | ')}`);

  // without edgeTreatment the kerf overlap is still an ERROR — the gate
  // only opens where the op declares the intent
  const noFlag = structuredClone(rec);
  delete noFlag.pipeline[0].params.edgeTreatment;
  const rn = run(noFlag);
  if (!rn.ok && rn.errors.some(e => e.toLowerCase().includes('overlap') || e.toLowerCase().includes('intru'))) {
    pass(`same recipe without edgeTreatment still refused: "${rn.errors[0]}"`);
  } else fail(`overlap check did not hold: ok=${rn.ok} ${rn.errors?.join(' | ')}`);

  // grossly oversized edge work is still caught despite the fit grace
  const off = structuredClone(rec);
  off.pipeline[0].params.path = off.pipeline[0].params.path.replaceAll('{r-t+rw}', '{r-t+rw+1}').replaceAll('{-(r-t+rw)}', '{-(r-t+rw+1)}');
  const ro = run(off);
  if (!ro.ok && ro.errors.some(e => e.includes('pokes outside'))) {
    pass('fit grace is small: a rabbet band 1" too wide still refused as misplaced content');
  } else fail(`gross misplacement slipped through the fit grace: ok=${ro.ok} ${ro.errors?.join(' | ')}`);
}

// ---------------- 22. hole patterns: explicit centers with expressions ----------------
// The "five evenly spaced holes along the arch centerline" decline,
// converted: bore_hole "at" takes any number of explicit centers in the
// working frame; direction cosines are baked constants and the radius is
// {r-t/2}, so the whole pattern rides the arch's sliders.

console.log('--- five holes along the arch centerline ---');
{
  const m = '(r-t/2)';   // centerline radius
  const at = [
    `{-0.951*${m}} {0.309*${m}}`,
    `{-0.588*${m}} {0.809*${m}}`,
    `0 {${m}}`,
    `{0.588*${m}} {0.809*${m}}`,
    `{0.951*${m}} {0.309*${m}}`,
  ].join('; ');
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Arch with holes',
    controls: [
      { id: 'r', type: 'number', label: 'Arch radius (in)', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Band thickness (in)', default: 0.6, min: 0.25, max: 2, step: 0.125 },
    ],
    pipeline: [
      { id: 'holes', strategy: 'bore_hole', params: { at, diameter: 0.25, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'shape_cutout', params: {
        path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {r-t} 0 A {r-t} {r-t} 0 0 0 {t-r} 0 Z',
        width: 0, height: 0, tabs: true,
      } },
    ],
  };
  const r = run(rec);
  const nHoles = r.preview?.built?.find(x => x.r.previewHoles)?.r.previewHoles.length ?? 0;
  if (r.ok && r.sbp && nHoles === 5) pass(`arch + 5 centerline holes VERIFIED → SBP (${nHoles} holes placed)`);
  else fail(`hole pattern rejected: ok=${r.ok} holes=${nHoles} ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const mid = 2 - 0.3;   // centerline radius at defaults
    const crownHole = surfaceAt(sim, p2.x, mid + p2.y);                       // hole at 90°
    const sideHole = surfaceAt(sim, 0.588 * mid + p2.x, 0.809 * mid + p2.y); // hole at 54°
    const between = surfaceAt(sim, Math.cos(Math.PI * 0.4) * mid + p2.x, Math.sin(Math.PI * 0.4) * mid + p2.y); // 72°, between holes
    if (crownHole < -0.49 && sideHole < -0.49 && between === 0) {
      pass(`holes measured: crown ${crownHole.toFixed(3)} and 54° ${sideHole.toFixed(3)} through, band between holes ${between}`);
    } else fail(`hole surface wrong: crown=${crownHole} side=${sideHole} between=${between}`);
  }

  // the pattern rides the sliders: bigger arch, holes at the new centerline
  const r2 = run(rec, { r: 3, t: 0.8 });
  if (r2.ok) {
    const sim2 = simulateJob(r2.preview.built, r2.preview.placement, r2.preview.stock);
    const p2 = r2.preview.placement;
    const crown2 = surfaceAt(sim2, p2.x, (3 - 0.4) + p2.y);
    if (crown2 < -0.49) pass(`pattern rides the sliders: crown hole through at the new centerline (r-t/2 = 2.6")`);
    else fail(`pattern did not follow sliders: ${crown2}`);
  } else fail(`holes at r=3 rejected: ${r2.errors?.join(' | ')}`);

  // a stray hole off the part is refused by the cutout's fit check
  const stray = structuredClone(rec);
  stray.pipeline[0].params.at = at + '; 0 {r+0.5}';
  const rs = run(stray);
  if (!rs.ok && rs.errors.some(e => e.includes('pokes outside'))) {
    pass('a 6th hole floated off the part → cutout refuses the layout');
  } else fail(`stray hole not caught: ok=${rs.ok} ${rs.errors?.join(' | ')}`);

  // malformed "at" fails as data
  const badAt = structuredClone(rec);
  badAt.pipeline[0].params.at = '1 2; 3';
  const rb = run(badAt);
  if (!rb.ok && rb.errors.some(e => e.includes('could not read hole center'))) {
    pass(`malformed at fails clean: "${rb.errors[0]}"`);
  } else fail(`malformed at not caught: ${rb.errors?.join(' | ')}`);
}

// ---------------- 23. derived values: name it once, use it everywhere ----------------
// Structural upgrade 1 of the language work: recipe.derived is an
// ordered list of named expressions over controls (and earlier derived
// ids). Re-deriving "r - t/2" in five params is where the model's
// arithmetic drifts; a let-binding removes the repetition.

console.log('--- derived values ---');
{
  if (EMPTY_RECIPE.version === 2 && Array.isArray(EMPTY_RECIPE.derived) && Array.isArray(EMPTY_RECIPE.shapes)) {
    pass('recipe grammar v2: version + derived + shapes fields present');
  } else fail(`EMPTY_RECIPE shape wrong: ${JSON.stringify(Object.keys(EMPTY_RECIPE))}`);
  const old = migrateRecipe({ name: 'vintage', stock: { thickness: 0.5 }, controls: [], pipeline: [] });
  if (old.version === 2 && Array.isArray(old.derived) && Array.isArray(old.shapes) && Array.isArray(old.assets)) {
    pass('a v1-era recipe migrates in place (version, derived, shapes, assets filled)');
  } else fail(`migration incomplete: ${JSON.stringify(old)}`);

  // the arch app, rewritten with derived values — chained (mid uses inner)
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Arch (derived)',
    controls: [
      { id: 'r', type: 'number', label: 'Radius', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Thickness', default: 0.6, min: 0.25, max: 2, step: 0.125 },
    ],
    derived: [
      { id: 'inner', expr: 'r - t' },
      { id: 'mid', expr: 'inner + t/2' },   // chained: uses a derived id
    ],
    pipeline: [
      { id: 'holes', strategy: 'bore_hole', params: {
        at: '{-0.951*mid} {0.309*mid}; {-0.588*mid} {0.809*mid}; 0 {mid}; {0.588*mid} {0.809*mid}; {0.951*mid} {0.309*mid}',
        diameter: 0.25, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'shape_cutout', params: {
        path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z',
        width: 0, height: 0, tabs: true } },
    ],
  };
  const r = run(rec);
  if (r.ok && r.sbp) pass('derived-value arch VERIFIED → SBP ({inner}, chained {mid})');
  else fail(`derived arch rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const crown = surfaceAt(sim, p2.x, 1.7 + p2.y);   // mid = 2 - 0.3
    if (crown < -0.49) pass('equivalence: crown hole through at mid = 1.7", same as the inline-expression recipe');
    else fail(`derived crown hole missing: ${crown}`);
  }

  // failure modes are data, not crashes
  const loose = structuredClone(rec);
  loose.derived[1].expr = 'inner + q/2';
  const rl = run(loose);
  if (!rl.ok && rl.errors[0].includes('derived "mid"') && rl.errors[0].includes('unknown name "q"')) {
    pass(`unknown name in a derived expr fails clean: "${rl.errors[0]}"`);
  } else fail(`derived error wrong: ${rl.errors?.join(' | ')}`);
  const clash = structuredClone(rec);
  clash.derived.push({ id: 'r', expr: '1' });
  const rc = run(clash);
  if (!rc.ok && rc.errors[0].includes('clashes with a control')) pass('derived id clashing with a control refused');
  else fail(`clash not caught: ${rc.errors?.join(' | ')}`);
}

console.log('--- derived values through the intent layer ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  rec.controls.push({ id: 'r', type: 'number', label: 'R', default: 2 }, { id: 't', type: 'number', label: 'T', default: 0.6 });
  const res = applyActions(rec, { summary: 'derive', actions: [
    { kind: 'set_derived', derived: { id: 'inner', expr: 'r - t' } },
    { kind: 'set_derived', derived: { id: 'mid', expr: 'inner + t/2' } },
    { kind: 'set_derived', derived: { id: 'oops', expr: 'nope * 2' } },      // unknown name
    { kind: 'set_derived', derived: { id: 'r', expr: '5' } },                // control clash
  ], declined: [] });
  if (res.applied.length === 2 && res.recipe.derived.length === 2 && res.skipped.length === 2
      && res.skipped[0].includes('unknown name "nope"') && res.skipped[1].includes('already a control')) {
    pass(`set_derived validates at apply time: 2 applied, 2 skipped with reasons`);
  } else fail(`set_derived apply wrong: applied=${JSON.stringify(res.applied)} skipped=${JSON.stringify(res.skipped)}`);

  // updating in place keeps order; removal is blocked while referenced
  const upd = applyActions(res.recipe, { summary: 'u', actions: [
    { kind: 'set_derived', derived: { id: 'inner', expr: 'r - t*1' } },
    { kind: 'remove_derived', id: 'inner' },
  ], declined: [] });
  if (upd.recipe.derived[0].id === 'inner' && upd.recipe.derived[0].expr === 'r - t*1'
      && upd.skipped.some(s => s.includes('referenced by another'))) {
    pass('update-in-place keeps chain order; removal blocked while "mid" references it');
  } else fail(`derived update/remove wrong: ${JSON.stringify(upd.recipe.derived)} ${JSON.stringify(upd.skipped)}`);

  const sys = buildParseRequest(upd.recipe, 'x').system;
  if (sys.includes('set_derived') && sys.includes('"expr": "r - t*1"')) {
    pass('prompt carries the derived rules and the current derived chain');
  } else fail('derived missing from the prompt');
}

// ---------------- 24. named shapes: define geometry once, reference it ----------------
// Structural upgrade 2: recipe.shapes holds named geometry in the SHARED
// frame — closed outlines for cutouts/pockets, open CURVES for
// along-the-curve derivations. The arch app in its final grammar:
// no baked cosines, the machine does the arc-length spacing.

console.log('--- the arch app in full v2 grammar ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Arch, v2 grammar',
    controls: [
      { id: 'r', type: 'number', label: 'Radius', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Thickness', default: 0.6, min: 0.25, max: 2, step: 0.125 },
    ],
    derived: [
      { id: 'inner', expr: 'r - t' },
      { id: 'mid', expr: 'r - t/2' },
    ],
    shapes: [
      { id: 'arch', path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z' },
      { id: 'centerline', path: 'M {-mid} 0 A {mid} {mid} 0 0 1 {mid} 0', open: true },
    ],
    pipeline: [
      { id: 'holes', strategy: 'bore_hole', params: { along: 'centerline', count: 5, endMargin: 0.3, diameter: 0.25, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'arch', tabs: true } },
    ],
  };
  const r = run(rec);
  const holes = r.preview?.built?.find(x => x.r.previewHoles)?.r.previewHoles ?? [];
  if (r.ok && r.sbp && holes.length === 5) pass('v2-grammar arch VERIFIED → SBP, 5 holes spaced by the machine');
  else fail(`v2 arch rejected: ok=${r.ok} holes=${holes.length} ${r.errors?.join(' | ')}`);
  if (r.ok && holes.length === 5) {
    // every hole rides the centerline radius exactly, spacing is even
    const mid = 2 - 0.3;
    const radiusErr = Math.max(...holes.map(h => Math.abs(Math.hypot(h.x, h.y) - mid)));
    const angs = holes.map(h => Math.atan2(h.y, h.x)).sort((a, b) => a - b);
    const gaps = angs.slice(1).map((a, i) => a - angs[i]);
    const gapSpread = Math.max(...gaps) - Math.min(...gaps);
    if (radiusErr < 0.002 && gapSpread < 0.002) {
      pass(`holes measured: all on the centerline (radius err ${radiusErr.toFixed(4)}"), even angular gaps (spread ${gapSpread.toFixed(4)} rad)`);
    } else fail(`hole layout wrong: radiusErr=${radiusErr} gapSpread=${gapSpread}`);
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const crown = surfaceAt(sim, p2.x, mid + p2.y);
    if (crown < -0.49) pass('crown hole through — same physical part as the hand-cosine grammar');
    else fail(`crown hole missing: ${crown}`);
  }

  // sliders re-lower shapes: the pattern and cutout follow together
  const r2 = run(rec, { r: 3, t: 0.8 });
  if (r2.ok) {
    const h2 = r2.preview.built.find(x => x.r.previewHoles).r.previewHoles;
    const radiusErr = Math.max(...h2.map(h => Math.abs(Math.hypot(h.x, h.y) - 2.6)));
    if (radiusErr < 0.002) pass('sliders re-lower the shapes: holes on the new 2.6" centerline');
    else fail(`shape re-lowering wrong: ${radiusErr}`);
  } else fail(`v2 arch at r=3 rejected: ${r2.errors?.join(' | ')}`);
}

console.log('--- along a closed outline: the bolt circle ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Flange',
    controls: [{ id: 'bc', type: 'number', label: 'Bolt circle radius', default: 1, min: 0.5, max: 2, step: 0.125 }],
    shapes: [{ id: 'ring', path: 'M {-bc} 0 A {bc} {bc} 0 1 1 {bc} 0 A {bc} {bc} 0 1 1 {-bc} 0 Z' }],
    pipeline: [
      { id: 'bolts', strategy: 'bore_hole', params: { along: 'ring', count: 6, diameter: 0.25, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'disc_cutout', params: { diameter: 3 } },
    ],
  };
  const r = run(rec);
  const holes = r.preview?.built?.find(x => x.r.previewHoles)?.r.previewHoles ?? [];
  if (r.ok && holes.length === 6) {
    const radiusErr = Math.max(...holes.map(h => Math.abs(Math.hypot(h.x, h.y) - 1)));
    if (radiusErr < 0.002) pass(`bolt circle: 6 holes evenly around a closed ring (radius err ${radiusErr.toFixed(4)}")`);
    else fail(`bolt circle radius wrong: ${radiusErr}`);
  } else fail(`bolt circle rejected: ok=${r.ok} holes=${holes.length} ${r.errors?.join(' | ')}`);
}

console.log('--- shape reference failure modes ---');
{
  const base = {
    ...structuredClone(EMPTY_RECIPE),
    controls: [{ id: 'r', type: 'number', label: 'R', default: 2 }],
    shapes: [
      { id: 'blob', path: 'M {-r} 0 A {r} {r} 0 1 1 {r} 0 A {r} {r} 0 1 1 {-r} 0 Z' },
      { id: 'line', path: 'M {-r} 0 L {r} 0', open: true },
    ],
  };
  const unknown = { ...structuredClone(base), pipeline: [{ id: 'c', strategy: 'shape_cutout', params: { shape: 'blobb' } }] };
  const ru = run(unknown);
  if (!ru.ok && ru.errors[0].includes('unknown shape "blobb"') && ru.errors[0].includes('blob, line')) {
    pass(`unknown reference names the defined shapes: "${ru.errors[0]}"`);
  } else fail(`unknown-shape error wrong: ${ru.errors?.join(' | ')}`);
  const openCut = { ...structuredClone(base), pipeline: [{ id: 'c', strategy: 'shape_cutout', params: { shape: 'line' } }] };
  const ro = run(openCut);
  if (!ro.ok && ro.errors[0].includes('open curve')) pass('cutting out an open curve refused with the reason');
  else fail(`open-curve cutout not caught: ${ro.errors?.join(' | ')}`);
  const both = { ...structuredClone(base), pipeline: [{ id: 'h', strategy: 'bore_hole', params: { along: 'line', at: '0 0' } }] };
  const rb = run(both);
  if (!rb.ok && rb.errors[0].includes('not both')) pass('at + along together refused as ambiguous');
  else fail(`at+along not caught: ${rb.errors?.join(' | ')}`);
}

console.log('--- shapes through the intent layer ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  rec.controls.push({ id: 'r', type: 'number', label: 'R', default: 2 });
  const res = applyActions(rec, { summary: 's', actions: [
    { kind: 'set_derived', derived: { id: 'inner', expr: 'r - 0.5' } },
    { kind: 'set_shape', shape: { id: 'arch', path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z' } },
    { kind: 'set_shape', shape: { id: 'mid', path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0', open: true } },
    { kind: 'set_shape', shape: { id: 'bad', path: 'M {q} 0 L 1 1 Z' } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'shape_cutout', params: { shape: 'arch' } } },
  ], declined: [] });
  if (res.applied.length === 4 && res.skipped.length === 1 && res.skipped[0].includes('unknown name "q"')) {
    pass('set_shape validates paths at apply time (bad {q} skipped with reason)');
  } else fail(`set_shape apply wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);
  const rm = applyActions(res.recipe, { summary: 'rm', actions: [{ kind: 'remove_shape', id: 'arch' }], declined: [] });
  if (rm.skipped.some(s => s.includes('still referenced'))) pass('remove_shape blocked while an op references it');
  else fail(`remove_shape guard failed: ${JSON.stringify(rm.skipped)}`);
  const rr = run(res.recipe);
  if (rr.ok) pass('intent-built shape recipe weaves VERIFIED');
  else fail(`intent-built shapes rejected: ${rr.errors?.join(' | ')}`);
}

// ---------------- 25. shape algebra + reference-scoped overlap ----------------
// Structural upgrades 2b and 3: shapes derive from earlier shapes
// (inset/outset/band/booleans — geometry by code, not by the model
// re-authoring offsets), and an edge treatment's overlap allowance is
// SCOPED to the cutout of the same base shape instead of blanket.

console.log('--- shape algebra: the whole-rim rabbet, derived ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Framed arch',
    controls: [
      { id: 'r', type: 'number', label: 'Radius', default: 2, min: 0.75, max: 6, step: 0.125 },
      { id: 't', type: 'number', label: 'Thickness', default: 0.6, min: 0.25, max: 2, step: 0.125 },
      { id: 'rw', type: 'number', label: 'Rabbet width', default: 0.2, min: 0.1, max: 0.4, step: 0.05 },
    ],
    derived: [{ id: 'inner', expr: 'r - t' }],
    shapes: [
      { id: 'arch', path: 'M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z' },
      { id: 'rim', band: { of: 'arch', width: '{rw}', overrun: 0.05 } },
    ],
    pipeline: [
      { id: 'rabbet', strategy: 'pocket_shape', params: { shape: 'rim', depth: 0.15, toolDiameter: 0.125, edgeTreatment: true } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'arch', tabs: true } },
    ],
  };
  const r = run(rec);
  if (r.ok && r.sbp) pass('band-derived whole-rim rabbet VERIFIED → SBP (scoped overlap, no blanket flag)');
  else fail(`derived rabbet rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const rabbetOp = r.job.operations.find(o => o.name.includes('rabbet'));
    if (rabbetOp && !rabbetOp.allowOverlap && rabbetOp.allowOverlapWith?.some(n => n.includes('cut'))) {
      pass(`overlap allowance is scoped: rabbet ↔ [${rabbetOp.allowOverlapWith.join(', ')}] only`);
    } else fail(`scoping wrong: allowOverlap=${rabbetOp?.allowOverlap} with=${JSON.stringify(rabbetOp?.allowOverlapWith)}`);
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    // whole-rim: ledge on the OUTER edge at the crown too (r - rw/2 in)
    const outerLedge = surfaceAt(sim, p2.x, (2 - 0.1) + p2.y);
    const innerLedge = surfaceAt(sim, p2.x, (2 - 0.6 + 0.1) + p2.y);
    const bandFace = surfaceAt(sim, p2.x, (2 - 0.3) + p2.y);
    if (Math.abs(outerLedge + 0.15) < 0.005 && Math.abs(innerLedge + 0.15) < 0.005 && bandFace === 0) {
      pass(`whole-rim ledge measured: outer ${outerLedge.toFixed(3)}, inner ${innerLedge.toFixed(3)}, mid-band face ${bandFace}`);
    } else fail(`rim ledge wrong: outer=${outerLedge} inner=${innerLedge} face=${bandFace}`);
  }

  // the scoping has teeth: an UNRELATED op overlapping the rabbet is
  // still an error (the old blanket flag would have waved it through).
  // An anchored pocket at the crown, inside the arch, straddling the rim
  // band (band spans radius 1.8..2 there):
  const sabotage = structuredClone(rec);
  sabotage.pipeline.splice(1, 0, {
    id: 'tray', strategy: 'pocket_shape',
    params: { shape: 'custom', path: 'M -0.2 -1.9 L 0.2 -1.9 L 0.2 -1.7 L -0.2 -1.7 Z', width: 0, height: 0, depth: 0.05, toolDiameter: 0.125 },
  });
  const rs = run(sabotage);
  if (!rs.ok && rs.errors.some(e => e.includes('overlap'))) {
    pass(`unrelated overlap still caught: "${rs.errors.find(e => e.includes('overlap')).slice(0, 80)}…"`);
  } else fail(`scoped overlap did not hold: ok=${rs.ok} ${rs.errors?.join(' | ')}`);
}

console.log('--- shape algebra: booleans and offsets ---');
{
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Washer',
    controls: [],
    shapes: [
      { id: 'disc', path: 'M -1.5 0 A 1.5 1.5 0 1 1 1.5 0 A 1.5 1.5 0 1 1 -1.5 0 Z' },
      { id: 'bore', path: 'M -0.5 0 A 0.5 0.5 0 1 1 0.5 0 A 0.5 0.5 0 1 1 -0.5 0 Z' },
      { id: 'washer', difference: ['disc', 'bore'] },
      { id: 'wellRim', inset: { of: 'washer', by: '0.2' } },
    ],
    pipeline: [
      { id: 'well', strategy: 'pocket_shape', params: { shape: 'wellRim', depth: 0.1, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'washer' } },
    ],
  };
  const r = run(rec);
  if (r.ok) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const well = surfaceAt(sim, 1.0 + p2.x, p2.y);        // mid-annulus: pocketed
    const rim = surfaceAt(sim, 1.45 + p2.x, p2.y);        // outer rim: untouched (inset kept it)
    const boreEdge = surfaceAt(sim, 0.55 + p2.x, p2.y);   // inner rim: untouched
    if (Math.abs(well + 0.1) < 0.005 && rim === 0 && boreEdge === 0) {
      pass(`washer: difference + inset compose (well ${well.toFixed(3)}, both rims untouched)`);
    } else fail(`washer surface wrong: well=${well} rim=${rim} boreEdge=${boreEdge}`);
  } else fail(`washer rejected: ${r.errors?.join(' | ')}`);

  // derivation failure modes are data
  const fwd = structuredClone(rec);
  fwd.shapes = [{ id: 'x', band: { of: 'later', width: '0.2' } }, ...fwd.shapes.map(s => s.id === 'disc' ? { ...s, id: 'later' } : s)];
  const rf = run(fwd);
  if (!rf.ok && rf.errors[0].includes('not defined ABOVE')) pass('forward reference refused (document order is definition order)');
  else fail(`forward ref not caught: ${rf.errors?.join(' | ')}`);
  const eat = structuredClone(rec);
  eat.shapes.push({ id: 'gone', inset: { of: 'bore', by: '0.6' } });
  const re = run(eat);
  if (!re.ok && re.errors[0].includes('leaves nothing')) pass('inset that consumes the whole shape refused with the reason');
  else fail(`empty inset not caught: ${re.errors?.join(' | ')}`);
}

console.log('--- algebra through the intent layer ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  rec.controls.push({ id: 'r', type: 'number', label: 'R', default: 2 });
  const res = applyActions(rec, { summary: 's', actions: [
    { kind: 'set_shape', shape: { id: 'disc', path: 'M {-r} 0 A {r} {r} 0 1 1 {r} 0 A {r} {r} 0 1 1 {-r} 0 Z' } },
    { kind: 'set_shape', shape: { id: 'rim', band: { of: 'disc', width: '0.25', overrun: '0.05' } } },
    { kind: 'set_shape', shape: { id: 'both', path: 'M 0 0 L 1 1 Z', band: { of: 'disc', width: '1' } } },  // two forms
    { kind: 'set_shape', shape: { id: 'orphan', band: { of: 'nope', width: '0.2' } } },                     // bad ref
  ], declined: [] });
  if (res.applied.length === 2 && res.skipped.length === 2
      && res.skipped[0].includes('one derivation') && res.skipped[1].includes('not defined ABOVE')) {
    pass('set_shape derivations validated at apply time (two-forms and bad-ref skipped with reasons)');
  } else fail(`algebra apply wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);
  const rm = applyActions(res.recipe, { summary: 'rm', actions: [{ kind: 'remove_shape', id: 'disc' }], declined: [] });
  if (rm.skipped.some(s => s.includes("another shape's derivation"))) {
    pass('remove_shape blocked while a derivation references it');
  } else fail(`derivation removal guard failed: ${JSON.stringify(rm.skipped)}`);
}

// ---------------- 26. failure is a picture, not a blank ----------------
// Brian's heart report: "prompt appeared to succeed but the preview is
// totally empty." Three compounding failure modes, all from pasting an
// SVG-viewbox path as inches: fit conflicts blanked the preview and
// mislabeled the badge EMPTY; a viewbox-sized shape verified honestly
// as a 100-inch part and previewed as a giant blank board.

console.log('--- degraded previews and authoring-scale warnings ---');
{
  const heart100 = 'M 50 88 C 20 60 0 40 0 25 C 0 10 12 0 25 0 C 35 0 45 8 50 18 C 55 8 65 0 75 0 C 88 0 100 10 100 25 C 100 40 80 60 50 88 Z';
  const base = {
    ...structuredClone(EMPTY_RECIPE),
    controls: [{ id: 'initials', type: 'text', label: 'Initials', default: 'BKO' }],
  };

  // off-origin viewbox heart in the shapes section: fit conflict — but
  // the preview must still carry the picture (text built + outlines)
  const conflict = {
    ...structuredClone(base),
    shapes: [{ id: 'heart', path: heart100 }],
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'initials' }, letterHeight: 1 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'heart', tabs: true } },
    ],
  };
  const r1 = run(conflict);
  if (!r1.ok && !r1.preview.empty && r1.preview.failed
      && r1.preview.built.length >= 1 && r1.preview.shapeOutlines?.length === 1
      && r1.preview.stock && r1.errors[0].includes('pokes outside')) {
    pass(`fit conflict degrades to a picture: ${r1.preview.built.length} built op + heart outline + ${r1.preview.stock.w.toFixed(1)}"-wide diagnostic stock`);
  } else fail(`degraded preview wrong: empty=${r1.preview?.empty} failed=${r1.preview?.failed} built=${r1.preview?.built?.length} outlines=${r1.preview?.shapeOutlines?.length} ${r1.errors?.join(' | ')}`);
  if (r1.warnings.some(w => w.includes('from the origin'))) {
    pass(`off-origin authoring warned: "${r1.warnings.find(w => w.includes('from the origin'))}"`);
  } else fail(`no off-origin warning: ${JSON.stringify(r1.warnings)}`);

  // centered but still viewbox-sized: verifies as a 100-inch part —
  // must warn loudly instead of silently previewing a barren board
  const centered = heart100.replace(/([\d.]+) ([\d.]+)/g, (m, a, b) => (a - 50).toFixed(0) + ' ' + (b - 44).toFixed(0));
  const giant = {
    ...structuredClone(base),
    shapes: [{ id: 'heart', path: centered }],
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'initials' }, letterHeight: 1 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'heart', tabs: true } },
    ],
  };
  const r2 = run(giant);
  if (r2.ok && r2.warnings.some(w => w.includes('INCHES') && w.includes('viewbox'))) {
    pass(`viewbox-scale part warned: "${r2.warnings.find(w => w.includes('INCHES')).slice(0, 90)}…"`);
  } else fail(`giant part not warned: ok=${r2.ok} ${JSON.stringify(r2.warnings)}`);

  // the CORRECT authoring — a 3.6" heart centered on the origin —
  // engraves the initials inside it and verifies clean
  const scaled = heart100.replace(/([\d.]+) ([\d.]+)/g, (m, a, b) => ((a - 50) * 0.036).toFixed(3) + ' ' + ((b - 44) * 0.036).toFixed(3));
  const good = {
    ...structuredClone(base),
    shapes: [{ id: 'heart', path: scaled }],
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'initials' }, letterHeight: 0.7 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'heart', tabs: true } },
    ],
  };
  const r3 = run(good);
  if (r3.ok && r3.preview.stock.w < 6 && !r3.warnings.some(w => w.includes('viewbox') || w.includes('from the origin'))) {
    pass(`initials in a heart, authored right: VERIFIED on a ${r3.preview.stock.w}" × ${r3.preview.stock.h}" board, no warnings`);
  } else fail(`good heart wrong: ok=${r3.ok} stock=${JSON.stringify(r3.preview?.stock)} warnings=${JSON.stringify(r3.warnings)}`);

  // shape outlines ride along on SUCCESS too (construction geometry)
  if (r3.ok && r3.preview.shapeOutlines?.length === 1) pass('construction outlines present in successful previews');
  else fail(`outlines missing on success: ${r3.preview?.shapeOutlines?.length}`);
}

// ---------------- 27. uploaded SVG files as shapes ----------------
// The "carve the uploaded logo" decline, converted: a whole SVG FILE
// (transform stacks, shape elements, per-element fill rules) lowers to
// the same welded regions an authored path does, via the shapes section
// ({ asset: {of, width} }). Size is expression-capable, so the logo
// rides a slider like any parametric shape.

console.log('--- svg file parsing: transforms, elements, fill rules ---');
{
  const file = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- machinery that must NOT become geometry -->
  <defs><circle id="tpl" cx="0" cy="0" r="40"/></defs>
  <g transform="translate(50 50)">
    <path fill-rule="evenodd" d="M -30 0 A 30 30 0 1 1 30 0 A 30 30 0 1 1 -30 0 Z M -15 0 A 15 15 0 1 1 15 0 A 15 15 0 1 1 -15 0 Z"/>
    <rect x="-45" y="-45" width="20" height="10" transform="rotate(90)"/>
    <circle cx="40" cy="40" r="8" fill="none"/>
    <text x="0" y="0">skip me</text>
  </g>
  <polygon points="90,90 98,90 94,98"/>
</svg>`;
  const r = svgToRegions(file);
  const area = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      a += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
    }
    return Math.abs(a / 2);
  };
  if (r.error) fail(`svg file did not parse: ${r.error}`);
  else {
    const donut = r.regions.find(x => x.holes.length === 1);
    const ringErr = donut ? Math.abs(area(donut.outer) - Math.PI * 900) / (Math.PI * 900) : 1;
    const holeErr = donut ? Math.abs(area(donut.holes[0]) - Math.PI * 225) / (Math.PI * 225) : 1;
    if (donut && ringErr < 0.01 && holeErr < 0.01) {
      pass(`evenodd donut welds with its hole (outer ${(ringErr * 100).toFixed(2)}% from π·30², hole ${(holeErr * 100).toFixed(2)}% from π·15²)`);
    } else fail(`donut wrong: found=${!!donut} ringErr=${ringErr} holeErr=${holeErr}`);
    const rect = r.regions.find(x => !x.holes.length && Math.abs(area(x.outer) - 200) < 0.5);
    if (rect) {
      const xs = rect.outer.map(q => q.x), ys = rect.outer.map(q => q.y);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      // translate(50,50)·rotate(90) maps the 20×10 rect to a 10-wide, 20-tall one
      if (Math.abs(w - 10) < 1e-6 && Math.abs(h - 20) < 1e-6) {
        pass('nested transform stack exact: rotate(90) under translate turns 20×10 into 10×20');
      } else fail(`transform wrong: ${w}×${h}`);
    } else fail('transformed rect missing');
    const tri = r.regions.find(x => Math.abs(area(x.outer) - 32) < 0.5);
    if (r.regions.length === 3 && tri) pass('3 filled pieces total: defs template did not leak, triangle polygon parsed');
    else fail(`pieces wrong: ${r.regions.length}, tri=${!!tri}`);
    const wantWarn = ['unfilled', '<text>'];
    if (wantWarn.every(w => r.warnings.some(x => x.includes(w)))) {
      pass(`skips are honest warnings: ${r.warnings.join(' / ')}`);
    } else fail(`skip warnings wrong: ${JSON.stringify(r.warnings)}`);
  }

  // declared physical size: 80mm-wide viewBox-100 file → true-size mode
  const mm = `<svg width="80mm" height="80mm" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>`;
  const t = svgAssetToRegions(mm, {});
  if (!t.error && Math.abs(t.w - 64 / 25.4) < 1e-3 && !t.warnings.length) {
    pass(`physical units honored: 64mm-diameter circle lowers to ${t.w.toFixed(4)}" with no size given`);
  } else fail(`true-size wrong: w=${t.w} ${t.error ?? ''} ${JSON.stringify(t.warnings)}`);
  const bare = svgAssetToRegions(`<svg viewBox="0 0 10 5"><rect width="10" height="5"/></svg>`, {});
  if (!bare.error && bare.w === 3 && bare.warnings.some(w => w.includes('3"'))) {
    pass('unit-less file defaults to 3" wide WITH a warning to set a size');
  } else fail(`default-size wrong: ${bare.w} ${JSON.stringify(bare.warnings)}`);
}

console.log('--- the uploaded logo, pocketed: asset → shape → verified job ---');
{
  // a "logo" exercising cross-element union (the tab overlaps the plate)
  // and an evenodd hole that must survive as an uncut island
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
  <g transform="translate(60 40)">
    <path fill-rule="evenodd" d="M -50 -30 L 50 -30 L 50 30 L -50 30 Z M -12 0 A 12 12 0 1 1 12 0 A 12 12 0 1 1 -12 0 Z"/>
    <rect x="-54" y="-8" width="8" height="16"/>
  </g>
</svg>`;
  let rec = structuredClone(EMPTY_RECIPE);
  rec.assets.push({ id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: logo });

  // built the way the model would build it: through the intent layer,
  // with the size BOUND so the user can rescale the logo later
  const res = applyActions(rec, { summary: 'pocket the logo', actions: [
    { kind: 'add_control', control: { id: 'w', type: 'number', label: 'Logo width', default: 3, min: 1.5, max: 6, step: 0.25 } },
    { kind: 'set_shape', shape: { id: 'logo', asset: { of: 'logo.svg', width: 'w' } } },
    { kind: 'add_operation', operation: { id: 'emblem', strategy: 'pocket_shape', params: { shape: 'logo', depth: 0.15, toolDiameter: 0.125 } } },
  ], declined: [] });
  if (res.applied.length === 3 && !res.skipped.length) pass('asset shape applies through the intent layer (dry-lowered the real file)');
  else fail(`asset apply wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);

  const r = run(res.recipe);
  if (r.ok && r.sbp) pass('uploaded-logo pocket VERIFIED → SBP');
  else fail(`logo pocket rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    // measured: the weld crossed elements (tab + plate = one piece), the
    // island is uncut at 0, the floor is at depth, the width matches w
    const p = r.preview.placement;
    const sim = simulateJob(r.preview.built, p, r.preview.stock);
    const island = surfaceAt(sim, p.x, p.y);
    const floor = surfaceAt(sim, p.x + 1.0, p.y);
    if (Math.abs(island) < 1e-6 && Math.abs(floor + 0.15) < 0.01) {
      pass(`evenodd hole survives as an island (surface ${island}" vs floor ${floor.toFixed(3)}")`);
    } else fail(`island/floor wrong: island=${island} floor=${floor}`);
    const rings = r.preview.built[0].r.previewRegions?.[0];
    const xs = rings.outer.map(q => q.x);
    const w = Math.max(...xs) - Math.min(...xs);
    if (Math.abs(w - 3) < 1e-6) pass('logo scaled to the bound control: 3.000" wide');
    else fail(`logo width wrong: ${w}`);

    const r2 = run(res.recipe, { w: 4.5 });
    if (r2.ok) {
      const rr = r2.preview.built[0].r.previewRegions[0];
      const xs2 = rr.outer.map(q => q.x);
      const w2 = Math.max(...xs2) - Math.min(...xs2);
      if (Math.abs(w2 - 4.5) < 1e-6) pass('slider rescales the uploaded file: 4.5" wide re-lowers and re-verifies');
      else fail(`rescale wrong: ${w2}`);
    } else fail(`w=4.5 rejected: ${r2.errors?.join(' | ')}`);
  }
}

console.log('--- asset shapes compose: inset ring, holes along it, cutout ---');
{
  const shield = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 10 H 90 V 55 C 90 80 50 95 50 95 C 50 95 10 80 10 55 Z"/>
</svg>`;
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Shield plaque',
    assets: [{ id: 'shield.svg', name: 'shield.svg', kind: 'svg', data: shield }],
    shapes: [
      { id: 'shield', asset: { of: 'shield.svg', width: '4' } },
      { id: 'rim', inset: { of: 'shield', by: 0.45 } },
    ],
    pipeline: [
      { id: 'holes', strategy: 'bore_hole', params: { along: 'rim', count: 6, diameter: 0.25, toolDiameter: 0.125 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'shield', tabs: true } },
    ],
  };
  const r = run(rec);
  const holes = r.preview?.built?.find(x => x.r.previewHoles)?.r.previewHoles ?? [];
  if (r.ok && r.sbp && holes.length === 6) {
    pass('shape algebra runs on file geometry: 6 holes along an inset of the UPLOAD, cutout verified');
  } else fail(`shield recipe rejected: ok=${r.ok} holes=${holes.length} ${r.errors?.join(' | ')}`);
}

console.log('--- asset shape failure modes stay honest ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  rec.assets.push(
    { id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
    { id: 'dog.png', name: 'dog.png', kind: 'image', data: 'data:image/png;base64,AAAA', width: 64, height: 64 },
    { id: 'junk.svg', name: 'junk.svg', kind: 'svg', data: '<p>not svg</p>' },
  );
  const tryShape = (shape) => applyActions(rec, { summary: 's', actions: [{ kind: 'set_shape', shape }], declined: [] }).skipped[0] ?? '';
  const missing = tryShape({ id: 'x', asset: { of: 'nope.svg' } });
  if (missing.includes('no uploaded file "nope.svg"') && missing.includes('"logo.svg"')) {
    pass(`wrong name skipped, uploads listed: "${missing}"`);
  } else fail(`missing-asset message wrong: ${missing}`);
  const raster = tryShape({ id: 'x', asset: { of: 'dog.png' } });
  if (raster.includes('raster image')) pass('raster asset refused as a shape with the honest reason');
  else fail(`raster message wrong: ${raster}`);
  const junk = tryShape({ id: 'x', asset: { of: 'junk.svg' } });
  if (junk.includes('no <svg> element')) pass('unparseable file refused at apply time, not at weave time');
  else fail(`junk message wrong: ${junk}`);
  const both = tryShape({ id: 'x', path: 'M 0 0 L 1 0 L 1 1 Z', asset: { of: 'logo.svg' } });
  if (both.includes('give a path, an asset, a drawing, a glyph, OR')) pass('path + asset together refused as ambiguous');
  else fail(`both-forms message wrong: ${both}`);
}

// ---------------- 28. fit: self-sizing outlines around content ----------------
// Brian's heart report, part two: the model guessed the heart's absolute
// size and the text overflowed it. fit {of, margin} moves the sizing
// into code — the shape scales uniformly about the origin until all
// content clears its edge by margin, so a longer name makes a BIGGER
// heart, the tag_cutout ergonomic for any outline.

console.log('--- the heart that fits the name ---');
{
  const heart100 = 'M 50 88 C 20 60 0 40 0 25 C 0 10 12 0 25 0 C 35 0 45 8 50 18 C 55 8 65 0 75 0 C 88 0 100 10 100 25 C 100 40 80 60 50 88 Z';
  const centered = heart100.replace(/([\d.]+) ([\d.]+)/g, (m, a, b) => (a - 50).toFixed(0) + ' ' + (b - 44).toFixed(0));
  const distToRing = (q, ring) => {
    let d = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)));
    }
    return d;
  };
  const ringWidth = (ring) => {
    const xs = ring.map(q => q.x);
    return Math.max(...xs) - Math.min(...xs);
  };

  // built through the intent layer, margin bound like tag_cutout's buffer
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, { summary: 'name in a heart', actions: [
    { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'BKO' } },
    { kind: 'add_control', control: { id: 'm', type: 'number', label: 'Margin', default: 0.25, min: 0.1, max: 1, step: 0.05 } },
    { kind: 'set_shape', shape: { id: 'heart', path: centered } },
    { kind: 'set_shape', shape: { id: 'tag', fit: { of: 'heart', margin: 'm' } } },
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 0.7 } } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag', tabs: true } } },
  ], declined: [] });
  if (res.applied.length === 6 && !res.skipped.length) pass('fit shape applies through the intent layer (dry-run resolves at scale 1)');
  else fail(`fit apply wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);
  rec = res.recipe;

  const measure = (values) => {
    const r = run(rec, values);
    if (!r.ok) return { r };
    const ring = r.preview.built.find(x => x.op.id === 'cut').r.previewRing;
    const cutXY = r.preview.built
      .filter(x => x.op.id === 'engrave')
      .flatMap(x => x.r.moves)
      .filter(mv => Number.isFinite(mv.x) && Number.isFinite(mv.y));
    const clear = Math.min(...cutXY.map(q => distToRing(q, ring)));
    return { r, ring, clear, w: ringWidth(ring) };
  };

  const short = measure({ name: 'BO', m: 0.25 });
  if (short.r.ok && short.r.sbp) pass('name-in-a-fitted-heart VERIFIED → SBP');
  else fail(`fitted heart rejected: ${short.r.errors?.join(' | ')}`);
  if (short.r.ok) {
    // THE bug: text must clear the heart's edge — measure it
    if (short.clear >= 0.25 * 0.9 && short.clear < 1.5) {
      pass(`engraving clears the fitted edge by ${short.clear.toFixed(3)}" (margin 0.25", snug not bloated)`);
    } else fail(`clearance wrong: ${short.clear}`);
    const long = measure({ name: 'BARTHOLOMEW', m: 0.25 });
    if (long.r.ok && long.w > short.w * 1.5 && long.clear >= 0.25 * 0.9) {
      pass(`longer name grows the heart: ${short.w.toFixed(2)}" → ${long.w.toFixed(2)}" wide, clearance still ${long.clear.toFixed(3)}"`);
    } else fail(`long-name fit wrong: ok=${long.r.ok} w=${long.w} vs ${short.w} clear=${long.clear}`);
    const roomy = measure({ name: 'BO', m: 0.8 });
    if (roomy.r.ok && roomy.w > short.w * 1.3 && roomy.clear >= 0.8 * 0.9) {
      pass(`margin slider is the size the user means: 0.8" margin → ${roomy.w.toFixed(2)}"-wide heart`);
    } else fail(`margin response wrong: ok=${roomy.r.ok} w=${roomy.w} clear=${roomy.clear}`);
  }
}

console.log('--- fit composes: rabbet band on the fitted heart ---');
{
  const heart = 'M 0 44 C -30 16 -50 -4 -50 -19 C -50 -34 -38 -44 -25 -44 C -15 -44 -5 -36 0 -26 C 5 -36 15 -44 25 -44 C 38 -44 50 -34 50 -19 C 50 -4 30 16 0 44 Z';
  const rec = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Heart tag, rabbeted',
    controls: [{ id: 'name', type: 'text', label: 'Name', default: 'ADA' }],
    shapes: [
      { id: 'heart', path: heart },
      { id: 'tag', fit: { of: 'heart', margin: 0.3 } },
      { id: 'rim', band: { of: 'tag', width: 0.2, overrun: 0.05 } },
    ],
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 0.7 } },
      { id: 'rabbet', strategy: 'pocket_shape', params: { shape: 'rim', depth: 0.15, toolDiameter: 0.125, edgeTreatment: true } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag' } },
    ],
  };
  const r = run(rec);
  if (r.ok && r.sbp) pass('band-of-fitted-shape chain resolves and VERIFIES (rabbet rides the self-sized heart)');
  else fail(`fitted rabbet rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const rabbet = r.job.operations.find(o => o.name.startsWith('rabbet'));
    if (rabbet?.allowOverlapWith?.some(n => n.startsWith('cut'))) {
      pass('overlap allowance still scoped through the fit lineage (rabbet ↔ its cutout only)');
    } else fail(`fit lineage broken: allowOverlapWith=${JSON.stringify(rabbet?.allowOverlapWith)} allowOverlap=${rabbet?.allowOverlap}`);
    // the band actually follows the fitted size: its outline must hug
    // the fitted ring, not the unit-less base heart
    const cutRing = r.preview.built.find(x => x.op.id === 'cut').r.previewRing;
    const rimRings = r.preview.shapeOutlines.find(o => o.id === 'rim')?.rings ?? [];
    const cutXs = cutRing.map(q => q.x);
    const rimXs = rimRings.flat().map(q => q.x);
    const cutW = Math.max(...cutXs) - Math.min(...cutXs);
    const rimW = Math.max(...rimXs) - Math.min(...rimXs);
    if (Math.abs(rimW - (cutW + 0.1)) < 0.02) {
      pass(`band hugs the fitted edge: rim ${rimW.toFixed(3)}" vs cutout ${cutW.toFixed(3)}" + 2×0.05 overrun`);
    } else fail(`band did not follow the fit: rim=${rimW} cut=${cutW}`);
  }
}

console.log('--- fit failure modes stay honest ---');
{
  const heartCentered = 'M 0 44 C -30 16 -50 -4 -50 -19 C -50 -34 -38 -44 -25 -44 C -15 -44 -5 -36 0 -26 C 5 -36 15 -44 25 -44 C 38 -44 50 -34 50 -19 C 50 -4 30 16 0 44 Z';
  const heartOffOrigin = 'M 50 88 C 20 60 0 40 0 25 C 0 10 12 0 25 0 C 35 0 45 8 50 18 C 55 8 65 0 75 0 C 88 0 100 10 100 25 C 100 40 80 60 50 88 Z';
  const base = (shapes, pipeline) => ({ ...structuredClone(EMPTY_RECIPE), shapes, pipeline });

  // nothing before the referencing op → there is nothing to wrap
  const empty = base(
    [{ id: 'heart', path: heartCentered }, { id: 'tag', fit: { of: 'heart', margin: 0.25 } }],
    [{ id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag' } }],
  );
  const r1 = run(empty);
  if (!r1.ok && r1.errors[0].includes('BEFORE')) pass(`fit with no content refused: "${r1.errors[0]}"`);
  else fail(`empty-fit error wrong: ${r1.errors?.join(' | ')}`);

  // base authored off-origin (viewbox coords) can never wrap origin-centered content
  const off = base(
    [{ id: 'heart', path: heartOffOrigin }, { id: 'tag', fit: { of: 'heart', margin: 0.25 } }],
    [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'AB', letterHeight: 0.7 } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag' } },
    ],
  );
  const r2 = run(off);
  if (!r2.ok && r2.errors[0].includes('ORIGIN')) pass('off-origin base refused with the origin lesson, not an endless search');
  else fail(`off-origin fit error wrong: ${r2.errors?.join(' | ')}`);

  // apply-time validation: bad references and expressions skip with reasons
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, { summary: 's', actions: [
    { kind: 'set_shape', shape: { id: 'line', path: 'M -1 0 L 1 0', open: true } },
    { kind: 'set_shape', shape: { id: 'a', fit: { of: 'line', margin: 0.2 } } },
    { kind: 'set_shape', shape: { id: 'b', fit: { of: 'nope', margin: 0.2 } } },
    { kind: 'set_shape', shape: { id: 'heart', path: 'M 0 1 L -1 -1 L 1 -1 Z' } },
    { kind: 'set_shape', shape: { id: 'c', fit: { of: 'heart', margin: '{q+}' } } },
    { kind: 'set_shape', shape: { id: 'tag', fit: { of: 'heart', margin: 0.25 } } },
  ], declined: [] });
  const want = [['open curve'], ['not defined ABOVE'], ['margin']];
  if (res.applied.length === 3 && res.skipped.length === 3 && want.every((w, i) => w.every(x => res.skipped[i].includes(x)))) {
    pass('fit validated at apply time: open-curve base, unknown base, bad margin all skipped with reasons');
  } else fail(`fit apply validation wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);
  const rm = applyActions(res.recipe, { summary: 'rm', actions: [{ kind: 'remove_shape', id: 'heart' }], declined: [] });
  if (rm.skipped.some(s => s.includes('referenced'))) pass('remove_shape blocked while a fit derives from it');
  else fail(`remove_shape fit guard failed: ${JSON.stringify(rm.skipped)}`);
}

// ---------------- shape scalar accepts a {ctrl} binding (the "bull tag" bug) ----------------
// A fit margin (like every shape scalar) bound to a control the op-param way —
// {ctrl:"m"} — used to stringify to "[object Object]" and hit the arithmetic
// parser ("expected a number, name, or ("). The prompt tells the model to
// "bind margin to a control", so that form MUST resolve. A non-binding object
// still fails, but with a readable reason instead of the parser vomit.
console.log('--- shape scalar accepts a {ctrl} control binding ---');
{
  const res = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'name in a fitted shape', actions: [
    { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'DURHAM' } },
    { kind: 'add_control', control: { id: 'm', type: 'number', label: 'Margin', default: 0.3, min: 0.1, max: 1, step: 0.05 } },
    { kind: 'set_shape', shape: { id: 'body', path: 'M 0 2 L -2 -2 L 2 -2 Z' } },
    { kind: 'set_shape', shape: { id: 'tag', fit: { of: 'body', margin: { ctrl: 'm' } } } },  // THE bug: object binding
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 0.6 } } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag', tabs: true } } },
  ], declined: [] });
  if (res.applied.length === 6 && !res.skipped.length) pass('fit margin bound to a control {ctrl:"m"} applies (no more [object Object])');
  else fail(`ctrl-bound margin skipped: ${JSON.stringify(res.skipped)}`);

  const r = run(res.recipe, { name: 'DURHAM', m: 0.3 });
  if (r.ok && r.sbp) pass('the ctrl-bound fit builds and verifies → SBP');
  else fail(`ctrl-bound fit failed to build: ${r.errors?.join(' | ')}`);

  // a NON-binding object is still rejected — but readably, not "[object Object]"
  const bad = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'bad', actions: [
    { kind: 'set_shape', shape: { id: 'body', path: 'M 0 2 L -2 -2 L 2 -2 Z' } },
    { kind: 'set_shape', shape: { id: 'tag', fit: { of: 'body', margin: { nope: 1 } } } },
  ], declined: [] });
  if (bad.skipped.some(s => s.includes('margin') && s.includes('expected a number') && !s.includes('[object Object]'))) {
    pass('a non-binding object margin skips with a readable reason (not [object Object])');
  } else fail(`bad object margin message wrong: ${JSON.stringify(bad.skipped)}`);
}

// ---------------- prompt: decline representational likenesses, still draw geometry ----------------
// A bull/eagle/face/logo hand-drawn from a few béziers is a blob that passes
// every toolpath check yet looks nothing like the subject — worse than a clean
// decline (the naive user just sees a bad drawing). The grounding prompt must
// tell the model to refuse AUTHORING the likeness and offer the two real
// sources — the user's own hand (set_shape draw) or a file (set_shape asset) —
// WITHOUT chilling the geometric shapes it draws well. (Calibration — that it
// refuses to author a bull but still draws a star — is a live-key check; this
// guards the guidance.)
console.log('--- prompt: decline authored likenesses, offer draw + upload, still author geometry ---');
{
  const sys = buildParseRequest(structuredClone(EMPTY_RECIPE), 'x').system;
  const declinesLikeness = /REPRESENTATIONAL/.test(sys) && /blob/.test(sys) && /beats a bad one you invented/.test(sys);
  const offersSources = /set_shape asset/.test(sys) && /UPLOAD the artwork/.test(sys)
    && /DRAW it themselves/.test(sys) && /MORE DESCRIPTION WILL NOT HELP/.test(sys);
  const stillAuthorsGeometry = /AUTHOR it yourself as an SVG path/.test(sys) && /star, heart/.test(sys);
  if (declinesLikeness && offersSources && stillAuthorsGeometry) {
    pass('prompt refuses authored likenesses + offers draw AND upload, and still authors geometric outlines');
  } else fail(`likeness-decline guidance wrong: decline=${declinesLikeness} sources=${offersSources} geom=${stillAuthorsGeometry}`);
}

// ---------------- draw modality: a smoothed sketch → an SVG shape asset ----------------
// A hand-drawn outline is stored as an SVG asset and lowers through the SAME
// svgAssetToRegions the file-upload path uses — so a drawn shape composes like
// any uploaded one (set_shape asset {of, width} → cutout/pocket). outlineToSvg
// is pure (no DOM), so it tests headless; the canvas capture is exercised live.
console.log('--- draw: smoothed outline → SVG asset lowers to a shape ---');
{
  const { outlineToSvg } = await import('./draw.mjs');
  const pts = [{ x: 10, y: 10 }, { x: 110, y: 20 }, { x: 130, y: 90 }, { x: 60, y: 130 }, { x: 5, y: 80 }];
  const svg = outlineToSvg(pts, { maxInches: 4 });
  const r = svgAssetToRegions(svg, {});
  if (!r.error && r.regions.length === 1 && Math.abs(r.w - 4) < 0.5) {
    pass(`drawn outline → one SVG region at ~4" default (w=${r.w.toFixed(2)}")`);
  } else fail(`drawn SVG lowered wrong: ${JSON.stringify({ error: r.error, w: r.w, n: r.regions?.length })}`);
  const sized = svgAssetToRegions(svg, { width: 6 });
  if (!sized.error && Math.abs(sized.w - 6) < 1e-6) pass('set_shape width overrides the drawn default size');
  else fail(`width override wrong: ${sized.w}`);
  if (outlineToSvg([{ x: 0, y: 0 }, { x: 1, y: 1 }]) === null) pass('a degenerate sketch (< 3 pts) yields no SVG');
  else fail('outlineToSvg should reject < 3 points');
}

// ---------------- pinned blank: design to a real piece, not a grown board ----------------
// A user with a specific offcut pins recipe.stock.width/height; the board is
// then that exact piece (content centered within), and the model is grounded to
// fit it. Empty = the board auto-sizes to the content, exactly as before.
console.log('--- pinned blank pins the board + grounds the model ---');
{
  const base = structuredClone(EMPTY_RECIPE);
  base.pipeline.push({ id: 'name', strategy: 'vcarve_text', params: { text: 'HI', letterHeight: 1 } });

  const auto = run(base, {});
  if (auto.ok && !auto.preview.stock.pinned && auto.preview.stock.w > 0) {
    pass(`no blank: board auto-sizes to content (${auto.preview.stock.w}" × ${auto.preview.stock.h}")`);
  } else fail(`auto-size baseline wrong: ${JSON.stringify(auto.preview?.stock)}`);

  const big = structuredClone(base); big.stock.width = 12; big.stock.height = 8;
  const rBig = run(big, {});
  if (rBig.preview.stock.pinned && rBig.preview.stock.w === 12 && rBig.preview.stock.h === 8) {
    pass('pinned blank fixes the board at 12" × 8" (not grown to content)');
  } else fail(`pinned blank wrong: ${JSON.stringify(rBig.preview?.stock)}`);

  const small = structuredClone(base); small.stock.width = 0.5; small.stock.height = 0.5;
  const rSmall = run(small, {});
  if ((rSmall.warnings ?? []).some(w => w.includes('your blank is 0.5"'))) {
    pass('design bigger than the blank warns, does not silently overrun');
  } else fail(`too-small blank warning missing: ${JSON.stringify(rSmall.warnings)}`);

  const sysPinned = buildParseRequest(big, 'x').system;
  const sysAuto = buildParseRequest(base, 'x').system;
  if (sysPinned.includes('PINNED A BLANK') && sysPinned.includes('12" × 8"')
    && !sysAuto.includes('PINNED A BLANK') && sysAuto.includes('AUTO-SIZED')) {
    pass('prompt grounds the pinned blank only when declared');
  } else fail(`blank grounding wrong: pinned=${sysPinned.includes('PINNED A BLANK')} auto=${sysAuto.includes('AUTO-SIZED')}`);
}

// ---------------- sheet ledger: track a piece of stock + what's been cut ----------------
// Pure state/geometry: place a footprint into the free space, record cuts, and
// report % free — the local "keep cutting from my sheet" workflow. UI/persistence
// live in main.js; the packer here is the reusable nesting primitive.
console.log('--- sheet ledger: nest into free space, record cuts, report free % ---');
{
  const L = await import('./ledger.mjs');
  const ok = (msg, cond, detail) => (cond ? pass(msg) : fail(detail ? `${msg} — ${detail}` : msg));
  const s0 = L.makeSheet(24, 12, 0.5);

  const first = L.placeOnSheet(s0, 6, 4);
  if (first && Math.abs(first.x) < 1e-9 && Math.abs(first.y) < 1e-9) pass('empty sheet: first part lands at the origin');
  else fail(`first placement wrong: ${JSON.stringify(first)}`);
  if (L.sheetFreePct(s0) === 100) pass('empty sheet is 100% free'); else fail(`empty free% = ${L.sheetFreePct(s0)}`);

  // two cuts must not overlap, and free% must drop
  const r1 = L.recordCut(s0, 6, 4, 'a');
  const r2 = L.recordCut(r1.sheet, 6, 4, 'b');
  if (!r1.error && !r2.error) pass('two 6×4 parts both record onto a 24×12 sheet'); else fail(`record failed: ${r1.error || r2.error}`);
  const [o0, o1] = r2.sheet.occupied;
  const overlap = o0.x < o1.x + o1.w && o1.x < o0.x + o0.w && o0.y < o1.y + o1.h && o1.y < o0.y + o0.h;
  ok('the two recorded footprints do not overlap', !overlap, JSON.stringify(r2.sheet.occupied));
  const free = L.sheetFreePct(r2.sheet);
  ok('free% drops after cuts', free < 100 && free > 50, `free=${free}%`);

  // a long-thin part fits a narrow-tall sheet ONLY when turned
  const rot = L.placeOnSheet(L.makeSheet(3, 12, 0.5), 10, 2);
  ok('a 10×2 part fits a 3×12 sheet by rotating', !!rot && rot.rotated && rot.w === 2 && rot.h === 10, JSON.stringify(rot));

  // won't-fit is honest and records nothing
  const tooBig = L.recordCut(s0, 40, 40, 'huge');
  ok('a part bigger than the remaining space is refused with a reason', !!tooBig.error && /won't fit/.test(tooBig.error));
  ok('fitsOnSheet agrees with placement', !L.fitsOnSheet(s0, 40, 40) && L.fitsOnSheet(s0, 6, 4));

  // clear + inactive-sheet guards
  ok('clearCuts wipes the history', L.clearCuts(r2.sheet).occupied.length === 0);
  const none = L.makeSheet(0, 0, 0.5);
  ok('an undeclared sheet nests nothing and reads 100% free', L.placeOnSheet(none, 2, 2) === null && L.sheetFreePct(none) === 100);
}

// ---------------- place-on-export: sheet is the stock, design offset to its spot ----------------
// runRecipe's 6th arg (placeAt) makes the SHEET the stock and offsets the design
// to its nested (x,y), so the exported cut lands in the free space rather than at
// a lone board origin — the ledger's Record button uses this.
console.log('--- place-on-export: cut lands at its sheet position, not centered ---');
{
  const base = structuredClone(EMPTY_RECIPE);
  base.pipeline.push({ id: 'name', strategy: 'vcarve_text', params: { text: 'HI', letterHeight: 1 } });
  const placed = quiet(() => runRecipe(base, {}, FONT_SHELF, {}, {}, { x: 5, y: 3, sheetW: 12, sheetH: 12 }));
  if (placed.ok && placed.preview.stock.w === 12 && placed.preview.stock.h === 12 && placed.preview.stock.placed) pass('placeAt makes the 12×12 sheet the stock');
  else fail(`placeAt stock wrong: ${JSON.stringify(placed.preview?.stock)} ok=${placed.ok}`);
  const cuts = (placed.composed ?? []).filter((m) => m.type === 'linear' || m.type === 'arc');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of cuts) {
    if (Number.isFinite(m.x)) { minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x); }
    if (Number.isFinite(m.y)) { minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y); }
  }
  if (minX >= 5 - 0.01 && minY >= 3 - 0.01 && maxX <= 12.01 && maxY <= 12.01) {
    pass(`the toolpath sits in the (5,3) corner of the 12×12 sheet (x[${minX.toFixed(2)},${maxX.toFixed(2)}] y[${minY.toFixed(2)},${maxY.toFixed(2)}])`);
  } else fail(`toolpath not placed at (5,3): x[${minX.toFixed(2)},${maxX.toFixed(2)}] y[${minY.toFixed(2)},${maxY.toFixed(2)}]`);
}

// ---------------- redrawn shape flows into its cutout (replace the asset in place) ----------------
// The per-person shape input: replacing a drawn SVG asset's data in place (same
// id) re-lowers any cutout referencing it — the geometry drives the cut, so a
// redraw changes the part without re-pointing anything.
console.log('--- redrawn shape flows into its cutout ---');
{
  const square = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0 L10 0 L10 10 L0 10 Z" fill="#000"/></svg>';
  const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 5"><path d="M0 0 L20 0 L20 5 L0 5 Z" fill="#000"/></svg>';
  const rec = structuredClone(EMPTY_RECIPE);
  rec.assets = [{ id: 'tag', name: 'tag', kind: 'svg', data: square }];
  rec.shapes = [{ id: 'tagshape', asset: { of: 'tag', width: 4 } }];
  rec.pipeline = [{ id: 'cut', strategy: 'shape_cutout', params: { shape: 'tagshape' } }];
  const before = run(rec, {});
  rec.assets[0].data = wide;   // "redraw" — replace the drawn shape's geometry in place
  const after = run(rec, {});
  if (before.ok && after.ok && Math.abs(before.preview.stock.h - after.preview.stock.h) > 1) {
    pass(`replacing the drawn shape re-lowers the cutout (board ${before.preview.stock.w}×${before.preview.stock.h} → ${after.preview.stock.w}×${after.preview.stock.h})`);
  } else fail(`replace didn't flow through: before=${JSON.stringify(before.preview?.stock)} after=${JSON.stringify(after.preview?.stock)} ok=${before.ok}/${after.ok}`);
}

// ---------------- 29. guest strategies: a sibling app as a catalog verb ----------------
// The mount mechanism, proven with a mock guest (the real guests — e.g.
// the furniture designer — live in the private workspace and test
// there). Contract: entries registered at boot, document params with
// expression-string numbers via ctx.evalNumber, output in the WORKING
// FRAME with internal placements baked, same verify gate.

console.log('--- guest mount: register, weave, verify ---');
{
  const { CATALOG, registerCatalogEntries, catalogDoc } = await import('./catalog.mjs');
  const { generatePocket } = await import('../strategies/pocket.js');

  const mockGuest = {
    two_pads: {
      doc: 'MOCK GUEST for tests: two square pads pocketed side by side.',
      params: {
        size: { type: 'string', default: '1', doc: 'pad size, inches — expression over controls allowed', bindable: true },
        depth: { type: 'number', default: 0.2, doc: 'pad depth' },
      },
      run(p, ctx) {
        const s = ctx.evalNumber(p.size, { u: 1.5 });   // extras: guest-supplied namespace
        if (s.error) return { error: s.error };
        const sz = s.value;
        const square = (x0) => ({ outer: [
          { x: x0, y: 0 }, { x: x0 + sz, y: 0 }, { x: x0 + sz, y: sz }, { x: x0, y: sz },
        ], holes: [] });
        const ops = [];
        for (const x0 of [0, sz + 0.5]) {   // internal layout, baked into coords
          const g = generatePocket(square(x0), { diameter: 0.25 }, {
            stepoverPct: 40, totalDepth: p.depth, depthPerPass: 0.125, safeZ: ctx.safeZ, feedRate: 80, plungeRate: 30,
          });
          ops.push({
            subName: `pad@${x0}`,
            tool: { name: '1/4" endmill', diameter: 0.25 },
            cutter: { type: 'flat', diameter: 0.25 },
            feedRate: 80, plungeRate: 30,
            moves: g.moves, target: g.target,
          });
        }
        return {
          ops,
          bbox: { minX: 0, minY: 0, maxX: 2 * sz + 0.5, maxY: sz },
          // assembled-view contract: op-level assembly data (flat panels
          // with sheet spots + Y-up world poses) must reach the preview
          assembly: {
            box: [2 * sz + 0.5, sz, sz],
            panels: [{
              id: 'padA', thickness: 0.2, rings: [square(0).outer],
              sheet: { x: 0, y: 0 },
              world: { origin: [0, 0, sz], u: [1, 0, 0], v: [0, 0, -1] },
            }],
          },
          // frames contract: a clear face beside the pads, TURNED 90°,
          // for native verbs to mount into (see the framed-vcarve checks)
          frames: [{ id: 'face', cx: 2 * sz + 2.5, cy: sz / 2, rot: 90, w: 4, h: 4 }],
        };
      },
    },
  };
  const added = registerCatalogEntries(mockGuest);
  if (added.length === 1 && CATALOG.two_pads) pass('guest entry registered into the live catalog');
  else fail(`registration failed: ${JSON.stringify(added)}`);
  if (catalogDoc().includes('MOCK GUEST')) pass('guest doc joins the grounding prompt automatically');
  else fail('guest doc missing from catalogDoc');

  // the intent layer accepts guest verbs like native ones
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, { summary: 'pads', actions: [
    { kind: 'add_control', control: { id: 'u2', type: 'number', label: 'Pad', default: 2, min: 1, max: 3, step: 0.5 } },
    { kind: 'add_operation', operation: { id: 'pads', strategy: 'two_pads', params: { size: 'u2', depth: 0.2 } } },
  ], declined: [] });
  if (res.applied.length === 2) pass('intent layer validates a guest op like a native one');
  else fail(`guest apply wrong: ${JSON.stringify(res.skipped)}`);

  const r = run(res.recipe);
  if (r.ok && r.sbp) pass('guest-woven recipe VERIFIED → SBP through the unchanged gate');
  else fail(`guest recipe rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    const asm = r.preview.assemblies?.[0];
    if (asm?.opId === 'pads' && asm.panels?.length === 1 &&
        asm.panels[0].world?.u && Number.isFinite(asm.panels[0].sheet?.x)) {
      pass('op-level assembly data flows to the preview (assembled-view contract)');
    } else fail(`assembly passthrough wrong: ${JSON.stringify(asm)?.slice(0, 120)}`);
    // baked layout survives: two distinct pads at the guest's offsets
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p2 = r.preview.placement;
    const padA = surfaceAt(sim, p2.x + 1.0, p2.y + 1.0);
    const padB = surfaceAt(sim, p2.x + 3.5, p2.y + 1.0);
    const gapZ = surfaceAt(sim, p2.x + 2.25, p2.y + 1.0);
    if (Math.abs(padA + 0.2) < 0.01 && Math.abs(padB + 0.2) < 0.01 && Math.abs(gapZ) < 1e-6) {
      pass(`working-frame baking measured: pads at -0.2, untouched gap between (${padA.toFixed(3)} / ${gapZ} / ${padB.toFixed(3)})`);
    } else fail(`pad layout wrong: ${padA} ${gapZ} ${padB}`);
    // ctx.evalNumber: control u2=2 wins over the guest extra u; expression re-evaluates
    const r3 = run(res.recipe, { u2: 3 });
    const w3 = r3.ok ? r3.preview.built.at(-1).r.target.rings ? 1 : 1 : 0;
    if (r3.ok && r3.preview.stock.w > r.preview.stock.w) {
      pass(`guest expression param rides the slider: stock ${r.preview.stock.w}" → ${r3.preview.stock.w}" at size 3`);
    } else fail(`guest slider response wrong: ${w3} ${r3.errors?.join(' | ')}`);
  }

  // FRAMES: native verbs mount inside guest geometry — panel-local
  // authoring, whole-result transform, unchanged gate
  const fr = applyActions(structuredClone(res.recipe), { summary: 'framed carve', actions: [
    { kind: 'add_operation', operation: { id: 'carve', strategy: 'vcarve_text', params: { text: 'MMM', letterHeight: 0.8 }, frame: 'face' } },
  ], declined: [] });
  if (fr.applied.length === 1 && fr.recipe.pipeline.at(-1).frame === 'face') {
    pass('intent layer carries the op-level frame field');
  } else fail(`frame field lost: ${JSON.stringify(fr.recipe.pipeline.at(-1))}`);
  const rf = run(fr.recipe);
  if (rf.ok) pass('framed vcarve VERIFIES through the unchanged gate');
  else fail(`framed vcarve rejected: ${rf.errors?.join(' | ')}`);
  if (rf.ok) {
    let bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const b of rf.preview.built.filter(x => x.op.id === 'carve')) {
      for (const ring of b.r.target?.rings ?? []) for (const q of ring) {
        bb.minX = Math.min(bb.minX, q.x); bb.maxX = Math.max(bb.maxX, q.x);
        bb.minY = Math.min(bb.minY, q.y); bb.maxY = Math.max(bb.maxY, q.y);
      }
    }
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const sz = 2;   // the u2 control default
    if (Math.abs(cx - (2 * sz + 2.5)) < 0.2 && Math.abs(cy - sz / 2) < 0.2) {
      pass(`framed content lands at the frame center (${cx.toFixed(2)}, ${cy.toFixed(2)})`);
    } else fail(`framed content at (${cx.toFixed(2)}, ${cy.toFixed(2)}), frame at (${2 * sz + 2.5}, ${sz / 2})`);
    // "MMM" is a wide block; the frame turns 90° — the placed block must be TALL
    if (bb.maxY - bb.minY > (bb.maxX - bb.minX) * 1.5) {
      pass(`frame rotation baked into the content (${(bb.maxX - bb.minX).toFixed(2)}" wide × ${(bb.maxY - bb.minY).toFixed(2)}" tall)`);
    } else fail(`content not rotated: ${(bb.maxX - bb.minX).toFixed(2)} × ${(bb.maxY - bb.minY).toFixed(2)}`);
  }
  // unknown frame: refused, names what exists
  const badFrame = structuredClone(fr.recipe);
  badFrame.pipeline.at(-1).frame = 'lid';
  const rbf = run(badFrame);
  if (!rbf.ok && rbf.errors[0].includes('no frame "lid"') && rbf.errors[0].includes('face')) {
    pass('unknown frame refused, published frames named');
  } else fail(`unknown-frame error wrong: ${rbf.errors?.join(' | ')}`);
  // surface targets can't ride a frame yet — clean refusal, not garbage motion
  const dishFrame = structuredClone(res.recipe);
  dishFrame.pipeline.push({ id: 'dish', strategy: 'dish_shape', params: {}, frame: 'face' });
  const rdf = run(dishFrame);
  if (!rdf.ok && rdf.errors[0].includes('surface targets')) {
    pass('heightmap op in a frame: honest refusal with the reason');
  } else fail(`heightmap-frame error wrong: ${rdf.errors?.join(' | ')}`);

  // guardrails: no shadowing native verbs, no malformed entries
  const dup = registerCatalogEntries({ pocket_shape: { doc: 'evil', params: {}, run: () => ({}) } });
  const bad = registerCatalogEntries({ broken: { doc: 'no run' } });
  if (!dup.length && !bad.length && CATALOG.pocket_shape.doc !== 'evil') {
    pass('guest cannot shadow a native verb or register malformed');
  } else fail('registration guardrails failed');

  delete CATALOG.two_pads;   // leave the catalog clean for other sections
}

console.log('--- glyph library: built-in signage symbols, no upload ---');
{
  const { GLYPHS, glyphById } = await import('./glyphs.mjs');
  // every library entry lowers cleanly at the default size — the library
  // is pre-curated, so a warning here means a bad regeneration
  let dirty = 0;
  for (const g of GLYPHS) {
    const r = svgAssetToRegions(g.svg, { width: 3 });
    if (r.error || !r.regions?.length || r.warnings?.length) {
      dirty++; fail(`glyph "${g.id}": ${r.error ?? r.warnings?.join(' | ') ?? 'no regions'}`);
    }
  }
  if (!dirty) pass(`all ${GLYPHS.length} glyphs lower clean and warning-free`);
  if (glyphById('restroom') && glyphById('accessible')) pass('restroom + accessible present (the signage staples)');
  else fail('restroom/accessible missing from library');

  // built the way the model would build it: a restroom sign — glyph
  // recessed via the intent layer, size bound, plaque cut around it
  const res = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'restroom sign', actions: [
    { kind: 'add_control', control: { id: 'gw', type: 'number', label: 'Symbol width', default: 2.5, min: 1, max: 5, step: 0.25 } },
    { kind: 'set_shape', shape: { id: 'sym', glyph: { of: 'restroom', width: 'gw' } } },
    { kind: 'add_operation', operation: { id: 'recess', strategy: 'pocket_shape', params: { shape: 'sym', depth: 0.1, toolDiameter: 0.125 } } },
  ], declined: [] });
  if (res.applied.length === 3 && !res.skipped.length) pass('glyph shape applies through the intent layer (dry-lowered the library file)');
  else fail(`glyph apply wrong: ${JSON.stringify(res.applied)} / ${JSON.stringify(res.skipped)}`);

  const r = run(res.recipe);
  if (r.ok && r.sbp) pass('restroom-glyph pocket VERIFIED → SBP');
  else fail(`glyph pocket rejected: ${r.errors?.join(' | ')}`);
  if (r.ok) {
    // the composite pockets as several sub-ops (one per figure) — measure
    // the whole glyph across all of them
    const rings = r.preview.built.flatMap(b => b.r.previewRegions ?? []);
    const xs = rings.flatMap(reg => reg.outer.map(q => q.x));
    const w = Math.max(...xs) - Math.min(...xs);
    if (Math.abs(w - 2.5) < 1e-6) pass('glyph scaled to the bound control: 2.500" wide');
    else fail(`glyph width wrong: ${w}`);
  }

  // a wrong name must skip with the library listed, not half-apply
  const bad = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'x', actions: [
    { kind: 'set_shape', shape: { id: 'sym', glyph: { of: 'unicorn' } } },
  ], declined: [] });
  if (!bad.applied.length && bad.skipped[0]?.includes('no built-in glyph "unicorn"')) {
    pass(`unknown glyph skipped with the library listed: "${bad.skipped[0].slice(0, 70)}…"`);
  } else fail(`unknown glyph not refused: ${JSON.stringify(bad.skipped)}`);

  // the men's-room sign: the model just orders the ops and sets
  // place:"below" — no coordinates. The field-reported failure was every
  // element stacked on the origin; here each drops under the last.
  const sign = applyActions(structuredClone(EMPTY_RECIPE), { summary: "men's sign", actions: [
    { kind: 'set_shape', shape: { id: 'fig', glyph: { of: 'men', width: '2' } } },
    { kind: 'add_operation', operation: { id: 'symbol', strategy: 'pocket_shape', params: { shape: 'fig', depth: 0.1, toolDiameter: 0.125 } } },
    { kind: 'add_operation', operation: { id: 'label', strategy: 'vcarve_text', params: { text: 'Men', letterHeight: 0.8, place: 'below' } } },
    { kind: 'add_operation', operation: { id: 'plaque', strategy: 'tag_cutout', params: { buffer: 0.5 } } },
  ], declined: [] });
  if (sign.applied.length === 4 && !sign.skipped.length) pass('men\'s sign layout applies (place:"below", no coordinates)');
  else fail(`sign apply wrong: ${JSON.stringify(sign.skipped)}`);
  const sr = run(sign.recipe);
  if (sr.ok) pass('men\'s sign VERIFIED with stacked elements');
  else fail(`men's sign rejected: ${sr.errors?.join(' | ')}`);
  if (sr.ok) {
    const yRange = (strategy) => {
      const ys = sr.preview.built.filter(b => b.op.strategy === strategy)
        .flatMap(b => b.r.previewRegions ?? []).flatMap(reg => reg.outer.map(q => q.y));
      return { min: Math.min(...ys), max: Math.max(...ys) };
    };
    const glyphY = yRange('pocket_shape'), textY = yRange('vcarve_text');
    if (glyphY.min > textY.max + 0.1) {
      pass(`place:"below" stacks: glyph bottom ${glyphY.min.toFixed(2)}" clears text top ${textY.max.toFixed(2)}"`);
    } else fail(`glyph/text overlap: glyph [${glyphY.min.toFixed(2)},${glyphY.max.toFixed(2)}] text [${textY.min.toFixed(2)},${textY.max.toFixed(2)}]`);
  }

  // the glyph DROPDOWN: of bound to a choice control, switching the value
  // swaps the symbol and re-lowers the sign live
  const drop = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'switchable sign', actions: [
    { kind: 'add_control', control: { id: 'symbol', type: 'choice', default: 'men', options: [
      { value: 'men', label: 'Men' }, { value: 'women', label: 'Women' }, { value: 'accessible', label: 'Accessible' },
    ] } },
    { kind: 'set_shape', shape: { id: 'fig', glyph: { of: { ctrl: 'symbol' }, width: '2' } } },
    { kind: 'add_operation', operation: { id: 'sym', strategy: 'pocket_shape', params: { shape: 'fig', depth: 0.1, toolDiameter: 0.125 } } },
  ], declined: [] });
  if (drop.applied.length === 3 && !drop.skipped.length) pass('glyph bound to a choice control applies (of: {ctrl})');
  else fail(`glyph dropdown apply wrong: ${JSON.stringify(drop.skipped)}`);

  const widthAt = (recipe, symbol) => {
    const r = run(recipe, { ...controlDefaults(recipe), symbol });
    if (!r.ok) return { err: r.errors?.join(' | ') };
    const xs = r.preview.built.flatMap(b => b.r.previewRegions ?? []).flatMap(reg => reg.outer.map(q => q.x));
    const ys = r.preview.built.flatMap(b => b.r.previewRegions ?? []).flatMap(reg => reg.outer.map(q => q.y));
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const men = widthAt(drop.recipe, 'men');
  const acc = widthAt(drop.recipe, 'accessible');
  // men figure is tall-and-narrow; the wheelchair symbol is near-square —
  // so at the same 2" width their HEIGHTS differ measurably: the dropdown
  // really swapped the geometry, not just relabelled it
  if (men.err || acc.err) fail(`dropdown weave failed: ${men.err ?? acc.err}`);
  else if (Math.abs(men.h - acc.h) > 0.5) pass(`dropdown swaps geometry: "men" is ${men.h.toFixed(1)}" tall, "accessible" ${acc.h.toFixed(1)}" at the same 2" width`);
  else fail(`dropdown did not change the glyph: men ${men.h.toFixed(2)} vs accessible ${acc.h.toFixed(2)}`);

  // a binding to a missing control is refused at apply time
  const missing = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'x', actions: [
    { kind: 'set_shape', shape: { id: 'fig', glyph: { of: { ctrl: 'nope' }, width: '2' } } },
  ], declined: [] });
  if (!missing.applied.length && missing.skipped[0]?.includes('missing control "nope"')) {
    pass('glyph bound to a missing control refused at apply time');
  } else fail(`missing-control binding not refused: ${JSON.stringify(missing.skipped)}`);

  // the overlay case must still center: a monogram in a pocketed well
  // (place default "center") sits ON the well, not below it
  const mono = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'well', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 2, depth: 0.1 } },
      { id: 'mono', strategy: 'vcarve_text', params: { text: 'B', letterHeight: 1 } },
    ],
  });
  if (mono.ok) {
    const wc = mono.preview.built.find(b => b.op.id === 'well');
    const mc = mono.preview.built.find(b => b.op.id === 'mono');
    const cy = (b) => { const ys = (b.r.previewRegions ?? []).flatMap(r => r.outer.map(q => q.y)); return (Math.min(...ys) + Math.max(...ys)) / 2; };
    if (Math.abs(cy(wc) - cy(mc)) < 0.15) pass('overlay unchanged: default-place monogram still centers ON the well');
    else fail(`monogram not centered on well: well cy ${cy(wc).toFixed(2)} vs mono cy ${cy(mc).toFixed(2)}`);
  } else fail(`monogram-in-well rejected: ${mono.errors?.join(' | ')}`);
}

// ---------------- texture_field: procedural relief around a name ----------------

console.log('--- texture_field: flood a texture around the name ---');
{
  const base = () => ({ ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.6 } });
  const mk = (params) => ({ ...base(), pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: 'Anna', letterHeight: 1 } },
    { id: 'tex', strategy: 'texture_field', params },
  ] });

  // clean case: verified ballnose surface-raster; the field carries relief and
  // the letters stay PROUD (a shallow texture band, then the deeper V-carve —
  // two distinct depth populations, proving the ball did not skim the letters)
  const r = run(mk({ texture: 'waves', depth: 0.06 }));
  const texBuilt = r.preview?.built?.find(b => b.op.id === 'tex');
  const tgt = r.report?.stats.targets?.find(t => t.type === 'heightmap');
  if (r.ok && texBuilt?.r.cutter?.type === 'ball' && tgt && (tgt.gouges ?? 0) === 0) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    let texBand = 0, letterBand = 0;
    for (const z of sim.grid) { if (z < -0.015 && z > -0.14) texBand++; if (z <= -0.15) letterBand++; }
    if (texBand > 50000 && letterBand > 3000) pass(`waves field verified: ${tgt.samples} samples, 0 gouges; ${texBand} texture cells shallower than the ${letterBand}-cell V-carve (letters stay proud)`);
    else fail(`relief populations off: texBand=${texBand} letterBand=${letterBand}`);
  } else fail(`waves texture_field failed: ok=${r.ok} err=${r.errors?.join(' | ')} cutter=${texBuilt?.r.cutter?.type} gouges=${tgt?.gouges}`);

  // every curated family verifies through the unchanged gate with a heightmap target
  const fams = ['waves', 'ripples', 'interference', 'fluting', 'basketweave', 'woodgrain', 'crosshatch', 'hammered', 'flowing', 'slate'];
  const bad = fams.filter(f => { const x = run(mk({ texture: f })); return !(x.ok && x.report?.stats.targets?.some(t => t.type === 'heightmap')); });
  if (!bad.length) pass(`all ${fams.length} curated families verify → ball surface-raster`);
  else fail(`families that did not verify: ${bad.join(', ')}`);

  // honest failures
  const noPrior = run({ ...base(), pipeline: [{ id: 'tex', strategy: 'texture_field', params: { texture: 'waves' } }] });
  if (!noPrior.ok && noPrior.errors.some(e => /prior operation/.test(e))) pass('nothing to surround: friendly error');
  else fail(`no-prior not handled: ${JSON.stringify(noPrior.errors)}`);

  const unknown = run(mk({ texture: 'zigzag' }));
  if (!unknown.ok && unknown.errors.some(e => /unknown texture/.test(e))) pass('unknown family named with the list: clean error');
  else fail(`unknown family not handled: ${JSON.stringify(unknown.errors)}`);

  // bit-aware guardrail: a feature finer than the ballnose can resolve warns (and still cuts)
  const muddy = run(mk({ texture: 'waves', featureSize: 0.1, toolDiameter: 0.125 }));
  if (muddy.ok && muddy.warnings.some(w => /finer than|muddy/.test(w))) pass('sub-bit feature size warns (bit-aware guardrail), still verifies');
  else fail(`muddy warning missing: ok=${muddy.ok} warnings=${JSON.stringify(muddy.warnings)}`);

  // ---- driving fields: angle / origin / flow / fade reshape the pattern,
  // all through the unchanged verifier gate
  const movesOf = (r) => r.preview.built.find((b) => b.op.id === 'tex').r.moves;
  const sig = (r) => JSON.stringify(movesOf(r).slice(0, 80));
  const plain = run(mk({ texture: 'waves' }));
  const angled = run(mk({ texture: 'waves', angle: 90 }));
  if (plain.ok && angled.ok && sig(plain) !== sig(angled)) pass('angle 90° verifies and actually rotates the pattern (motion differs)');
  else fail(`angle: plain ok=${plain.ok} angled ok=${angled.ok} differs=${plain.ok && angled.ok ? sig(plain) !== sig(angled) : '-'}`);

  const fromName = run(mk({ texture: 'ripples', origin: 'content' }));
  const native = run(mk({ texture: 'ripples' }));
  if (fromName.ok && native.ok && sig(fromName) !== sig(native)
    && fromName.report.stats.targets.some((t) => t.type === 'heightmap' && (t.gouges ?? 0) === 0)) {
    pass('origin "content" verifies: rings spread from the letters, 0 gouges, distinct from native ripples');
  } else fail(`origin content: ok=${fromName.ok} distinct=${fromName.ok && native.ok ? sig(fromName) !== sig(native) : '-'} err=${fromName.errors?.join(' | ')}`);

  const bent = run(mk({ texture: 'waves', flow: 1 }));
  if (bent.ok && sig(bent) !== sig(plain)) pass('flow 1 verifies: ridges bend around the letters (motion differs from straight waves)');
  else fail(`flow: ok=${bent.ok} distinct=${bent.ok && plain.ok ? sig(bent) !== sig(plain) : '-'}`);

  // fade calms the field near the letters: strictly fewer full-depth cells
  // than the same texture without fade (the pool is the only difference)
  const deepCells = (r) => {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    let n = 0;
    for (const z of sim.grid) if (z < -0.045 && z > -0.14) n++;
    return n;
  };
  const pooled = run(mk({ texture: 'waves', fade: 0.6 }));
  if (pooled.ok && plain.ok) {
    const dp = deepCells(pooled), dn = deepCells(plain);
    if (dp < dn * 0.9) pass(`fade 0.6 calms a pool around the letters: ${dp} full-depth cells vs ${dn} without fade`);
    else fail(`fade did not calm the field: ${dp} full-depth cells with fade vs ${dn} without`);
  } else fail(`fade run failed: ok=${pooled.ok} err=${pooled.errors?.join(' | ')}`);

  // knobs that need a wave family or content degrade politely, bad values error
  const flat2d = run(mk({ texture: 'basketweave', origin: 'edge', flow: 0.5 }));
  if (flat2d.ok && flat2d.warnings.some((w) => /not a wave family/.test(w))) pass('origin/flow on a 2D family: warned and ignored, still verifies');
  else fail(`2D-family origin not handled: ok=${flat2d.ok} warnings=${JSON.stringify(flat2d.warnings)}`);
  const badOrigin = run(mk({ texture: 'waves', origin: 'letters' }));
  if (!badOrigin.ok && badOrigin.errors.some((e) => /unknown origin/.test(e))) pass('unknown origin named with the choices: clean error');
  else fail(`bad origin not handled: ${JSON.stringify(badOrigin.errors)}`);
}

// ---------------- texture_field within: texture strictly inside a shape ----------------

console.log('--- texture_field within: texture strictly inside a named shape ---');
{
  const heartPath = 'M 0 -1.2 C 1.6 0.4 0.9 1.6 0 0.7 C -0.9 1.6 -1.6 0.4 0 -1.2 Z';
  const rec = {
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.6 },
    shapes: [{ id: 'heart', path: heartPath }],
    pipeline: [{ id: 'tex', strategy: 'texture_field', params: { texture: 'hammered', within: 'heart', depth: 0.06 } }],
  };
  const r = run(rec);
  const tgt = r.report?.stats.targets?.find((t) => t.type === 'heightmap');
  if (r.ok && tgt && (tgt.gouges ?? 0) === 0 && (tgt.maskViolations ?? 0) === 0) {
    // brute force: the texture stays inside the heart — everything cut must
    // be within the shape; sample the simulated stock on a coarse lattice
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const built = r.preview.built.find((b) => b.op.id === 'tex');
    const rings = built.r.previewRegions.flatMap((rg) => [rg.outer, ...rg.holes])
      .map((ring) => ring.map((q) => ({ x: q.x + r.preview.placement.x, y: q.y + r.preview.placement.y })));
    const inRings = (x, y) => {
      let inside = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
      }
      return inside;
    };
    // previewRegions are the guard-inset mask; the cut legitimately reaches
    // the TRUE shape edge (the guard annulus is sub-cut by design), so allow
    // guard (0.03) + sim stamp quantization beyond the preview rings
    let cut = 0, escapes = 0;
    const step = sim.dx * 3, tol = 0.06;
    for (let y = 0; y < r.preview.stock.h; y += step) {
      for (let x = 0; x < r.preview.stock.w; x += step) {
        if (surfaceAt(sim, x, y) < -0.005) {
          cut++;
          if (!inRings(x, y) && !inRings(x + tol, y) && !inRings(x - tol, y) && !inRings(x, y + tol) && !inRings(x, y - tol)) escapes++;
        }
      }
    }
    if (cut > 800 && escapes === 0) pass(`within "heart" verified: ${cut} cut samples, all inside the shape (+guard), 0 gouges`);
    else fail(`within containment: cut=${cut} escapes=${escapes}`);
  } else fail(`within heart failed: ok=${r.ok} gouges=${tgt?.gouges} maskViol=${tgt?.maskViolations} err=${r.errors?.join(' | ')}`);

  const unknownShape = run({ ...structuredClone(EMPTY_RECIPE), pipeline: [{ id: 'tex', strategy: 'texture_field', params: { within: 'ghost' } }] });
  if (!unknownShape.ok && unknownShape.errors.some((e) => /unknown shape/.test(e))) pass('unknown within shape named with the list: clean error');
  else fail(`unknown within shape not handled: ${JSON.stringify(unknownShape.errors)}`);
}

// ---------------- texture_text: the letters ARE the texture ----------------

console.log('--- texture_text: letters rendered as texture, face stays smooth ---');
{
  const base = () => ({ ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.6 } });
  const mk = (params) => ({ ...base(), pipeline: [{ id: 'word', strategy: 'texture_text', params: { text: 'OAK', letterHeight: 2.5, ...params } }] });

  const r = run(mk({ texture: 'waves' }));
  const tgt = r.report?.stats.targets?.find((t) => t.type === 'heightmap');
  if (r.ok && tgt && (tgt.gouges ?? 0) === 0 && (tgt.maskViolations ?? 0) === 0) {
    // brute force both directions: relief exists INSIDE the letter strokes,
    // nothing is cut outside them (even-odd over the true outlines, ball
    // feather tolerance), and the O's counter keeps its smooth face
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const built = r.preview.built.find((b) => b.op.id === 'word');
    const regions = built.r.previewRegions;
    const rings = regions.flatMap((rg) => [rg.outer, ...rg.holes])
      .map((ring) => ring.map((q) => ({ x: q.x + r.preview.placement.x, y: q.y + r.preview.placement.y })));
    const inRings = (x, y) => {
      let inside = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
      }
      return inside;
    };
    let cut = 0, escapes = 0;
    const step = sim.dx * 2, tol = 0.03;
    for (let y = 0; y < r.preview.stock.h; y += step) {
      for (let x = 0; x < r.preview.stock.w; x += step) {
        if (surfaceAt(sim, x, y) < -0.005) {
          cut++;
          if (!inRings(x, y) && !inRings(x + tol, y) && !inRings(x - tol, y) && !inRings(x, y + tol) && !inRings(x, y - tol)) escapes++;
        }
      }
    }
    // the counter of the O: centroid of the first hole ring must stay at the surface
    const holed = regions.find((rg) => rg.holes.length);
    let counterOk = true;
    if (holed) {
      const hr = holed.holes[0];
      const cx = hr.reduce((s, q) => s + q.x, 0) / hr.length + r.preview.placement.x;
      const cy = hr.reduce((s, q) => s + q.y, 0) / hr.length + r.preview.placement.y;
      counterOk = surfaceAt(sim, cx, cy) > -0.001;
    }
    if (cut > 400 && escapes === 0 && counterOk) pass(`texture_text verified: ${cut} cut samples all inside the strokes, counters smooth, 0 gouges/mask violations`);
    else fail(`texture_text containment: cut=${cut} escapes=${escapes} counterOk=${counterOk}`);
  } else fail(`texture_text failed: ok=${r.ok} gouges=${tgt?.gouges} maskViol=${tgt?.maskViolations} err=${r.errors?.join(' | ')}`);

  // origin "edge" = contour bands inside each letter — verifies and differs
  const contour = run(mk({ texture: 'ripples', origin: 'edge', featureSize: 0.2 }));
  const straight = run(mk({ texture: 'ripples', featureSize: 0.2 }));
  const sigOf = (x) => JSON.stringify(x.preview.built.find((b) => b.op.id === 'word').r.moves.slice(0, 80));
  if (contour.ok && straight.ok && sigOf(contour) !== sigOf(straight)) pass('origin "edge" verifies: pattern follows the letter outlines (motion differs)');
  else fail(`texture_text edge origin: ok=${contour.ok} distinct=${contour.ok && straight.ok ? sigOf(contour) !== sigOf(straight) : '-'}`);

  // honest failures
  const thin = run(mk({ text: 'lily', letterHeight: 0.5, toolDiameter: 0.125 }));
  if (!thin.ok && thin.errors.some((e) => /too thin/.test(e))) pass('strokes thinner than the ball: friendly error naming the fixes');
  else fail(`thin strokes not handled: ${JSON.stringify(thin.errors)}`);
  const badFam = run(mk({ texture: 'plaid' }));
  if (!badFam.ok && badFam.errors.some((e) => /unknown texture/.test(e))) pass('unknown family named with the list: clean error');
  else fail(`unknown family not handled: ${JSON.stringify(badFam.errors)}`);

  // built the way the model would: the pond-drop plaque through the intent
  // layer — bound text, a texture choice control, rings spreading from the
  // name — then woven and verified
  const res = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'pond-drop plaque', actions: [
    { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'Anna' } },
    { kind: 'add_control', control: { id: 'tex', type: 'choice', label: 'Texture', default: 'ripples', options: [{ value: 'ripples', label: 'Ripples' }, { value: 'waves', label: 'Waves' }] } },
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 1 } } },
    { kind: 'add_operation', operation: { id: 'field', strategy: 'texture_field', params: { texture: { ctrl: 'tex' }, origin: 'content', fade: 0.2 } } },
    { kind: 'add_operation', operation: { id: 'word', strategy: 'texture_text', params: { text: { ctrl: 'name' }, letterHeight: 2.5, posY: -4 } } },
  ], declined: [] });
  if (res.applied.length === 5 && !res.skipped.length) {
    const woven = run(res.recipe);
    if (woven.ok && woven.report.stats.targets.filter((t) => t.type === 'heightmap').length === 2) {
      pass('intent layer: pond-drop plaque + textured word apply, weave, and verify (2 heightmap targets)');
    } else fail(`intent recipe did not weave: ok=${woven.ok} err=${woven.errors?.join(' | ')}`);
  } else fail(`intent apply wrong: applied=${res.applied.length} skipped=${JSON.stringify(res.skipped)}`);
}

// ---------------- terrain_relief: real-world relief + the proud plaque ----------------

console.log('--- terrain_relief: canyon relief with an embedded plaque ---');
{
  const base = () => ({ ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.75 }, terrains: [{ id: 'gc', query: 'Grand Canyon' }] });
  // the full job from the prompt: name + coordinates v-carved with ZERO
  // coordinates (default position + place:"below"), the terrain rectangle
  // positioning itself so their pad sits in the lower-left, cutout last
  const plaque = () => ({ ...base(), pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: 'Grand Canyon', letterHeight: 0.35 } },
    { id: 'coords', strategy: 'vcarve_text', params: { text: '36.06N 112.14W', letterHeight: 0.25, place: 'below', gap: 0.15 } },
    { id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc', width: 10, depth: 0.35, plaque: 'sw' } },
    { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } },
  ] });

  const r = run(plaque());
  const tgt = r.report?.stats.targets?.find((t) => t.type === 'heightmap');
  if (r.ok && tgt && (tgt.gouges ?? 0) === 0 && (tgt.maskViolations ?? 0) === 0) {
    // brute force the composition: the pad is an uncut plateau at stock top
    // with the letters carved INTO it, and the terrain around it actually
    // carves deep
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const px = r.preview.placement.x, py = r.preview.placement.y;
    // content bbox from the two text ops' preview outlines
    let cb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const id of ['name', 'coords']) {
      for (const rg of r.preview.built.find((b) => b.op.id === id).r.previewRegions) {
        for (const q of rg.outer) {
          cb = { minX: Math.min(cb.minX, q.x), minY: Math.min(cb.minY, q.y), maxX: Math.max(cb.maxX, q.x), maxY: Math.max(cb.maxY, q.y) };
        }
      }
    }
    // plateau: sample the pad ring area (between content and pad edge, on all
    // four sides) — must sit at stock top
    let plateauBad = 0;
    const padPts = [];
    for (let x = cb.minX; x <= cb.maxX; x += 0.4) padPts.push([x, cb.maxY + 0.15], [x, cb.minY - 0.15]);
    for (let y = cb.minY; y <= cb.maxY; y += 0.4) padPts.push([cb.minX - 0.15, y], [cb.maxX + 0.15, y]);
    for (const [x, y] of padPts) if (surfaceAt(sim, x + px, y + py) < -0.002) plateauBad++;
    // letters: carved into the plateau
    const letterZ = surfaceAt(sim, (cb.minX + cb.maxX) / 2 + px, -2.0 + py - 0.02);
    // terrain: the canyon carves deep somewhere well away from the pad
    let deepCells = 0;
    for (let y = 0.5; y < r.preview.stock.h - 0.5; y += 0.1) {
      for (let x = r.preview.stock.w / 2; x < r.preview.stock.w - 0.5; x += 0.1) {
        if (surfaceAt(sim, x, y) < -0.25) deepCells++;
      }
    }
    // the semantic corner: the pad ring must hug the rectangle's SW corner
    // (within the fixed edge inset + guard + a little slack)
    const relief = r.preview.built.find((b2) => b2.op.id === 'land').r;
    const rects = relief.previewRegions[0];
    const bb = (ring) => ring.reduce((a, q) => ({ minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y) }), { minX: Infinity, minY: Infinity });
    const rectBB = bb(rects.outer), padBB = bb(rects.holes[0]);
    const swOk = padBB.minX - rectBB.minX < 0.5 && padBB.minY - rectBB.minY < 0.5;
    if (plateauBad === 0 && deepCells > 100 && swOk) {
      pass(`plaque composition verified, zero coordinates: pad hugs the SW corner (${(padBB.minX - rectBB.minX).toFixed(2)}"/${(padBB.minY - rectBB.minY).toFixed(2)}" in), plateau uncut at ${padPts.length} probes, canyon < -0.25" in ${deepCells} probes (letters at ${letterZ.toFixed(3)}")`);
    } else fail(`composition geometry off: plateauBad=${plateauBad} deepCells=${deepCells} swOk=${swOk}`);
  } else fail(`plaque composition failed: ok=${r.ok} gouges=${tgt?.gouges} maskViol=${tgt?.maskViolations} err=${r.errors?.join(' | ')}`);

  // terrain standing alone: whole rectangle, no pad
  const alone = run({ ...base(), pipeline: [{ id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc', width: 8, depth: 0.3 } }] });
  const aloneBuilt = alone.preview?.built?.find((b) => b.op.id === 'land');
  if (alone.ok && aloneBuilt.r.previewRegions[0].holes.length === 0) pass('terrain alone verifies: full rectangle, no pad');
  else fail(`terrain alone: ok=${alone.ok} err=${alone.errors?.join(' | ')}`);

  // honest failures
  const unknown = run({ ...base(), pipeline: [{ id: 'land', strategy: 'terrain_relief', params: { terrain: 'mars' } }] });
  if (!unknown.ok && unknown.errors.some((e) => /unknown terrain "mars".*gc/.test(e))) pass('unknown terrain id names the defined ones: clean error');
  else fail(`unknown terrain not handled: ${JSON.stringify(unknown.errors)}`);

  const unfetched = run({ ...base(), pipeline: [{ id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc' } }] }, undefined, {});
  if (!unfetched.ok && unfetched.errors.some((e) => /not fetched yet/.test(e))) pass('declared-but-unfetched terrain: honest "not fetched yet" state');
  else fail(`unfetched terrain not handled: ${JSON.stringify(unfetched.errors)}`);

  // the rectangle places itself around the content, so the only unfittable
  // case left is text genuinely bigger than the terrain
  const poking = run({ ...base(), pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: 'Grand Canyon', letterHeight: 1.4 } },
    { id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc', width: 6, plaque: 'sw' } },
  ] });
  if (!poking.ok && poking.errors.some((e) => /does not fit/.test(e))) pass('pad bigger than the terrain: clean error with the fix');
  else fail(`oversized pad not handled: ${JSON.stringify(poking.errors)}`);
  const badSpot = run({ ...base(), pipeline: [
    { id: 'name', strategy: 'vcarve_text', params: { text: 'Hi', letterHeight: 0.5 } },
    { id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc', plaque: 'left' } },
  ] });
  if (!badSpot.ok && badSpot.errors.some((e) => /unknown plaque spot/.test(e))) pass('unknown plaque spot named with the choices: clean error');
  else fail(`bad plaque spot not handled: ${JSON.stringify(badSpot.errors)}`);

  const tooDeep = run({ ...base(), pipeline: [{ id: 'land', strategy: 'terrain_relief', params: { terrain: 'gc', depth: 0.8 } }] });
  if (!tooDeep.ok && tooDeep.errors.some((e) => /not less than/.test(e))) pass('relief deeper than stock: clean error');
  else fail(`too-deep not handled: ${JSON.stringify(tooDeep.errors)}`);

  // through the intent layer: the model authors the reference, never the data
  const res = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'grand canyon plaque', actions: [
    { kind: 'set_terrain', terrain: { id: 'land', query: 'Grand Canyon' } },
    { kind: 'add_operation', operation: { id: 'name', strategy: 'vcarve_text', params: { text: 'Grand Canyon', letterHeight: 0.35 } } },
    { kind: 'add_operation', operation: { id: 'relief', strategy: 'terrain_relief', params: { terrain: 'land', width: 10, depth: 0.35, plaque: 'sw' } } },
    { kind: 'add_operation', operation: { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } } },
  ], declined: [] });
  if (res.applied.length === 4 && !res.skipped.length) {
    const woven = run({ ...res.recipe, stock: { thickness: 0.75 } }, undefined, { land: TERRAIN_FIXTURE.gc });
    if (woven.ok) pass('intent layer: set_terrain + relief + cutout apply and verify');
    else fail(`intent terrain recipe did not weave: ${woven.errors?.join(' | ')}`);
  } else fail(`intent terrain apply wrong: applied=${res.applied.length} skipped=${JSON.stringify(res.skipped)}`);

  const badRef = applyActions(structuredClone(EMPTY_RECIPE), { summary: 'x', actions: [
    { kind: 'set_terrain', terrain: { id: 'land' } },
  ], declined: [] });
  if (badRef.skipped.length === 1 && /query or a full/.test(badRef.skipped[0])) pass('set_terrain without query or box: skipped with reason');
  else fail(`bad set_terrain not skipped: ${JSON.stringify(badRef.skipped)}`);

  const blocked = applyActions(migrateRecipe({ ...structuredClone(EMPTY_RECIPE), terrains: [{ id: 'land', query: 'x' }], pipeline: [{ id: 'relief', strategy: 'terrain_relief', params: { terrain: 'land' } }] }), { summary: 'x', actions: [
    { kind: 'remove_terrain', id: 'land' },
  ], declined: [] });
  if (blocked.skipped.length === 1 && /still referenced/.test(blocked.skipped[0])) pass('remove_terrain refused while an op references it');
  else fail(`remove_terrain not blocked: ${JSON.stringify(blocked.skipped)}`);
}

// ---------------- shop limits ----------------
// The user's declared machine cutting area / material sheets (app-level
// settings, runRecipe's 5th argument) must surface as honest warnings
// when the finished board cannot fit them — and must change NOTHING
// when unset.

console.log('--- shop limits: declared machine & material ground the weave ---');
{
  const rec = structuredClone(EMPTY_RECIPE);
  rec.stock.thickness = 0.5;
  rec.pipeline.push({ id: 'name', strategy: 'vcarve_text', params: { text: 'WORKSHOP', letterHeight: 2 } });
  rec.pipeline.push({ id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.5 } });

  const free = quiet(() => runRecipe(rec, {}, FONT_SHELF, {}, {}));
  if (free.ok && !free.warnings.some((w) => /cutting area|material sheets/.test(w))) {
    pass(`no shop declared: no shop warnings (board ${free.preview.stock.w}" × ${free.preview.stock.h}")`);
  } else fail(`unset shop changed the weave: ok=${free.ok} warnings=${JSON.stringify(free.warnings)}`);

  const small = quiet(() => runRecipe(rec, {}, FONT_SHELF, {}, { machineW: 4, machineH: 4, materialW: 5, materialH: 5 }));
  if (small.ok === free.ok && small.warnings.some((w) => w.includes(`machine's cutting area is 4" × 4"`))) {
    pass('board bigger than the machine: warned, not blocked (the declaration is a fact, not a gate)');
  } else fail(`machine warning wrong: ok=${small.ok} warnings=${JSON.stringify(small.warnings)}`);
  if (small.warnings.some((w) => w.includes('5" × 5" material sheets'))) pass('board bigger than the declared sheets: warned');
  else fail(`material warning missing: ${JSON.stringify(small.warnings)}`);

  const fits = quiet(() => runRecipe(rec, {}, FONT_SHELF, {}, { machineW: 96, machineH: 48 }));
  if (fits.ok && !fits.warnings.some((w) => /cutting area/.test(w))) pass('board inside the machine: silent (either board orientation counts)');
  else fail(`fitting board still warned: ${JSON.stringify(fits.warnings)}`);

  // the grounding prompt carries the shop facts only when declared
  const sysWith = buildParseRequest(rec, 'x', { shop: { machineW: 18, machineH: 24 } }).system;
  const sysWithout = buildParseRequest(rec, 'x').system;
  if (sysWith.includes(`cutting area is 18" × 24"`) && !sysWithout.includes('cutting area')) {
    pass('shop limits in the grounding prompt only when declared');
  } else fail('shop grounding wrong');
}

// ---------------- blank text & unknown params: the photo-frame story ----------------
// Field report (funnel q_41883969 → q_b185f68f): a photo-frame app's
// caption, bound to a text control, took the WHOLE build down when the
// field was cleared — and the model invented an "enabled" param trying
// to make it optional. Blank text on any text op is now a skip-with-
// warning (the rest of the pipeline still builds); params a strategy
// doesn't declare warn instead of vanishing.

console.log('--- blank text skips, the rest still builds; unknown params warn ---');
{
  const rec = structuredClone(EMPTY_RECIPE);
  rec.stock.thickness = 0.75;
  rec.controls.push({ id: 'caption', type: 'text', label: 'Caption', default: 'Our Memory' });
  rec.pipeline.push({ id: 'caption_engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'caption' }, letterHeight: 0.4, maxDepth: 0.06, place: 'below' } });
  rec.pipeline.push({ id: 'opening', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 4, height: 6, depth: 0.5, toolDiameter: 0.25 } });
  rec.pipeline.push({ id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.75 } });

  const typed = run(rec);
  if (typed.ok && typed.preview.built.some((b) => b.op.id === 'caption_engrave')) {
    pass('caption typed: full frame builds, caption included');
  } else fail(`typed caption broke: ok=${typed.ok} errors=${JSON.stringify(typed.errors)}`);

  const blank = run(rec, { caption: '   ' });
  if (blank.ok
    && !blank.preview.built.some((b) => b.op.id === 'caption_engrave')
    && blank.preview.built.some((b) => b.op.id === 'opening')
    && blank.preview.built.some((b) => b.op.id === 'cutout')
    && blank.warnings.some((w) => w.includes('caption_engrave') && w.includes('blank'))) {
    pass('caption cleared: engraving skipped with a warning, opening + cutout still cut');
  } else fail(`blank caption: ok=${blank.ok} errors=${JSON.stringify(blank.errors)} warnings=${JSON.stringify(blank.warnings)}`);

  // every text entry skips the same way — and an all-skipped recipe still
  // explains itself instead of a bare "nothing to machine"
  for (const strategy of ['vcarve_text', 'outline_text', 'pocket_text', 'texture_text']) {
    const solo = structuredClone(EMPTY_RECIPE);
    solo.stock.thickness = 0.5;
    solo.pipeline.push({ id: 'words', strategy, params: { text: '' } });
    const r = run(solo);
    if (!r.ok && r.warnings.some((w) => w.includes('blank'))) pass(`${strategy}: blank text skips (warning survives the empty build)`);
    else fail(`${strategy} blank text: ok=${r.ok} warnings=${JSON.stringify(r.warnings)} errors=${JSON.stringify(r.errors)}`);
  }

  // the phantom param: reaches the runtime (a hand-edited or version-
  // drifted recipe), gets NAMED in a warning, changes nothing
  const phantom = structuredClone(rec);
  phantom.pipeline[0].params.enabled = 'yes';
  const ph = run(phantom);
  if (ph.ok && ph.warnings.some((w) => w.includes('caption_engrave') && w.includes('"enabled"') && w.includes('ignored'))) {
    pass('undeclared param: named in a warning, build unchanged');
  } else fail(`phantom param: ok=${ph.ok} warnings=${JSON.stringify(ph.warnings)}`);

  // the intent layer still refuses it outright at authoring time (the
  // validator test covers the mechanism; this pins the exact session)
  const res = applyActions(rec, {
    summary: 'make the caption optional',
    actions: [{ kind: 'set_operation', operation: { id: 'caption_engrave', params: { enabled: { ctrl: 'showCaption' } } } }],
    declined: [],
  });
  if (res.skipped.length === 1 && res.skipped[0].includes('unknown param "enabled"')) {
    pass('set_operation with an invented param: skipped with the reason');
  } else fail(`set_operation leak: applied=${JSON.stringify(res.applied)} skipped=${JSON.stringify(res.skipped)}`);
}

// ---------------- 33. drawn shapes: the "hand-drawn outline" decline, converted ----------------
// Until 2026-07-21 a tablet-drawn nametag outline was declined ("a shape
// must be an SVG path I author, a built-in glyph, or an uploaded asset")
// even though the draw modality shipped. set_shape draw is the fill: the
// model authors the WHOLE app before any drawing exists, ops that need
// the outline SKIP with an honest note, and drawing lights them up.

console.log('--- drawn shape: authored before it is drawn, completed by drawing ---');
{
  const rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, {
    summary: 'Nametag app with a drawn outline.',
    actions: [
      { kind: 'set_name', name: 'Nametags' },
      { kind: 'add_control', control: { id: 'name', type: 'text', label: 'Name', default: 'Brian' } },
      { kind: 'set_shape', shape: { id: 'tag', draw: { of: 'outline', width: 4 } } },
      { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 0.6 } } },
      { kind: 'add_operation', operation: { id: 'cutout', strategy: 'shape_cutout', params: { shape: 'tag' } } },
    ],
    declined: [],
  });
  if (res.skipped.length === 0 && res.recipe.shapes.length === 1) {
    pass('set_shape draw applies with NO artwork behind it (nothing skipped)');
  } else fail(`draw shape rejected at authoring: ${JSON.stringify(res.skipped)}`);

  // undrawn: the recipe still builds, minus exactly the op that needs it
  const before = run(res.recipe);
  const cutBefore = before.job?.operations?.some((o) => o.name.includes('cutout'));
  if (before.ok && !cutBefore && before.warnings.some((w) => w.includes('waiting on the drawing') && w.includes('outline'))) {
    pass('undrawn: engraving verifies, the cutout skips with a named warning');
  } else fail(`undrawn build wrong: ok=${before.ok} cutout=${cutBefore} warnings=${JSON.stringify(before.warnings)}`);

  // the user draws it — a plain SVG asset under the name the shape asked for
  const drawn = structuredClone(res.recipe);
  drawn.assets.push({
    id: 'outline', name: 'outline', kind: 'svg',
    data: '<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="2in" viewBox="0 0 4 2"><path d="M 0 0 L 4 0 L 4 2 L 0 2 Z" fill="#000"/></svg>',
  });
  const after = run(drawn);
  const cutAfter = after.job?.operations?.some((o) => o.name.includes('cutout'));
  if (after.ok && cutAfter && !after.warnings.some((w) => w.includes('waiting on the drawing'))) {
    pass('drawn: the same recipe now cuts the outline, warning gone');
  } else fail(`drawn build wrong: ok=${after.ok} cutout=${cutAfter} warnings=${JSON.stringify(after.warnings)}`);

  // a derivation over an undrawn shape waits too, instead of erroring
  const derived = structuredClone(res.recipe);
  derived.shapes.push({ id: 'ring', outset: { of: 'tag', by: 0.25 } });
  derived.pipeline.push({ id: 'ringcut', strategy: 'shape_cutout', params: { shape: 'ring' } });
  const dr = run(derived);
  if (dr.ok && dr.warnings.some((w) => w.includes('ringcut') && w.includes('waiting on the drawing'))) {
    pass('a derivation over an undrawn shape waits instead of failing the weave');
  } else fail(`derived-undrawn wrong: ok=${dr.ok} errors=${JSON.stringify(dr.errors)} warnings=${JSON.stringify(dr.warnings)}`);

  // a FIT over an undrawn shape — the draw-a-nametag recipe (tag self-sizes
  // around the drawing): fit shapes defer to first op reference, so the
  // undrawn state only surfaces at resolve time. Field report 2026-07-26:
  // this came back REJECTED ("open curve") instead of skipping, so the app
  // never showed the draw-me state.
  const fitRec = structuredClone(EMPTY_RECIPE);
  fitRec.controls = [{ id: 'name', type: 'text', label: 'Name', default: 'Alex' }];
  fitRec.shapes = [
    { id: 'profile', draw: { of: 'profile', width: '3.5' } },
    { id: 'tagfit', fit: { of: 'profile', margin: 0.3 } },
  ];
  fitRec.pipeline = [
    { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' } } },
    { id: 'cutout', strategy: 'shape_cutout', params: { shape: 'tagfit' } },
  ];
  const fr = run(fitRec);
  if (fr.ok && fr.warnings.some((w) => w.includes('cutout') && w.includes('waiting on the drawing "profile"'))) {
    pass('fit over an undrawn shape: engraving verifies, the cutout waits for the drawing');
  } else fail(`fit-undrawn wrong: ok=${fr.ok} errors=${JSON.stringify(fr.errors)} warnings=${JSON.stringify(fr.warnings)}`);

  // and the prompt teaches it rather than declining it
  const sys = buildParseRequest(rec, 'nametag outlines drawn by hand on a tablet').system;
  if (sys.includes('DRAWN SHAPES') && sys.includes('draw {of:') && sys.includes('is NOT a decline')) {
    pass('prompt teaches set_shape draw for hand-drawn outlines');
  } else fail('prompt still lacks the drawn-shape rule');
  if (sys.includes('Current board') && sys.includes('Add to board')) {
    pass('prompt answers sheet nesting/run-tracking with the board tracker instead of declining');
  } else fail('prompt still lacks the current-board rule');
}

// ---------------- the tool rack: real &Tool numbers + chipload feeds ----------------
// shop.toolLibrary is the shared shopbot:tools drawer. Matched specs must
// post the user's REAL tool numbers; a declared material must derive feeds
// by chipload; anything the rack lacks must fall back honestly — a spare
// number that collides with NO rack slot, plus a warning naming the bit.
console.log('--- tool rack: real numbers, chipload feeds, honest fallbacks ---');
{
  const rec = structuredClone(EMPTY_RECIPE);
  rec.name = 'Rack test';
  // chamfered disc = a two-tool job: 90° V-bit rim pass, then the 1/4" cut
  rec.pipeline = [{ id: 'disc', strategy: 'disc_cutout', params: { diameter: 3, chamfer: 0.1 } }];
  const runShop = (shop) => quiet(() => runRecipe(rec, controlDefaults(rec), FONT_SHELF, {}, shop));

  // no rack: first-use numbering, exactly as before
  const bare = runShop({});
  const bareNums = bare.job.operations.map((o) => o.tool);
  if (bare.ok && bareNums.join(',') === '1,2') pass('no rack: first-use numbering 1,2 unchanged');
  else fail(`no-rack numbering wrong: ok=${bare.ok} tools=${bareNums}`);

  const LIB = {
    version: 1,
    machine: { minRPM: 6000, maxRPM: 24000, maxFeed: 360 },
    tools: [
      { number: 5, kind: 'flat', diameter: 0.25, flutes: 2 },
      { number: 9, kind: 'vee', diameter: 0.5, angleDeg: 90, flutes: 2 },
    ],
  };

  // full rack: both specs post their REAL numbers, feeds untouched
  const racked = runShop({ toolLibrary: LIB });
  const nums = racked.job.operations.map((o) => o.tool);
  if (racked.ok && nums.join(',') === '9,5') pass(`rack match posts real &Tool numbers: ${nums.join(', ')}`);
  else fail(`rack numbering wrong: ok=${racked.ok} tools=${nums} warnings=${JSON.stringify(racked.warnings)}`);
  if (racked.job.operations[1].feedRate === 80 && racked.job.tools[5].rpm === undefined) {
    pass('without a material, strategy feeds and job rpm stay untouched');
  } else fail(`feeds changed without a material: feed=${racked.job.operations[1].feedRate} rpm=${racked.job.tools[5].rpm}`);

  // material declared: chipload feeds + per-tool rpm, measured against the engine
  const fed = runShop({ toolLibrary: LIB, material: 'plywood' });
  const want = recommendFeeds(LIB.tools[0], 'plywood', LIB.machine);
  const cut = fed.job.operations[1];
  if (fed.ok && cut.feedRate === want.feedRate && cut.plungeRate === want.plungeRate && fed.job.tools[5].rpm === want.rpm) {
    pass(`plywood chipload feeds applied: ${want.feedRate} in/min @ ${want.rpm} rpm (plunge ${want.plungeRate})`);
  } else fail(`chipload feeds wrong: feed=${cut.feedRate}/${want.feedRate} plunge=${cut.plungeRate}/${want.plungeRate} rpm=${fed.job.tools[5].rpm}/${want.rpm}`);

  // a bit the rack lacks: spare number dodging every rack slot + a warning
  const veeOnly = { ...LIB, tools: [LIB.tools[1]] };
  const missing = runShop({ toolLibrary: veeOnly });
  const cutOp = missing.job.operations[1];
  if (missing.ok && cutOp.tool === 1 && missing.warnings.some((w) => w.includes('endmill') && w.includes('tool rack'))) {
    pass('missing bit posts a spare number and warns by name');
  } else fail(`missing-bit fallback wrong: tool=${cutOp.tool} warnings=${JSON.stringify(missing.warnings)}`);

  // available:false = in the drawer, not on the machine — must not be assigned,
  // and its NUMBER stays reserved (that slot still means that bit)
  const benched = { ...LIB, tools: [LIB.tools[0], { ...LIB.tools[1], available: false }] };
  const bench = runShop({ toolLibrary: benched });
  const veeNum = bench.job.operations[0].tool;
  if (bench.ok && veeNum !== 9 && veeNum !== 5 && bench.warnings.some((w) => w.includes('V-bit'))) {
    pass(`benched bit is not assigned and keeps its slot number (vee posted as ${veeNum})`);
  } else fail(`benched-bit handling wrong: vee=${veeNum} warnings=${JSON.stringify(bench.warnings)}`);
}

// ---------------- pattern shapes: one cell → grid / ring ----------------
// The synthetic-decline probe's biggest find: repeated layouts (chess
// boards, honeycombs, hour marks) died three different ways because the
// model hand-authored every cell. pattern is the primitive that ends that.

console.log('--- pattern shapes: checkerboard from one authored cell ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, { summary: 'chess', actions: [
    { kind: 'add_control', control: { id: 'sq', type: 'number', label: 'Square (in)', default: 1, min: 0.5, max: 3, step: 0.25 } },
    { kind: 'set_shape', shape: { id: 'cell', path: 'M {-sq/2} {-sq/2} L {sq/2} {-sq/2} L {sq/2} {sq/2} L {-sq/2} {sq/2} Z' } },
    { kind: 'set_shape', shape: { id: 'darks', pattern: { of: 'cell', cols: '4', rows: '8', dx: '2*sq', dy: 'sq', staggerX: 'sq' } } },
    { kind: 'add_operation', operation: { id: 'squares', strategy: 'pocket_shape', params: { shape: 'darks', depth: 0.0625 } } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'tag_cutout', params: { buffer: 0.5 } } },
  ], declined: [] });
  const bv = buildVars(res.recipe, controlDefaults(res.recipe));
  const bs = buildShapes(res.recipe, bv.vars);
  const n = bs.shapes?.darks?.regions?.length ?? 0;
  if (res.skipped.length === 0 && n === 32) pass(`one 1" cell → 32 disjoint dark squares (4×8 grid, staggered)`);
  else fail(`checkerboard wrong: skipped=${JSON.stringify(res.skipped)} regions=${n}`);
  const r = run(res.recipe);
  if (r.ok && r.sbp) pass('checkerboard pockets weave and verify → SBP');
  else fail(`checkerboard weave: ok=${r.ok} errors=${JSON.stringify(r.errors)}`);
  // the slider still drives the whole board: bigger squares, same 32 cells
  const big = quiet(() => runRecipe(res.recipe, { ...controlDefaults(res.recipe), sq: 1.5 }, FONT_SHELF, TERRAIN_FIXTURE));
  if (big.ok) pass('square-size control re-lowers the whole pattern');
  else fail(`pattern under slider move: ${JSON.stringify(big.errors)}`);
}

console.log('--- pattern shapes: ring with spin, curves, and honest failures ---');
{
  // 12 hour ticks: authored ONE tick standing at the origin, patterned
  // around a 4" circle; spin turns each to face outward
  let rec = structuredClone(EMPTY_RECIPE);
  rec.shapes = [
    { id: 'tick', path: 'M -0.1 -0.3 L 0.1 -0.3 L 0.1 0.3 L -0.1 0.3 Z' },
    { id: 'ring12', pattern: { of: 'tick', count: '12', radius: '4', spin: true } },
  ];
  const bs = buildShapes(rec, {});
  const regions = bs.shapes?.ring12?.regions ?? [];
  const centroid = (rg) => {
    const pts = rg.outer;
    const s = pts.reduce((acc, q) => ({ x: acc.x + q.x, y: acc.y + q.y }), { x: 0, y: 0 });
    return { x: s.x / pts.length, y: s.y / pts.length };
  };
  const radii = regions.map(rg => Math.hypot(centroid(rg).x, centroid(rg).y));
  const allAtRadius = radii.length === 12 && radii.every(rr => Math.abs(rr - 4) < 0.02);
  const top = regions.find(rg => { const c = centroid(rg); return Math.abs(c.x) < 0.02 && c.y > 3.9; });
  const left = regions.find(rg => { const c = centroid(rg); return c.x < -3.9 && Math.abs(c.y) < 0.02; });
  const spanOf = (rg) => {
    const xs = rg.outer.map(q => q.x), ys = rg.outer.map(q => q.y);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const topSpan = top && spanOf(top), leftSpan = left && spanOf(left);
  if (allAtRadius && topSpan && Math.abs(topSpan.h - 0.6) < 0.01 && leftSpan && Math.abs(leftSpan.w - 0.6) < 0.01) {
    pass('ring of 12: all at radius 4, first copy at the top upright, the 180° copy spun to face outward');
  } else fail(`ring wrong: n=${regions.length} radii=${radii.map(r => r.toFixed(2)).join(',')} top=${JSON.stringify(topSpan)} left=${JSON.stringify(leftSpan)}`);

  // an OPEN curve patterns too: three rows of the same hole-line for bore_hole along
  rec.shapes = [
    { id: 'row', path: 'M -2 0 L 2 0', open: true },
    { id: 'rows3', pattern: { of: 'row', rows: '3', dy: '0.75' } },
  ];
  const bc = buildShapes(rec, {});
  if (bc.shapes?.rows3?.kind === 'curve' && bc.shapes.rows3.polylines.length === 3) {
    pass('patterning an open curve concatenates copies (hole rows for bore_hole along)');
  } else fail(`curve pattern wrong: ${JSON.stringify(bc.shapes?.rows3?.kind)} n=${bc.shapes?.rows3?.polylines?.length}`);

  // honest failures, caught at APPLY time with reasons
  let r2 = structuredClone(EMPTY_RECIPE);
  const bad = applyActions(r2, { summary: 'bad patterns', actions: [
    { kind: 'set_shape', shape: { id: 'a', pattern: { of: 'ghost', cols: '2', dx: '1' } } },
    { kind: 'set_shape', shape: { id: 'c1', path: 'M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z' } },
    { kind: 'set_shape', shape: { id: 'b', pattern: { of: 'c1', cols: '40', rows: '40', dx: '1', dy: '1' } } },
    { kind: 'set_shape', shape: { id: 'c', pattern: { of: 'c1', cols: '3' } } },
  ], declined: [] });
  if (bad.skipped.length === 3
      && bad.skipped[0].includes('not defined ABOVE') && bad.skipped[1].includes('too many')
      && bad.skipped[2].includes('needs dx')) {
    pass('pattern sabotage: missing base, 1600 copies, and missing spacing all skip with reasons');
  } else fail(`pattern sabotage wrong: ${JSON.stringify(bad.skipped)}`);
}

// ---------------- applyActions robustness: rescue the nearly-right ----------------
// Field forms from the probe: the control emitted AFTER the shape that
// binds it, a derived chain listed backwards, set_derived flattened to
// {kind, id, expr}. All salvageable without guessing intent.

console.log('--- applyActions: ordering rescue and flattened set_derived ---');
{
  let rec = structuredClone(EMPTY_RECIPE);
  const res = applyActions(rec, { summary: 'scrambled', actions: [
    // references control "d" — emitted BEFORE the control (probe: record-clock-svg)
    { kind: 'set_shape', shape: { id: 'disc', path: 'M {-d/2} 0 A {d/2} {d/2} 0 1 1 {d/2} 0 A {d/2} {d/2} 0 1 1 {-d/2} 0 Z' } },
    // flattened set_derived (probe: speaker-baffle, 3× in one response)
    { kind: 'set_derived', id: 'quarter', expr: 'd/4' },
    // chain listed backwards: mid needs r8, which comes next
    { kind: 'set_derived', derived: { id: 'mid', expr: 'r8 + 1' } },
    { kind: 'set_derived', derived: { id: 'r8', expr: 'd/8' } },
    { kind: 'add_control', control: { id: 'd', type: 'number', label: 'Diameter', default: 4, min: 1, max: 12, step: 0.5 } },
    // a GENUINE mistake must still be reported, once, after the retries
    { kind: 'set_shape', shape: { id: 'bad', path: 'M {nope} 0 L 1 1 Z' } },
  ], declined: [] });
  const ids = (res.recipe.derived ?? []).map(x => x.id);
  if (res.applied.length === 5 && res.skipped.length === 1 && res.skipped[0].includes('unknown name "nope"')
      && (res.recipe.shapes ?? []).some(s => s.id === 'disc') && ids.includes('quarter') && ids.includes('mid') && ids.includes('r8')) {
    pass('control hoisted, backwards chain retried, flattened set_derived accepted; the real mistake reported once');
  } else fail(`rescue wrong: applied=${JSON.stringify(res.applied)} skipped=${JSON.stringify(res.skipped)} derived=${JSON.stringify(ids)}`);
  const w = run(res.recipe);   // no ops yet — just confirm the recipe state is coherent
  if (!w.ok && w.errors[0].includes('no operations')) pass('rescued recipe is coherent (weave reports only the empty pipeline)');
  else fail(`rescued recipe weave: ${JSON.stringify(w.errors)}`);
}

console.log('--- truncation guard: the parse request budget and the prompt teach patterns ---');
{
  const req = buildParseRequest(EMPTY_RECIPE, 'a chess board');
  if (req.max_tokens >= 8000) pass(`max_tokens ${req.max_tokens} — geometry-heavy builds no longer truncate at 2000`);
  else fail(`max_tokens still ${req.max_tokens}`);
  if (req.system.includes('REPEATED layout') && req.system.includes('pattern {of:"cell"') && req.system.includes('staggerX')) {
    pass('prompt teaches one-cell-plus-pattern instead of cell-by-cell authoring');
  } else fail('prompt lacks the pattern rule');
}

// ---------------- positioned pockets: the jack-o-lantern story ----------------
// The probe's top failure class: the model kept inventing posX/posY on
// pocket_shape (12 hits) and the whole op was skipped as an unknown
// param. Now they're real: absolute centers for multi-pocket faces.

console.log('--- positioned pockets (posX/posY): multi-pocket face ---');
{
  // the action path is where the failure lived — posX must survive validation
  const res = quiet(() => applyActions(structuredClone(EMPTY_RECIPE), {
    summary: '', declined: [], actions: [
      { kind: 'add_operation', operation: { id: 'eyeL', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 1, depth: 0.25, posX: -1, posY: 0.75 } } },
    ],
  }));
  if (res.applied.length === 1 && !res.skipped.length) pass('posX/posY accepted by the action validator (was: op skipped as unknown param)');
  else fail(`posX still rejected: applied=${JSON.stringify(res.applied)} skipped=${JSON.stringify(res.skipped)}`);

  // eyes at absolute centers, mouth with only posY (X defaults to content center)
  const face = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Jack-o-lantern face',
    pipeline: [
      { id: 'eyeL', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 1, depth: 0.25, posX: -1, posY: 0.75 } },
      { id: 'eyeR', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 1, depth: 0.25, posX: 1, posY: 0.75 } },
      { id: 'mouth', strategy: 'pocket_shape', params: { shape: 'rectangle', width: 2.5, height: 0.6, cornerRadius: 0.2, depth: 0.25, posY: -1 } },
      { id: 'cut', strategy: 'tag_cutout', params: { buffer: 0.5 } },
    ],
  };
  const r = run(face);
  if (r.ok && r.sbp) {
    const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
    const p = r.preview.placement;
    const eyeL = surfaceAt(sim, -1 + p.x, 0.75 + p.y);
    const eyeR = surfaceAt(sim, 1 + p.x, 0.75 + p.y);
    const mouth = surfaceAt(sim, p.x, -1 + p.y);
    const brow = surfaceAt(sim, p.x, 0.75 + p.y);   // between the eyes: untouched
    if (Math.abs(eyeL + 0.25) < 0.005 && Math.abs(eyeR + 0.25) < 0.005 && Math.abs(mouth + 0.25) < 0.005 && brow === 0) {
      pass(`face measured: eyes ${eyeL.toFixed(3)}/${eyeR.toFixed(3)} at ±1, mouth ${mouth.toFixed(3)} at -1, brow untouched`);
    } else fail(`pockets landed wrong: eyeL=${eyeL} eyeR=${eyeR} mouth=${mouth} brow=${brow}`);
  } else fail(`positioned face rejected: ${r.errors?.join(' | ')}`);

  // {arithmetic} positions ride the controls (template params)
  const spaced = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Spaced wells',
    controls: [{ id: 'sp', type: 'number', label: 'Spacing', default: 1.5, min: 1, max: 3, step: 0.25 }],
    pipeline: [
      { id: 'wellL', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 1, depth: 0.2, posX: '{-sp}' } },
      { id: 'wellR', strategy: 'pocket_shape', params: { shape: 'circle', diameter: 1, depth: 0.2, posX: '{sp}' } },
    ],
  };
  const s2 = run(spaced, { sp: 2 });
  if (s2.ok) {
    const sim = simulateJob(s2.preview.built, s2.preview.placement, s2.preview.stock);
    const p = s2.preview.placement;
    const at2 = surfaceAt(sim, 2 + p.x, p.y);
    const mid = surfaceAt(sim, 1 + p.x, p.y);   // between the wells: clear at sp=2
    if (Math.abs(at2 + 0.2) < 0.005 && mid === 0) pass(`parametric posX follows the slider: well at ±2.0 (sp=2), midfield clear`);
    else fail(`template posX wrong: at2=${at2} mid=${mid}`);
  } else fail(`parametric positions rejected: ${s2.errors?.join(' | ')}`);

  // a referenced shape MOVES as a whole — silent no-op would be a
  // confidently-wrong layout, the exact failure the probe hunts
  const moved = {
    ...structuredClone(EMPTY_RECIPE),
    name: 'Moved star well',
    shapes: [{ id: 'sq', path: 'M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z' }],
    pipeline: [
      { id: 'well', strategy: 'pocket_shape', params: { shape: 'sq', depth: 0.15, toolDiameter: 0.125, posX: 2, posY: 1 } },
    ],
  };
  const m = run(moved);
  if (m.ok) {
    const sim = simulateJob(m.preview.built, m.preview.placement, m.preview.stock);
    const p = m.preview.placement;
    const there = surfaceAt(sim, 2 + p.x, 1 + p.y);
    const home = surfaceAt(sim, p.x, p.y);   // authored origin: untouched
    if (Math.abs(there + 0.15) < 0.005 && home === 0) pass(`referenced shape moved whole: pocket at (2,1), authored origin clear`);
    else fail(`reference move wrong: there=${there} home=${home}`);
  } else fail(`moved reference rejected: ${m.errors?.join(' | ')}`);
}

// ---------------- 34. the "What is this?" examples all weave ----------------
// One click loads these for a brand-new visitor; a catalog or schema change
// that breaks one must fail HERE, not greet a first-timer with REJECTED.

console.log('--- examples: every What-is-this recipe weaves ---');
{
  const { EXAMPLES } = await import('./examples.mjs');
  for (const ex of EXAMPLES) {
    const r = run(migrateRecipe(structuredClone(ex.recipe)));
    if (r.ok) pass(`example "${ex.id}" weaves ok${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''})` : ''}`);
    else fail(`example "${ex.id}" failed: ${r.errors.join(' | ')}`);
  }
  // the badge example is authored around a not-yet-drawn outline: it must
  // arrive VERIFIED with the cutout honestly waiting, not REJECTED
  const badge = run(migrateRecipe(structuredClone(EXAMPLES.find((e) => e.id === 'name_badge').recipe)));
  if (badge.ok && badge.warnings.some((w) => w.includes('waiting on the drawing'))) {
    pass('name-badge example waits for its drawing (the step-1 state)');
  } else fail(`badge example state wrong: ok=${badge.ok} warnings=${JSON.stringify(badge.warnings)}`);
}

// ---------------- 35. pinned cutouts: the drag-to-place wrapper contract ----------------
// Field report (2026-07-27): dragging a name on a tag_cutout badge read as
// a no-op — the self-sizing tag re-wrapped the moved text and re-centered
// it. The wrappers now take posX/posY (+ width/height on tag_cutout) so
// the 2D drag can PIN them where they stand; a pinned outline that no
// longer contains the content is refused with the fix named, never grown
// silently.

console.log('--- pinned cutouts: the outline holds still, the content moves ---');
{
  const ringBBoxOf = (r, id) => {
    const ring = r.preview?.built?.find((x) => x.op.id === id)?.r.previewRing;
    if (!ring) return null;
    return ring.reduce((a, q) => ({
      minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
      maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  };
  const mid = (b) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

  // baseline: a self-sized tag around centered text
  const base = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1 } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4 } },
    ],
  });
  const bb0 = ringBBoxOf(base, 'cutout');
  if (base.ok && bb0) pass(`baseline self-sized tag verified (${(bb0.maxX - bb0.minX).toFixed(2)}" × ${(bb0.maxY - bb0.minY).toFixed(2)}")`);
  else fail(`baseline failed: ${base.errors?.join(' | ')}`);

  // the no-op mechanism itself: move the text WITHOUT pinning — the tag
  // chases it (this is what the drag must prevent by pinning)
  const chase = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1, posX: 1, posY: -0.5 } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4 } },
    ],
  });
  const bbChase = ringBBoxOf(chase, 'cutout');
  if (chase.ok && Math.abs(mid(bbChase).x - mid(bb0).x - 1) < 0.01 && Math.abs(mid(bbChase).y - mid(bb0).y + 0.5) < 0.01) {
    pass('unpinned tag chases moved text (the re-centering the pin exists to stop)');
  } else fail(`chase geometry unexpected: ${JSON.stringify(bbChase)}`);

  // pin the tag at the baseline geometry, then move the text: the tag must
  // NOT move, and the text sits off-center ON it
  const c0 = mid(bb0);
  const pin = {
    posX: c0.x || 0.001, posY: c0.y || 0.001,
    width: Math.ceil((bb0.maxX - bb0.minX) * 1000) / 1000,
    height: Math.ceil((bb0.maxY - bb0.minY) * 1000) / 1000,
  };
  const pinned = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1, posX: 0.2, posY: 0.001 } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4, ...pin } },
    ],
  });
  const bbPin = ringBBoxOf(pinned, 'cutout');
  const textBB = pinned.preview?.built?.find((x) => x.op.id === 'engrave')?.r.bbox;
  if (pinned.ok
    && Math.abs(mid(bbPin).x - c0.x) < 0.01 && Math.abs(mid(bbPin).y - c0.y) < 0.01
    && Math.abs((bbPin.maxX - bbPin.minX) - pin.width) < 0.01
    && textBB && Math.abs((textBB.minX + textBB.maxX) / 2 - 0.2) < 0.01) {
    pass('pinned tag holds still while the text moves 0.2" across it, verified');
  } else fail(`pinned tag wrong: ok=${pinned.ok} ring=${JSON.stringify(bbPin)} ${pinned.errors?.join(' | ')}`);

  // content dragged past the pinned edge: an honest refusal naming the fix
  const over = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1, posX: pin.width, posY: 0.001 } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4, ...pin } },
    ],
  });
  if (!over.ok && over.errors[0]?.includes('no longer contains')) {
    pass(`overflowing a pinned tag refused: "${over.errors[0].slice(0, 70)}..."`);
  } else fail(`overflow leaked: ok=${over.ok} ${JSON.stringify(over.errors)}`);

  // disc_cutout: pinned center holds, reach measured from the pin
  const disc = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'carve', strategy: 'vcarve_text', params: { text: 'AB', letterHeight: 0.8 } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 4, posX: 0.5, posY: 0.001 } },
    ],
  });
  const bbDisc = ringBBoxOf(disc, 'disc');
  if (disc.ok && Math.abs(mid(bbDisc).x - 0.5) < 0.01 && Math.abs(mid(bbDisc).y) < 0.01) {
    pass('pinned disc centers at (0.5, 0), content off-center inside, verified');
  } else fail(`pinned disc wrong: ok=${disc.ok} ${JSON.stringify(bbDisc)} ${disc.errors?.join(' | ')}`);
  const discFar = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'carve', strategy: 'vcarve_text', params: { text: 'AB', letterHeight: 0.8 } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 3, posX: 2.5 } },
    ],
  });
  if (!discFar.ok && discFar.errors[0]?.includes('pinned at')) {
    pass(`disc pinned too far refused: "${discFar.errors[0].slice(0, 70)}..."`);
  } else fail(`far disc leaked: ok=${discFar.ok} ${JSON.stringify(discFar.errors)}`);

  // shape_cutout: a pinned inline outline centers at the pin
  const heart = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'carve', strategy: 'vcarve_text', params: { text: 'AB', letterHeight: 0.6 } },
      { id: 'cut', strategy: 'shape_cutout', params: { path: 'M 0 50 A 50 30 0 1 1 100 50 A 50 30 0 1 1 0 50 Z', width: 5, posX: 0.4, posY: 0.001 } },
    ],
  });
  const bbHeart = ringBBoxOf(heart, 'cut');
  if (heart.ok && Math.abs(mid(bbHeart).x - 0.4) < 0.01) {
    pass('pinned shape_cutout centers its outline at the pin, verified');
  } else fail(`pinned shape wrong: ok=${heart.ok} ${JSON.stringify(bbHeart)} ${heart.errors?.join(' | ')}`);
}

// ---------------- 36. line_text: single-line engraving fonts ----------------
// Field report (2026-07-27): asked to swap V-carving for a single-line
// font milled with a flat bit, the model pocketed the outline face
// instead — there was nothing else it could reach for. line_text traces
// vendored Hershey stroke fonts (open pen paths, no outline to fill), so
// the ask now has an honest verb.

console.log('--- line_text: single-line strokes, flat bit or vee hairline ---');
{
  const rec = (params) => ({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'line', strategy: 'line_text', params },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.3 } },
    ],
  });

  // the nameplate: flat endmill, verified through the standard gate
  const flat = run(rec({ text: 'Brian', letterHeight: 1 }));
  const lineT = flat.report?.stats.targets?.find((t) => t.name.startsWith('line'));
  const built = flat.preview?.built?.find((x) => x.op.id === 'line');
  if (flat.ok && lineT?.depthViolations === 0 && built?.r.cutter?.type === 'flat') {
    pass(`flat-bit single-line nameplate verified (${lineT.samples} samples, ${flat.report.stats.cutLength}" of line)`);
  } else fail(`flat line_text failed: ok=${flat.ok} ${flat.errors?.join(' | ')}`);

  // strokes are PEN PATHS, not outlines: 'I' in the simplex face is one
  // straight stroke — its cut length is the letter height plus nothing
  const bare = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [{ id: 'line', strategy: 'line_text', params: { text: 'I', letterHeight: 1 } }],
  });
  // cut length = the 1" stroke + one plunge from safeZ 0.5 to -0.03
  if (bare.ok && Math.abs(bare.report.stats.cutLength - 1.53) < 0.06) {
    pass(`"I" is one traced stroke: ${bare.report.stats.cutLength}" of cut = 1" letter + one plunge (an outline would trace both sides)`);
  } else fail(`stroke trace wrong: ok=${bare.ok} cutLength=${bare.report?.stats.cutLength}`);

  // vee hairline variant + script face
  const vee = run(rec({ text: 'Brian', letterHeight: 1, font: 'line-script', toolDiameter: 0 }));
  const veeBuilt = vee.preview?.built?.find((x) => x.op.id === 'line');
  if (vee.ok && veeBuilt?.r.cutter?.type === 'vee') pass('script face + vee hairline verified');
  else fail(`vee line_text failed: ok=${vee.ok} ${vee.errors?.join(' | ')}`);

  // posX moves the block (the 2D drag rides this param)
  const moved = run(rec({ text: 'Brian', letterHeight: 1, posX: 0.8, posY: 0.001 }));
  const mb = moved.preview?.built?.find((x) => x.op.id === 'line')?.r.bbox;
  if (moved.ok && Math.abs((mb.minX + mb.maxX) / 2 - 0.8) < 0.01) pass('posX places the stroke block (draggable like the other text verbs)');
  else fail(`posX wrong: ok=${moved.ok} bbox=${JSON.stringify(mb)}`);

  // an outline-shelf id here is an honest refusal naming both shelves
  const wrongShelf = run(rec({ text: 'Brian', letterHeight: 1, font: 'bold-sans' }));
  if (!wrongShelf.ok && wrongShelf.errors[0]?.includes("can't single-line")) {
    pass(`outline face refused: "${wrongShelf.errors[0].slice(0, 70)}..."`);
  } else fail(`wrong shelf leaked: ok=${wrongShelf.ok} ${JSON.stringify(wrongShelf.errors)}`);

  // blank bound text skips the op like every other text verb
  const blank = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.5 },
    pipeline: [
      { id: 'line', strategy: 'line_text', params: { text: '  ' } },
      { id: 'disc', strategy: 'disc_cutout', params: { diameter: 3 } },
    ],
  });
  if (blank.ok && blank.warnings.some((w) => w.includes('skipped'))) pass('blank text skips, the disc still cuts');
  else fail(`blank skip wrong: ok=${blank.ok} ${JSON.stringify(blank.warnings)}`);
}

// ---------------- around + contain sizing: the badge-window contract ----------------
// Field report (2026-07-28): default badges were huge — the fit-derived
// tag scaled the whole drawing up to hold the name. The contract now:
// the sketch scales down EVENLY into a maxWidth×maxHeight window
// (aspect kept), the letters NEVER scale, and a name the outline can't
// hold carries its own rounded rect (around) into the cutout via union —
// the rect is swallowed whenever the outline already contains the text.

console.log('--- around + maxWidth/maxHeight: fixed-size outline, fixed-size name ---');
{
  const ringBBoxOf = (r, id) => {
    const ring = r.preview?.built?.find((x) => x.op.id === id)?.r.previewRing;
    if (!ring) return null;
    return ring.reduce((a, q) => ({
      minX: Math.min(a.minX, q.x), minY: Math.min(a.minY, q.y),
      maxX: Math.max(a.maxX, q.x), maxY: Math.max(a.maxY, q.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  };
  const dims = (b) => b && { w: b.maxX - b.minX, h: b.maxY - b.minY };

  // contain: a 2:1 artwork into a 3.5×2.5 window binds on WIDTH → 3.5×1.75
  const wide = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.25 },
    assets: [{ id: 'art', name: 'art', kind: 'svg', data: '<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>' }],
    shapes: [{ id: 'card', asset: { of: 'art', maxWidth: 3.5, maxHeight: 2.5 } }],
    pipeline: [{ id: 'cut', strategy: 'shape_cutout', params: { shape: 'card' } }],
  });
  const wd = dims(ringBBoxOf(wide, 'cut'));
  if (wide.ok && wd && Math.abs(wd.w - 3.5) < 0.02 && Math.abs(wd.h - 1.75) < 0.02) {
    pass(`maxWidth binds a wide artwork: ${wd.w.toFixed(2)}" × ${wd.h.toFixed(2)}" (aspect kept)`);
  } else fail(`wide contain wrong: ok=${wide.ok} dims=${JSON.stringify(wd)}`);

  // ...and a 1:2 artwork into the same window binds on HEIGHT → 1.25×2.5
  const tall = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.25 },
    assets: [{ id: 'art', name: 'art', kind: 'svg', data: '<svg viewBox="0 0 100 200"><rect width="100" height="200"/></svg>' }],
    shapes: [{ id: 'card', asset: { of: 'art', maxWidth: 3.5, maxHeight: 2.5 } }],
    pipeline: [{ id: 'cut', strategy: 'shape_cutout', params: { shape: 'card' } }],
  });
  const td = dims(ringBBoxOf(tall, 'cut'));
  if (tall.ok && td && Math.abs(td.w - 1.25) < 0.02 && Math.abs(td.h - 2.5) < 0.02) {
    pass(`maxHeight binds a tall artwork: ${td.w.toFixed(2)}" × ${td.h.toFixed(2)}"`);
  } else fail(`tall contain wrong: ok=${tall.ok} dims=${JSON.stringify(td)}`);

  // the noodle case: a 6×0.5 bar can never hold 0.9" letters — the union
  // with the around-rect grows ONLY where the name pokes out, and the
  // bar keeps its authored 6" span (nothing scaled)
  const noodle = (shapes, letterHeight = 0.9) => ({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.25 },
    shapes,
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brianna', letterHeight } },
      { id: 'cut', strategy: 'shape_cutout', params: { shape: 'tag' } },
    ],
  });
  const bar = { id: 'bar', path: 'M -3 -0.25 L 3 -0.25 L 3 0.25 L -3 0.25 Z' };
  const poked = run(noodle([
    bar,
    { id: 'nameRect', around: { margin: 0.3, cornerRadius: 0.4 } },
    { id: 'tag', union: ['bar', 'nameRect'] },
  ]));
  const pd = dims(ringBBoxOf(poked, 'cut'));
  if (poked.ok && pd && Math.abs(pd.w - 6) < 0.02 && Math.abs(pd.h - 1.5) < 0.1) {
    pass(`name outgrows the bar → its own tab: union ${pd.w.toFixed(2)}" × ${pd.h.toFixed(2)}" (bar span kept, rect = letters + margins)`);
  } else fail(`noodle union wrong: ok=${poked.ok} dims=${JSON.stringify(pd)} ${poked.errors?.join(' | ') ?? ''}`);

  // ...while the bar WITHOUT the rect honestly REFUSES the identical text
  // (this is the failure mode around+union exists to absorb; the poke
  // must clear shape_cutout's 0.1" edge grace to count)
  const bare = run(noodle([bar, { id: 'tag', union: ['bar', 'bar'] }]));
  if (!bare.ok && bare.errors[0]?.includes('pokes outside')) {
    pass('the bar alone refuses the oversized name (fit check held)');
  } else fail(`bare noodle wrong: ok=${bare.ok} ${JSON.stringify(bare.errors)}`);

  // swallowed: an outline that already holds the name is unchanged by
  // the union — the around-rect is strictly inside it
  const roomy = run(noodle([
    { id: 'bar', path: 'M -2 -1.5 L 2 -1.5 L 2 1.5 L -2 1.5 Z' },
    { id: 'nameRect', around: { margin: 0.3, cornerRadius: 0.4 } },
    { id: 'tag', union: ['bar', 'nameRect'] },
  ], 0.6));
  const rd = dims(ringBBoxOf(roomy, 'cut'));
  if (roomy.ok && rd && Math.abs(rd.w - 4) < 0.02 && Math.abs(rd.h - 3) < 0.02) {
    pass(`roomy outline swallows the rect: ${rd.w.toFixed(2)}" × ${rd.h.toFixed(2)}" (authored size, no growth)`);
  } else fail(`swallow wrong: ok=${roomy.ok} dims=${JSON.stringify(rd)}`);

  // around with nothing before it is an honest authoring error
  const early = run({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.25 },
    shapes: [{ id: 'nameRect', around: { margin: 0.3 } }],
    pipeline: [{ id: 'cut', strategy: 'shape_cutout', params: { shape: 'nameRect' } }],
  });
  if (!early.ok && early.errors[0]?.includes('nothing to wrap')) {
    pass('around before any content refused with the fix named');
  } else fail(`early around wrong: ok=${early.ok} ${JSON.stringify(early.errors)}`);
}

// ---------------- vcarve depth cap is stock-aware ----------------
// Field report (2026-07-28): engraving 1/16" material REJECTED with
// "cuts through stock bottom" — the vee's 0.2" default cap was three
// times the board. The cap now defaults to AUTO (0.2" or half the
// stock, whichever is shallower); strokes wider than the capped vee
// reaches bottom out flat and pocket-clear, exactly like a thick-stock
// carve that hits 0.2".

console.log('--- vcarve maxDepth: auto-caps to half of thin stock ---');
{
  const rec = (thickness, params = {}) => ({
    ...structuredClone(EMPTY_RECIPE), stock: { thickness },
    pipeline: [
      { id: 'engrave', strategy: 'vcarve_text', params: { text: 'Brian', letterHeight: 1, ...params } },
      { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4 } },
    ],
  });
  const minZOf = (r) => {
    const mv = r.preview?.built?.find((x) => x.op.id === 'engrave')?.r.moves ?? [];
    return mv.reduce((m, q) => (q.z !== undefined ? Math.min(m, q.z) : m), 0);
  };

  // 1/16" ply: auto cap = 0.03125, verified instead of refused
  const thin = run(rec(0.0625));
  const tz = minZOf(thin);
  if (thin.ok && Math.abs(tz + 0.03125) < 1e-6) {
    pass(`1/16" stock engraves at the half-thickness cap (deepest Z ${tz}")`);
  } else fail(`thin stock: ok=${thin.ok} minZ=${tz} ${thin.errors?.join(' | ') ?? ''}`);

  // ...and the wide strokes that USED to over-cut now flat-clear
  const engr = thin.preview?.built?.find((x) => x.op.id === 'engrave')?.r;
  if (engr?.target.depth === 0.03125) pass('target declares the capped depth');
  else fail(`target depth ${engr?.target.depth}`);

  // an explicit cap past the stock bottom clamps with the numbers named
  const forced = run(rec(0.0625, { maxDepth: 0.2 }));
  if (forced.ok && forced.warnings.some((w) => w.includes('capped at 0.03125'))) {
    pass('explicit 0.2" cap on 1/16" stock: capped + warned, still verified');
  } else fail(`forced: ok=${forced.ok} warnings=${JSON.stringify(forced.warnings)}`);

  // thick stock: auto stays the classic 0.2" — no behavior change
  const thick = run(rec(0.75));
  const kd = thick.preview?.built?.find((x) => x.op.id === 'engrave')?.r.target.depth;
  if (thick.ok && kd === 0.2) pass('3/4" stock keeps the 0.2" cap (auto = min(0.2, half))');
  else fail(`thick: ok=${thick.ok} target depth=${kd}`);
}

// ---------------- pocket_text narrow strokes: honest declarations survive ----------------
// Field report (2026-07-28): "engrave bulk (pocket_text) gouges outside its
// declared region: 4/857 samples" on ordinary text. Two kernel defects, both
// in the DECLARATION (the motion was fine): (1) CleanPolygons folded a
// hair-thin level-0 sliver into a self-crossing bow-tie, and offsetting that
// dropped a lobe of the declared sweep — cleaned() now simplifies to keep
// the "rings are simple" promise; (2) the declared polygon under-approximated
// the true circular sweep (inscribed tessellation), eating the verifier's
// gouge budget at sharp serif corners — the sweep now declares with outward
// slack. These weaves exercise the fonts/sizes that failed.

console.log('--- pocket_text: skinny-stroke declarations verify ---');
{
  const cases = [
    ['slab', 1, 'Brian'],        // tolerance stack at serif corners
    ['condensed', 0.8, 'Brian'], // bow-tie level-0 sliver
    ['script', 0.8, 'Millie'],   // 28-sample slot-fit case
    ['slab', 0.6, 'WELCOME'],    // 181-sample worst case
  ];
  for (const [font, letterHeight, text] of cases) {
    const r = run({
      ...structuredClone(EMPTY_RECIPE), stock: { thickness: 0.75 },
      pipeline: [
        { id: 'engrave', strategy: 'pocket_text', params: { text, letterHeight, font, depth: 0.2 } },
        { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.4 } },
      ],
    });
    if (r.ok) pass(`${font} ${letterHeight}" "${text}" pockets + verifies`);
    else fail(`${font} ${letterHeight}" "${text}": ${r.errors?.join(' | ')}`);
  }
}

console.log(failures === 0 ? '\nALL LOOM APP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
