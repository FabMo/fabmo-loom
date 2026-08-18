// Boot the PACKAGED .fma exactly as a FabMo tool would serve it: static
// files from the zip root + the engine's own API endpoints on the SAME
// origin. Proves the package is self-contained (no labs, no CDN, no
// fonts.googleapis), that the weave worker survives packaging, and that
// Loom auto-adopts the tool it is served from (the whole point of the
// .fma: same-origin = no browser walls on any device).
//
// NOT part of npm test (needs the labs packager endpoint up):
//   node test/browser-fma-test.mjs [fma-url]
// Downloads the package, unzips it to a temp dir (shells out to unzip),
// serves it with a stub engine, and boots it in headless Chrome.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const FMA_URL = process.argv[2] || 'http://127.0.0.1:4000/apps/fabmo-loom/fabmo.fma';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fma-'));
const fmaPath = path.join(work, 'loom.fma');
const res0 = await fetch(FMA_URL);
if (!res0.ok) { console.log(`✗ FAIL could not download ${FMA_URL}: HTTP ${res0.status}`); process.exit(1); }
fs.writeFileSync(fmaPath, Buffer.from(await res0.arrayBuffer()));
const ROOT = path.join(work, 'pkg');
execFileSync('unzip', ['-oq', fmaPath, '-d', ROOT]);
console.log(`unpacked ${FMA_URL} -> ${ROOT}`);
let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ok = (data) => JSON.stringify({ status: 'success', data });
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // the engine API, same-origin — what a real tool answers
  if (url === '/version') return res.end(ok({ version: { number: '9.9.9-stub' } }));
  if (url === '/status') return res.end(ok({ status: { state: 'idle' } }));
  if (url === '/config') return res.end(ok({ engine: { name: 'Stub Desktop MAX' } }));
  if (url === '/jobs/queue') return res.end(ok({ jobs: { pending: [], running: [] } }));
  const file = path.join(ROOT, url === '/' ? 'app/index.html' : url.slice(1));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const pageErrors = [];
const netFails = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
page.on('requestfailed', (r) => { if (!r.url().includes('guests.local')) netFails.push(r.url()); });
page.on('request', (r) => { if (!r.url().startsWith(`http://127.0.0.1:${port}`)) netFails.push('EXTERNAL: ' + r.url()); });

await page.goto(`http://127.0.0.1:${port}/app/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

const s = await page.evaluate(() => ({
  badge: document.getElementById('badge')?.textContent,
  intro: document.getElementById('introOverlay')?.style.display,
  chip: document.getElementById('fabmoChip')?.textContent,
  chipShown: document.getElementById('fabmoChip')?.style.display !== 'none',
  machines: JSON.parse(localStorage.getItem('loom:fabmo') ?? '{}'),
  worker: window.loomWeave?.workerActive?.() ?? null,
}));
console.log(JSON.stringify(s));
if (['VERIFIED', 'EMPTY'].includes(s.badge)) pass(`packaged app boots and weaves (badge ${s.badge})`);
else fail(`badge=${s.badge}`);
if (s.intro !== 'none') pass('first-visit intro opens (fresh install experience)');
else fail('intro did not open');
if (s.chipShown && /Stub Desktop MAX.*idle/.test(s.chip ?? '')) pass(`auto-adopted the tool it runs on: "${s.chip}"`);
else fail(`machine chip wrong: shown=${s.chipShown} chip="${s.chip}" machines=${JSON.stringify(s.machines)}`);
if (s.worker === true) pass('weave worker alive inside the package');
else fail(`worker=${s.worker}`);
if (!pageErrors.length) pass('no page errors');
else fail(`page errors: ${pageErrors.join(' | ')}`);
const external = netFails.filter((u) => u.startsWith('EXTERNAL'));
if (!external.length) pass('fully self-contained — zero external requests');
else fail(`external requests: ${external.join(', ')}`);
if (netFails.filter((u) => !u.startsWith('EXTERNAL')).length) console.log('  note: failed same-origin fetches:', netFails.filter((u) => !u.startsWith('EXTERNAL')).slice(0, 5));

await browser.close();
server.close();
console.log(failures ? `${failures} FAILURE(S)` : 'FMA BOOT: all checks passed');
process.exit(failures ? 1 : 0);
