// Reference lookup gauntlet — find_reference proven in BOTH directions,
// with no network and no model: the Wikimedia APIs are a recorded fixture
// behind an injected fetch, and the model is a script.
//
//   fetch      the lookup picks the right article, a Commons photograph of
//              the outside, the measured sentences; credits the author
//   refusals   a person, a logo, a brand, nothing found, a photo that only
//              exists as fair use, a host that is down — each comes back as
//              a named non-answer, never a throw
//   request    what the model is offered: the tool and its rule only when a
//              lookup exists and the model can choose; web search only on a
//              request that carries a reference; NOTHING changes otherwise
//   loop       the turn starts over with the reference attached; the second
//              lookup; the search fallback; a paused turn; a late call
//
// Run: node test/reference-test.mjs

import { findReference, measuredSentences, referenceCredit, REFERENCE_PHOTO_BUDGET } from '../app/reference-fetch.mjs';
import { buildParseRequest, runIntentLoop, referenceText, webSearches, REFERENCE_TOOL, WEB_SEARCH_TOOL, MAX_LOOKUPS, DEFAULT_MODEL, ACTION_TOOL } from '../app/intent.mjs';
import { EMPTY_RECIPE } from '../app/runtime.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- fixture
// A tiny Wikimedia: three articles, a handful of files. Shapes copied from
// the real APIs (recorded 2026-11-05); the JPEG "bytes" are filler of a
// chosen size, because only their length matters here.
const ARTICLES = {
  'Spire Hall': {
    index: 1, description: 'Six-spired meeting hall in Exampleton', qid: 'Q100', pageimage: 'Spire_Hall_front.jpg',
    intro: 'Spire Hall is a meeting hall in Exampleton. Standing 288 feet (88 m) tall, it is the tallest hall in the county.',
    full: 'Spire Hall is a meeting hall in Exampleton. Standing 288 feet (88 m) tall, it is the tallest hall in the county.\n\n== Design ==\nThe six-spire design has three towers at each end. The hall is 240 feet (73 m) long and 136 feet (41 m) wide. The lobby doors are 9 feet (2.7 m) high. It was originally proposed to be 400 feet (120 m) tall. The grout is 1 inch (25 mm) thick.',
    files: ['File:Commons-logo.svg', 'File:Spire Hall lobby.jpg', 'File:Spire Hall and Other Hall.jpg', 'File:Spire Hall front.jpg', 'File:Spire Hall 1974.jpg', 'File:Spire Hall site plan.jpg', 'File:Spire Hall fair use.jpg'],
    claims: { P31: [{ id: 'Q16970' }], P2048: [{ amount: '+88', unit: 'http://www.wikidata.org/entity/Q11573' }, { amount: '+250', unit: 'http://www.wikidata.org/entity/Q3710' }], P1101: [{ amount: '+7', unit: '1' }] },
  },
  'Spire Hall (band)': { index: 2, description: 'American rock band', qid: 'Q101', intro: 'A band.', full: 'A band.', files: [], claims: { P31: [{ id: 'Q215380' }] } },
  'Ada Example': {
    index: 1, description: 'Exampletonian engineer (1900–1980)', qid: 'Q200', pageimage: 'Ada_Example_1950.jpg',
    intro: 'Ada Example was an engineer.', full: 'Ada Example was an engineer.', files: ['File:Ada Example 1950.jpg'], claims: { P31: [{ id: 'Q5' }] },
  },
  'Zip (logo)': { index: 1, description: 'Logo of the Zip shoe company', qid: 'Q300', intro: 'The Zip is a logo.', full: 'The Zip is a logo.', files: ['File:Zip factory.jpg'], claims: { P31: [{ id: 'Q1886349' }] } },
  'Zap mark': { index: 1, description: 'Symbol of a shoe maker', qid: 'Q301', intro: 'The Zap mark is a symbol.', full: 'The Zap mark is a symbol.', files: ['File:Zip factory.jpg'], claims: { P31: [{ id: 'Q1886349' }] } },
  'Zop': { index: 1, description: 'Shoe brand', qid: 'Q302', intro: 'Zop makes shoes.', full: 'Zop makes shoes.', files: ['File:Zip factory.jpg'], claims: {} },
  'Busy Tower': {
    index: 1, description: 'Tower in Exampleton', qid: 'Q400', pageimage: 'Busy_Tower.jpg',
    intro: 'Busy Tower is a tower.', full: 'Busy Tower is a tower. It is 500 feet (152 m) tall.', files: ['File:Busy Tower.jpg'], claims: {},
  },
  'Plain Tower': { index: 1, description: 'Tower in Exampleton', qid: 'Q500', intro: 'Plain Tower is a tower.', full: 'Plain Tower is a tower.', files: ['File:Plain Tower fair use.jpg'], claims: {} },
  'Tower (disambiguation)': { index: 1, description: 'Topics referred to by the same term', qid: 'Q600', disambiguation: true, intro: '', full: '', files: [], claims: {} },
};
// files on Commons: [width, height, artist html, licence, kB at 960, kB at 500]
const COMMONS_FILES = {
  'File:Spire Hall front.jpg': [3000, 2000, '<a href="//x">Pat Photographer</a>', 'CC BY-SA 4.0', 120, 40],
  'File:Spire Hall 1974.jpg': [1600, 1200, '<a href="//x">w:User:Old Archive</a> derivative work: Old Archive ( <a>talk</a> )', 'Public domain', 90, 30],
  'File:Spire Hall and Other Hall.jpg': [2000, 1500, 'Someone Else', 'CC BY 2.0', 100, 35],
  'File:Spire Hall lobby.jpg': [2000, 1500, 'Indoor Person', 'CC0', 100, 35],
  'File:Spire Hall site plan.jpg': [2000, 1500, 'Drafter', 'Public domain', 100, 35],
  'File:Ada Example 1950.jpg': [1000, 1400, 'Studio', 'Public domain', 80, 30],
  'File:Zip factory.jpg': [2000, 1500, 'Factory Fan', 'CC BY 4.0', 80, 30],
  'File:Busy Tower.jpg': [3000, 4000, 'Busy &amp; Co', 'CC BY 4.0', 400, 90],   // over the budget at 960 px
  // 'File:… fair use.jpg' is deliberately absent: it lives on en.wikipedia only
};
const SEARCH = {
  'Spire Hall': ['Spire Hall', 'Spire Hall (band)'], 'Ada Example': ['Ada Example'], 'Zip logo': ['Zip (logo)'],
  'Busy Tower': ['Busy Tower'], 'Plain Tower': ['Plain Tower'], 'Zap mark': ['Zap mark'], 'Zop': ['Zop'], 'Tower': ['Tower (disambiguation)', 'Busy Tower'],
};
const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => 'application/json' } });
function makeFetch({ down = null, log = [], noMediaList = false } = {}) {
  return async (url) => {
    const u = new URL(url);
    log.push(url);
    if (down && u.hostname.includes(down)) return { ok: false, status: 503, json: async () => ({}), headers: { get: () => '' } };
    const q = Object.fromEntries(u.searchParams);
    if (u.hostname === 'upload.example') {
      const kb = Number(u.searchParams.get('kb'));
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array(kb * 768).buffer };   // ×4/3 → kb KB of base64
    }
    if (u.hostname === 'en.wikipedia.org' && q.generator === 'search') {
      const titles = SEARCH[q.gsrsearch] ?? [];
      const pages = {};
      titles.forEach((t, i) => {
        const a = ARTICLES[t];
        pages[i + 1] = { title: t, index: i + 1, description: a.description, extract: a.intro, fullurl: `https://en.wikipedia.org/wiki/${t.replace(/ /g, '_')}`, ...(a.pageimage ? { pageimage: a.pageimage } : {}), pageprops: { wikibase_item: a.qid, ...(a.disambiguation ? { disambiguation: '' } : {}) } };
      });
      return json(titles.length ? { query: { pages } } : { batchcomplete: '' });
    }
    if (u.hostname === 'en.wikipedia.org' && u.pathname.startsWith('/api/rest_v1/page/media-list/')) {
      if (noMediaList) return { ok: false, status: 404, json: async () => ({}), headers: { get: () => '' } };
      const a = ARTICLES[decodeURIComponent(u.pathname.split('/').pop()).replace(/_/g, ' ')];
      return json({ items: a.files.map((title, i) => ({ title: title.replace(/ /g, '_'), type: 'image', section_id: i < (a.infobox ?? 0) ? 0 : 3, leadImage: `File:${(a.pageimage ?? '').replace(/_/g, ' ')}` === title })) });
    }
    if (u.hostname === 'en.wikipedia.org' && q.prop === 'extracts') return json({ query: { pages: { 1: { title: q.titles, extract: ARTICLES[q.titles].full } } } });
    if (u.hostname === 'en.wikipedia.org' && q.prop === 'images') return json({ query: { pages: { 1: { title: q.titles, images: ARTICLES[q.titles].files.map(title => ({ title })) } } } });
    if (u.hostname === 'www.wikidata.org') {
      const a = Object.values(ARTICLES).find(x => x.qid === q.entity);
      return json({ claims: { [q.property]: (a.claims[q.property] ?? []).map(value => ({ mainsnak: { datavalue: { value } } })) } });
    }
    if (u.hostname === 'commons.wikimedia.org') {
      const w = Number(q.iiurlwidth);
      const pages = {};
      q.titles.split('|').forEach((t, i) => {
        const f = COMMONS_FILES[t];
        pages[f ? i + 1 : -(i + 1)] = f
          ? { title: t, imageinfo: [{ mime: 'image/jpeg', width: f[0], height: f[1], thumbwidth: w, descriptionurl: `https://commons.wikimedia.org/wiki/${t.replace(/ /g, '_')}`, thumburl: `https://upload.example/${encodeURIComponent(t)}?w=${w}&kb=${w >= 960 ? f[4] : f[5]}`, extmetadata: { Artist: { value: f[2] }, LicenseShortName: { value: f[3] } } }] }
          : { title: t, missing: '' };
      });
      return json({ query: { pages } });
    }
    throw new Error(`fixture has no answer for ${url}`);
  };
}

