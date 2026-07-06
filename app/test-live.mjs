// LIVE intent test — real model, real grounding prompt, no browser.
// Needs ANTHROPIC_API_KEY in the environment or /var/opt/apps/.intent.env
// (the ShopBot Labs shop key); SKIPS cleanly when absent, so it is safe
// in any environment but only meaningful on the workspace.
//
// Plays Brian's three prompts against the real model and asserts the
// woven recipe verifies — the closest thing to the workshop demo that
// can run unattended.
//
// Usage: node app/test-live.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_RECIPE, runRecipe, controlDefaults } from './runtime.mjs';
import { buildParseRequest, applyActions } from './intent.mjs';

let key = process.env.ANTHROPIC_API_KEY;
if (!key && existsSync('/var/opt/apps/.intent.env')) {
  key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
}
if (!key) {
  console.log('SKIP: no ANTHROPIC_API_KEY available');
  process.exit(0);
}

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

async function parse(recipe, utterance) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(buildParseRequest(recipe, utterance)),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const toolUse = data.content?.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('no tool_use block');
  return toolUse.input;
}

let recipe = structuredClone(EMPTY_RECIPE);

console.log('--- live prompt 1: "an app to engrave names" ---');
{
  const payload = await parse(recipe, 'an app to engrave names');
  const out = applyActions(recipe, payload);
  recipe = out.recipe;
  console.log(`    model: "${payload.summary}" | applied: ${out.applied.join('; ')}${out.skipped.length ? ` | skipped: ${out.skipped.join('; ')}` : ''}`);
  const hasVcarve = recipe.pipeline.some(o => o.strategy === 'vcarve_text' || o.strategy === 'outline_text');
  const hasTextCtrl = recipe.controls.some(c => c.type === 'text');
  const r = quiet(() => runRecipe(recipe, controlDefaults(recipe), FONT));
  if (hasVcarve && hasTextCtrl && r.ok) pass(`woven and verified: ${recipe.pipeline.map(o => o.strategy).join(' + ')}, controls [${recipe.controls.map(c => c.id).join(', ')}]`);
  else fail(`prompt 1: vcarve=${hasVcarve} textCtrl=${hasTextCtrl} verified=${r.ok} errors=${r.errors?.join(' | ')}`);
}

console.log('--- live prompt 2: "now add a cutout around the names…" ---');
{
  const payload = await parse(recipe, 'now add a cutout around the names, about a quarter inch of buffer, rounded corners roughly half an inch radius');
  const out = applyActions(recipe, payload);
  recipe = out.recipe;
  console.log(`    model: "${payload.summary}" | applied: ${out.applied.join('; ')}${out.skipped.length ? ` | skipped: ${out.skipped.join('; ')}` : ''}`);
  const cut = recipe.pipeline.find(o => o.strategy === 'tag_cutout');
  const r = quiet(() => runRecipe(recipe, controlDefaults(recipe), FONT));
  const mounts = (r.sbp?.match(/C9/g) ?? []).length;
  if (cut && r.ok && mounts === 2) pass(`cutout woven, two-tool job verified (C9 × 2)`);
  else fail(`prompt 2: cutout=${!!cut} verified=${r.ok} mounts=${mounts} errors=${r.errors?.join(' | ')}`);
}

console.log('--- live prompt 3: "add holding tabs to the cutout" → a FEATURE now ---');
{
  // this prompt was the original decline that grew the tabs capability;
  // the same words must now edit the cutout instead of declining
  const payload = await parse(recipe, 'add holding tabs to the cutout');
  const out = applyActions(recipe, payload);
  recipe = out.recipe;
  console.log(`    model: "${payload.summary}"${out.declined.length ? ` | declined: ${out.declined.map(d => d.what).join('; ')}` : ''}${out.skipped.length ? ` | skipped: ${out.skipped.join('; ')}` : ''}`);
  const cut = recipe.pipeline.find(o => o.strategy === 'tag_cutout');
  const tabsOn = cut && (cut.params.tabs === true || cut.params.tabs === 'true');
  const r = quiet(() => runRecipe(recipe, controlDefaults(recipe), FONT));
  if (out.declined.length === 0 && tabsOn && r.ok) {
    pass('tabs applied as a cutout param (the converted decline holds live); recipe verifies');
  } else fail(`prompt 3: declined=${out.declined.length} tabs=${JSON.stringify(cut?.params.tabs)} verified=${r.ok}`);
}

