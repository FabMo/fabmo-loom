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
import { EMPTY_RECIPE, runRecipe, controlDefaults } from './runtime.mjs';
import { applyActions, buildParseRequest } from './intent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const buf = readFileSync(join(here, '..', 'examples', 'engraver', 'assets', 'DejaVuSans-Bold.ttf'));
const FONT = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};
const run = (recipe, values) => quiet(() => runRecipe(recipe, values ?? controlDefaults(recipe), FONT));

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

  // text too big for stock → human-sized fit error
  const big = run(recipe, { ...controlDefaults(recipe), name: 'Congratulations', letterHeight: 2 });
  if (!big.ok && big.errors[0].includes('stock is')) pass('oversized content: fit error before motion');
  else fail(`fit not caught: ${JSON.stringify(big.errors)}`);
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
  if (req.tools?.[0]?.name === 'apply_recipe_actions' && req.system.includes('vcarve_text') && req.system.includes(JSON.stringify(recipe.stock))) {
    pass('request carries catalog doc + current recipe + forced tool choice');
  } else fail('parse request malformed');
}

console.log(failures === 0 ? '\nALL LOOM APP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
