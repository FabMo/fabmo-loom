// The probe's one model-call transport, shared by probe.mjs and
// live-retest.mjs, plus the "was this row the network, not Loom?" test
// every downstream stage (nightly triage, corpus-add, autoprompt) uses.
//
// A dropped connection (`TypeError: fetch failed`, cause SocketError /
// EPIPE / ECONNRESET) or an overloaded API is PROBE INFRASTRUCTURE. It is
// retried a small bounded number of times with backoff — never looped on
// (PROBE.md guardrail) — and when it still fails the thrown error carries
// `infra: true` so the row is recorded as INFRA_ERROR rather than ERROR.
// A plain ERROR row stays what it always meant: Loom threw.

export const INFRA_OUTCOME = 'INFRA_ERROR';
// retried: rate limit, server faults, overloaded. Other 4xx are the
// request's own fault (a bad request is a Loom/probe bug) — never retried.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
// rows recorded before the marker existed died with these in row.error
const LEGACY_INFRA = /fetch failed|ECONNRESET|EPIPE|socket|API retries exhausted/i;

export function isInfraRow(row) {
  if (!row) return false;
  if (row.outcome === INFRA_OUTCOME || row.infra === true) return true;
  return row.outcome === 'ERROR' && LEGACY_INFRA.test(String(row.error ?? ''));
}

export class InfraError extends Error {
  constructor(message) { super(message); this.name = 'InfraError'; this.infra = true; }
}

// makeCallModel({ key }) → call(req) → Anthropic messages response JSON.
//   attempts:    total tries per call (bounded; default 4)
//   baseDelayMs: backoff is baseDelayMs × attempt number (2s, 4s, 6s)
export function makeCallModel({ key, attempts = 4, baseDelayMs = 2000, onRetry = null }) {
  return async function callModel(req) {
    let last = 'no attempt made';
    const retrying = (attempt) => { if (attempt + 1 < attempts) onRetry?.(last, attempt); };
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          // connection: close — a weave is seconds of synchronous CPU; a
          // kept-alive socket can go stale behind it and the next call on it
          // dies with "other side closed" / EPIPE (same fix as nightly.mjs llm())
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', connection: 'close' },
          body: JSON.stringify(req),
        });
      } catch (e) {
        // a thrown fetch is a transport failure (stale socket, reset, DNS)
        last = `fetch failed: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}`;
        retrying(attempt);
        continue;
      }
      if (RETRYABLE.has(res.status)) {
        last = `API ${res.status}`;
        try { await res.text(); } catch { /* drain */ }
        retrying(attempt);
        continue;
      }
      if (!res.ok) {
        const text = `API ${res.status}: ${(await res.text()).slice(0, 300)}`;
        // a rejected key is the deployment's problem, not Loom's — marked, not retried
        if (res.status === 401 || res.status === 403) throw new InfraError(text);
        throw new Error(text);
      }
      try { return await res.json(); }
      catch (e) {
        // the body was cut off mid-read — same transport failure, later
        last = `response body failed: ${e?.cause?.code ?? e?.message ?? e}`;
        retrying(attempt);
      }
    }
    throw new InfraError(`model call failed after ${attempts} attempts — ${last}`);
  };
}