console.log('--- live prompt 4: "cut out the uploaded logo" → asset shape ---');
{
  // an uploaded SVG rides the recipe; the model must author a shapes-
  // section asset entry and reference it, not decline it
  recipe = structuredClone(EMPTY_RECIPE);
  recipe.assets.push({
    id: 'logo.svg', name: 'logo.svg', kind: 'svg',
    data: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><g transform="translate(60 40)"><path fill-rule="evenodd" d="M -50 -30 L 50 -30 L 50 30 L -50 30 Z M -12 0 A 12 12 0 1 1 12 0 A 12 12 0 1 1 -12 0 Z"/><rect x="-54" y="-8" width="8" height="16"/></g></svg>',
  });
  const payload = await parse(recipe, 'cut out the uploaded logo, about 4 inches wide');
  const out = applyActions(recipe, payload);
  recipe = out.recipe;
  console.log(`    model: "${payload.summary}" | applied: ${out.applied.join('; ')}${out.skipped.length ? ` | skipped: ${out.skipped.join('; ')}` : ''}${out.declined.length ? ` | declined: ${out.declined.map(d => d.what).join('; ')}` : ''}`);
  const assetShape = (recipe.shapes ?? []).find(s => s.asset);
  const cut = recipe.pipeline.find(o => o.strategy === 'shape_cutout' && o.params.shape === assetShape?.id);
  const r = quiet(() => runRecipe(recipe, controlDefaults(recipe), FONT));
  if (out.declined.length === 0 && assetShape && cut && r.ok && r.sbp) {
    pass(`uploaded SVG woven live: shape "${assetShape.id}" from ${assetShape.asset.of}, cutout verified → SBP`);
  } else fail(`prompt 4: declined=${out.declined.length} assetShape=${!!assetShape} cutout=${!!cut} verified=${r.ok} errors=${r.errors?.join(' | ')}`);
}

console.log('--- live prompt 5: "engrave a name and cut it out as a heart" → fit ---');
{
  // the heart field report: the model used to guess the heart's size and
  // the text overflowed. It must now reach for the fit derivation.
  recipe = structuredClone(EMPTY_RECIPE);
  const payload = await parse(recipe, 'an app to engrave a name and cut it out as a heart-shaped tag');
  const out = applyActions(recipe, payload);
  recipe = out.recipe;
  console.log(`    model: "${payload.summary}" | applied: ${out.applied.join('; ')}${out.skipped.length ? ` | skipped: ${out.skipped.join('; ')}` : ''}${out.declined.length ? ` | declined: ${out.declined.map(d => d.what).join('; ')}` : ''}`);
  const fitShape = (recipe.shapes ?? []).find(s => s.fit);
  const r = quiet(() => runRecipe(recipe, controlDefaults(recipe), FONT));
  // the strong assertion is the fit derivation; the fallback is at least
  // a verified heart with the text inside (fit check passed)
  if (fitShape && r.ok && r.sbp) {
    pass(`heart self-sizes around the name live: fit {of: ${fitShape.fit.of}}, verified → SBP`);
  } else if (r.ok && r.sbp) {
    fail(`verified, but WITHOUT fit — the model still guessed a size (shapes: ${JSON.stringify(recipe.shapes)})`);
  } else fail(`prompt 5: fit=${!!fitShape} verified=${r.ok} errors=${r.errors?.join(' | ')}`);
}

console.log(failures === 0 ? '\nALL LIVE INTENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
