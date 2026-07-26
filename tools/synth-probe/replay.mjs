// Replay the weave/verify stage from recorded actions with the CORRECT
// font shelf (fonts.mjs map), no API calls. Writes results2.jsonl.

import { readFileSync, writeFileSync } from 'node:fs';
import { PROMPTS, FAKE_SVG } from './prompts.mjs';

const LOOM = '/var/opt/apps/contributors/brian.o/fabmo-loom';
const { EMPTY_RECIPE, runRecipe, controlDefaults } = await import(`${LOOM}/app/runtime.mjs`);
const { applyActions } = await import(`${LOOM}/app/intent.mjs`);
const { registerCatalogEntries } = await import(`${LOOM}/app/catalog.mjs`);
const { FONTS } = await import(`${LOOM}/app/fonts.mjs`);

for (const g of [
  '/var/opt/apps/contributors/brian.o/furniture_designer_app/shared/loom-guest.mjs',
  '/var/opt/apps/contributors/brian.o/braille_sign_app/shared/loom-guest.mjs',
]) registerCatalogEntries((await import(g)).entries);

// the real font shelf, exactly as test.mjs loads it
const fonts = {};
for (const f of FONTS) {
  const buf = readFileSync(new URL(f.file, `file://${LOOM}/app/`).pathname);
  fonts[f.id] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const quiet = (fn) => {
  const orig = console.log, origW = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = orig; console.warn = origW; }
};

function syntheticGrids(recipe) {
  const grids = {};
  for (const t of recipe.terrains ?? []) {
    const cols = 200, rows = 150, elev = new Float32Array(cols * rows);
    for (let i = 0; i < elev.length; i++)
      elev[i] = 1500 + 600 * Math.sin((i % cols) / 17) * Math.sin(Math.floor(i / cols) / 13);
    grids[t.id] = { grid: { elev, cols, rows }, meta: { name: 'fixture', center: { lat: 36.1, lng: -112.1 }, min: 900, max: 2100 } };
  }
  return grids;
}

const byId = Object.fromEntries(PROMPTS.map(p => [p.id, p]));
const rows = readFileSync(new URL('./results.jsonl', import.meta.url).pathname, 'utf8')
  .trim().split('\n').map(JSON.parse);

const out = [];
for (const rec of rows) {
  if (!rec.rawActions) { out.push(rec); continue; }
  const p = byId[rec.id];
  const recipe = structuredClone(EMPTY_RECIPE);
  if (p.asset === 'svg') recipe.assets.push({ id: 'logo.svg', name: 'logo.svg', kind: 'svg', data: FAKE_SVG });

  const applied = applyActions(recipe, { summary: rec.summary, actions: rec.rawActions, declined: rec.declined });
  rec.applied = applied.applied;
  rec.skipped = applied.skipped;
  const drawShapes = (applied.recipe.shapes ?? []).filter(s => s.draw).map(s => s.id);
  rec.awaitingDraw = drawShapes.length ? drawShapes : undefined;
  rec.pipeline = applied.recipe.pipeline.map(o => o.strategy + (o.frame ? `@${o.frame}` : ''));

  if (!applied.recipe.pipeline.length) {
    rec.verified = null; rec.weaveErrors = []; rec.weaveWarnings = [];
  } else {
    try {
      const r = quiet(() => runRecipe(applied.recipe, controlDefaults(applied.recipe), fonts, syntheticGrids(applied.recipe)));
      rec.verified = !!r.ok;
      rec.weaveErrors = r.errors ?? [];
      rec.weaveWarnings = (r.warnings ?? []).slice(0, 6);
      rec.hasSbp = !!r.sbp;
    } catch (e) {
      rec.outcome = 'WEAVE_CRASH'; rec.error = String(e?.stack ?? e).slice(0, 800);
      out.push(rec); continue;
    }
  }

  rec.outcome =
    rec.declined.length && rec.actionKinds.length ? 'PARTIAL' :
    rec.declined.length ? 'DECLINED' :
    rec.skipped.length && !rec.applied.length ? 'ALL_SKIPPED' :
    rec.verified === false ? 'FULFILLED_UNVERIFIED' : 'FULFILLED';
  out.push(rec);
}

writeFileSync(new URL('./results2.jsonl', import.meta.url).pathname, out.map(r => JSON.stringify(r)).join('\n') + '\n');

const tally = {};
for (const r of out) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
console.log(tally);
for (const r of out) {
  const v = r.verified === false ? ' VERIFY-FAIL' : '';
  console.log(`${r.outcome.padEnd(22)}${v.padEnd(12)} ${r.id.padEnd(22)} prior=${r.prior}`);
}
