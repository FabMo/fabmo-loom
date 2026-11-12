// Measure-and-look gauntlet — the three opt-in loop features of plan
// workstreams 2 and 3, proven without a model:
//
//   measure  a client tool the model may call before authoring; the app
//            answers with real sizes from the font and shape code
//   look     per-operation SIZES and a picture of the cut on EVERY second
//            look (depth as grey levels), plus one more review question
//   ladder   a whole-request decline on an empty recipe is sent back down
//            the fallback ladder once
//
// Each is OFF unless the caller asks: the first section proves a request
// built without them is byte-identical to what it was.
//
// Usage: node test/look-test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_RECIPE, runRecipe, controlDefaults } from '../app/runtime.mjs';
import { buildParseRequest, buildObservation, observationText, buildReviseRequest, runIntentLoop, measureItems, imageSize, MEASURE_TOOL, MAX_MEASURES, DEFAULT_MODEL } from '../app/intent.mjs';
import { weaveGroups, snapshotWeave } from '../app/snapshot.mjs';
import { FONTS } from '../app/fonts.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const FONT_SHELF = {};
for (const f of FONTS) {
  const b = readFileSync(join(app, f.file));
  FONT_SHELF[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
let failures = 0;
const ok = (msg, cond, detail = '') => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ FAIL ${msg}${detail ? ` — ${detail}` : ''}`); } };
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
const weave = async (rec) => quiet(() => runRecipe(rec, controlDefaults(rec), FONT_SHELF, {}));
const empty = () => structuredClone(EMPTY_RECIPE);
const names = (req) => req.tools.map(t => t.name).join(',');
const act = (input, id = 'tu_act') => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id, name: 'apply_recipe_actions', input }] });
const ask = (items, id = 'tu_m') => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'tool_use', id, name: 'measure', input: { items } }] });
const SIGN = {
  summary: 'A welcome sign.', claims: { faces: 'top', pieces: 1 },
  actions: [
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: 'WELCOME', letterHeight: 1 } } },
    { kind: 'add_operation', operation: { id: 'cutout', strategy: 'tag_cutout', params: {} } },
  ],
};

console.log('--- off by default: nothing changes for a caller that does not ask ---');
{
  const plain = buildParseRequest(empty(), 'a sign', { model: DEFAULT_MODEL });
  const again = buildParseRequest(empty(), 'a sign', { model: DEFAULT_MODEL, measure: false, ladder: false });
  ok('no flags: one tool, and no measure or ladder rule in the prompt', names(plain) === 'apply_recipe_actions' && !/MEASURE BEFORE YOU GUESS/.test(plain.system) && !/NEVER END AT NOTHING/.test(plain.system));
  ok('explicit false is the same request, byte for byte', JSON.stringify(plain) === JSON.stringify(again));
  const seen = [];
  let n = 0;
  const out = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, call: async (r) => { seen.push(r); return act(++n === 1 ? SIGN : { summary: 'Built.', actions: [] }); } });
  const res = seen[1].messages[2].content[0];
  ok('default loop: the second look is plain text — no picture, no SIZES, the old review text', typeof res.content === 'string' && !/SIZES \(/.test(res.content) && !/PICTURE OF THE CUT/.test(res.content) && !/would a stranger/.test(seen[1].messages[2].content[1].text) && names(seen[0]) === 'apply_recipe_actions');
  ok('default loop reports no measures and no ladder', out.measures.length === 0 && out.laddered === false);
  let calls = 0;
  const dec = await runIntentLoop({ recipe: empty(), utterance: 'a bull', weave, call: async () => { calls++; return act({ summary: 'No.', actions: [], declined: [{ what: 'a bull outline', why: 'likeness' }] }); } });
  ok('default loop: a pure decline still ends after one call', calls === 1 && dec.turns.length === 1);
}

console.log('--- measure: real sizes from the font and shape code ---');
{
  const m = await measureItems(empty(), { items: [
    { text: 'WELCOME', letterHeight: 1 },
    { text: 'WELCOME', letterHeight: 2 },
    { text: 'WELCOME', letterHeight: 1, strategy: 'pocket_text' },
    { shape: { glyph: { of: 'men', width: 3 } } },
    { shape: { path: 'M -2 -1 L 2 -1 L 2 1 L -2 1 Z' } },
  ] }, weave);
  const [a, b, c, g, p] = m.items;
  // the same text woven for real, as the reference
  const wr = await weave({ ...empty(), pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: 'WELCOME', letterHeight: 1 } }] });
  const bb = wr.preview.built[0].r.bbox;
  ok(`text measures what a weave makes of it (${a.w}" × ${a.h}")`, Math.abs(a.w - (bb.maxX - bb.minX)) < 0.002 && Math.abs(a.h - (bb.maxY - bb.minY)) < 0.002 && a.w > 2 && a.h > 0.5 && a.h <= 1.001, JSON.stringify(a));
  ok('twice the letter height is twice the size', Math.abs(b.w - 2 * a.w) < 0.01 && Math.abs(b.h - 2 * a.h) < 0.01, JSON.stringify(b));
  ok('another text strategy measures too', c.w > 2 && !c.error, JSON.stringify(c));
  ok(`a glyph at width 3 measures 3" wide (${g.w} × ${g.h})`, Math.abs(g.w - 3) < 0.01 && g.h > 0.5, JSON.stringify(g));
  ok('an authored path measures its own extent', p.w === 4 && p.h === 2, JSON.stringify(p));
  ok('the answer is text the model can read, numbered, in inches', /MEASURED by the app/.test(m.text) && /1\. text "WELCOME"/.test(m.text) && /5\. shape \(path\): 4" wide × 2" tall/.test(m.text), m.text);

  const withShape = { ...empty(), controls: [{ id: 'w', type: 'number', label: 'w', default: 5 }], shapes: [{ id: 'plate', path: 'M {-w/2} -1 L {w/2} -1 L {w/2} 1 L {-w/2} 1 Z' }] };
  const s = await measureItems(withShape, { items: [{ shapeId: 'plate' }, { shape: { inset: { of: 'plate', by: 0.5 } } }, { shapeId: 'nope' }, { shape: { fit: { of: 'plate', margin: 0.2 } } }, { shape: { bogus: 1 } }, {}, { text: 'x', letterHeight: 1 }] }, weave);
  ok('a shape id in the recipe measures with its controls at their defaults', s.items[0].w === 5 && s.items[0].h === 2, JSON.stringify(s.items[0]));
  ok('a derivation over a recipe shape measures', s.items[1].w === 4 && s.items[1].h === 1, JSON.stringify(s.items[1]));
  ok('every miss is an answer with a reason, never a throw', /no shape "nope"/.test(s.items[2].error) && /no size until the weave/.test(s.items[3].error) && s.items[4].error && s.items[5].error, JSON.stringify(s.items.slice(2)));
  ok('six items per call, and the answer says so', s.items.length === 6 && /only the first 6 items/.test(s.text));
  const bad = await measureItems(empty(), { items: [{ text: 'A', letterHeight: 1, font: 'no-such-font' }] }, weave);
  ok('an unknown font comes back as the strategy\'s own error', /unknown font/.test(bad.items[0].error ?? ''), JSON.stringify(bad.items[0]));
  const junk = await measureItems(empty(), 'nonsense', weave);
  ok('a malformed call is an answer too', junk.items.length === 0 && /nothing to measure/.test(junk.text));
  const noWeave = await measureItems(empty(), { items: [{ text: 'A', letterHeight: 1 }] }, null);
  ok('text with no weave to measure it says so', /no weave/.test(noWeave.items[0].error));
}

console.log('--- measure in the loop: asked, answered, then the build ---');
{
  const offer = buildParseRequest(empty(), 'a sign', { model: DEFAULT_MODEL, measure: true });
  ok('offered: measure rides last in the tool list with its rule', names(offer) === 'apply_recipe_actions,measure' && /MEASURE BEFORE YOU GUESS/.test(offer.system) && offer.tool_choice.type === 'auto');
  const forced = buildParseRequest(empty(), 'a sign', { model: 'claude-opus-4-8', measure: true });
  ok('a model forced onto apply_recipe_actions is not offered a tool it could never call', names(forced) === 'apply_recipe_actions' && !/MEASURE BEFORE YOU GUESS/.test(forced.system));

  const seen = [], stages = [];
  let n = 0;
  const out = await runIntentLoop({
    recipe: empty(), utterance: 'WELCOME on a 6 inch plaque', weave, measure: true, onStage: (s) => stages.push(s.stage),
    call: async (r) => { seen.push(r); n++; return n === 1 ? ask([{ text: 'WELCOME', letterHeight: 1 }]) : n === 2 ? act(SIGN) : act({ summary: 'Built and verified.', actions: [] }); },
  });
  const answer = seen[1].messages[2].content[0];
  ok('the measure call is answered as a tool_result in the SAME conversation, tools unchanged', seen.length === 3 && seen[1].messages.length === 3 && seen[1].messages[1].role === 'assistant' && answer.type === 'tool_result' && answer.tool_use_id === 'tu_m' && /WELCOME.*wide ×/.test(answer.content) && names(seen[1]) === names(seen[0]) && seen[1].system === seen[0].system, JSON.stringify(answer).slice(0, 300));
  ok('the thinking block rides back unchanged with the call it came from', seen[1].messages[1].content[0].type === 'thinking');
  ok('then the build applies and gets its ordinary second look', out.turns.length === 2 && out.recipe.pipeline.length === 2 && out.summary === 'Built and verified.' && seen[2].messages[4].content[0].tool_use_id === 'tu_act');
  ok('the loop reports what was measured, and a measure is not a turn', out.measures.length === 1 && out.measures[0].items[0].w > 2 && out.usage.calls === 3 && stages.includes('measure'));

  // a model that keeps measuring: MAX_MEASURES answers, one refusal, then a nudge that answers the open call
  const seen2 = [];
  let k = 0;
  const greedy = await runIntentLoop({
    recipe: empty(), utterance: 'a sign', weave, measure: true,
    call: async (r) => { seen2.push(r); k++; return k <= MAX_MEASURES + 2 ? ask([{ text: 'A', letterHeight: 1 }], `tu_m${k}`) : k === MAX_MEASURES + 3 ? act(SIGN) : act({ summary: 'Done.', actions: [] }); },
  });
  const refusal = seen2[MAX_MEASURES + 1].messages.at(-1).content[0];
  const nudged = seen2[MAX_MEASURES + 2].messages.at(-1).content;
  ok(`only ${MAX_MEASURES} measurements are made; the next call is told there are no more`, greedy.measures.length === MAX_MEASURES && refusal.is_error === true && /No more measurements/.test(refusal.content), JSON.stringify(refusal));
  ok('a measure call left open is answered before the nudge, so the conversation stays valid', Array.isArray(nudged) && nudged[0].type === 'tool_result' && nudged[0].tool_use_id === `tu_m${MAX_MEASURES + 2}` && /Call apply_recipe_actions now/.test(nudged[1].text) && greedy.recipe.pipeline.length === 2, JSON.stringify(nudged).slice(0, 300));
  // every tool_use in every request has its tool_result in the next message
  const valid = seen2.every(r => r.messages.every((m, i) => m.role !== 'assistant' || !Array.isArray(m.content) || m.content.filter(b => b.type === 'tool_use').every(b => Array.isArray(r.messages[i + 1]?.content) && r.messages[i + 1].content.some(x => x.type === 'tool_result' && x.tool_use_id === b.id))));
  ok('every tool call in every request is answered by the next message', valid);
}

console.log('--- look: sizes and a picture on every second look ---');
{
  const rec = { ...empty(), stock: { thickness: 0.75 }, shapes: [{ id: 'dot', path: 'M 3 -0.4 L 3.8 -0.4 L 3.8 0.4 L 3 0.4 Z' }, { id: 'pan', path: 'M -2 -1.2 L 2 -1.2 L 2 1.2 L -2 1.2 Z' }], pipeline: [
    { id: 'shallow', strategy: 'pocket_shape', params: { shape: 'pan', depth: 0.1 } },
    { id: 'deep', strategy: 'pocket_shape', params: { shape: 'dot', depth: 0.5 } },
    { id: 'cutout', strategy: 'tag_cutout', params: {} },
  ] };
  const wr = await weave(rec);
  const groups = weaveGroups(wr);
  const shades = groups.filter(g => g.shade !== 'part' && g.shade !== 'hole').map(g => g.shade);
  ok(`the weave verifies and its recesses shade by depth (${shades.join(', ')})`, wr.ok && shades.length >= 2 && shades.every(Number.isFinite) && shades[0] > shades.at(-1) && shades[0] > 120 && shades.at(-1) < 100, JSON.stringify({ ok: wr.ok, errors: wr.errors, shades }));
  ok('the deeper recess is painted last, so it shows inside the shallow one', groups.filter(g => g.depth != null).every((g, i, a) => i === 0 || a[i - 1].depth <= g.depth));
  const snap = snapshotWeave(wr);
  ok('the picture is a readable PNG', snap && imageSize(snap)?.w === snap.w && snap.parts === 1);

  const obs = buildObservation({ applied: ['x'], skipped: [] }, wr, rec, { snapshot: snap, sizes: true });
  const txt = observationText(obs);
  const z = Object.fromEntries(obs.sizes.map(s => [s.id, s]));
  ok(`SIZES lists each operation as woven (${obs.sizes.map(s => `${s.id} ${s.w}×${s.h}`).join(', ')})`, z.shallow?.w === 4 && z.shallow?.h === 2.4 && z.deep?.w === 0.8 && z.deep?.cx === 3.4 && z.cutout?.w > 5.8 && /SIZES \(measured by the app.*shallow 4 × 2\.4 centered at \(0, 0\); deep 0\.8 × 0\.8 centered at \(3\.4, 0\)/.test(txt), txt);
  ok('with no user picture the cut picture asks what a stranger would see', /PICTURE OF THE CUT/.test(txt) && /never read the request/.test(txt) && /darker = deeper/.test(txt) && !/user's picture/.test(txt));
  const plain = observationText(buildObservation({ applied: ['x'], skipped: [] }, wr, rec));
  ok('without the option the observation has neither', !/SIZES \(/.test(plain) && !/PICTURE OF THE CUT/.test(plain));

  const seen = [];
  let n = 0;
  const out = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, look: true, call: async (r) => { seen.push(r); return act(++n === 1 ? SIGN : { summary: 'Built.', actions: [] }); } });
  const res = seen[1].messages[2].content[0], text = seen[1].messages[2].content[1].text;
  ok('look on: the second look carries text + the picture of the cut, with no user picture attached', Array.isArray(res.content) && res.content[1]?.type === 'image' && res.content[1].source.media_type === 'image/png' && /SIZES \(/.test(res.content[0].text) && out.turns[0].snapshot?.w > 0);
  ok('…and the review asks the stranger question as step 6, before the closing line', /6\. LOOK at the PICTURE OF THE CUT and the SIZES/.test(text) && /would a stranger/.test(text) && /An empty actions list is the right answer/.test(text) && text.indexOf('6. LOOK') < text.indexOf('An empty actions list'));
  ok('the first request is untouched by look (same tools, same prompt as a plain one)', JSON.stringify(seen[0]) === JSON.stringify(buildParseRequest(empty(), 'a welcome sign', {})));
}

console.log('--- ladder: a whole-request decline is walked down once ---');
{
  const withRule = buildParseRequest(empty(), 'a bull', { model: DEFAULT_MODEL, ladder: true });
  ok('the ladder rule is in the prompt only when asked for, and keeps the likeness rule', /NEVER END AT NOTHING/.test(withRule.system) && /likeness rule still stands/.test(withRule.system));
  const DECLINE = { summary: 'I cannot draw a bull.', actions: [], declined: [{ what: 'a bull silhouette', why: 'a likeness cannot be freehanded' }] };
  const PLAQUE = { summary: 'A plaque that reads BULL instead of a bull outline.', claims: { faces: 'top', pieces: 1 }, declined: DECLINE.declined, actions: [
    { kind: 'add_operation', operation: { id: 'name', strategy: 'vcarve_text', params: { text: 'BULL', letterHeight: 1.5 } } },
    { kind: 'add_operation', operation: { id: 'cutout', strategy: 'tag_cutout', params: {} } },
  ] };
  const seen = [];
  let n = 0;
  const out = await runIntentLoop({ recipe: empty(), utterance: 'cut out a bull', weave, ladder: true, call: async (r) => { seen.push(r); n++; return act(n === 1 ? DECLINE : n === 2 ? PLAQUE : { summary: 'A BULL plaque, verified; the outline itself was not made.', actions: [], declined: DECLINE.declined }, `tu${n}`); } });
  const back = seen[1].messages[2].content;
  ok('the decline comes back as a tool_result with the ladder text', back[0].type === 'tool_result' && back[0].tool_use_id === 'tu1' && /PIPELINE: EMPTY/.test(back[0].content) && /NOTHING WAS BUILT/.test(back[1].text) && /likeness rule still stands/.test(back[1].text));
  ok('the model builds a depiction, which gets an ordinary second look', seen.length === 3 && /WEAVE: VERIFIED/.test(seen[2].messages[4].content[0].content) && out.recipe.pipeline.length === 2 && out.laddered === true && out.turns[0].laddered === true);
  ok('the user gets the final summary and the decline is still on record', /BULL plaque/.test(out.summary) && out.declined.length === 1 && out.declined[0].what === 'a bull silhouette');

  let calls = 0;
  const firm = await runIntentLoop({ recipe: empty(), utterance: 'something unsafe', weave, ladder: true, call: async () => { calls++; return act(DECLINE, `tu${calls}`); } });
  ok('a model that stands by its decline is asked once, not twice', calls === 2 && firm.recipe.pipeline.length === 0 && firm.laddered === true && firm.declined.length === 1 && firm.summary === DECLINE.summary);

  calls = 0;
  const built = { ...empty(), pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: 'HI', letterHeight: 1 } }] };
  await runIntentLoop({ recipe: built, utterance: 'add a bull', weave, ladder: true, call: async () => { calls++; return act(DECLINE); } });
  ok('a decline on a recipe that already cuts something is left alone', calls === 1);
  calls = 0;
  await runIntentLoop({ recipe: empty(), utterance: 'what fonts are there?', weave, ladder: true, call: async () => { calls++; return act({ summary: 'bold-sans and others.', actions: [] }); } });
  ok('an answered question (no decline) is not a zero-cut failure', calls === 1);
  calls = 0;
  await runIntentLoop({ recipe: empty(), utterance: 'a bull', weave, ladder: true, mode: 'off', call: async () => { calls++; return act(DECLINE); } });
  ok('with the loop off there is no second call to make', calls === 1);
  const lad = buildReviseRequest(withRule, [{ type: 'tool_use', id: 't', name: 'apply_recipe_actions', input: {} }], 't', buildObservation({ applied: [], skipped: [] }, null, empty()), { ladder: true });
  ok('the ladder request reuses the system prompt and tools (cached prefix)', lad.system === withRule.system && lad.tools === withRule.tools);
}

