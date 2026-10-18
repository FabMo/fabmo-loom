// Exemplar retrieval — past VERIFIED builds handed to the model as worked
// examples for a similar ask.
//
// The index (app/exemplars.json, built by tools/synth-probe/exemplars-build.mjs
// from the recorded-model-output corpus) is a flat list of rows:
//
//   { key, date, prompt, actions, summary, kinds, outcome, photo? }
//
// Retrieval is lexical (BM25 over the recorded prompt plus the strategy
// names it used) — the corpus is a few hundred rows and a phone must do
// this with no network call. pickExemplars() returns the rows worth
// quoting (possibly none: an ask unlike anything recorded gets no
// examples rather than a misleading one) and exemplarBlock() renders them
// as the text block buildParseRequest puts in the FIRST USER TURN. The
// user turn is the right place: the system prompt is cached across calls
// and must not vary per ask.
//
// Pure module: no DOM, no fs. Browser callers fetch the JSON; node callers
// read the file.

// Words that say nothing about WHAT is being built — asks share them by
// the dozen (every ask is "make me a ... cut from plywood, about 12 wide").
const STOP = new Set(('a an and are as at be by for from has have i in is it its me my of on or our so that the this to we with you your ' +
  'make build want need like please could would should can some into onto out up down over under about one two also just ' +
  'inch inches in long wide tall high deep thick size sized cut cuts cutting plywood wood wooden board mdf piece pieces ' +
  'design project thing something new nice simple small big little large standard basic mine ' +
  'what picture photo image pic shown attached ' +   // "build what is in this picture" is no subject
  'open top bottom side front back under underneath below above between across along').split(' '));   // positions, not subjects

// Domain synonyms folded to one token after stemming.
const ALIAS = { bookcase: 'bookshelf', bookshelve: 'bookshelf', shelv: 'shelf', cubbie: 'cubby', cupboard: 'cabinet',
  bedside: 'nightstand', plaque: 'sign', signage: 'sign', nameplate: 'sign', tag: 'tag', nametag: 'tag', drawers: 'drawer' };

// Subject classes: an ask that names furniture should be shown furniture
// builds even when a sign row shares more words with it ("table", "menu").
// Class words are checked AFTER stemming/aliasing.
const CLASS_WORDS = {
  furniture: new Set('furniture nightstand bookshelf shelf cabinet drawer dresser chest bench desk table stool chair cubby bookcase wardrobe closet rack hutch sideboard credenza vanity crate toolbox cubbie carcass plinth'.split(' ')),
  terrain: new Set('terrain topo topographic relief elevation mountain lake bathymetry contour map'.split(' ')),
};
const ROW_CLASS = (kinds = []) => kinds.some(k => /^furniture_/.test(k)) ? 'furniture' : kinds.includes('terrain_relief') ? 'terrain' : 'flat';
export function askClass(q) {
  for (const [cls, words] of Object.entries(CLASS_WORDS)) if (q.some(w => words.has(w))) return cls;
  return null;
}

const stem = (w) => {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ves')) w = w.slice(0, -3) + 'f';   // shelves → shelf, halves → half
  else if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return ALIAS[w] ?? w;
};

export function tokens(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

export const normPrompt = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// A row's searchable text: its prompt plus the strategy names it used,
// split on underscores ("furniture_assembly" → furniture, assembly) so an
// ask that names the thing finds rows that built it with the matching verb.
function docTokens(row) {
  const t = tokens(row.prompt);
  for (const k of row.kinds ?? []) t.push(...String(k).split('_').filter(Boolean).map(stem));
  return t;
}

const K1 = 1.2, B = 0.75;

// rows → index; cheap enough to rebuild per pick for a few hundred rows,
// so callers may pass the raw rows and let pick index them.
export function buildIndex(rows) {
  const docs = rows.map(docTokens);
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  return { rows, docs, df, avgdl, N: rows.length };
}

const idf = (ix, w) => Math.log(1 + (ix.N - (ix.df.get(w) ?? 0) + 0.5) / ((ix.df.get(w) ?? 0) + 0.5));

export function scoreRow(ix, i, q) {
  const d = ix.docs[i];
  if (!d.length) return { score: 0, matched: 0 };
  const tf = new Map();
  for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
  let score = 0, matched = 0;
  for (const w of q) {
    const f = tf.get(w);
    if (!f) continue;
    matched++;
    score += idf(ix, w) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.length / ix.avgdl));
  }
  return { score, matched };
}

// Default per-call budget in characters of quoted actions (~2k tokens):
// enough for two median rows or one big furniture document.
export const EXEMPLAR_BUDGET = 7000;

