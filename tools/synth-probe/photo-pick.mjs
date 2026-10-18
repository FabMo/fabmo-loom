// Tonight's furniture photos — the picture lane of the nightly probe.
//
// Loom takes a picture of a piece of furniture plus (optionally) its overall
// size and builds it. This script gathers the night's pictures and writes
// a prompts file in the probe's shape, one row per picture:
//
//   { id, persona, prior, prompt, note,
//     photo: { file, source, title, credit, license, url, media_type },
//     statedSize?: [W, H, D] }
//
// Two sources, same as the rest of the harness's public/private split:
//   - photos.local/   real photos someone dropped in (gitignored; a sidecar
//                     <name>.txt is the prompt text, e.g. the tape-measure
//                     numbers). Up to --local of them per night, rotating.
//   - Wikimedia Commons: random CC/PD photos from a rotating wheel of
//                     curated furniture CATEGORIES (full-text search was too
//                     loose: a train station for "shelving"), downloaded at
//                     1200px. The
//                     picture decides structure; since nobody measured the
//                     real piece, every other Commons row states a plausible
//                     size in the text — a deterministic check that the TEXT
//                     decides the numbers (probe.mjs records sizeHonored).
//
// Selection is seeded by the day so a re-run picks the same pictures.
// Pictures land in runs/photos/<day>/ (gitignored, never committed).
//
// Usage: node photo-pick.mjs <YYYY-MM-DD> [--count N] [--local N] [--no-commons] [--fresh]
//   writes runs/<day>-photo-prompts.json; prints one [photos] line. A
//   second run the same day keeps the first pick unless --fresh.
//   Exit 0 even when nothing was picked — nightly.mjs reads the count.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';

const HERE = new URL('./', import.meta.url).pathname;
const RUNS = `${HERE}runs/`;
const LOCAL_DIR = `${HERE}photos.local/`;
const USED = `${RUNS}photos/used.json`;
const UA = 'fabmo-loom-nightly-probe/0.1 (https://labs.shopbottools.com; CNC furniture reproduction test harness)';

const argv = process.argv.slice(2);
const DAY = argv.find(a => /^\d{4}-\d\d-\d\d$/.test(a));
if (!DAY) { console.error('usage: node photo-pick.mjs <YYYY-MM-DD> [--count N] [--local N] [--no-commons]'); process.exit(1); }
const flag = (name, dflt) => { const i = argv.indexOf(name); return i > 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt; };
const COUNT = flag('--count', 6);
const LOCAL_MAX = flag('--local', 2);
const NO_COMMONS = argv.includes('--no-commons');
const FRESH = argv.includes('--fresh');

// idempotent per day: a re-run (nightly after a crash, an attended
// --photos-only) keeps the same pictures unless --fresh
const OUT = `${RUNS}${DAY}-photo-prompts.json`;
if (!FRESH && existsSync(OUT)) {
  const prior = JSON.parse(readFileSync(OUT, 'utf8'));
  if (prior.length && prior.every(r => existsSync(`${HERE}${r.photo.file}`))) {
    console.log(`[photos] ${prior.length} kept from the earlier pick today (${OUT.replace(HERE, '')}; --fresh to re-pick)`);
    process.exit(0);
  }
}