console.log('--- subjects: a likeness is drawn from a fetched photo, never from memory ---');
{
  const PHOTO = { title: 'Bull in a field.jpg', artist: 'A. Farmer', license: 'CC BY-SA 4.0', url: 'https://commons.example/bull', media_type: 'image/jpeg', data: '/9j/AAAA', width: 900, height: 600 };
  const FOUND = { ok: true, subject: 'Bull', page: { title: 'Bull', description: 'adult male cattle', url: 'https://en.wikipedia.example/Bull', qid: 'Q1' }, facts: { extract: 'A bull is…', measures: [], heightM: [], floors: [], lengthM: [], widthM: [] }, photo: PHOTO, alternates: [], others: [] };
  const lookFor = (subject, kind) => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'tu_ref', name: 'find_reference', input: { subject, ...(kind ? { kind } : {}) } }] });
  const BULL = { summary: 'A bull.', observed: ['humped shoulders', 'short horns', 'heavy neck'], claims: { faces: 'top', pieces: 1 }, actions: [
    { kind: 'set_shape', shape: { id: 'bull', path: 'M -3 -2 L 3 -2 L 3.5 0 L 2 2 L -2 2.4 L -3.5 0.5 Z' } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'shape_cutout', params: { shape: 'bull' } } },
  ] };

  const plainOffer = buildParseRequest(empty(), 'a bull', { model: DEFAULT_MODEL, lookUp: true });
  const offer = buildParseRequest(empty(), 'a bull', { model: DEFAULT_MODEL, lookUp: true, subjects: true });
  ok('without the option the lookup is buildings only, as before', !/A LIKENESS WITH NO PICTURE ATTACHED/.test(plainOffer.system) && !plainOffer.tools[1].input_schema.properties.kind);
  ok('with it: the tool takes kind "subject" and the rule says look it up instead of declining', /A LIKENESS WITH NO PICTURE ATTACHED/.test(offer.system) && offer.tools[1].name === 'find_reference' && offer.tools[1].input_schema.properties.kind.enum.includes('subject') && /never look those up/.test(offer.system));
  ok('the option does nothing without a lookup to call', JSON.stringify(buildParseRequest(empty(), 'a bull', { model: DEFAULT_MODEL, subjects: true })) === JSON.stringify(buildParseRequest(empty(), 'a bull', { model: DEFAULT_MODEL })));

  const seen = [], asked = [];
  let n = 0;
  const out = await runIntentLoop({
    recipe: empty(), utterance: 'cut out a bull', weave, subjects: true, search: true,
    lookUp: async (subject) => { asked.push(subject); return structuredClone(FOUND); },
    call: async (r) => { seen.push(r); n++; return n === 1 ? lookFor('Bull', 'subject') : n === 2 ? act(BULL) : act({ summary: 'A simple bull drawn from a reference photo by A. Farmer.', actions: [] }); },
  });
  const first = seen[1].messages[0].content;
  const refText = first.find(b => b.type === 'text' && /REFERENCE —/.test(b.text))?.text ?? '';
  ok('the turn starts over with the photo attached and the likeness notes, credited', asked[0] === 'Bull' && first[0].type === 'image' && /LOOK AT, not data/.test(refText) && /"Bull in a field\.jpg" by A\. Farmer, CC BY-SA 4\.0/.test(refText) && /Never trace the photograph/.test(refText) && !/MASSING/.test(refText), refText.slice(0, 300));
  ok('the photo-likeness rule rides with it, and no web search does', /A REFERENCE PHOTOGRAPH IS ATTACHED/.test(seen[1].system) && /A LIKENESS FROM THE PICTURE/.test(seen[1].system) && !names(seen[1]).includes('web_search'), names(seen[1]));
  const look2 = seen[2].messages[2].content[0];
  ok('the second look carries the picture of the cut, to compare with the photo', Array.isArray(look2.content) && look2.content[1]?.type === 'image' && /PICTURE OF THE CUT/.test(look2.content[0].text));
  ok('the build verifies and the loop records a subject lookup', out.recipe.pipeline.length === 1 && out.lookups[0].kind === 'subject' && out.reference?.photo?.artist === 'A. Farmer' && /A\. Farmer/.test(out.summary));

  // a refused subject, and a found article with no photo: nothing in view → the likeness rule stands
  const runWith = async (found) => { const s2 = []; let k = 0; await runIntentLoop({ recipe: empty(), utterance: 'x', weave, subjects: true, lookUp: async () => structuredClone(found), call: async (r) => { s2.push(r); return ++k === 1 ? lookFor('X', 'subject') : act({ summary: 'Declined.', actions: [], declined: [{ what: 'x', why: 'y' }] }); } }); return s2[1]; };
  const refused = await runWith({ ok: false, subject: 'X', reason: 'refused', message: '"X" is a fictional character — the app does not fetch a likeness of people, logos or brands', others: [] });
  const refusedText = refused.messages[0].content[0].text;
  ok('a refused subject: told to decline, no photo rule, no drawing from memory', /likeness rule stands: decline/.test(refusedText) && !/A LIKENESS FROM THE PICTURE/.test(refused.system) && !/from what you know/.test(refusedText), refusedText);
  const noPhoto = await runWith({ ...FOUND, photo: null });
  const noPhotoText = noPhoto.messages[0].content[0].text;
  ok('an article with no usable photo: the RECOGNIZABLE rule stands', /no usable photograph/.test(noPhotoText) && /RECOGNIZABLE rule stands/.test(noPhotoText) && !/A LIKENESS FROM THE PICTURE/.test(noPhoto.system) && noPhoto.messages[0].content.every(b => b.type !== 'image'), noPhotoText);
  const missing = await runWith({ ok: false, subject: 'X', reason: 'not-found', message: 'Wikipedia has no article matching "X"', others: [] });
  ok('nothing found: one retry offered, otherwise decline — never "build from what you know"', /ONCE more with kind "subject"/.test(missing.messages[0].content[0].text) && /RECOGNIZABLE rule stands/.test(missing.messages[0].content[0].text) && !/from what you know/.test(missing.messages[0].content[0].text));

  // a building lookup under the same option is untouched
  const s3 = []; let k3 = 0;
  await runIntentLoop({ recipe: empty(), utterance: 'x', weave, subjects: true, lookUp: async () => structuredClone({ ...FOUND, subject: 'Spire Hall' }), call: async (r) => { s3.push(r); return ++k3 === 1 ? lookFor('Spire Hall') : act({ summary: 'ok', actions: [] }); } });
  ok('kind omitted = a structure: the massing notes, as before', /MASSING only/.test(s3[1].messages[0].content[1].text) && /A REFERENCE IS ATTACHED/.test(s3[1].system) && !/A REFERENCE PHOTOGRAPH IS ATTACHED/.test(s3[1].system));
}

