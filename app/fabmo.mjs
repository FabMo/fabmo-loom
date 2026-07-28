// FabMo network client — find FabMo CNC controllers on the shop network
// and send them verified jobs, straight from the browser.
//
// The FabMo Engine (github.com/FabMo/FabMo-Engine) serves a restify HTTP
// API with `Access-Control-Allow-Origin: *` but NO handler for OPTIONS —
// any request that triggers a CORS preflight fails cross-origin. Every
// request here is therefore shaped to stay a "simple" request:
//   - GET with no custom headers (probe /version, /status, /jobs/queue)
//   - POST application/x-www-form-urlencoded (the job-metadata leg; the
//     engine parses bodies with `qs`, so bracket notation nests back into
//     the {files:[{...}]} object its upload protocol expects)
//   - POST multipart/form-data (the file leg: key, index, file)
//   - POST with no body at all (run next job)
// Never add a JSON body or a custom header to these calls — it will work
// same-origin and silently break from the web app.
//
// Job submission is the engine's two-leg upload protocol (routes/util.js):
//   1. POST /job with {files:[{filename,name,description}]} → upload key
//   2. POST /job multipart (key, index, file) → job created
// Then POST /jobs/queue/run starts the next pending job. We only auto-run
// when OUR job is the sole pending job and the machine is idle — with
// anything else in the queue, "run next" could start someone else's cut.

const DEFAULT_TIMEOUT = 2500;
const PROBE_TIMEOUT = 1600;

// HTTPS pages need `targetAddressSpace` to reach plain-HTTP machines on
// the LAN — it exempts the request from mixed-content blocking (Chrome's
// Local Network Access). Chrome REJECTS the request when the declared
// space doesn't match the target's real one ('local' = LAN in current
// Chrome, 'private' in the older naming, 'loopback' = 127.x), so the
// option goes ONLY where it's needed: https page → non-loopback target.
// Feature-detect the accepted spelling once via the Request constructor,
// which validates the enum synchronously.
let addrExtra = null;
function lanInit(url, extra) {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return extra;
  if (/^http:\/\/(localhost|127\.)/i.test(url)) return extra;
  if (addrExtra === null) {
    addrExtra = {};
    for (const v of ['local', 'private']) {
      try {
        new Request('http://192.0.2.1/', { targetAddressSpace: v });
        addrExtra = { targetAddressSpace: v };
        break;
      } catch { /* unsupported enum value — try the older spelling */ }
    }
  }
  return { ...addrExtra, ...extra };
}

function hostUrl(host, path) {
  const clean = String(host).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { clean, url: 'http://' + clean + path };
}

async function timedFetch(url, init, timeoutMs, fetchFn) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await (fetchFn ?? fetch)(url, lanInit(url, { ...init, signal: ctl.signal }));
  } finally {
    clearTimeout(t);
  }
}

