// FabMo client gauntlet — proves app/fabmo.mjs speaks the engine's wire
// protocol WITHOUT ever triggering a CORS preflight, both directions:
// the happy path submits + runs, and every honest-refusal path (stale
// queue, busy machine, bad key, non-FabMo host) refuses with a reason.
//
// The stub below replicates what matters about the real engine
// (FabMo-Engine routes/util.js + jobs.js on restify 11): bodies parsed
// like `qs` (bracket keys nest), the two-leg upload keyed in memory, and
// the exact response envelopes. It also REJECTS any request that would
// have needed a preflight (JSON content-type, custom headers) — the
// engine has no OPTIONS handler, so those break cross-origin in the
// field even though they'd pass a same-origin test.

import http from 'http';
import { probe, machineName, machineStatus, jobQueue, scanSubnet, metadataBody, submitJob, runNextJob, submitAndRun } from '../app/fabmo.mjs';

let failures = 0;
function check(label, got, want) {
  const ok = Object.is(got, want);
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- stub engine

// Minimal nested-bracket parser: 'files[0][filename]' → files[0].filename —
// the shape `qs` (restify's urlencoded parser) produces for the engine.
function parseBrackets(raw) {
  const out = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = key.split(/[[\]]+/).filter(Boolean);
    let node = out;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      const nextIsIndex = /^\d+$/.test(path[i + 1]);
      node = node[k] ?? (node[k] = nextIsIndex ? [] : {});
    }
    node[path[path.length - 1]] = value;
  }
  return out;
}

function parseMultipart(buf, contentType) {
  const boundary = '--' + contentType.match(/boundary=(.+)$/)[1];
  const fields = {};
  for (const part of buf.toString('binary').split(boundary).slice(1, -1)) {
    const idx = part.indexOf('\r\n\r\n');
    const head = part.slice(0, idx);
    const body = part.slice(idx + 4, part.length - 2); // trailing \r\n
    const name = head.match(/name="([^"]+)"/)?.[1];
    const filename = head.match(/filename="([^"]+)"/)?.[1];
    fields[name] = filename !== undefined ? { filename, content: body } : body;
  }
  return fields;
}

function makeStub() {
  const state = {
    machineState: 'idle',
    queue: [],           // pending jobs, oldest first
    running: [],
    uploads: {},         // key → files metadata
    nextId: 100,
    ranJobs: [],
    preflightViolations: [],
    lastMetaContentType: null,
  };
  const server = http.createServer((req, res) => {
    // the engine's crossOrigin middleware — exactly these two headers, no OPTIONS route
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const ct = req.headers['content-type'] ?? '';
      // A real cross-origin caller may only send simple requests. JSON
      // bodies or custom X- headers would preflight → the engine 405s.
      if (/application\/json/.test(ct)) state.preflightViolations.push(`${req.method} ${req.url} sent JSON`);
      for (const h of Object.keys(req.headers)) {
        if (/^x-(?!$)/.test(h) && h !== 'x-requested-with') state.preflightViolations.push(`header ${h}`);
      }
      const json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

      if (req.method === 'GET' && req.url.startsWith('/version')) {
        return json({ status: 'success', data: { version: { number: 'stub-1.0', type: 'dev' } } });
      }
      if (req.method === 'GET' && req.url.startsWith('/status')) {
        return json({ status: 'success', data: { status: { state: state.machineState, posx: 0, posy: 0, posz: 0 } } });
      }
      if (req.method === 'GET' && req.url.startsWith('/config')) {
        return json({ status: 'success', data: { engine: { name: 'Stub Desktop MAX' }, driver: {} } });
      }
      if (req.method === 'GET' && req.url.startsWith('/jobs/queue')) {
        return json({ status: 'success', data: { jobs: { pending: state.queue, running: state.running } } });
      }
      if (req.method === 'POST' && req.url.startsWith('/jobs/queue/run')) {
        if (state.machineState !== 'idle' || state.queue.length === 0) {
          return json({ status: 'failed', data: { job: 'Cannot run next job' } });
        }
        const job = state.queue.shift();
        state.ranJobs.push(job);
        return json({ status: 'success', data: { job } });
      }
      if (req.method === 'POST' && req.url.startsWith('/job')) {
        if (/^multipart\/form-data/.test(ct)) {
          const fields = parseMultipart(body, ct);
          const up = state.uploads[fields.key];
          if (!up || !fields.file) return json({ status: 'error', message: 'Invalid upload key: ' + fields.key });
          const meta = up.files[Number(fields.index)];
          const job = { _id: state.nextId++, name: meta.name, filename: fields.file.filename, description: meta.description ?? '', content: fields.file.content };
          state.queue.push(job);
          delete state.uploads[fields.key];
          return json({ status: 'success', data: { status: 'complete', data: { jobs: [job] } } });
        }
        // metadata leg — must arrive urlencoded, like the browser sends it
        state.lastMetaContentType = ct;
        const parsed = parseBrackets(body.toString());
        if (!parsed.files?.length) return json({ status: 'error', message: 'bad metadata' });
        const key = 'k-' + Math.random().toString(36).slice(2, 10);
        state.uploads[key] = { files: parsed.files };
        return json({ status: 'success', data: { status: 'pending', key } });
      }
      json({ status: 'error', message: 'not found' });
    });
  });
  return { server, state };
}