console.log('--- cascade: small model first, escalate instead of failing or declining ---');
{
  const { runIntentCascade, escalateReason, CASCADE_MODELS } = await import('../app/intent.mjs');
  const BAD = { summary: 'A cutout.', claims: { faces: 'top', pieces: 1 }, actions: [{ kind: 'add_operation', operation: { id: 'cutout', strategy: 'tag_cutout', params: {} } }] };   // nothing to cut around: fails
  const DECLINE = { summary: 'No.', actions: [], declined: [{ what: 'it', why: 'cannot' }] };
  const done = (s) => ({ summary: s, actions: [] });
  // a scripted model per id: each entry answers that model's calls in order
  // the judge is its own request (one tool, report_check): scripted separately
  const verdictOf = (v) => ({ stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu_judge', name: 'report_check', input: v }] });
  const KEEP = { subject: 'a welcome sign', on_subject: true, missing: [], reduced: false, declined_makeable: [], verdict: 'keep', why: 'matches' };
  const script = (plan) => { const n = {}; const seen = []; const judged = []; return { seen, judged, call: async (r) => {
    if (r.tools?.[0]?.name === 'report_check') { judged.push(r); const j = plan.judge ?? KEEP; if (j instanceof Error) throw j; return j === 'prose' ? { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'looks fine' }] } : verdictOf(j); } seen.push(r.model); n[r.model] = (n[r.model] ?? 0) + 1; const steps = plan[r.model]; const step = steps[Math.min(n[r.model], steps.length) - 1]; if (step instanceof Error) throw step; return act(step, `tu_${r.model}_${n[r.model]}`); } }; };
  const run = (plan, extra = {}) => { const sc = script(plan); const tiers = []; return runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: sc.call, ...extra }, { models: ['small', 'big'], onTier: (t) => tiers.push(t) }).then(out => ({ out, seen: sc.seen, tiers, judged: sc.judged })); };

  ok('the default ladder is the small model, then the default model', CASCADE_MODELS.length === 2 && /haiku/.test(CASCADE_MODELS[0]) && CASCADE_MODELS[1] === DEFAULT_MODEL);
  const kept = await run({ small: [SIGN, done('Built and verified.')], big: [SIGN] });
  ok('a small-model build that verifies with nothing declined is kept: the big model is never called', kept.out.tier === 0 && kept.out.model === 'small' && !kept.seen.includes('big') && kept.out.attempts.length === 1 && kept.out.attempts[0].reason === null && kept.out.recipe.pipeline.length === 2);

  const failed = await run({ small: [BAD, done('Still failing.'), done('x')], big: [SIGN, done('Built by the big model.')] });
  ok('a build that does not verify escalates, and the user gets the big model\'s result', failed.out.tier === 1 && failed.out.summary === 'Built by the big model.' && /did not verify/.test(failed.out.attempts[0].reason) && failed.out.attempts[1].reason === null && failed.tiers[0].model === 'big' && /did not verify/.test(failed.tiers[0].reason), JSON.stringify(failed.out.attempts));
  ok('the big attempt starts from the ORIGINAL recipe, not the small model\'s leftovers', failed.out.recipe.pipeline.map(o => o.id).join() === 'engrave,cutout');
  ok('each attempt\'s usage is reported under its own model, for pricing', failed.out.usageByModel.small.calls >= 2 && failed.out.usageByModel.big.calls === 2);

  const declined = await run({ small: [DECLINE], big: [SIGN, done('Built instead of declined.')] });
  ok('a decline escalates rather than reaching the user', declined.out.tier === 1 && declined.out.attempts[0].reason === 'declined the request' && declined.out.declined.length === 0);
  const partial = await run({ small: [{ ...SIGN, declined: [{ what: 'gold leaf', why: 'no' }] }, done('Sign, no gold.')], big: [SIGN, done('Sign.')] });
  ok('a build that declined part of the ask is the judge\'s call: a real limit of the machine stays at the small model, decline and all', partial.out.tier === 0 && partial.out.attempts[0].reason === null && partial.out.declined.length === 1 && partial.judged.length === 1 && /gold leaf — no/.test(partial.judged[0].messages[0].content.map(b => b.text ?? '').join('\n')));
  const lazy = await run({ small: [{ ...SIGN, declined: [{ what: 'the other seven bars', why: 'not authored yet' }] }, done('One bar.')], big: [SIGN, done('All eight.')], judge: { ...KEEP, declined_makeable: ['the other seven bars'] } });
  ok('a decline of something this machine can make escalates, whatever word the judge chose', lazy.out.tier === 1 && /judge: declined what this machine can make: the other seven bars/.test(lazy.out.attempts[0].reason) && lazy.out.attempts[0].judge.makeable.length === 1, JSON.stringify(lazy.out.attempts[0]));
  const unjudged = script({ small: [{ ...SIGN, declined: [{ what: 'gold leaf', why: 'no' }] }, done('Sign, no gold.')], big: [SIGN, done('Sign.')] });
  const uj = await runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: unjudged.call }, { models: ['small', 'big'], judge: false });
  ok('with the judge off, any decline escalates as before', uj.tier === 1 && uj.attempts[0].reason === 'declined part of the request');

  const threw = await run({ small: [new Error('API 400: bad request')], big: [SIGN, done('Recovered.')] });
  ok('a small-model error is an escalation, not the user\'s error', threw.out.tier === 1 && /failed: API 400/.test(threw.out.attempts[0].reason) && threw.out.summary === 'Recovered.');
  let stopped = null;
  try { await run({ small: [Object.assign(new Error('stopped'), { name: 'AbortError' })], big: [SIGN] }); } catch (e) { stopped = e; }
  ok('a cancel is never escalated', stopped?.name === 'AbortError');

  const sc = script({ small: [DECLINE], big: [DECLINE, DECLINE] });
  const both = await runIntentCascade({ recipe: empty(), utterance: 'x', weave, call: sc.call }, { models: ['small', 'big'] });
  const bigSecond = sc.seen.filter(m => m === 'big').length;
  ok('the top rung walks the fallback ladder before a decline stands', both.tier === 1 && both.laddered === true && bigSecond === 2 && both.declined.length === 1);

  const worse = await run({ small: [{ ...SIGN, declined: [{ what: 'gold leaf', why: 'no' }] }, done('Sign, no gold.')], big: [{ summary: 'x', actions: [{ kind: 'remove_operation', id: 'engrave' }] }, done('broken'), done('broken')], judge: { ...KEEP, declined_makeable: ['gold leaf'] } });
  ok('if the big model ends unverified but the small build verified, the build that cuts is what the user gets', worse.out.tier === 0 && worse.out.recipe.pipeline.length === 2 && worse.out.attempts.length === 2 && worse.out.attempts[1].ok === false, JSON.stringify(worse.out.attempts));

  const q = await run({ small: [done('The fonts are bold-sans and others.')], big: [SIGN] });
  ok('an answered question is kept at the small model', q.out.tier === 0 && q.out.attempts[0].reason === null);
  ok('escalateReason: verified and clean is null; a user-drawn placeholder escalates', escalateReason({ recipe: { pipeline: [1], shapes: [{ id: 'a', draw: { of: 'a' } }] }, declined: [], turns: [{ applied: ['x'], skipped: [] }] }, { ok: true }, empty()) === 'left the drawing to the user');

  // ---- the judge: verified is not the same as what was asked for ----
  const { buildFacts, buildJudgeRequest, judgeBuild } = await import('../app/intent.mjs');
  ok('a kept build was judged first: one judge request, with the ask, the facts and the picture — and not the builder\'s summary', kept.judged.length === 1 && (() => { const c = kept.judged[0].messages[0].content; const t = c.map(b => b.text ?? '').join('\n'); return /THE REQUEST:\na welcome sign/.test(t) && /OPERATIONS, in machining order \(2\)/.test(t) && /engrave: vcarve_text — text=WELCOME/.test(t) && c.some(b => b.type === 'image') && !/Built and verified\./.test(t) && kept.judged[0].system.length < 3000 && kept.judged[0].tools.length === 1; })());
  ok('the verdict rides on the attempt, for the log', kept.out.attempts[0].judge?.verdict === 'keep');
  const offSubject = await run({ small: [SIGN, done('A sign.')], big: [SIGN, done('The real thing.')], judge: { subject: 'a name tag', on_subject: false, missing: ['the jig base'], reduced: false, verdict: 'redo', why: 'a tag, not a jig' } });
  ok('a build that verifies but is the WRONG THING escalates', offSubject.out.tier === 1 && /judge: off-subject \(a name tag\)/.test(offSubject.out.attempts[0].reason) && offSubject.out.summary === 'The real thing.', JSON.stringify(offSubject.out.attempts[0]));
  const thin = await run({ small: [SIGN, done('A sign.')], big: [SIGN, done('All eight.')], judge: { subject: 'one bar', on_subject: true, missing: [], reduced: true, verdict: 'keep', why: 'one of eight' } });
  ok('"reduced" overrides a judge that still said keep: findings decide, not the word', thin.out.tier === 1 && /a reduced version/.test(thin.out.attempts[0].reason));
  const missing = await run({ small: [SIGN, done('A sign.')], big: [SIGN, done('With the holes.')], judge: { subject: 'a panel', on_subject: true, missing: ['three of the six toggle holes'], reduced: false, verdict: 'keep', why: '' } });
  ok('so does something named in the request and missing from the build', missing.out.tier === 1 && /judge: missing three of the six toggle holes/.test(missing.out.attempts[0].reason));
  // ---- the judge's findings go up with the build ----
  const { reviewNote, plainBuiltSummary } = await import('../app/intent.mjs');
  const capture = (plan) => { const sc = script(plan); const reqs = []; return { sc, reqs, call: async (r) => { if (r.tools?.[0]?.name !== 'report_check') reqs.push(r); return sc.call(r); } }; };
  const askText = (r) => { const c = r.messages[0].content; return typeof c === 'string' ? c : c.map(b => b.text ?? '').join('\n'); };
  const FIX = { summary: 'Sign with all six holes.', claims: SIGN.claims, actions: [{ kind: 'set_operation', id: 'engrave', params: { text: 'HELLO' } }] };
  const fx = capture({ small: [SIGN, done('A sign.')], big: [FIX, done('Sign with all six holes.')], judge: { subject: 'a panel', on_subject: true, missing: ['three of the six toggle holes'], reduced: false, declined_makeable: [], verdict: 'redo', why: '' } });
  const fixed = await runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: fx.call }, { models: ['small', 'big'] });
  const bigFirst = fx.reqs.find(r => r.model === 'big');
  ok('a build sent up for a gap is FIXED: the big model starts from the small build, with the findings after the ask', fixed.tier === 1 && /"engrave"/.test(bigFirst.system.split('CURRENT RECIPE:')[1]) && /^a welcome sign\n\nA CHECKER'S FINDINGS ON THE BUILD IN THE CURRENT RECIPE/.test(askText(bigFirst)) && /- missing: three of the six toggle holes/.test(askText(bigFirst)) && fixed.attempts[1].handoff === 'fix', askText(bigFirst).slice(0, 300));
  ok('…and its edits land on that build', fixed.recipe.pipeline.length === 2 && fixed.recipe.pipeline[0].params.text === 'HELLO' && fixed.summary === 'Sign with all six holes.');
  const off = capture({ small: [SIGN, done('A sign.')], big: [SIGN, done('The real thing.')], judge: { subject: 'a name tag', on_subject: false, missing: [], reduced: false, declined_makeable: [], verdict: 'redo', why: 'a tag, not a jig' } });
  const offOut = await runIntentCascade({ recipe: empty(), utterance: 'a router jig', weave, call: off.call }, { models: ['small', 'big'] });
  const offFirst = off.reqs.find(r => r.model === 'big');
  ok('the WRONG thing is not fixed: the big model starts from the original recipe and is told what not to repeat', offOut.tier === 1 && !/"engrave"/.test(offFirst.system.split('CURRENT RECIPE:')[1]) && /A CHECKER'S FINDINGS ON AN EARLIER ATTEMPT/.test(askText(offFirst)) && /wrong thing \(a name tag\)/.test(askText(offFirst)) && offOut.attempts[1].handoff === 'findings');
  const cold = capture({ small: [BAD, done('Still failing.'), done('x')], big: [SIGN, done('Built.')] });
  await runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: cold.call }, { models: ['small', 'big'] });
  ok('an escalation the judge never saw carries no findings', askText(cold.reqs.find(r => r.model === 'big')) === 'a welcome sign');
  const lz = capture({ small: [{ ...SIGN, declined: [{ what: 'the other seven bars', why: 'not authored yet' }, { what: 'gold leaf', why: 'no' }] }, done('One bar.')], big: [done('Nothing to add.')], judge: { ...KEEP, declined_makeable: ['the other seven bars'] } });
  const lzOut = await runIntentCascade({ recipe: empty(), utterance: 'eight bars', weave, call: lz.call }, { models: ['small', 'big'] });
  ok('a makeable decline goes up as a finding; a fix that changes nothing keeps the build and its real-limit decline only', /declined, though a 3-axis router[^\n]*: the other seven bars/.test(askText(lz.reqs.find(r => r.model === 'big'))) && lzOut.recipe.pipeline.length === 2 && lzOut.declined.map(d => d.what).join() === 'gold leaf', JSON.stringify(lzOut.declined));
  const brk = capture({ small: [SIGN, done('A sign.')], big: [{ summary: 'x', actions: [{ kind: 'set_operation', id: 'cutout', strategy: 'tag_cutout', params: {} }, { kind: 'remove_operation', id: 'engrave' }] }, done('broken'), done('broken')], judge: { ...KEEP, reduced: true } });
  const brkOut = await runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: brk.call }, { models: ['small', 'big'] });
  ok('a fix that breaks the build never reaches the user: a verified build is what comes back', (await weave(brkOut.recipe)).ok === true && brkOut.tier === 0 && brkOut.attempts[1].ok === false, JSON.stringify(brkOut.attempts.map(a => [a.model, a.reason, a.ok])));
  ok('reviewNote: nothing to say on a keep or an unjudged build', reviewNote({ verdict: 'keep' }) === null && reviewNote({ verdict: null, why: 'x' }) === null && reviewNote(null) === null);

  // ---- a blank summary is written by the app, not bought from the big model ----
  const blank = await run({ small: [{ ...SIGN, summary: '' }, done('')], big: [SIGN, done('Big.')] });
  ok('a verified build with a blank summary is kept, with a sentence from the recipe and the weave', blank.out.tier === 0 && !blank.seen.includes('big') && /^Built and verified — 2 operations \(vcarve text, [a-z ]+\) on a [\d.]+" × [\d.]+" × [\d.]+" board, 1 piece cut free\.$/.test(blank.out.summary), blank.out.summary);
  ok('plainBuiltSummary: counts repeated strategies, skips an untitled name and a missing board', plainBuiltSummary({ name: 'Untitled', pipeline: [{ strategy: 'bore_hole' }, { strategy: 'bore_hole' }, { strategy: 'part' }] }, { stock: null, pieces: null }) === 'Built and verified — 3 operations (bore hole ×2, part).');

  const mute = await run({ small: [SIGN, done('A sign.')], big: [SIGN, done('Big.')], judge: 'prose' });
  const down = await run({ small: [SIGN, done('A sign.')], big: [SIGN, done('Big.')], judge: new Error('503') });
  ok('a judge that does not answer in form, or cannot be reached, is not a pass: the build goes up a rung', mute.out.tier === 1 && /not judged/.test(mute.out.attempts[0].reason) && down.out.tier === 1 && /could not be reached/.test(down.out.attempts[0].reason));
  ok('the top rung is not judged (nowhere to escalate to), and neither is an answered question', offSubject.judged.length === 1 && q.judged.length === 0);
  const noJudge = script({ small: [SIGN, done('A sign.')], big: [SIGN] });
  const unj = await runIntentCascade({ recipe: empty(), utterance: 'a welcome sign', weave, call: noJudge.call }, { models: ['small', 'big'], judge: false });
  ok('judge: false keeps the old behaviour', unj.tier === 0 && noJudge.judged.length === 0);
  const wr = await weave(kept.out.recipe);
  const facts = buildFacts(kept.out.recipe, wr, [{ what: 'gold leaf', why: 'no' }]);
  ok('the facts are the app\'s own: operations with resolved params, sizes, pieces, verified, declines', /SEPARATE PIECES CUT FREE: 1/.test(facts) && /SIZES of each operation as cut/.test(facts) && /VERIFIED BY THE MACHINE SOFTWARE: yes/.test(facts) && /DECLINED openly by the builder, with its reason:\n- gold leaf — no/.test(facts), facts);
  const bound = { ...empty(), controls: [{ id: 'label', type: 'text', label: 'Text', default: 'Men' }], pipeline: [{ id: 'e', strategy: 'vcarve_text', params: { text: { ctrl: 'label' } } }] };
  ok('a bound text shows as the text the user would get', /e: vcarve_text — text=Men/.test(buildFacts(bound, null)));
  const jr = buildJudgeRequest({ utterance: 'x', recipe: bound, weaveResult: null });
  ok('with no weave the judge is told there is no picture', jr.messages[0].content.every(b => b.type !== 'image') && /No picture of the cut/.test(jr.messages[0].content.at(-1).text));

  // the parallel-call repair: two action calls in one reply are one answer
  const seen2 = [];
  let k = 0;
  const split = await runIntentLoop({ recipe: empty(), utterance: 'a sign', weave, model: 'claude-haiku-5-5', call: async (r) => { seen2.push(r); k++; return k === 1 ? { stop_reason: 'tool_use', usage: {}, content: [
    { type: 'tool_use', id: 'a', name: 'apply_recipe_actions', input: { summary: '', actions: [SIGN.actions[0]] } },
    { type: 'tool_use', id: 'b', name: 'apply_recipe_actions', input: { summary: 'A sign.', claims: SIGN.claims, actions: [SIGN.actions[1]] } }] } : act(done('Built.')); } });
  const results = seen2[1].messages[2].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);
  ok('a reply split over two tool calls is applied whole, and both calls are answered', split.recipe.pipeline.length === 2 && results.join() === 'a,b' && seen2[0].tool_choice.disable_parallel_tool_use === true, JSON.stringify(results));
}

