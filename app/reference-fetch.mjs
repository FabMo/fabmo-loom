// Reference lookup — a credited photo and a few measured facts for ONE
// named real building or landmark, fetched on the user's connection.
//
// The model has no web access: it cannot look at the Chrysler Building. It
// CAN ask the app to (the find_reference tool in intent.mjs), and this
// module is the app's answer — the same seam as terrain-fetch.mjs, above
// the rail: nothing below the intent layer ever touches the net, and what
// comes back is REFERENCE, not data. Nothing here becomes geometry; the
// model reads the picture for massing and the facts for proportion, and
// still has to build the thing out of the catalog and get it verified.
//
// Sources, all keyless and CORS-open (origin=*):
//   en.wikipedia.org     which article the name means, its intro, the
//                        sentences in it that carry a measurement, and its
//                        pictures IN ARTICLE ORDER (the infobox view first)
//   wikidata.org         height / floors / length / width when recorded,
//                        and "instance of" — the person / brand backstop
//   commons.wikimedia.org  the photo, its author and its licence. Commons
//                        ONLY: a file that lives on en.wikipedia alone is
//                        there under fair use and is skipped.
//
// Isomorphic (fetch + btoa): the page calls it in the browser; the test
// and a probe call it in Node. `fetch` is injectable so the gauntlet runs
// it against recorded responses with no network at all.

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKI_REST = 'https://en.wikipedia.org/api/rest_v1';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
// a browser may not set User-Agent; Wikimedia reads Api-User-Agent there
const AGENT = 'fabmo-loom-reference/0.1 (https://labs.shopbottools.com; CNC design app, one lookup per user request)';

export const REFERENCE_PHOTO_BUDGET = 350 * 1024;   // base64 chars: the picture rides in every call of the turn, through a 1 MB relay cap
const THUMB_WIDTHS = [960, 500];                     // Commons' standard thumbnail steps
const MAX_CANDIDATES = 8;

// Wikidata "instance of" values the app will not fetch a likeness for,
// whatever the model asked: people (real or fictional), marks and the
// companies behind them. The model's own rule is the first line; this is
// the backstop that does not depend on it.
const REFUSED_KINDS = {
  Q5: 'a real person', Q15632617: 'a fictional person', Q95074: 'a fictional character', Q15773347: 'a fictional character',
  Q1886349: 'a logo', Q167270: 'a trademark', Q431289: 'a brand',
  Q4830453: 'a company', Q783794: 'a company', Q6881511: 'a company', Q891723: 'a company',
};
const REFUSED_DESCRIPTION = /\b(logo|trademark|wordmark|brand)\b/i;

