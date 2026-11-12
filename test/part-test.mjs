// Part-first gauntlet — the `part` verb (plan workstream 4): the model
// gives an outline and features at depths, the planner does the CAM. Each
// case is woven, verified, run through the machinability gate, and then
// SIMULATED: the cut surface is sampled at points whose depth the
// description fixes, so "the planner made what was described" is measured
// on the material, not read off the plan.
//
// Usage: node test/part-test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_RECIPE, runRecipe, controlDefaults } from '../app/runtime.mjs';
import { applyActions, checkClaims } from '../app/intent.mjs';
import { simulateJob, surfaceAt } from '../app/sim.mjs';
import { FONTS } from '../app/fonts.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const FONT_SHELF = {};
for (const f of FONTS) { const b = readFileSync(join(app, f.file)); FONT_SHELF[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
let failures = 0;
const ok = (msg, cond, detail = '') => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ FAIL ${msg}${detail ? ` — ${detail}` : ''}`); } };
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
const T = 0.75;
const recipe = (params, extra = {}) => ({ ...structuredClone(EMPTY_RECIPE), stock: { thickness: T }, ...extra, pipeline: [...(extra.before ?? []), { id: 'p', strategy: 'part', params }, ...(extra.after ?? [])] });
const weave = (rec, shop = {}) => quiet(() => runRecipe(rec, controlDefaults(rec), FONT_SHELF, {}, shop));
const subs = (r) => (r.preview.built ?? []).filter(e => e.op.id === 'p').map(e => ({ name: e.r.subName, d: e.r.tool?.diameter, depth: e.r.target?.depth, type: e.r.target?.type }));
// depth of the cut surface at a point given in the PART frame (origin = part center for built-in outlines)
function prober(r) {
  const sim = simulateJob(r.preview.built, r.preview.placement, r.preview.stock);
  const ring = r.preview.built.find(e => e.r.previewRing).r.previewRing;
  const cx = (Math.min(...ring.map(q => q.x)) + Math.max(...ring.map(q => q.x))) / 2, cy = (Math.min(...ring.map(q => q.y)) + Math.max(...ring.map(q => q.y))) / 2;
  return (x, y) => -surfaceAt(sim, cx + x + r.preview.placement.x, cy + y + r.preview.placement.y);
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const summary = (r) => JSON.stringify({ ok: r.ok, errors: r.errors?.slice(0, 2), subs: subs(r) }).slice(0, 500);

console.log('--- counterbored fence: the ledger\'s counterbore class, with no op order from the author ---');
{
  const r = weave(recipe({ outline: 'rectangle', width: 6, height: 3, features: [
    // listed deep-first on purpose: order in the list must not matter
    { shape: 'circle', x: -2, y: 0, diameter: 0.3125, depth: 'through' }, { shape: 'circle', x: -2, y: 0, diameter: 0.75, depth: 0.25 },
    { shape: 'circle', x: 2, y: 0, diameter: 0.75, depth: 0.25 }, { shape: 'circle', x: 2, y: 0, diameter: 0.3125, depth: 'through' },
    { shape: 'slot', x: 0, y: 0.8, width: 3, height: 0.375, depth: 'through' },
  ] }));
  const s = subs(r), at = prober(r);
  ok('verifies, and the machinability gate has no complaint', r.ok && r.machinability?.ok && !(r.machinability.warnings ?? []).length, summary(r));
  ok('frees one piece, cut free LAST, with tabs added by policy', r.pieces === 1 && s.at(-1).name === 'cut free' && s.at(-1).type === 'profile' && (r.warnings ?? []).some(w => /holding tabs added/.test(w)));
  ok('each counterbore is two bores, shallow before deep', s.filter(x => /^bore/.test(x.name)).length === 4 && s.findIndex(x => x.depth === 0.25) < s.findIndex(x => /^bore/.test(x.name) && x.depth === T), JSON.stringify(s));
  ok(`simulated: ledge ${at(-2 + 0.27, 0).toFixed(3)}", bolt hole ${at(-2, 0).toFixed(3)}", slot ${at(0, 0.8).toFixed(3)}", face ${at(0, -0.8).toFixed(3)}"`, near(at(-2 + 0.27, 0), 0.25) && near(at(-2, 0), T) && near(at(2, 0), T) && near(at(2 - 0.27, 0), 0.25) && near(at(0, 0.8), T) && near(at(0, -0.8), 0));
}

console.log('--- nested pockets and small holes: deepest wins, small features get a smaller bit ---');
{
  const r = weave(recipe({ outline: 'rectangle', width: 8, height: 5, features: [
    { shape: 'rectangle', x: 0, y: 0, width: 6, height: 3, cornerRadius: 0.25, depth: 0.125 },
    { shape: 'rectangle', x: -1, y: 0, width: 2, height: 1.5, depth: 0.375 },
    { shape: 'circle', x: 1.5, y: 0, diameter: 1, depth: 'through' },
    { shape: 'circle', at: '-3.5 2; 3.5 2; -3.5 -2; 3.5 -2', diameter: 0.1875, depth: 'through' },
  ] }));
  const s = subs(r), at = prober(r);
  ok('verifies with overlapping features — no allowance asked of the author', r.ok, summary(r));
  ok(`simulated depth map: tray ${at(2.6, 1).toFixed(3)}", inner well ${at(-1, 0).toFixed(3)}", through hole ${at(1.5, 0).toFixed(3)}", corner hole ${at(-3.5, 2).toFixed(3)}", rim ${at(0, 2.2).toFixed(3)}"`, near(at(2.6, 1), 0.125) && near(at(-1, 0), 0.375) && near(at(1.5, 0), T) && near(at(-3.5, 2), T) && near(at(0, 2.2), 0));
  ok('the 3/16" holes are bored with a 1/8" bit; everything else with the 1/4"', s.filter(x => x.d === 0.125).length === 4 && s.filter(x => x.d === 0.125).every(x => /^bore/.test(x.name)) && s.filter(x => x.d === 0.25).length === s.length - 4);
  ok('one bit at a time: all 1/4" features, then the 1/8" ones, then the cutout', (() => { const d = s.slice(0, -1).map(x => x.d); return d.every((v, i) => i === 0 || v <= d[i - 1]); })(), JSON.stringify(s.map(x => x.d)));
  ok('the gate still speaks for the physics: a 1/8" bit 3/4" deep is past its reach', (r.machinability?.warnings ?? []).some(w => /reaches 0\.500"/.test(w)));
}

console.log('--- edges: a through slot at the edge is a notch; a blind one is an open pocket ---');
{
  const r = weave(recipe({ outline: 'rectangle', width: 6, height: 4, features: [
    { shape: 'slot', x: 3, y: 0, width: 2, height: 0.5, depth: 'through' },
    { shape: 'rectangle', x: -3, y: 1, width: 1.5, height: 1, depth: 0.25 },
    { shape: 'slot', x: 0, y: -1, width: 2.5, height: 0.3, angle: 30, depth: 'through' },
  ] }));
  const s = subs(r), at = prober(r);
  const ring = r.preview.built.find(e => e.r.previewRing).r.previewRing;
  ok('verifies, with no thin-wall warning for the open pocket', r.ok && !(r.machinability?.warnings ?? []).some(w => /wall that thin/.test(w)), summary(r) + JSON.stringify(r.machinability?.warnings));
  ok('the notch is part of the outline (more than a rectangle\'s points on the right edge)', ring.filter(q => q.x > Math.max(...ring.map(z => z.x)) - 1.3 && q.x < Math.max(...ring.map(z => z.x)) - 0.2).length > 4);
  ok(`simulated: open pocket ${at(-2.6, 1).toFixed(3)}", angled slot center ${at(0, -1).toFixed(3)}" and along its 30° axis ${at(0.87, -0.5).toFixed(3)}", off-axis ${at(0.87, -1.5).toFixed(3)}"`, near(at(-2.6, 1), 0.25) && near(at(0, -1), T) && near(at(0.87, -0.5), T) && near(at(0.87, -1.5), 0));
  ok('two features only (the notch is not a pocket), then the cutout', s.length === 3 && s.at(-1).name === 'cut free', JSON.stringify(s));
}

console.log('--- a notch that opens a hole to the edge (the rain-gauge cradle arm, 2026-11-12) ---');
{
  // a tube hole with a snap mouth cut into it from the edge: listed hole
  // first, so the hole is interior until the mouth is taken out
  const r = weave(recipe({ outline: 'rectangle', width: 2, height: 2.4, features: [
    { shape: 'circle', x: 0, y: 0, diameter: 1.03, depth: 'through' },
    { shape: 'rectangle', x: 0, y: 0.66, width: 0.88, height: 1.32, depth: 'through' },
  ] }));
  const s = subs(r), at = prober(r);
  ok('verifies: the mouth and the hole both become part of the outline — nothing left to overlap the cutout', r.ok && s.length === 1 && s[0].name === 'cut free', summary(r));
  ok(`simulated: the cradle is open (${at(0, 0).toFixed(3)}" at the hole center is waste outside the part) and the arm beside it is untouched (${at(0.8, -0.9).toFixed(3)}")`, near(at(0.8, -0.9), 0));
  const ring = r.preview.built.find(e => e.r.previewRing).r.previewRing;
  ok('the outline is a C, not a rectangle', ring.length > 40);
}

console.log('--- outlines: circle, shape id, arithmetic, text on the part ---');
{
  const disc = weave(recipe({ outline: 'circle', diameter: 5, features: [{ shape: 'circle', diameter: 0.5, depth: 'through' }, { shape: 'circle', diameter: 3, depth: 0.2 }] }));
  const at = prober(disc);
  ok('a dished disc with a center hole', disc.ok && near(at(1, 0), 0.2) && near(at(0, 0), T) && near(at(2, 0), 0), summary(disc));

  const shaped = weave(recipe({ outline: 'plate', features: [{ shape: 'window', depth: 'through' }, { shape: 'circle', x: '-len/2 + 1', y: 0, diameter: 0.5, depth: 0.25 }] }, {
    controls: [{ id: 'len', type: 'number', label: 'Length', default: 8, min: 4, max: 20 }],
    shapes: [{ id: 'plate', path: 'M {-len/2} -2 L {len/2} -2 L {len/2} 1 L 0 2.5 L {-len/2} 1 Z' }, { id: 'window', path: 'M 1 -1 L 3 -1 L 3 0 L 1 0 Z' }],
  }));
  const ring = shaped.preview.built.find(e => e.r.previewRing)?.r.previewRing ?? [];
  ok('a shape-id outline with a shape-id window and an arithmetic hole position', shaped.ok && ring.length === 5 && subs(shaped).length === 3, summary(shaped));

  const named = weave(recipe({ outline: 'rectangle', width: 7, height: 3, features: [{ shape: 'circle', at: '-3 1; 3 1', diameter: 0.25, depth: 'through' }] }, {
    before: [{ id: 'name', strategy: 'vcarve_text', params: { text: 'JIG A', letterHeight: 1 } }],
  }));
  ok('text machined before the part sits on it, and the job verifies', named.ok && named.pieces === 1, summary(named));

  const two = weave({ ...recipe({ outline: 'rectangle', width: 4, height: 3, features: [{ shape: 'circle', diameter: 1, depth: 0.25 }, { shape: 'circle', diameter: 0.3, depth: 'through' }] }),
    pipeline: [{ id: 'p', strategy: 'part', params: { outline: 'rectangle', width: 4, height: 3, features: [{ shape: 'circle', diameter: 1, depth: 0.25 }, { shape: 'circle', diameter: 0.3, depth: 'through' }] } },
      { id: 'q', strategy: 'part', params: { outline: 'circle', diameter: 3, features: [{ shape: 'circle', diameter: 1, depth: 0.25 }, { shape: 'circle', diameter: 0.3, depth: 'through' }] } }] });
  ok('two parts in one job are two pieces, laid out apart, both verified', two.ok && two.pieces === 2, JSON.stringify({ ok: two.ok, pieces: two.pieces, errors: two.errors?.slice(0, 2) }));
}

console.log('--- refusals and repairs: every one says what and why ---');
{
  const err = (params, extra) => weave(recipe(params, extra)).errors?.join(' | ') ?? '';
  ok('an unknown outline names the choices', /outline is "rectangle", "circle" or a closed shape id/.test(err({ outline: 'blob' })));
  ok('a feature without a depth says so, by number', /feature 2 needs a depth/.test(err({ features: [{ shape: 'circle', diameter: 1, depth: 0.1 }, { shape: 'circle', diameter: 1, x: 2 }] })));
  ok('bad arithmetic is reported with the feature', /feature 1 x:/.test(err({ features: [{ shape: 'circle', x: 'nope*2', diameter: 1, depth: 0.1 }] })));
  ok('an unknown feature shape names the choices', /"circle", "rectangle", "slot" or a closed shape id/.test(err({ features: [{ shape: 'hexagon', depth: 0.1 }] })));
  ok('a hole smaller than any bit is refused', /smaller than the smallest bit/.test(err({ features: [{ shape: 'circle', diameter: 0.02, depth: 'through' }] })));
  ok('a through feature that swallows the part is refused', /removes the whole part/.test(err({ width: 4, height: 3, features: [{ shape: 'rectangle', width: 9, height: 9, depth: 'through' }] })));
  const out = weave(recipe({ width: 4, height: 3, features: [{ shape: 'circle', x: 9, y: 9, diameter: 0.5, depth: 'through' }, { shape: 'circle', diameter: 0.5, depth: 5 }] }));
  ok('a feature off the part is dropped with a warning; a depth past the stock is "through"', out.ok && (out.warnings ?? []).some(w => /lies outside the part — ignored/.test(w)) && near(prober(out)(0, 0), T), summary(out));
  const bare = weave(recipe({ outline: 'rectangle', width: 5, height: 5 }));
  ok('a part with no features is simply the cutout', bare.ok && subs(bare).length === 1);
  const vac = weave(recipe({ outline: 'rectangle', width: 8, height: 8 }), { holdDown: 'vacuum' });
  ok('on a vacuum table a large part is not tabbed', vac.ok && !(vac.warnings ?? []).some(w => /holding tabs added/.test(w)));
}

console.log('--- the intent layer knows a part frees a piece ---');
{
  const out = applyActions(structuredClone(EMPTY_RECIPE), { summary: 's', actions: [{ kind: 'add_operation', operation: { id: 'fence', strategy: 'part', params: { outline: 'rectangle', width: 6, height: 3, features: [{ shape: 'circle', diameter: 0.5, depth: 'through' }] } } }] });
  ok('add_operation part applies with a features list', out.skipped.length === 0 && out.recipe.pipeline[0].params.features.length === 1, JSON.stringify(out.skipped));
  const cc = checkClaims({ faces: 'top', pieces: 1, parts: [{ name: 'fence', opId: 'fence' }] }, out.recipe, 'A fence.', [], 1);
  ok('claims: a part op substantiates a named piece', cc.issues.length === 0, JSON.stringify(cc.issues));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\npart gauntlet clean');
process.exit(failures ? 1 : 0);
