// Exemplar retrieval: the worked-example picker and its place in the
// parse request. Runs against a fixture index (no corpus needed) plus,
// when app/exemplars.json exists, a few sanity picks from the real one.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tokens, pickExemplars, exemplarBlock, buildIndex, EXEMPLAR_BUDGET } from '../app/exemplars.mjs';
import { buildParseRequest, DEFAULT_IMAGE_UTTERANCE } from '../app/intent.mjs';

const row = (key, prompt, kinds, extra = {}) => ({
  key, date: key.slice(0, 10), prompt, kinds, outcome: 'FULFILLED', summary: `Built ${prompt}.`,
  actions: [{ kind: 'set_name', name: prompt }, ...kinds.map(k => ({ kind: 'add_operation', operation: { id: k, strategy: k, params: {} } }))],
  ...extra,
});
const FIX = [
  row('2026-08-01/bookshelf', 'A simple bookshelf, 30 inches wide, three shelves', ['furniture_design']),
  row('2026-08-02/nightstand', 'A nightstand with one drawer box', ['furniture_assembly']),
  row('2026-08-03/welcome', 'A welcome sign with a sunflower', ['pocket_shape', 'vcarve_text', 'tag_cutout']),
  row('2026-08-04/restroom', "Men's restroom sign with braille", ['pocket_shape', 'vcarve_text', 'braille_text', 'tag_cutout']),
  row('2026-08-05/sword', 'cut a sword blade shape out of plywood for a prop', ['shape_cutout']),
  row('2026-08-06/photo-chest', DEFAULT_IMAGE_UTTERANCE, ['furniture_assembly'], { photo: true }),
  row('2026-08-07/photo-cubby', DEFAULT_IMAGE_UTTERANCE, ['furniture_assembly'], { photo: true, outcome: 'PARTIAL' }),
];

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('tokens: stop words, stems and aliases fold', () => {
  assert.deepEqual(tokens('Make me a bookcase with 5 shelves, cut from 3/4 plywood'), ['bookshelf', 'shelf']);
  assert.deepEqual(tokens('two drawers and a cupboard'), ['drawer', 'cabinet']);
});

t('pick: subject words find the matching build, generic words do not', () => {
  const p = pickExemplars(FIX, 'A bookcase 36 wide 72 tall with 5 shelves and a back');
  assert.equal(p[0]?.key, '2026-08-01/bookshelf');
  assert.deepEqual(pickExemplars(FIX, 'A dining chair cut from plywood'), [], 'cut/plywood are not a subject');
  assert.deepEqual(pickExemplars(FIX, 'qzx florp wibble'), []);
  const sign = pickExemplars(FIX, "Women's restroom sign with braille dots");
  assert.equal(sign[0]?.key, '2026-08-04/restroom');
  assert.ok(sign.length <= 2);
});

t('pick: a single shared word is not enough when the ask has several', () => {
  // "sign" alone matches welcome + restroom; a two-word ask needs two hits
  assert.deepEqual(pickExemplars(FIX, 'garage sign').map(r => r.key), []);
  // a one-word ask may match on that one word
  assert.equal(pickExemplars(FIX, 'sign').length, 2);
});

t('pick: a bare picture gets the newest photo-built rows', () => {
  const p = pickExemplars(FIX, DEFAULT_IMAGE_UTTERANCE, { hasImage: true });
  assert.deepEqual(p.map(r => r.key), ['2026-08-07/photo-cubby', '2026-08-06/photo-chest']);
  assert.deepEqual(pickExemplars(FIX, DEFAULT_IMAGE_UTTERANCE, { hasImage: false }), []);
});

t('pick: exclude drops the probe\'s own prompt and id', () => {
  const p = pickExemplars(FIX, 'A simple bookshelf, 30 inches wide, three shelves', { exclude: ['A simple bookshelf, 30 inches wide, three shelves', 'bookshelf'] });
  assert.ok(!p.some(r => r.key === '2026-08-01/bookshelf'));
});