async function getJson(host, path, { timeoutMs = DEFAULT_TIMEOUT, fetchFn } = {}) {
  const { url } = hostUrl(host, path);
  const res = await timedFetch(url, { method: 'GET' }, timeoutMs, fetchFn);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- discovery

// Is there a FabMo at this address? Resolves {host, version} or null —
// never throws (a dead address is an answer, not an error).
export async function probe(host, { timeoutMs = PROBE_TIMEOUT, fetchFn } = {}) {
  const { clean } = hostUrl(host, '/');
  try {
    const body = await getJson(clean, '/version', { timeoutMs, fetchFn });
    if (body?.status === 'success' && body.data && 'version' in body.data) {
      return { host: clean, version: body.data.version ?? null };
    }
  } catch { /* not a FabMo / not reachable */ }
  return null;
}

// The tool's user-facing name lives in the engine config (data.engine.name);
// null when unset or unreadable.
export async function machineName(host, opts = {}) {
  try {
    const body = await getJson(host, '/config', { timeoutMs: 4000, ...opts });
    const name = body?.data?.engine?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

// Machine status (state, position, current job) — throws when unreachable.
export async function machineStatus(host, opts = {}) {
  const body = await getJson(host, '/status', opts);
  if (body?.status !== 'success' || !body.data?.status) throw new Error('bad /status reply');
  return body.data.status;
}

export async function jobQueue(host, opts = {}) {
  const body = await getJson(host, '/jobs/queue', opts);
  const jobs = body?.data?.jobs;
  if (body?.status !== 'success' || !jobs) throw new Error('bad /jobs/queue reply');
  return { pending: jobs.pending ?? [], running: jobs.running ?? [] };
}

// Probe every host of a /24 ("192.168.1" or "192.168.1.0/24" or any IP in
// it). Calls onFound(machine) as machines answer and onProgress(done, total)
// as addresses resolve; resolves the list of machines found. `stop` (an
// {aborted} box) lets the UI cancel a scan mid-flight.
export async function scanSubnet(base, { onFound, onProgress, stop, concurrency = 24, timeoutMs = 1200, fetchFn } = {}) {
  const m = String(base).trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.\d{1,3})?(?:\/24)?$/);
  if (!m) throw new Error('Subnet should look like 192.168.1 (a /24 network)');
  const net = m[1];
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${net}.${i}`);
  const found = [];
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < hosts.length && !stop?.aborted) {
      const host = hosts[next++];
      const hit = await probe(host, { timeoutMs, fetchFn });
      done++;
      if (hit) {
        found.push(hit);
        onFound?.(hit);
      }
      onProgress?.(done, hosts.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

// --------------------------------------------------------------- job submit

// Exported for the gauntlet: the exact metadata leg the engine's qs parser
// nests back into {files:[{filename,name,description}]}.
export function metadataBody({ filename, name, description }) {
  const p = new URLSearchParams();
  p.set('files[0][filename]', filename);
  p.set('files[0][name]', name ?? filename);
  if (description) p.set('files[0][description]', description);
  return p;
}

// Submit one file as a FabMo job (queued, not started). Resolves the
// created job record (with _id) from the engine.
export async function submitJob(host, { content, filename, name, description }, { timeoutMs = 8000, fetchFn } = {}) {
  if (!content || !filename) throw new Error('submitJob needs content and filename');
  const { url } = hostUrl(host, '/job');

  // Leg 1: metadata → upload key. URLSearchParams posts as urlencoded.
  const metaRes = await timedFetch(url, { method: 'POST', body: metadataBody({ filename, name, description }) }, timeoutMs, fetchFn);
  const meta = await metaRes.json();
  if (meta?.status !== 'success' || !meta.data?.key) {
    throw new Error('FabMo refused the job metadata: ' + (meta?.message ?? `HTTP ${metaRes.status}`));
  }

  // Leg 2: the file itself, tied back by key.
  const fd = new FormData();
  fd.set('key', meta.data.key);
  fd.set('index', '0');
  fd.set('file', new Blob([content], { type: 'text/plain' }), filename);
  const fileRes = await timedFetch(url, { method: 'POST', body: fd }, timeoutMs, fetchFn);
  const fin = await fileRes.json();
  if (fin?.status !== 'success' || fin.data?.status !== 'complete') {
    throw new Error('FabMo refused the job file: ' + (fin?.message ?? `HTTP ${fileRes.status}`));
  }
  const job = fin.data?.data?.jobs?.[0];
  if (job?._id) return job;

  // Shipping engines lose the job records here: routes/jobs.js collects
  // them with async.eachOf, whose completion callback gets only (err) —
  // so `jobs` serializes away and the reply is data:{status:'complete',
  // data:{}} even though the job WAS created and queued. Recover the
  // record from the queue: our job is the newest pending entry with the
  // name we just submitted.
  const wanted = name ?? filename;
  let queue = null;
  try {
    queue = await jobQueue(host, { timeoutMs, fetchFn });
  } catch {
    throw new Error('FabMo accepted the upload but the job record could not be confirmed — check the FabMo dashboard queue');
  }
  const mine = queue.pending
    .filter((j) => j?._id && (j.name === wanted || j.filename === filename))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || (b._id > a._id ? 1 : -1));
  if (!mine.length) throw new Error('FabMo accepted the upload but the job did not appear in the queue');
  return mine[0];
}

// Start the next pending job. The engine offers no "run job N" without a
// preflighted request, so callers must ensure the queue's next job is the
// one they mean (see submitAndRun).
export async function runNextJob(host, { timeoutMs = 6000, fetchFn } = {}) {
  const { url } = hostUrl(host, '/jobs/queue/run');
  const res = await timedFetch(url, { method: 'POST' }, timeoutMs, fetchFn);
  const body = await res.json();
  if (body?.status !== 'success') {
    const msg = body?.data?.job ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error('FabMo could not start the job: ' + msg);
  }
  return body.data?.job ?? null;
}

// Submit, then start — but only when it is unambiguous and safe:
// machine idle, nothing running, and our job the sole pending entry.
// Anything else resolves {job, ran:false, reason} with the job queued.
export async function submitAndRun(host, file, opts = {}) {
  const job = await submitJob(host, file, opts);
  let state = null;
  try {
    state = (await machineStatus(host, opts))?.state ?? null;
  } catch {
    return { job, ran: false, reason: 'submitted, but the machine stopped answering — start it from the FabMo dashboard' };
  }
  if (state !== 'idle') {
    return { job, ran: false, reason: `machine is ${state ?? 'in an unknown state'} — job is queued and will not start by itself` };
  }
  const q = await jobQueue(host, opts).catch(() => null);
  if (!q || q.running.length > 0 || q.pending.length !== 1 || String(q.pending[0]?._id) !== String(job._id)) {
    const ahead = q ? q.pending.filter((j) => String(j._id) !== String(job._id)).length + q.running.length : null;
    return {
      job,
      ran: false,
      reason: ahead
        ? `${ahead} other job${ahead > 1 ? 's' : ''} in the FabMo queue — queued yours rather than starting someone else's cut`
        : 'could not confirm yours is the next job — queued without starting',
    };
  }
  await runNextJob(host, opts);
  return { job, ran: true };
}