// file titles that are not a photograph of the outside of the thing
const NOT_A_VIEW = /\b(logo|icon|flag|seal|coat of arms|map|plans?|diagram|drawing|sketch|blueprint|section|chart|graph|poster|stamp|coin|banknote|signature|portrait|caricature|plaque|lobby|interior|inside|ceiling|elevators?|doors?|windows?|mural|details?|motifs?|closeup|close-up|gargoyle|eagle|statue|statuary|entrance|decoration|room|font|model of|festival|fireworks|construction|fondations|demolition|ruins of|commons-logo|wiki)\b/i;
// a view, but a poor one to read massing from: lit up, at night, dressed for an occasion
const POOR_LIGHT = /\b(night|illuminat\w*|lights?|lit|led|christmas|rainbow|election|fog|silhouette)\b/i;

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
// a Commons author field is wiki markup flattened: "w:User:Overand derivative
// work: Overand ( talk )" should read as a name in a credit line
const author = (s) => strip(s).replace(/\(\s*talk\s*\)/gi, ' ').replace(/\b(?:w:)?User:/gi, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'unknown author';
const words = (s) => String(s ?? '').toLowerCase().replace(/\.[a-z]+$/, '').split(/[^a-z0-9]+/).filter(w => w.length > 2);

export class ReferenceError_ extends Error {
  constructor(reason, message, extra = {}) { super(message); this.reason = reason; Object.assign(this, extra); }
}

// Node sends "node" as its User-Agent, which Wikimedia throttles at once;
// a browser sets its own and refuses to let a page change it
const HEADERS = typeof window === 'undefined' ? { 'Api-User-Agent': AGENT, 'user-agent': AGENT } : { 'Api-User-Agent': AGENT };
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(fetchFn, base, params, signal) {
  const url = `${base}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const host = new URL(base).hostname;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetchFn(url, { headers: HEADERS, signal }); }
    catch (e) { throw new ReferenceError_('network', `the lookup could not reach ${host} (${e?.name === 'AbortError' ? 'cancelled' : 'no connection'})`); }
    // one polite retry when throttled — never a loop
    if (res.status === 429 && attempt === 0) { await pause(1200); continue; }
    if (!res.ok) throw new ReferenceError_('network', `${host} answered ${res.status}`);
    return res.json();
  }
}

// bytes → base64 without Buffer (browser-safe), in chunks so a 300 KB
// photo does not blow the argument limit of String.fromCharCode
function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

// Every sentence of the article that states a size — the cheap, citable
// way to hand the model "288 feet tall, six spires, seven floors" without
// parsing an infobox. The ones about the whole building (tall, wide,
// frontage, setbacks, spires) outrank the ones about a detail (a 9-foot
// pineapple, 1/16 inch of grout); the kept ones go back in article order.
const MEASURE = /\b\d[\d,.]*\s*(?:-|–|\s)?\s*(?:ft|feet|foot|m|metres?|meters?|stor(?:y|ies|eys?)|floors?|inch(?:es)?|yards?|sq(?:uare)?\s*f(?:ee)?t|acres?)\b/i;
const COUNTED = /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve|\d+)\s+(?:spires?|towers?|domes?|wings?|setbacks?|tiers?|storeys?|stories|floors?|columns?|arches|bays|minarets?|turrets?|gables?)\b/i;
const SIZED = /\b\d[\d,.]*\s*(?:-|–|\s)?\s*(?:ft|feet|foot|m|metres?|meters?)\b/i;
const WHOLE = /\b(tall|height|high|wide|width|long|length|deep|depth|footprint|frontage|on each side|square|dimensions?|measur\w+|rises?|setbacks?)\b/i;
const PARTS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve|\d+)[- ](?:spires?|towers?|domes?|wings?|setbacks?|tiers?|minarets?|turrets?|gables?)\b/i;
const DETAIL = /\b(inch(?:es)?|mm|cm|thick|grout|elevators?|lobby|stairs?|windows?|doors?|entrances?|ornaments?|cost|million|tons?|acres?|ha)\b|\$/i;
const HISTORY = /\b(would have|proposed|originally|initial(?:ly)? plans?|had been|had requested|planned|earthquake|sold|purchased|rented|leased)\b/i;
export function measuredSentences(text, { max = 7, maxChars = 1400 } = {}) {
  const plain = String(text ?? '').replace(/=+\s*[^=\n]{1,80}\s*=+/g, ' ').replace(/\n+/g, ' ');
  const seen = new Set();
  const found = [];
  plain.split(/(?<=[.!?])\s+(?=[A-Z"(])/).forEach((raw, i) => {
    const s = raw.trim();
    if (s.length < 20 || s.length > 420) return;
    if (!MEASURE.test(s) && !COUNTED.test(s)) return;
    const key = s.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ s, i, score: (SIZED.test(s) && WHOLE.test(s) ? 3 : 0) + (PARTS.test(s) ? 2 : 0) + (COUNTED.test(s) ? 0.5 : 0) - (DETAIL.test(s) ? 1.5 : 0) - (HISTORY.test(s) ? 2 : 0) - i * 0.004 });
  });
  const kept = [];
  let used = 0;
  for (const f of [...found].sort((a, b) => b.score - a.score)) {
    if (kept.length >= max || used + f.s.length > maxChars) continue;
    kept.push(f); used += f.s.length;
  }
  return kept.sort((a, b) => a.i - b.i).map(f => f.s);
}

const UNIT_M = { Q11573: 1, Q3710: 0.3048, Q174728: 0.01, Q828224: 1000, Q218593: 0.0254, Q482798: 0.9144 };   // metre, foot, centimetre, kilometre, inch, yard
const metres = (v) => {
  const f = UNIT_M[String(v?.unit ?? '').split('/').pop()];
  const n = Number(v?.amount);
  return f && Number.isFinite(n) ? +(n * f).toFixed(2) : null;
};

async function wikidataFacts(fetchFn, qid, signal) {
  const claim = async (P) => {
    try { return ((await getJson(fetchFn, WIKIDATA, { action: 'wbgetclaims', entity: qid, property: P }, signal)).claims?.[P] ?? []).map(c => c.mainsnak?.datavalue?.value).filter(Boolean); }
    catch { return []; }   // a missing fact is not a failed lookup
  };
  const [kinds, height, floors, length, width] = await Promise.all(['P31', 'P2048', 'P1101', 'P2043', 'P2049'].map(claim));
  const ms = (list) => [...new Set(list.map(metres).filter(v => v > 0))].sort((a, b) => b - a);
  return {
    kinds: kinds.map(k => k.id).filter(Boolean),
    heightM: ms(height), lengthM: ms(length), widthM: ms(width),
    floors: [...new Set(floors.map(f => Math.round(Number(f.amount))).filter(n => n > 0))].sort((a, b) => b - a),
  };
}

// Rank the article's photographs. `files` arrive IN ARTICLE ORDER when the
// REST media-list answered (each { title, lead, section }): the infobox
// view — the picture an editor chose to stand for the building — comes
// first, and that order is worth more than anything a file name says.
// From the plain images listing (alphabetical) they carry no order, and
// the name is all there is.
function rankCandidates(page, files, ordered) {
  const want = new Set(words(page.title));
  const lead = page.pageimage ? `File:${page.pageimage.replace(/_/g, ' ')}` : null;
  const seen = new Set();
  const all = [...(lead ? [{ title: lead, lead: true, section: 0 }] : []), ...files]
    .filter(f => /\.jpe?g$/i.test(f.title) && !seen.has(f.title) && seen.add(f.title));
  return all
    .map((f, i) => {
      // a SET of words: "Chrysler Building and Calyon Building" must not
      // outscore "Chrysler Building (1)" by saying "building" twice — and
      // a title about the subject alone beats one that shares the frame
      const w = new Set(words(f.title.replace(/^File:/, '')));
      const hit = [...w].filter(x => want.has(x)).length;
      const named = hit / Math.max(1, want.size) - 0.08 * (w.size - hit);
      const placed = ordered ? (f.section === 0 ? 1.5 : 0) - i * 0.05 : -i * 0.001;
      return { title: f.title, score: (f.lead || f.title === lead ? 2 : 0) + placed + named * (ordered ? 0.5 : 1) - (NOT_A_VIEW.test(f.title) ? 3 : 0) - (POOR_LIGHT.test(f.title) ? 1 : 0) };
    })
    .filter(c => c.score > -1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(c => c.title);
}

// The article's pictures in the order a reader meets them, or null.
async function mediaList(fetchFn, title, signal) {
  try {
    const url = `${WIKI_REST}/page/media-list/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const res = await fetchFn(url, { headers: HEADERS, signal });
    if (!res.ok) return null;
    const items = (await res.json())?.items;
    if (!Array.isArray(items)) return null;
    return items.filter(i => i?.type === 'image' && i.title).map(i => ({ title: String(i.title).replace(/_/g, ' '), lead: !!i.leadImage, section: i.section_id ?? null }));
  } catch { return null; }
}