console.log('--- route: only the documentation the ask points at ---');
{
  const { pickShelves, shelfDoc, SHELVES, READ_DOCS_TOOL, MAX_READS, buildParseRequest: bpr, buildSystemPrompt: bsp } = await import('../app/intent.mjs');
  const M = 'claude-opus-5-5';
  const full = bpr(empty(), 'a welcome sign', { model: M });
  ok('not asked for: the prompt and tools are exactly what they were', full.system === bpr(empty(), 'a welcome sign', { model: M, shelves: null }).system && !full.tools.some(t => t.name === 'read_docs') && /the complete list — nothing else exists/.test(full.system) && !/OTHER STRATEGIES/.test(full.system));
  ok('a sign needs no shelf; words in the ask pull the shelf that makes the thing', pickShelves({ utterance: 'a welcome sign for the porch' }).length === 0 && pickShelves({ utterance: 'a log cabin plank set' }).join() === 'kits' && pickShelves({ utterance: 'a waffle stool' }).includes('ribs') && pickShelves({ utterance: 'Mount Rainier in relief' }).join() === 'terrain' && pickShelves({ utterance: 'my name with a wave texture' }).join() === 'texture');
  ok('a picture is never routed', pickShelves({ utterance: 'this', image: { data: 'x', media_type: 'image/png' } }) === null);
  ok('what the recipe already holds stays documented on a refinement turn', pickShelves({ utterance: 'make it wider', recipe: { ...empty(), pipeline: [{ id: 'k', strategy: 'linker_logs', params: {} }] } }).join() === 'kits');
  ok('a worked example chosen for the ask pulls its shelf too', pickShelves({ utterance: 'a thing', exemplars: [{ prompt: 'p', actions: [{ kind: 'add_operation', operation: { id: 'r', strategy: 'rib_lattice', params: {} } }] }] }).join() === 'ribs');
  const core = bpr(empty(), 'a welcome sign', { model: M, shelves: [] });
  ok('routed: the shelves left out are gone from the docs and the rules, and the prompt is much shorter', !/\n- linker_logs: /.test(core.system) && !/\n- rib_lattice: /.test(core.system) && !/\n- LINKER LOGS \/ PLAY PLANKS/.test(core.system) && !/\n- A RIB \/ WAFFLE/.test(core.system) && !/\nTERRAIN \(real-world/.test(core.system) && /\n- vcarve_text: /.test(core.system) && /\n- part: /.test(core.system) && core.system.length < full.system.length * 0.75, `${core.system.length} vs ${full.system.length}`);
  ok('…but each is still LISTED by name with what it makes, and read_docs is offered', /OTHER STRATEGIES \(real and available/.test(core.system) && /- shelf "kits" \(linker_logs\): LINKER LOGS/.test(core.system) && /- shelf "ribs" \((rib_chair, rib_lattice|rib_lattice, rib_chair)\)/.test(core.system) && core.tools.some(t => t.name === 'read_docs') && /MORE exist/.test(core.system));
  const one = bpr(empty(), 'a log cabin set', { model: M, shelves: ['kits'] });
  ok('a picked shelf rides in full, rule and all, and is not on the other-strategies list', /\n- linker_logs: /.test(one.system) && /\n- LINKER LOGS \/ PLAY PLANKS/.test(one.system) && !/- shelf "kits"/.test(one.system) && /- shelf "ribs"/.test(one.system));
  ok('every shelf picked = the full prompt, byte for byte', bsp(empty(), {}, { shelves: Object.keys(SHELVES) }) === bsp(empty(), {}, {}));
  const forced = bpr(empty(), 'a welcome sign', { model: 'claude-opus-4-8', shelves: [] });
  ok('a model that cannot choose a tool could never read_docs, so it is never routed', forced.system === bpr(empty(), 'a welcome sign', { model: 'claude-opus-4-8' }).system && !forced.tools.some(t => t.name === 'read_docs'));
  ok('shelfDoc is the documentation that was left out: strategies, section and rules', /- linker_logs: /.test(shelfDoc('kits')) && /RULES for these:\n- LINKER LOGS/.test(shelfDoc('kits')) && /TERRAIN \(real-world/.test(shelfDoc('terrain')) && /- terrain_relief: /.test(shelfDoc('terrain')) && shelfDoc('nope') === '');

  // in the loop: asked for a shelf, answered in the same conversation, then the build
  const read = (shelf, id = 'tu_read') => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id, name: 'read_docs', input: { shelf } }] });
  const seen = []; let n = 0;
  const out = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, model: M, route: true, call: async (r) => { seen.push(r); n++; return n === 1 ? read('kits') : n === 2 ? act(SIGN) : act({ summary: 'Built and verified.', actions: [] }); } });
  const answer = seen[1].messages[2].content[0];
  ok('read_docs is answered with that shelf\'s documentation as the tool result; the system prompt is untouched', answer.type === 'tool_result' && answer.tool_use_id === 'tu_read' && /- linker_logs: /.test(answer.content) && /Now call apply_recipe_actions/.test(answer.content) && seen[1].system === seen[0].system && !/\n- linker_logs: /.test(seen[0].system));
  ok('…then the build goes on as usual, and the result says what was routed and read', out.recipe.pipeline.length === 2 && out.summary === 'Built and verified.' && out.route.shelves.length === 0 && out.route.reads.length === 1 && out.route.reads[0].shelf === 'kits' && seen[2].messages[4].content[0].tool_use_id === 'tu_act');
  const seenB = []; let b = 0;
  const bad = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, model: M, route: true, call: async (r) => { seenB.push(r); b++; return b === 1 ? read('gears') : b === 2 ? act(SIGN) : act({ summary: 'ok', actions: [] }); } });
  ok('an unknown shelf is answered with the names that exist, not a crash', seenB[1].messages[2].content[0].is_error === true && /No shelf "gears"\. Shelves: /.test(seenB[1].messages[2].content[0].content) && bad.recipe.pipeline.length === 2 && bad.route.reads.length === 0);
  const seenC = []; let c = 0;
  const greedy = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, model: M, route: true, call: async (r) => { seenC.push(r); c++; return c <= MAX_READS + 1 ? read(['kits', 'ribs', 'terrain', 'texture'][c - 1], `tu_r${c}`) : c === MAX_READS + 2 ? act(SIGN) : act({ summary: 'ok', actions: [] }); } });
  ok(`${MAX_READS} reads a turn; one more is told to build`, greedy.route.reads.length === MAX_READS && /No more documentation this turn/.test(seenC[MAX_READS + 1].messages.at(-1).content[0].content) && greedy.recipe.pipeline.length === 2);
  const plain = await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, model: M, call: async () => act({ summary: 'x', actions: [] }) });
  ok('route off: nothing about routing in the result', plain.route === null && READ_DOCS_TOOL.name === 'read_docs');
}