t('pick: budget caps the quoted actions, first pick always fits', () => {
  const big = row('2026-09-01/big', 'A nightstand with a drawer and a shelf', ['furniture_assembly']);
  big.actions = [{ kind: 'add_operation', operation: { id: 'x', strategy: 'furniture_assembly', params: { blob: 'y'.repeat(6000) } } }];
  const p = pickExemplars([...FIX, big], 'nightstand drawer', { budget: 6000 });
  assert.equal(p.length, 1, 'second row would overrun the budget');
  const q = pickExemplars([...FIX, big], 'nightstand drawer', { budget: EXEMPLAR_BUDGET });
  assert.equal(q.length, 2);
});

t('block: renders asks, summaries and actions; empty for no picks', () => {
  assert.equal(exemplarBlock([]), '');
  const b = exemplarBlock(pickExemplars(FIX, 'welcome sign sunflower'));
  assert.match(b, /^WORKED EXAMPLES/);
  assert.match(b, /EXAMPLE 1 — ask: "A welcome sign with a sunflower"/);
  assert.match(b, /"strategy":"vcarve_text"/);
});

t('request: exemplars ride in the first user turn ahead of the ask, system untouched', () => {
  const recipe = { version: 2, name: 'Untitled', stock: { thickness: 0.5 }, margin: 0.375, controls: [], derived: [], shapes: [], pipeline: [], assets: [], terrains: [] };
  const picks = pickExemplars(FIX, 'welcome sign sunflower');
  const plain = buildParseRequest(recipe, 'A welcome sign with a daisy');
  const withEx = buildParseRequest(recipe, 'A welcome sign with a daisy', { exemplars: picks });
  assert.equal(plain.system, withEx.system, 'system prompt must not vary with the examples (it is cached)');
  assert.equal(typeof plain.messages[0].content, 'string');
  const c = withEx.messages[0].content;
  assert.ok(Array.isArray(c) && c.length === 2);
  assert.match(c[0].text, /^WORKED EXAMPLES/);
  assert.equal(c[1].text, 'A welcome sign with a daisy');
  const img = buildParseRequest(recipe, '', { exemplars: picks, image: { media_type: 'image/jpeg', data: 'AAAA' } });
  assert.deepEqual(img.messages[0].content.map(b => b.type), ['image', 'text', 'text']);
  assert.equal(img.messages[0].content[2].text, DEFAULT_IMAGE_UTTERANCE);
  const none = buildParseRequest(recipe, 'hello', { exemplars: [] });
  assert.equal(typeof none.messages[0].content, 'string');
});

const REAL = new URL('../app/exemplars.json', import.meta.url).pathname;
if (existsSync(REAL)) {
  t('real index: every row is a verified first-turn build with operations', () => {
    const rows = JSON.parse(readFileSync(REAL, 'utf8'));
    assert.ok(rows.length > 100);
    for (const r of rows) {
      assert.ok(r.key && r.prompt && Array.isArray(r.actions) && Array.isArray(r.kinds), r.key);
      assert.ok(['FULFILLED', 'PARTIAL'].includes(r.outcome), r.key);
      assert.ok(r.actions.some(a => a.kind === 'add_operation'), r.key);
    }
    const ix = buildIndex(rows);
    const ns = pickExemplars(ix, 'Nightstand with one drawer and a shelf below');
    assert.ok(ns.length && ns.every(r => /nightstand|drawer/i.test(r.prompt)), ns.map(r => r.prompt).join(' | '));
    const bk = pickExemplars(ix, 'A bookcase 36 wide 72 tall with 5 shelves');
    assert.ok(bk.length && bk.some(r => /book/i.test(r.prompt)), bk.map(r => r.prompt).join(' | '));
    assert.deepEqual(pickExemplars(ix, 'A dining chair cut from plywood').filter(r => !/chair/i.test(r.prompt)), []);
  });
}

console.log(`exemplars-test: ${n} passed`);