async function commonsInfo(fetchFn, titles, width, signal) {
  if (!titles.length) return [];
  const d = await getJson(fetchFn, COMMONS, {
    action: 'query', titles: titles.join('|'), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(width), iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription',
  }, signal);
  const norm = new Map((d.query?.normalized ?? []).map(n => [n.to, n.from]));
  const byTitle = new Map(Object.values(d.query?.pages ?? {}).map(p => [norm.get(p.title) ?? p.title, p]));
  const out = [];
  for (const t of titles) {
    const p = byTitle.get(t) ?? [...byTitle.values()].find(x => x.title === t);
    const ii = p?.imageinfo?.[0];
    // not on Commons (an en.wikipedia fair-use upload), not a JPEG, or too
    // small to read massing from
    if (!ii || p.missing !== undefined || ii.mime !== 'image/jpeg' || Math.min(ii.width, ii.height) < 400) continue;
    const em = ii.extmetadata ?? {};
    out.push({
      title: p.title.replace(/^File:/, ''), url: ii.descriptionurl,
      artist: author(em.Artist?.value), license: strip(em.LicenseShortName?.value) || 'see the file page',
      width: ii.width, height: ii.height, thumbUrl: ii.thumburl ?? ii.url, thumbWidth: ii.thumbwidth ?? ii.width,
    });
  }
  return out;
}

async function download(fetchFn, url, signal) {
  let res;
  try { res = await fetchFn(url, { headers: typeof window === 'undefined' ? { 'user-agent': AGENT } : {}, signal }); }
  catch (e) { throw new ReferenceError_('network', `the photo could not be downloaded (${e?.name === 'AbortError' ? 'cancelled' : 'no connection'})`); }
  if (!res.ok) throw new ReferenceError_('network', `the photo host answered ${res.status}`);
  const type = (res.headers?.get?.('content-type') ?? 'image/jpeg').split(';')[0];
  if (!/^image\/jpeg$/.test(type)) throw new ReferenceError_('no-photo', `the photo came back as ${type}`);
  return toBase64(await res.arrayBuffer());
}

/**
 * Look one subject up. Never throws: every way it can fail comes back as
 * { ok: false, reason, message } so the turn goes on without a reference.
 *
 *   subject   the name, as an encyclopedia would title it
 *   pick      (optional) a Commons file title the USER chose from the
 *             alternates of an earlier lookup — it becomes the photo
 *
 * ok: { ok: true, subject, page: { title, description, url, qid },
 *       facts: { extract, measures[], heightM[], floors[], lengthM[], widthM[] },
 *       photo: { title, url, artist, license, width, height, thumbUrl,
 *                media_type, data, bytes } | null,
 *       alternates: [{ title, url, artist, license, thumbUrl, width, height }],
 *       others: [{ title, description }] }
 */