const { server, state } = makeStub();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOST = '127.0.0.1:' + server.address().port;

// Also a NON-FabMo server: answers 200 HTML to everything.
const decoy = http.createServer((req, res) => res.end('<html>my router</html>'));
await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
const DECOY = '127.0.0.1:' + decoy.address().port;

// ---------------------------------------------------------------- discovery

console.log('probe / identify');
const hit = await probe(HOST);
check('FabMo answers probe', hit?.host, HOST);
check('probe carries version', hit?.version?.number, 'stub-1.0');
check('non-FabMo 200 is not a machine', await probe(DECOY), null);
check('dead port is not a machine', await probe('127.0.0.1:1', { timeoutMs: 400 }), null);
check('probe strips scheme/path', (await probe('http://' + HOST + '/dashboard'))?.host, HOST);
check('machine name from engine config', await machineName(HOST), 'Stub Desktop MAX');
const st = await machineStatus(HOST);
check('status state', st.state, 'idle');

console.log('subnet scan (injected fetch — one machine at .7)');
const scanFetch = (url, init) => {
  if (new URL(url).hostname === '192.168.9.7') {
    return Promise.resolve(new Response(JSON.stringify({ status: 'success', data: { version: { number: 'scan-hit' } } })));
  }
  return Promise.reject(new TypeError('unreachable'));
};
const found = await scanSubnet('192.168.9', { fetchFn: scanFetch, timeoutMs: 200 });
check('scan finds exactly one machine', found.length, 1);
check('scan hit host', found[0]?.host, '192.168.9.7');
check('scan accepts x.y.z.w form too', (await scanSubnet('192.168.9.55/24', { fetchFn: scanFetch, timeoutMs: 200 })).length, 1);
let scanErr = null;
await scanSubnet('not-a-subnet', {}).catch((e) => { scanErr = e.message; });
check('garbage subnet refused by name', /192\.168\.1/.test(scanErr ?? ''), true);

// ------------------------------------------------------------------- submit

console.log('metadata leg shape (what qs must reconstruct)');
const mb = metadataBody({ filename: 'sign.sbp', name: 'Shop sign', description: 'verified by Loom' });
check('bracket keys', mb.get('files[0][filename]'), 'sign.sbp');
check('name defaults to filename when omitted', metadataBody({ filename: 'a.sbp' }).get('files[0][name]'), 'a.sbp');

console.log('submit queues a job (two legs, no preflight)');
const SBP = "'Loom test\nC7,1\nMZ,0.5\nM5,1,2,-0.1,,\n";
const job = await submitJob(HOST, { content: SBP, filename: 'sign.sbp', name: 'Shop sign', description: 'verified by Loom' });
check('job created with id', typeof job._id, 'number');
check('job name carried', job.name, 'Shop sign');
check('file content survived byte-for-byte', state.queue[0]?.content, SBP);
check('metadata leg was urlencoded', /^application\/x-www-form-urlencoded/.test(state.lastMetaContentType), true);
check('no preflight-triggering requests so far', state.preflightViolations.join('; '), '');

console.log('run next');
const ran = await runNextJob(HOST);
check('ran the queued job', ran?._id, job._id);
check('queue drained', state.queue.length, 0);

console.log('bad upload key refused');
let keyErr = null;
// point the file leg at a key the stub never issued by racing two metadata legs is
// overkill — just corrupt the uploads table between legs via a tampering fetch
const tamperFetch = (url, init) => {
  if (init?.body instanceof FormData) init.body.set('key', 'k-forged');
  return fetch(url, init);
};
await submitJob(HOST, { content: SBP, filename: 'x.sbp' }, { fetchFn: tamperFetch }).catch((e) => { keyErr = e.message; });
check('forged key refused with reason', /Invalid upload key/.test(keyErr ?? ''), true);

console.log('submitAndRun — safe path');
state.queue.length = 0;
const r1 = await submitAndRun(HOST, { content: SBP, filename: 'go.sbp', name: 'Go' });
check('ran when idle + sole pending', r1.ran, true);
check('machine actually ran it', state.ranJobs.at(-1)?._id, r1.job._id);

console.log('submitAndRun — honest refusals');
state.queue.push({ _id: 1, name: 'stale job from last week' });
const r2 = await submitAndRun(HOST, { content: SBP, filename: 'q.sbp', name: 'Queued' });
check('queued but NOT run behind a stale job', r2.ran, false);
check('reason names the queue', /other job/.test(r2.reason), true);
check('stale job untouched', state.queue[0]?._id, 1);
state.queue.length = 0;

state.machineState = 'running';
const r3 = await submitAndRun(HOST, { content: SBP, filename: 'b.sbp', name: 'Busy' });
check('queued but NOT run while machine busy', r3.ran, false);
check('reason names the state', /running/.test(r3.reason), true);
state.machineState = 'idle';

console.log('queue readback');
const q = await jobQueue(HOST);
check('pending count', q.pending.length, 1);   // r3's job queued; r2's cleared with the stale job
check('total preflight violations across gauntlet', state.preflightViolations.join('; '), '');

server.close();
decoy.close();

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nfabmo-client gauntlet: all checks passed');
