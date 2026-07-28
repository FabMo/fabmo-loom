// Browser validation of board-aware send-to-machine (v0.71): with a
// Current board active, each "Send to machine" click nests the cut into
// the board's remaining free space, so successive jobs land at DIFFERENT
// spots instead of recutting the origin corner. Runs against a faithful
// record-less FabMo stub (real engines echo no job record on upload —
// this also browser-verifies the v0.70 queue-recovery path end to end).
//
// NOT part of npm test (needs the production server up):
//   node test/browser-board-send-test.mjs [url]
//
// Writes a screenshot to test/out/board-send.png.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { EXAMPLES } from '../app/examples.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

// ------------------------------------------------------- record-less stub
// The slice of the engine the send path touches. Like real engines, the
// upload-complete reply carries NO job record (async.eachOf bug) — the
// client must recover it from /jobs/queue.
const state = { queue: [], uploads: {}, nextId: 100 };
function parseMultipart(buf, ct) {
  const boundary = '--' + ct.match(/boundary=(.+)$/)[1];
  const fields = {};
  for (const part of buf.toString('binary').split(boundary).slice(1, -1)) {
    const idx = part.indexOf('\r\n\r\n');
    const name = part.slice(0, idx).match(/name="([^"]+)"/)?.[1];
    fields[name] = part.slice(idx + 4, part.length - 2);
  }
  return fields;
}
const stub = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ct = req.headers['content-type'] ?? '';
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url.startsWith('/version')) return json({ status: 'success', data: { version: { number: 'stub' } } });
    if (req.method === 'GET' && req.url.startsWith('/status')) return json({ status: 'success', data: { status: { state: 'idle' } } });
    if (req.method === 'GET' && req.url.startsWith('/config')) return json({ status: 'success', data: { engine: { name: 'Stub tool' } } });
    if (req.method === 'GET' && req.url.startsWith('/jobs/queue')) return json({ status: 'success', data: { jobs: { pending: state.queue, running: [] } } });
    if (req.method === 'POST' && req.url.startsWith('/job')) {
      if (/^multipart\/form-data/.test(ct)) {
        const f = parseMultipart(body, ct);
        const up = state.uploads[f.key];
        if (!up) return json({ status: 'error', message: 'Invalid upload key' });
        state.queue.push({ _id: state.nextId++, name: up.name, filename: up.filename, created_at: state.nextId, content: f.file });
        delete state.uploads[f.key];
        return json({ status: 'success', data: { status: 'complete', data: {} } });   // <- no record, like the field
      }
      const p = new URLSearchParams(body.toString());
      const key = 'k' + state.nextId++;
      state.uploads[key] = { name: p.get('files[0][name]'), filename: p.get('files[0][filename]') };
      return json({ status: 'success', data: { status: 'pending', key } });
    }
    json({ status: 'error', message: 'not found' });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const HOST = '127.0.0.1:' + stub.address().port;
console.log(`stub FabMo at ${HOST}`);

const recipe = EXAMPLES.find((e) => e.id === 'coaster').recipe;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.evaluateOnNewDocument((r, host) => {
    localStorage.setItem('loom:recipe', JSON.stringify(r));
    localStorage.setItem('loom:sheet', JSON.stringify({ w: 24, h: 12, thickness: 0.25, occupied: [] }));
    localStorage.setItem('loom:fabmo', JSON.stringify({ machines: [{ host, name: 'Stub tool' }], selected: host }));
  }, recipe, HOST);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const sendEnabled = () => page.evaluate(() => {
    const b = document.getElementById('sendFabmo');
    return b && b.style.display !== 'none' && !b.disabled;
  });
  for (let i = 0; i < 100 && !(await sendEnabled()); i++) await new Promise((r) => setTimeout(r, 200));
  if (await sendEnabled()) pass('woven + verified, machine selected — Send to machine live');
  else { fail('Send to machine never enabled'); throw new Error('cannot continue'); }

  // two sends; each must wait for its job (positioned weave + 2-leg upload)
  for (const want of [1, 2]) {
    await page.click('#sendFabmo');
    for (let i = 0; i < 150 && state.queue.length < want; i++) await new Promise((r) => setTimeout(r, 200));
    if (state.queue.length === want) pass(`send #${want} queued on the stub`);
    else { fail(`send #${want}: queue has ${state.queue.length} jobs`); throw new Error('cannot continue'); }
  }

  const [a, b] = state.queue;
  const spot = (j) => j.name.match(/@ (.+)$/)?.[1];
  if (spot(a) && spot(b)) pass(`jobs named with board spots: "${spot(a)}" and "${spot(b)}"`);
  else fail(`job names lack placements: "${a.name}" / "${b.name}"`);
  if (spot(a) !== spot(b)) pass('second job placed at a DIFFERENT spot');
  else fail(`both jobs at ${spot(a)} — still recutting`);
  if (a.content !== b.content) pass('SBP motion differs — offset baked into the toolpath');
  else fail('identical SBP bodies: placement never reached the motion');
  // the offset must appear in the coordinates themselves, not just the name
  const firstXY = (sbp) => sbp.split('\n').find((l) => /^[MJ][23],/.test(l));
  console.log(`  first XY move of job A: ${firstXY(a.content)}`);
  console.log(`  first XY move of job B: ${firstXY(b.content)}`);
  if (firstXY(a.content) && firstXY(a.content) !== firstXY(b.content)) pass('first XY move differs between jobs');
  else fail('first XY move identical or missing');

  const ui = await page.evaluate(() => ({
    chip: document.getElementById('sheetChip').textContent,
    lastTurn: [...document.querySelectorAll('#history .turn')].at(-1)?.textContent ?? '',
  }));
  if (/2 parts cut/.test(ui.chip)) pass(`board chip tracks both cuts: "${ui.chip}"`);
  else fail(`board chip: "${ui.chip}"`);
  if (/placed at .* on the board/.test(ui.lastTurn)) pass('history narrates the placement');
  else fail(`last turn: "${ui.lastTurn.slice(0, 120)}"`);

  await page.screenshot({ path: path.join(out, 'board-send.png') });
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  else pass('no page errors');
} finally {
  await browser.close();
  stub.close();
}

if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nboard-send browser test: all checks passed');