console.log('--- cache: the fixed part of the prompt is marked cacheable, the recipe is not ---');
{
  const { withPromptCache, buildParseRequest: bpr } = await import('../app/intent.mjs');
  const plain = bpr(empty(), 'a welcome sign', { model: 'claude-opus-5-5' });
  const c = withPromptCache(plain);
  ok('two blocks: everything before CURRENT RECIPE cached, the recipe after it not', Array.isArray(c.system) && c.system.length === 2 && c.system[0].cache_control?.type === 'ephemeral' && !c.system[1].cache_control && /^CURRENT RECIPE:/.test(c.system[1].text) && !/CURRENT RECIPE:/.test(c.system[0].text));
  ok('nothing is lost or reworded', c.system[0].text + '\n\n' + c.system[1].text === plain.system && c.messages === plain.messages && c.tools === plain.tools);
  const other = withPromptCache(bpr({ ...empty(), name: 'Fence', pipeline: [{ id: 'x', strategy: 'tag_cutout', params: {} }] }, 'make it wider', { model: 'claude-opus-5-5' }));
  ok('a different recipe shares the cached part exactly (a refinement or fix turn reads the cache)', other.system[0].text === c.system[0].text && other.system[1].text !== c.system[1].text);
  ok('already-blocked or empty systems pass through', withPromptCache(c) === c && withPromptCache({ system: '' }).system === '');
  const seen = [];
  await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, cache: true, call: async (r) => { seen.push(r); return seen.length === 1 ? act(SIGN) : act({ summary: 'ok', actions: [] }); } });
  ok('cache: true marks every call of the turn, and the revise call carries the same cached block', seen.length === 2 && seen.every(r => r.system[0]?.cache_control) && seen[0].system[0].text === seen[1].system[0].text);
  const seenOff = [];
  await runIntentLoop({ recipe: empty(), utterance: 'a welcome sign', weave, call: async (r) => { seenOff.push(r); return act({ summary: 'ok', actions: [] }); } });
  ok('off unless asked', typeof seenOff[0].system === 'string');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nmeasure-and-look gauntlet clean');
process.exit(failures ? 1 : 0);
