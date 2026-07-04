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

console.log(failures === 0 ? '\nALL LOOM APP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
