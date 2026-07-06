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
import { simulateJob, surfaceAt } from './sim.mjs';
import { FONTS } from './fonts.mjs';
import { pathToRegions } from './shape.mjs';

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
const run = (recipe, values) => quiet(() => runRecipe(recipe, values ?? controlDefaults(recipe), FONT_SHELF));

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
  const note = r.warnings.find(w => w.includes('auto tool:'));
  const nOps = r.report?.stats.targets?.length ?? 0;
  if (r.ok && nOps >= 2 && note?.includes('1/4"')) {
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

// ---------------- 18. uploaded assets: stored, surfaced, honestly unusable ----------------
// Upload happens in the browser; here we assert the document and prompt
// sides: assets ride the recipe, the LLM sees their names but never their
// bytes, and the runtime ignores them.

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
    pass('prompt lists both assets with decline guidance');
  } else fail('asset section missing from prompt');
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

console.log(failures === 0 ? '\nALL LOOM APP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