export async function findReference(subject, { fetch: fetchFn = globalThis.fetch, pick = null, signal = null, budget = REFERENCE_PHOTO_BUDGET } = {}) {
  const name = String(subject ?? '').trim().slice(0, 120);
  try {
    if (!name) throw new ReferenceError_('not-found', 'no subject was named');
    const s = await getJson(fetchFn, WIKI, {
      action: 'query', generator: 'search', gsrsearch: name, gsrlimit: '4', redirects: '1',
      prop: 'pageimages|extracts|description|pageprops|info', piprop: 'name', pilimit: '4',
      exintro: '1', explaintext: '1', exchars: '900', exlimit: '4', inprop: 'url', ppprop: 'wikibase_item|disambiguation',
    }, signal);
    const hits = Object.values(s.query?.pages ?? {}).sort((a, b) => a.index - b.index).filter(p => p.pageprops?.disambiguation === undefined);
    if (!hits.length) throw new ReferenceError_('not-found', `Wikipedia has no article matching "${name}"`);
    const page = hits[0];
    const others = hits.slice(1, 4).map(p => ({ title: p.title, description: p.description ?? '' }));
    const qid = page.pageprops?.wikibase_item ?? null;

    const [wd, full, media] = await Promise.all([
      qid ? wikidataFacts(fetchFn, qid, signal) : { kinds: [], heightM: [], lengthM: [], widthM: [], floors: [] },
      getJson(fetchFn, WIKI, { action: 'query', titles: page.title, prop: 'extracts', explaintext: '1', exlimit: '1' }, signal).catch(() => null),
      mediaList(fetchFn, page.title, signal),
    ]);
    // no media-list (an older wiki, a hiccup): the plain listing, unordered
    const listed = media ? null : await getJson(fetchFn, WIKI, { action: 'query', titles: page.title, prop: 'images', imlimit: '200' }, signal).catch(() => null);

    const refusedKind = wd.kinds.map(k => REFUSED_KINDS[k]).find(Boolean) ?? (REFUSED_DESCRIPTION.test(page.description ?? '') ? 'a logo or brand' : null);
    if (refusedKind) {
      throw new ReferenceError_('refused', `"${page.title}" is ${refusedKind} — the app does not fetch a likeness of people, logos or brands`, { others });
    }

    const article = Object.values(full?.query?.pages ?? {})[0]?.extract ?? '';
    const files = media ?? (Object.values(listed?.query?.pages ?? {})[0]?.images ?? []).map(i => ({ title: i.title, lead: false, section: null }));
    let candidates = rankCandidates(page, files, !!media);
    if (pick) candidates = [`File:${String(pick).replace(/^File:/, '')}`, ...candidates.filter(t => t.replace(/^File:/, '') !== String(pick).replace(/^File:/, ''))];

    let infos = [];
    try { infos = await commonsInfo(fetchFn, candidates, THUMB_WIDTHS[0], signal); } catch { /* facts without a photo still help */ }
    let photo = null;
    for (const cand of infos.slice(0, 3)) {
      try {
        let data = await download(fetchFn, cand.thumbUrl, signal);
        let used = cand;
        if (data.length > budget) {
          // a busy photo at 960 px can outgrow the request: one step down
          const small = (await commonsInfo(fetchFn, [`File:${cand.title}`], THUMB_WIDTHS[1], signal))[0];
          if (!small) continue;
          data = await download(fetchFn, small.thumbUrl, signal);
          if (data.length > budget) continue;
          used = small;
        }
        photo = { ...used, media_type: 'image/jpeg', data, bytes: data.length };
        break;
      } catch { /* try the next candidate */ }
    }

    return {
      ok: true, subject: name,
      page: { title: page.title, description: page.description ?? '', url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, qid },
      facts: {
        extract: String(page.extract ?? '').replace(/\s+/g, ' ').trim(),
        measures: measuredSentences(article),
        heightM: wd.heightM, floors: wd.floors, lengthM: wd.lengthM, widthM: wd.widthM,
      },
      photo,
      alternates: infos.filter(i => i.title !== photo?.title).slice(0, 6),
      others,
    };
  } catch (e) {
    return { ok: false, subject: name, reason: e?.reason ?? 'error', message: e?.message ?? String(e), others: e?.others ?? [] };
  }
}

// What the page keeps and logs about a lookup: who made the picture and
// where it came from — never the bytes.
export function referenceCredit(ref) {
  if (!ref?.ok) return null;
  return {
    subject: ref.subject, title: ref.page.title, url: ref.page.url,
    photo: ref.photo ? { title: ref.photo.title, url: ref.photo.url, artist: ref.photo.artist, license: ref.photo.license } : null,
  };
}