// opts:
//   hasImage  — the ask carries a picture; photo-built rows get a boost, and
//               an ask with NO words of its own ("Build what is in this
//               picture.") falls back to the latest photo-built rows
//   max       — rows to return (default 2)
//   budget    — total JSON chars of quoted actions
//   exclude   — a prompt string (or array of keys/prompts) never to return:
//               the probe passes its own prompt so a re-probe is not handed
//               its previous answer
export function pickExemplars(rowsOrIndex, utterance, { hasImage = false, max = 2, budget = EXEMPLAR_BUDGET, exclude = null } = {}) {
  const ix = rowsOrIndex?.docs ? rowsOrIndex : buildIndex(Array.isArray(rowsOrIndex) ? rowsOrIndex : []);
  if (!ix.N) return [];
  const ex = new Set((Array.isArray(exclude) ? exclude : exclude ? [exclude] : []).map(normPrompt));
  const banned = (r) => ex.has(normPrompt(r.prompt)) || ex.has(normPrompt(r.key));
  const q = [...new Set(tokens(utterance))];

  let ranked;
  if (!q.length) {
    // nothing to match on: a bare picture gets the newest picture-built rows
    if (!hasImage) return [];
    ranked = ix.rows.map((r, i) => ({ r, i, score: r.photo ? 1 : 0, matched: 0 }))
      .filter(x => x.score > 0).sort((a, b) => String(b.r.date).localeCompare(String(a.r.date)));
  } else {
    const cls = askClass(q);
    ranked = ix.rows.map((r, i) => {
      const { score, matched } = scoreRow(ix, i, q);
      let s = score;
      if (r.outcome === 'FULFILLED') s *= 1.1;
      if (hasImage && r.photo) s *= 1.3;
      // one shared word is coincidence; two is a subject — unless the ask
      // names a class and the row built that class, where one word
      // ("drawer") already says the row is the right kind of thing
      const rc = ROW_CLASS(r.kinds);
      const sameClass = cls && rc === cls;
      if (cls && !sameClass) s *= 0.25;
      const need = sameClass ? 1 : Math.min(2, q.length);
      return { r, i, score: s, matched, ok: matched >= need };
    }).filter(x => x.ok && x.score > 0).sort((a, b) => b.score - a.score);
    if (!ranked.length) return [];
    // drop the long tail: anything under 40% of the best match is a different subject
    const floor = ranked[0].score * 0.4;
    ranked = ranked.filter(x => x.score >= floor);
  }

  const out = [], seen = new Set();
  let used = 0;
  for (const x of ranked) {
    if (out.length >= max) break;
    if (banned(x.r)) continue;
    // picture-built rows all carry the same (default) prompt: they are distinct by key
    const np = x.r.photo ? x.r.key : normPrompt(x.r.prompt);
    if (seen.has(np)) continue;
    const size = JSON.stringify(x.r.actions).length;
    if (used + size > budget && out.length) continue;   // the first pick always fits; later ones must leave room
    if (size > budget) continue;
    seen.add(np);
    used += size;
    out.push(x.r);
  }
  return out;
}

export function exemplarBlock(picks) {
  if (!picks?.length) return '';
  const head = 'WORKED EXAMPLES — earlier asks on this machine whose builds VERIFIED, with the exact actions that built them. ' +
    'They show structure, control naming, bindings and operation order that worked here. ' +
    'Adapt the STRUCTURE to this ask; never carry over an old ask\'s text, names or sizes, and still commit your own design stance for this piece.';
  const body = picks.map((p, i) =>
    `EXAMPLE ${i + 1} — ask: ${JSON.stringify(p.prompt)}${p.photo ? ' (with a picture)' : ''}\n` +
    (p.summary ? `summary: ${p.summary}\n` : '') +
    `actions: ${JSON.stringify(p.actions)}`).join('\n\n');
  return `${head}\n\n${body}`;
}

// Browser helper: fetch the index once per page, never fail the build over
// it. The static server does not gzip JSON, so the builder also writes a
// .gz twin (~1/6 the bytes) that browsers with DecompressionStream inflate
// themselves; older ones take the plain file.
let memo = null;
export function loadExemplars(url = './exemplars.json') {
  if (!memo) {
    const plain = () => fetch(url, { cache: 'force-cache' }).then(r => r.ok ? r.json() : []);
    const packed = async () => {
      const r = await fetch(`${url}.gz`, { cache: 'force-cache' });
      if (!r.ok || !r.body) throw new Error('no gz');
      const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
      return JSON.parse(text);
    };
    memo = (typeof DecompressionStream === 'function' ? packed().catch(plain) : plain())
      .then(rows => (Array.isArray(rows) ? rows : []))
      .catch(() => []);
  }
  return memo;
}