// Commons categories (checked 2026-10-18: each holds 17–650 files) with a
// plausible overall size (W, H, D inches) for the "state the numbers" rows.
// Plain shop pieces — the kinds flat panels build — plus chairs, which
// mostly need curves and so probe the honest-decline path.
const WHEEL = [
  { cat: 'Bookshelves', size: [30, 60, 11] },
  { cat: 'Wooden bookcases', size: [36, 72, 12] },
  { cat: 'Bookcases', size: [36, 72, 12] },
  { cat: 'Shelves', size: [36, 48, 10] },
  { cat: 'Wooden shelves', size: [30, 36, 8] },
  { cat: 'Wall shelves', size: [30, 12, 8] },
  { cat: 'Nightstands', size: [20, 26, 16] },
  { cat: 'Wooden benches', size: [48, 18, 14] },
  { cat: 'Indoor benches', size: [48, 18, 14] },
  { cat: 'Shoe racks', size: [30, 24, 12] },
  { cat: 'Workbenches', size: [60, 34, 24] },
  { cat: 'Side tables', size: [20, 24, 20] },
  { cat: 'Wooden desks', size: [48, 30, 24] },
  { cat: 'Writing desks', size: [48, 30, 24] },
  { cat: 'Wooden crates', size: [18, 12, 12] },
  { cat: 'Crates', size: [24, 16, 16] },
  { cat: 'Step stools', size: [16, 20, 12] },
  { cat: 'Wine racks', size: [24, 36, 12] },
  { cat: 'Plant stands', size: [14, 30, 14] },
  { cat: 'Wooden stools', size: [14, 18, 14] },
  { cat: 'Wooden cabinets', size: [36, 72, 18] },
  { cat: 'Cupboards', size: [36, 72, 18] },
  { cat: 'Console tables', size: [48, 30, 14] },
  { cat: 'Coffee tables', size: [44, 18, 22] },
  { cat: 'Kitchen islands', size: [48, 36, 24] },
  { cat: 'Chests of drawers', size: [36, 40, 18] },
  { cat: 'Dressers', size: [60, 34, 18] },
  { cat: 'Sideboards', size: [60, 34, 18] },
  { cat: 'Wooden chests', size: [36, 20, 18] },
  { cat: 'Storage boxes', size: [24, 14, 14] },
  { cat: 'Wooden boxes', size: [16, 10, 10] },
  { cat: 'Wooden tables', size: [60, 30, 30] },
  { cat: 'Kitchen tables', size: [60, 30, 36] },
  { cat: 'Lecterns', size: [24, 46, 20] },
  { cat: 'Doghouses', size: [30, 30, 36] },
  { cat: 'Wooden chairs', size: [18, 34, 18] },
];
// titles that are not a photograph of a piece of furniture — and museum
// collection pieces (MET/NGA/palace…): 4 of the first night's 6 were ornate
// antiques, which only exercise the honest-decline path
const REJECT = /drawing|plan\b|diagram|logo|sketch|blueprint|catalog|advert|poster|\bmap\b|chart|pattern|scan|painting|illustration|engraving|lithograph|woodcut|magazine|NGA \d|\bpage\b|\bplate\b|\bMET\b|\bNGA\b|\bV&A\b|museum|museo|mus[ée]e|palace|palais|ch[âa]teau|castle|manor|cathedral|church|abbey|\.svg|\.png|\.tif|\.pdf/i;