// ------------------------------------------------------------------ fetch
console.log('--- the lookup ---');
{
  const log = [];
  const r = await findReference('Spire Hall', { fetch: makeFetch({ log }) });
  ok('a named hall: the first article that is not a list of meanings, with its description, URL and Wikidata id',
    r.ok && r.page.title === 'Spire Hall' && /Six-spired/.test(r.page.description) && r.page.url.endsWith('/Spire_Hall') && r.page.qid === 'Q100', JSON.stringify(r.page ?? r));
  ok('the photo is the article\'s own lead image, from Commons, with its author (markup stripped) and licence',
    r.photo?.title === 'Spire Hall front.jpg' && r.photo.artist === 'Pat Photographer' && r.photo.license === 'CC BY-SA 4.0' && /commons\.wikimedia\.org\/wiki\/File:Spire_Hall_front\.jpg$/.test(r.photo.url), JSON.stringify({ ...r.photo, data: undefined }));
  ok('the bytes ride as base64 JPEG within the budget (the 960 px thumbnail: 120 KB)',
    r.photo.media_type === 'image/jpeg' && r.photo.bytes === r.photo.data.length && Math.round(r.photo.bytes / 1024) === 120 && r.photo.bytes <= REFERENCE_PHOTO_BUDGET, `${r.photo.bytes}`);
  const alt = r.alternates.map(a => a.title);
  ok('alternates are the other outside views IN ARTICLE ORDER; the lobby, the site plan and the logo are not offered; the fair-use file is not on Commons and is skipped',
    JSON.stringify(alt) === JSON.stringify(['Spire Hall and Other Hall.jpg', 'Spire Hall 1974.jpg']), JSON.stringify(alt));
  {
    // an article with NO lead image on record: the first picture a reader
    // meets (the infobox) is the photo, not the first one in the alphabet
    const saved = ARTICLES['Spire Hall'].pageimage;
    delete ARTICLES['Spire Hall'].pageimage;
    ARTICLES['Spire Hall'].files = ['File:Spire Hall 1974.jpg', 'File:Spire Hall and Other Hall.jpg', 'File:Spire Hall front.jpg', 'File:Spire Hall at night.jpg'];
    ARTICLES['Spire Hall'].infobox = 1;
    COMMONS_FILES['File:Spire Hall at night.jpg'] = [2000, 3000, 'Night Owl', 'CC BY 4.0', 100, 35];
    const inOrder = await findReference('Spire Hall', { fetch: makeFetch() });
    ok('with no lead image on record, the infobox picture — first in the article — is the photo, and a night shot goes last',
      inOrder.photo?.title === 'Spire Hall 1974.jpg' && inOrder.alternates[inOrder.alternates.length - 1].title === 'Spire Hall at night.jpg', `${inOrder.photo?.title} | ${inOrder.alternates.map(a => a.title).join(', ')}`);
    ARTICLES['Spire Hall'].files = ['File:Spire Hall and Other Hall.jpg', 'File:Spire Hall 1974.jpg', 'File:Spire Hall front.jpg'];
    const byName = await findReference('Spire Hall', { fetch: makeFetch({ noMediaList: true }) });
    ok('with no article order to go by (the media list is unavailable), the file named after the subject alone comes first',
      byName.ok && byName.photo?.title === 'Spire Hall 1974.jpg' && byName.alternates[0].title === 'Spire Hall front.jpg', `${byName.photo?.title} | ${byName.alternates.map(a => a.title).join(', ')}`);
    ARTICLES['Spire Hall'].pageimage = saved;
    delete ARTICLES['Spire Hall'].infobox;
    ARTICLES['Spire Hall'].files = ['File:Commons-logo.svg', 'File:Spire Hall lobby.jpg', 'File:Spire Hall and Other Hall.jpg', 'File:Spire Hall front.jpg', 'File:Spire Hall 1974.jpg', 'File:Spire Hall site plan.jpg', 'File:Spire Hall fair use.jpg'];
  }
  ok('Wikidata: the tallest recorded height first, in metres whatever the unit (88 m; 250 ft = 76.2 m), and the floor count',
    JSON.stringify(r.facts.heightM) === '[88,76.2]' && JSON.stringify(r.facts.floors) === '[7]', JSON.stringify(r.facts));
  const m = r.facts.measures.join(' | ');
  ok('the article\'s sized sentences about the WHOLE building are kept, in article order: the height, the six spires, the length and width',
    /288 feet/.test(m) && /six-spire/.test(m) && /240 feet .* long and 136 feet/.test(m) && m.indexOf('288 feet') < m.indexOf('six-spire') && m.indexOf('six-spire') < m.indexOf('240 feet'), m);
  ok('…and no section heading leaks into them', !/==/.test(m), m);
  ok('the other articles that matched are named, for a second try', r.others.length === 1 && r.others[0].title === 'Spire Hall (band)', JSON.stringify(r.others));
  ok('every request went to Wikipedia, Wikidata, Commons or the photo host — nowhere else', log.every(u => /^https:\/\/(en\.wikipedia\.org|www\.wikidata\.org|commons\.wikimedia\.org|upload\.example)\//.test(u)), log.find(u => !/wiki|upload\.example/.test(u)));
  const c = referenceCredit(r);
  ok('the credit the page keeps names the article and the author — and carries no bytes', c.title === 'Spire Hall' && c.photo.artist === 'Pat Photographer' && !JSON.stringify(c).includes(r.photo.data.slice(0, 40)), JSON.stringify(c).slice(0, 200));

  const picked = await findReference('Spire Hall', { fetch: makeFetch(), pick: 'Spire Hall 1974.jpg' });
  ok('a photo the USER picked from the alternates becomes the photo, and the old one becomes an alternate',
    picked.photo?.title === 'Spire Hall 1974.jpg' && picked.alternates.some(a => a.title === 'Spire Hall front.jpg'), picked.photo?.title);

  ok('a Commons author field full of wiki markup reads as a name in the credit', picked.photo?.artist === 'Old Archive derivative work: Old Archive', picked.photo?.artist);
  const busy = await findReference('Busy Tower', { fetch: makeFetch() });
  ok('a photo too big for the request at 960 px is fetched one step down (500 px: 90 KB), not dropped',
    busy.ok && busy.photo?.thumbWidth === 500 && Math.round(busy.photo.bytes / 1024) === 90, JSON.stringify({ ...busy.photo, data: undefined }));
  ok('…and its author keeps the ampersand a credit line needs', busy.photo?.artist === 'Busy & Co', busy.photo?.artist);

  const dis = await findReference('Tower', { fetch: makeFetch() });
  ok('a page that only lists meanings is passed over for the next real article', dis.ok && dis.page.title === 'Busy Tower', dis.page?.title ?? dis.message);

  const s = measuredSentences('The tower is 500 feet (152 m) tall. It has 12 elevators and cost $4 million. The base is 80 feet (24 m) wide on each side. A plaque is 2 inches thick.', { max: 2 });
  ok('with room for two sentences, the height and the base outrank the lifts and the plaque', s.length === 2 && /500 feet/.test(s[0]) && /80 feet/.test(s[1]), JSON.stringify(s));
}

console.log('--- what the lookup refuses ---');
{
  const person = await findReference('Ada Example', { fetch: makeFetch() });
  ok('a real person: refused by name, no photo fetched', !person.ok && person.reason === 'refused' && /a real person/.test(person.message) && !person.photo, JSON.stringify(person));
  const logo = await findReference('Zip logo', { fetch: makeFetch() });
  ok('a logo: refused — even though its article has a photograph on Commons', !logo.ok && logo.reason === 'refused' && /logo/.test(logo.message), JSON.stringify(logo));
  const kind = await findReference('Zap mark', { fetch: makeFetch() });
  ok('a logo whose description never says "logo": refused on what Wikidata says it IS', !kind.ok && kind.reason === 'refused' && /is a logo/.test(kind.message), JSON.stringify(kind));
  const brand = await findReference('Zop', { fetch: makeFetch() });
  ok('a brand with no Wikidata type on record: refused on its description', !brand.ok && brand.reason === 'refused' && /logo or brand/.test(brand.message), JSON.stringify(brand));
  const none = await findReference('Nowhere Hall', { fetch: makeFetch() });
  ok('no such article: a named non-answer', !none.ok && none.reason === 'not-found' && /no article matching "Nowhere Hall"/.test(none.message), JSON.stringify(none));
  const blank = await findReference('   ', { fetch: makeFetch() });
  ok('no subject at all: a named non-answer', !blank.ok && blank.reason === 'not-found', JSON.stringify(blank));
  const fair = await findReference('Plain Tower', { fetch: makeFetch() });
  ok('an article whose only picture is a fair-use upload: the facts come back, the photo does not', fair.ok && fair.photo === null && fair.alternates.length === 0, JSON.stringify({ ...fair, photo: fair.photo && 1 }));
  const down = await findReference('Spire Hall', { fetch: makeFetch({ down: 'en.wikipedia.org' }) });
  ok('Wikipedia down: a named non-answer, not a throw', !down.ok && down.reason === 'network' && /en\.wikipedia\.org answered 503/.test(down.message), JSON.stringify(down));
  const noCommons = await findReference('Spire Hall', { fetch: makeFetch({ down: 'commons.wikimedia.org' }) });
  ok('Commons down: the facts still come back, with no photo', noCommons.ok && noCommons.photo === null && noCommons.facts.heightM[0] === 88, JSON.stringify(noCommons.photo));
  const noData = await findReference('Spire Hall', { fetch: makeFetch({ down: 'wikidata.org' }) });
  ok('Wikidata down: the photo and the article still come back', noData.ok && noData.photo?.title === 'Spire Hall front.jpg' && noData.facts.heightM.length === 0, JSON.stringify(noData.facts));
  const thrown = await findReference('Spire Hall', { fetch: async () => { throw new TypeError('fetch failed'); } });
  ok('no connection at all: a named non-answer', !thrown.ok && thrown.reason === 'network', JSON.stringify(thrown));
}

// ---------------------------------------------------------------- request
console.log('--- what the model is offered ---');
const recipe = structuredClone(EMPTY_RECIPE);
const hall = await findReference('Spire Hall', { fetch: makeFetch() });
const toolNames = (req) => req.tools.map(t => t.name).join(',');
{
  const plain = buildParseRequest(recipe, 'a linker logs Spire Hall');
  ok('with no lookup supplied the request is what it always was: one tool, no rule about references', toolNames(plain) === 'apply_recipe_actions' && !/find_reference/.test(plain.system) && typeof plain.messages[0].content === 'string', toolNames(plain));
  const offer = buildParseRequest(recipe, 'a linker logs Spire Hall', { lookUp: true });
  ok('with a lookup: find_reference is offered beside it, with its rule, and no web search yet',
    toolNames(offer) === 'apply_recipe_actions,find_reference' && /A NAMED REAL BUILDING OR LANDMARK/.test(offer.system) && offer.tool_choice.type === 'auto', toolNames(offer));
  ok('…and the rule keeps logos, brands and people declined', /NEVER for a logo, a brand, a person/.test(offer.system));
  const forced = buildParseRequest(recipe, 'a linker logs Spire Hall', { lookUp: true, model: 'claude-opus-4-8' });
  ok('a model that must be forced onto apply_recipe_actions is not offered a tool it could never call', toolNames(forced) === 'apply_recipe_actions' && !/find_reference/.test(forced.system) && forced.tool_choice.type === 'tool', toolNames(forced));
  const img = buildParseRequest(recipe, 'build this', { lookUp: true, image: { media_type: 'image/jpeg', data: 'AAAA' } });
  ok('the user attached their own picture: no lookup is offered — their picture is the reference', toolNames(img) === 'apply_recipe_actions' && !/A NAMED REAL BUILDING/.test(img.system), toolNames(img));

  const withRef = buildParseRequest(recipe, 'a linker logs Spire Hall', { lookUp: true, reference: hall, search: true });
  const c = withRef.messages[0].content;
  ok('with a reference attached: ONE user turn — the photo first, then the reference text, then the ask',
    withRef.messages.length === 1 && c[0].type === 'image' && c[0].source.data === hall.photo.data && /^REFERENCE — fetched by the app for "Spire Hall"/.test(c[1].text) && c[c.length - 1].text === 'a linker logs Spire Hall', c.map(b => b.type).join(','));
  ok('…web search rides on that request, capped at two uses, and one more lookup is allowed',
    toolNames(withRef) === 'apply_recipe_actions,find_reference,web_search' && withRef.tools[2].max_uses === 2 && withRef.tools[2].type === WEB_SEARCH_TOOL.type, JSON.stringify(withRef.tools.slice(1).map(t => t.type ?? t.name)));
  ok('…the system prompt points at the attached reference instead of asking for one, and turns no picture rule on',
    /A REFERENCE IS ATTACHED/.test(withRef.system) && !/A NAMED REAL BUILDING OR LANDMARK as a MODEL/.test(withRef.system) && !/FROM A PICTURE: the user attached/.test(withRef.system));
  const t = c[1].text;
  ok('the reference text names the article, credits the photographer and the licence, and gives the recorded height both ways',
    /FOUND: Spire Hall — Six-spired meeting hall/.test(t) && /"Spire Hall front\.jpg" by Pat Photographer, CC BY-SA 4\.0, Wikimedia Commons/.test(t) && /height 88 m \(289 ft\)/.test(t) && /7 floors above ground/.test(t), t.slice(0, 600));
  ok('…tells the model to read massing only, never trace, decline ornament, state its scale and list what it assumed',
    /MASSING only/.test(t) && /Do not trace an outline/.test(t) && /go to declined/.test(t) && /pick a scale and say it/.test(t) && /"Assumed:"/.test(t));
  ok('…and asks for a search only when the height, length or width is missing — one, and a second only if needed', /If any of the three is not stated above, run web_search for it now — one search, and a second only if/.test(t));
  const noSearch = buildParseRequest(recipe, 'a linker logs Spire Hall', { reference: hall, search: false });
  ok('without search: no web search tool, no mention of it, and no further lookup when none is offered',
    toolNames(noSearch) === 'apply_recipe_actions' && !/web_search/.test(noSearch.messages[0].content[1].text) && /ignore it, say so in the summary/.test(noSearch.messages[0].content[1].text), toolNames(noSearch));
  const alone = buildParseRequest(recipe, 'a linker logs Spire Hall', { search: true });
  ok('search is NEVER offered on a request with no reference — an ordinary prompt cannot bill a search', toolNames(alone) === 'apply_recipe_actions', toolNames(alone));

  const refused = { ok: false, subject: 'Ada Example', reason: 'refused', message: '"Ada Example" is a real person — the app does not fetch a likeness of people, logos or brands', others: [] };
  const rt = referenceText(refused, { again: true, search: true });
  ok('a refused subject: the text says decline, and offers neither a retry nor a search', /likeness rule stands: decline/.test(rt) && !/find_reference ONCE more/.test(rt) && !/web_search/.test(rt), rt);
  const missing = referenceText({ ok: false, subject: 'Nowhere Hall', reason: 'not-found', message: 'Wikipedia has no article matching "Nowhere Hall"', others: [{ title: 'Somewhere Hall', description: 'a hall' }] }, { again: true });
  ok('nothing found: the text allows one more try, names the near matches, and asks for the proportions to be listed as assumed',
    /find_reference ONCE more/.test(missing) && /Somewhere Hall \(a hall\)/.test(missing) && /"Assumed:"/.test(missing), missing);
  ok('a reference with no photo says so and attaches no image',
    buildParseRequest(recipe, 'x', { reference: { ...hall, photo: null } }).messages[0].content[0].type === 'text' && /PHOTO: no usable photograph/.test(referenceText({ ...hall, photo: null })));
}

// ------------------------------------------------------------------- loop
console.log('--- the turn ---');
const usage = (extra = {}) => ({ input_tokens: 100, output_tokens: 10, ...extra });
const askRef = (subject) => ({ stop_reason: 'tool_use', usage: usage(), content: [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'tool_use', id: 'tu_ref', name: 'find_reference', input: { subject } }] });
const build = (summary = 'Built the hall. Assumed: the footprint.', extra = []) => ({
  stop_reason: 'tool_use', usage: usage(), content: [...extra, { type: 'tool_use', id: 'tu_act', name: 'apply_recipe_actions', input: { summary, actions: [{ kind: 'set_thickness', thickness: 0.5 }], declined: [], suggest: [] } }],
});
const final = (summary = 'Done and described.') => ({ stop_reason: 'tool_use', usage: usage(), content: [{ type: 'tool_use', id: 'tu_fin', name: 'apply_recipe_actions', input: { summary, actions: [], declined: [], suggest: [] } }] });
const scripted = (replies) => { const seen = []; const call = async (req) => { seen.push(req); const r = replies.shift(); if (r instanceof Error) throw r; if (!r) throw new Error('the script ran out of replies'); return r; }; return { call, seen }; };
const weave = async () => ({ ok: true, errors: [], warnings: [], pieces: 0, preview: { empty: true } });
const run = (opts) => runIntentLoop({ recipe, utterance: 'a linker logs Spire Hall', model: DEFAULT_MODEL, weave, ...opts });
{
  const stages = [];
  const { call, seen } = scripted([askRef('Spire Hall'), build(), final()]);
  const subjects = [];
  const out = await run({ call, lookUp: async (s) => { subjects.push(s); return hall; }, search: true, onStage: (s) => stages.push(s.stage) });
  ok('the model asks, the app looks the subject up once, and the turn starts over: the second request is a NEW one-message conversation',
    subjects.join() === 'Spire Hall' && seen.length === 3 && seen[1].messages.length === 1 && seen[1].messages[0].content[0].type === 'image', `${seen.length} calls, ${seen[1]?.messages.length} messages`);
  ok('…so nothing of the first reply (its thinking, its tool call) is replayed under a different tool list',
    !JSON.stringify(seen[1].messages).includes('tu_ref') && !JSON.stringify(seen[1].messages).includes('"thinking"'));
  ok('the first request offers the lookup and no search; the second carries the reference and the search',
    toolNames(seen[0]) === 'apply_recipe_actions,find_reference' && toolNames(seen[1]) === 'apply_recipe_actions,find_reference,web_search', `${toolNames(seen[0])} | ${toolNames(seen[1])}`);
  ok('the look at the weave continues THAT conversation with the same tools (append-only)',
    seen[2].messages.length === 3 && JSON.stringify(seen[2].tools) === JSON.stringify(seen[1].tools) && JSON.stringify(seen[2].messages[0]) === JSON.stringify(seen[1].messages[0]));
  ok('the result carries the reference for the page to credit, the lookups, and every call in the usage',
    out.reference === hall && out.lookups.length === 1 && out.usage.calls === 3 && out.usage.input_tokens === 300 && out.summary === 'Done and described.', JSON.stringify(out.usage));
  ok('the page is told when the lookup starts and what it found', stages.join() === 'lookup,found', stages.join());
}
{
  const { call, seen } = scripted([build('Built a shelf.'), final()]);
  let looked = 0;
  const out = await run({ call, lookUp: async () => { looked++; return hall; }, search: true, utterance: 'a shelf' });
  ok('an ordinary prompt: no lookup, no search tool on any call, no reference in the result',
    looked === 0 && seen.every(r => !toolNames(r).includes('web_search')) && out.reference === null && out.lookups.length === 0 && out.usage.web_search_requests === 0);
}
{
  const wrong = { ...hall, page: { ...hall.page, title: 'Spire Hall (band)' } };
  const { call, seen } = scripted([askRef('Spire Hall band'), askRef('Spire Hall'), build(), final()]);
  const subjects = [];
  const out = await run({ call, lookUp: async (s) => { subjects.push(s); return subjects.length === 1 ? wrong : hall; }, search: true });
  ok(`the first lookup found the wrong article: ONE more is allowed (${MAX_LOOKUPS} in all), and the build uses the second`,
    subjects.join('|') === 'Spire Hall band|Spire Hall' && out.reference === hall && out.lookups.length === 2 && seen.length === 4, subjects.join('|'));
  ok('…after which find_reference is withdrawn, and the text stops offering it',
    toolNames(seen[1]) === 'apply_recipe_actions,find_reference,web_search' && toolNames(seen[2]) === 'apply_recipe_actions,web_search' && !/find_reference ONCE more/.test(seen[2].messages[0].content[1].text), toolNames(seen[2]));
}
{
  const { call, seen } = scripted([askRef('Spire Hall'), new Error('The API rejected the request (400): web search is not enabled for this organization'), build(), final()]);
  const out = await run({ call, lookUp: async () => hall, search: true });
  ok('the API refuses web search: the same request goes once more WITHOUT it, and the build goes on',
    seen.length === 4 && toolNames(seen[1]).includes('web_search') && !toolNames(seen[2]).includes('web_search') && !/web_search/.test(seen[2].messages[0].content[1].text) && out.reference === hall, seen.map(toolNames).join(' | '));
  ok('…and the result says why search was dropped', /web search is not enabled/.test(out.searchDropped ?? ''), out.searchDropped);
}
{
  const stopped = Object.assign(new Error('the request was cancelled'), { name: 'AbortError' });
  const { call, seen } = scripted([askRef('Spire Hall'), stopped]);
  let err = null;
  try { await run({ call, lookUp: async () => hall, search: true }); } catch (e) { err = e; }
  ok('a turn the user STOPPED is not retried without search — it stops', err === stopped && seen.length === 2, `${seen.length} calls`);
}
{
  const { call, seen } = scripted([askRef('Ada Example'), build('Declined the portrait.'), final()]);
  const refused = { ok: false, subject: 'Ada Example', reason: 'refused', message: '"Ada Example" is a real person — the app does not fetch a likeness of people, logos or brands', others: [] };
  const out = await run({ call, lookUp: async () => refused, search: true });
  ok('a refused subject: the turn goes on with no image, no search tool, and the decline instruction',
    toolNames(seen[1]) === 'apply_recipe_actions,find_reference' && seen[1].messages[0].content[0].type === 'text' && /decline that part/.test(seen[1].messages[0].content[0].text) && out.reference === null && out.lookups[0] === refused, toolNames(seen[1]));
}
{
  const { call, seen } = scripted([askRef('Spire Hall'), build(), final()]);
  const out = await run({ call, lookUp: async () => { throw new Error('boom'); }, search: false });
  ok('a lookup that THROWS is "nothing found", never a dead turn', seen.length === 3 && out.lookups[0].ok === false && /boom/.test(out.lookups[0].message) && /returned nothing: boom/.test(seen[1].messages[0].content[0].text), JSON.stringify(out.lookups[0]));
}
{
  const searchBlocks = [
    { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'Spire Hall footprint dimensions' } },
    { type: 'web_search_tool_result', tool_use_id: 'st_1', content: [{ type: 'web_search_result', title: 'Spire Hall facts', url: 'https://example.org/hall', encrypted_content: 'xxxx' }] },
  ];
  const paused = { stop_reason: 'pause_turn', usage: usage({ server_tool_use: { web_search_requests: 1 } }), content: searchBlocks };
  const { call, seen } = scripted([askRef('Spire Hall'), paused, build(), final()]);
  const out = await run({ call, lookUp: async () => hall, search: true });
  ok('a search that pauses the turn is resumed by sending the turn back as it stands — no extra user message',
    seen.length === 4 && seen[2].messages.length === 2 && seen[2].messages[1].role === 'assistant' && seen[2].messages[1].content === paused.content, `${seen[2]?.messages.length} messages`);
  ok('the searches are counted and what was searched is kept for the page to cite',
    out.usage.web_search_requests === 1 && out.searches.length === 1 && out.searches[0].query === 'Spire Hall footprint dimensions' && out.searches[0].results[0].url === 'https://example.org/hall', JSON.stringify(out.searches));
  ok('…the search result blocks go back to the API untouched on the next call', JSON.stringify(seen[3].messages).includes('"encrypted_content":"xxxx"'));
  ok('a failed search is recorded as failed, not as empty',
    webSearches([{ type: 'server_tool_use', id: 'a', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', tool_use_id: 'a', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }])[0].error === 'max_uses_exceeded');
}
{
  // the model calls find_reference AGAIN on the look at the weave — a build is not a lookup
  const { call, seen } = scripted([askRef('Spire Hall'), build('Built it.'), askRef('Spire Hall')]);
  const out = await run({ call, lookUp: async () => hall, search: false });
  ok('a find_reference on a LATER turn is ignored: the built state and its summary stand', seen.length === 3 && out.lookups.length === 1 && out.summary === 'Built it.' && out.turns.length === 1, `${out.turns.length} turns, "${out.summary}"`);
}
{
  const { call, seen } = scripted([build('Built a hall from memory.'), final()]);
  const out = await run({ call });
  ok('no lookup supplied: the loop is the loop it was — two calls, one tool, the same result shape plus empty reference fields',
    seen.length === 2 && seen.every(r => toolNames(r) === ACTION_TOOL.name) && out.reference === null && out.searches.length === 0 && out.searchDropped === null);
}
ok('the tool the model is offered is named find_reference and takes one required subject', REFERENCE_TOOL.name === 'find_reference' && JSON.stringify(REFERENCE_TOOL.input_schema.required) === '["subject"]');

console.log(failed === 0 ? `\nALL ${passed} REFERENCE CHECKS PASSED` : `\n${failed} REFERENCE CHECK(S) FAILED (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
