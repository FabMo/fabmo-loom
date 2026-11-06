// "Download nested vectors" (app/dxf.mjs): a woven layout exports as an
// R12 DXF in sheet coordinates — the board, the cut-out outline, the
// pocket at its depth, the V-carved letter outlines, the bored holes as
// circles — each on its own layer, every point shifted by the placement
// the cuts use, and nothing a strict R12 reader refuses. Measured, no mocks.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { EMPTY_RECIPE, runRecipe, controlDefaults } from '../app/runtime.mjs';
import { applyActions } from '../app/intent.mjs';
import { FONTS } from '../app/fonts.mjs';
import { weaveToDxf, parseDxfEntities } from '../app/dxf.mjs';

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; console.log(`  ✓ ${what}`); };
const fonts = {};
for (const f of FONTS) { const b = fs.readFileSync(new URL(f.file, new URL('../app/', import.meta.url)).pathname); fonts[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
const quiet = (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

console.log('a sign: letters, a pocket, two holes, cut out with tabs');
const applied = applyActions(structuredClone(EMPTY_RECIPE), { summary: '', actions: [
  { kind: 'set_name', name: 'DXF Test Sign' },
  { kind: 'set_shape', shape: { id: 'sq', path: 'M -1 -0.5 L 1 -0.5 L 1 0.5 L -1 0.5 Z' } },
  { kind: 'add_operation', operation: { id: 'text', strategy: 'vcarve_text', params: { text: 'HI', letterHeight: 1.5 } } },
  { kind: 'add_operation', operation: { id: 'pk', strategy: 'pocket_shape', params: { shape: 'sq', depth: 0.2, toolDiameter: 0.25, posY: -1.6 } } },
  { kind: 'add_operation', operation: { id: 'holes', strategy: 'bore_hole', params: { diameter: 0.25, at: '-0.75 1.6; 0.75 1.6' } } },
  { kind: 'add_operation', operation: { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } } },
], declined: [] });
ok(applied.skipped.length === 0, `every action applied (${applied.recipe.pipeline.length} ops)`);
const recipe = applied.recipe;
const res = quiet(() => runRecipe(recipe, controlDefaults(recipe), fonts, {}));
ok(res.ok, `the weave verifies (${res.errors.join('; ') || 'clean'})`);
const out = weaveToDxf(res, { name: recipe.name });
ok(!out.error && out.entities > 0, `the DXF has ${out.entities} entities on layers ${out.layers.join(', ')}`);
const dxf = out.dxf;
ok(/\n\$ACADVER\n1\nAC1009\n/.test(dxf) && /\n\$INSUNITS\n70\n1\n/.test(dxf), 'strict R12, inches');
ok(!/LWPOLYLINE/.test(dxf) && /\n2\nLTYPE\n/.test(dxf), 'only R12 entities, with an LTYPE table (what VCarve accepts)');
const ents = parseDxfEntities(dxf);
const on = (layer) => ents.filter(e => e.layer === layer);
const st = res.preview.stock, P = res.preview.placement;

const sheet = on('SHEET');
ok(sheet.length === 1 && sheet[0].closed && sheet[0].points.length === 4 && near(Math.max(...sheet[0].points.map(p => p.x)), st.w) && near(Math.max(...sheet[0].points.map(p => p.y)), st.h), `SHEET is the ${st.w}" × ${st.h}" board from the corner`);
ok(near(+dxf.match(/\n\$EXTMAX\n10\n([^\n]+)\n/)[1], st.w), '$EXTMAX is the board');

const tagRing = res.preview.built.find(b => b.op.id === 'tag').r.previewRing;
const profile = on('PROFILE');
ok(profile.length === 1 && profile[0].closed, 'the cut-out is ONE closed PROFILE polyline');
const p0 = profile[0].points[0], want = { x: tagRing[0].x + P.x, y: tagRing[0].y + P.y };
ok(near(p0.x, want.x) && near(p0.y, want.y), `its first vertex is the preview ring shifted by the placement (${p0.x.toFixed(3)}, ${p0.y.toFixed(3)})`);
ok(profile[0].points.every(p => p.x >= -1e-6 && p.x <= st.w + 1e-6 && p.y >= -1e-6 && p.y <= st.h + 1e-6), 'and it lies on the board');

const vee = on('VCARVE');
const veeRegions = res.preview.built.find(b => b.op.id === 'text').r.previewVee.regions;
const veeRings = veeRegions.reduce((n, r) => n + 1 + (r.holes?.length ?? 0), 0);
ok(vee.length === veeRings && vee.every(e => e.closed), `VCARVE carries the ${veeRegions.length} letter outlines (+ counters = ${veeRings} rings), closed`);

const pocketLayer = out.layers.find(l => l.startsWith('POCKET_D'));
ok(pocketLayer === 'POCKET_D0.2', `the pocket sits on its depth layer (${pocketLayer})`);
const pk = on(pocketLayer);
ok(pk.length >= 1 && pk[0].closed && pk[0].points.length === 4 && near(Math.max(...pk[0].points.map(p => p.x)) - Math.min(...pk[0].points.map(p => p.x)), 2), 'the pocket is the 2" design rectangle, not a tool-offset path');

const holeLayer = out.layers.find(l => l.startsWith('HOLES_D'));
const holes = on(holeLayer);
ok(holeLayer === 'HOLES_D0.25' && holes.length === 2 && holes.every(e => e.type === 'CIRCLE' && near(e.r, 0.125)), `two bores are CIRCLEs of r 0.125 on ${holeLayer}`);
ok(!on('THROUGH').length, 'nothing is nested, so no THROUGH layer');
ok(out.warnings.length === 0, 'no warnings on a plain 2D sign');

console.log('a ring: a disc cut inside a disc is THROUGH');
const ringRecipe = applyActions(structuredClone(EMPTY_RECIPE), { summary: '', actions: [
  { kind: 'add_operation', operation: { id: 'inner', strategy: 'disc_cutout', params: { diameter: 2 } } },
  { kind: 'add_operation', operation: { id: 'outer', strategy: 'disc_cutout', params: { diameter: 5 } } },
], declined: [] }).recipe;
const ringRes = quiet(() => runRecipe(ringRecipe, controlDefaults(ringRecipe), fonts, {}));
const ringOut = weaveToDxf(ringRes);
const re = parseDxfEntities(ringOut.dxf);
ok(ringRes.ok && re.filter(e => e.layer === 'PROFILE').length === 1 && re.filter(e => e.layer === 'THROUGH').length === 1, 'the outer disc is PROFILE, the inner one THROUGH');

console.log('nothing built');
const empty = weaveToDxf(quiet(() => runRecipe(structuredClone(EMPTY_RECIPE), {}, fonts, {})));
ok(typeof empty.error === 'string', `an empty weave says so: "${empty.error}"`);

console.log(`\nall ${pass} dxf checks passed`);