// ---- deterministic randomness: the day is the seed --------------------
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return function rand() {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const rand = seeded(DAY);
const doy = Math.floor((Date.parse(DAY) - Date.parse(DAY.slice(0, 4) + '-01-01')) / 86400e3);

mkdirSync(`${RUNS}photos/${DAY}`, { recursive: true });
const used = existsSync(USED) ? JSON.parse(readFileSync(USED, 'utf8')) : { commons: [] };
const usedSet = new Set(used.commons);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const sizeText = ([w, h, d]) => `Make it about ${w} wide, ${h} tall and ${d} deep.`;

const rows = [];
const notes = [];

// ---- 1. local photos (rotating) ------------------------------------------
if (existsSync(LOCAL_DIR)) {
  const files = readdirSync(LOCAL_DIR).filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort();
  const picks = files.length <= LOCAL_MAX ? files : Array.from({ length: LOCAL_MAX }, (_, i) => files[(doy * LOCAL_MAX + i) % files.length]);
  for (const f of picks) {
    const path = `${LOCAL_DIR}${f}`;
    const bytes = statSync(path).size;
    if (bytes > 4.5e6) { notes.push(`local ${f} skipped: ${(bytes / 1e6).toFixed(1)} MB (limit 4.5)`); continue; }
    const base = f.replace(/\.[^.]+$/, '');
    const sidecar = `${LOCAL_DIR}${base}.txt`;
    const prompt = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : '';
    const ext = f.split('.').pop().toLowerCase();
    rows.push({
      id: `photo-local-${slug(base)}`, persona: 'picture-first user (own photo)', prior: 'unsure', prompt,
      note: `local photo ${f}${prompt ? ' with the owner\'s text' : ' with no text — the model must assume the size'}`,
      photo: { file: `photos.local/${f}`, source: 'local', title: f, media_type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` },
    });
  }
}

// ---- 2. Wikimedia Commons ---------------------------------------------------
async function fetchJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { if (attempt) throw e; }
  }
}
async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp|gif)/.test(type)) throw new Error(`not an image: ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4.5e6) throw new Error(`${(buf.length / 1e6).toFixed(1)} MB`);
  return { buf, media_type: type.split(';')[0] };
}

const want = Math.max(0, COUNT - rows.length);
if (!NO_COMMONS && want > 0) {
  // rotate through the wheel by day, one category per picture; the first
  // 200 members are plenty, the seeded shuffle below picks among them
  const start = (doy * want) % WHEEL.length;
  const terms = Array.from({ length: want }, (_, i) => WHEEL[(start + i * 7) % WHEEL.length]);
  let i = 0;
  for (const { cat: term, size } of terms) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', generator: 'categorymembers', gcmtitle: `Category:${term}`, gcmtype: 'file', gcmlimit: '200',
      prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1200',
      iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription',
    });
    let pages;
    try { pages = Object.values((await fetchJson(`https://commons.wikimedia.org/w/api.php?${q}`))?.query?.pages ?? {}); }
    catch (e) { notes.push(`commons category "${term}" failed: ${e.message}`); continue; }
    const candidates = pages
      .map(p => ({ p, ii: p.imageinfo?.[0] }))
      .filter(({ p, ii }) => ii && ii.mime === 'image/jpeg' && ii.width >= 900 && ii.height >= 700 && !REJECT.test(p.title) && !usedSet.has(p.pageid))
      .sort(() => rand() - 0.5);
    let picked = false;
    for (const { p, ii } of candidates.slice(0, 3)) {
      try {
        const { buf, media_type } = await fetchBytes(ii.thumburl ?? ii.url);
        const em = ii.extmetadata ?? {};
        const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const id = `photo-${slug(term.split(' ')[0])}-${p.pageid}`;
        const file = `runs/photos/${DAY}/${id}.jpg`;
        writeFileSync(`${HERE}${file}`, buf);
        usedSet.add(p.pageid);
        const stated = i % 2 === 1;   // every other Commons row states a size
        rows.push({
          id, persona: 'picture-first user (found photo)', prior: 'unsure',
          prompt: stated ? sizeText(size) : '',
          ...(stated ? { statedSize: size } : {}),
          note: `commons "${term}": ${p.title.replace(/^File:/, '')}${stated ? ' — size stated in text' : ' — no text, size must be assumed'}`,
          photo: {
            file, source: 'commons', title: p.title.replace(/^File:/, ''), media_type,
            credit: strip(em.Artist?.value), license: strip(em.LicenseShortName?.value),
            description: strip(em.ImageDescription?.value).slice(0, 200), url: ii.descriptionurl, pageid: p.pageid,
          },
        });
        picked = true; i++;
        break;
      } catch (e) { notes.push(`commons ${p.title}: ${e.message}`); }
    }
    if (!picked) notes.push(`commons "${term}": no usable picture (${pages.length} members, ${candidates.length} candidates)`);
  }
}

mkdirSync(RUNS, { recursive: true });
const out = OUT;
writeFileSync(out, JSON.stringify(rows, null, 1));
writeFileSync(USED, JSON.stringify({ commons: [...usedSet] }));
const local = rows.filter(r => r.photo.source === 'local').length;
console.log(`[photos] ${rows.length} picked (${rows.length - local} commons, ${local} local) → ${out.replace(HERE, '')}${notes.length ? `; notes: ${notes.join(' | ')}` : ''}`);
