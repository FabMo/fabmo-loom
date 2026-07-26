// The nightly Loom improvement probe — PROBE.md's procedure as a
// self-contained script (system cron runs it; no interactive session).
// The two LLM stages (batch generation, failure triage) call the API
// directly with the shop key; everything else is deterministic.
//
// Measure aggressively, convert conservatively: this script NEVER edits
// app code, prompt rules, or the catalog. Output = runs/ artifacts, a
// run-log line in ledger.md, and runs/ATTENTION-<date>.md when a human
// should look (new class, regression, broken infra).
//
// Usage: node nightly.mjs [--dry]   (--dry: generate but skip live probes)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HERE = new URL('./', import.meta.url).pathname;
const RUNS = `${HERE}runs/`;
const DAY = new Date().toISOString().slice(0, 10);
const dry = process.argv.includes('--dry');
mkdirSync(RUNS, { recursive: true });

const log = (m) => console.log(`[nightly ${new Date().toISOString().slice(11, 19)}] ${m}`);
const attention = [];
let results, tri, priorMisses = [];
let tally = {};
const runNode = (script, ...args) => {
  const r = spawnSync('node', [script, ...args], { cwd: HERE, encoding: 'utf8', timeout: 30 * 60_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const key = readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('no shop key — aborting'); process.exit(1); }

let spendIn = 0, spendOut = 0;
async function llm(system, user, maxTokens = 4000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    spendIn += data.usage?.input_tokens ?? 0; spendOut += data.usage?.output_tokens ?? 0;
    return data.content.find(b => b.type === 'text')?.text ?? '';
  }
  throw new Error('API retries exhausted');
}
// tolerate fences and preambles: parse from the first bracket to the last
const parseJson = (text) => {
  const open = text.search(/[[{]/);
  const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(text.slice(open, close + 1));
};

// ---- 1. corpus regression check (free) — a fail stops the night ------
log('corpus regression check…');
const corpus = runNode('test-corpus.mjs');
if (corpus.code !== 0) {
  attention.push(`CORPUS REGRESSION — a commit broke handling of recorded model responses:\n${corpus.out.split('\n').filter(l => l.includes('REGRESSION')).join('\n')}`);
  finish('corpus regression — live probes skipped');
} else log(corpus.out.trim().split('\n').pop());

// ---- 2. real stream ---------------------------------------------------
log('funnel pull…');
const funnel = runNode('funnel-pull.mjs');
log(funnel.out.trim().split('\n').filter(l => l.startsWith('[funnel]')).join(' | '));
const funnelFile = `${RUNS}funnel-${DAY}.jsonl`;
const funnelRows = existsSync(funnelFile)
  ? readFileSync(funnelFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
const funnelDeclines = funnelRows.filter(r => r.declined?.length);

// ---- 3. generate tonight's batch --------------------------------------
const ledger = readFileSync(`${HERE}ledger.md`, 'utf8');
const probeDoc = readFileSync(`${HERE}PROBE.md`, 'utf8');
const WHEEL = ['signage & wayfinding', 'gifts & keepsakes', 'kitchen & serving', 'furniture & storage', 'shop jigs & fixtures',
  'games & puzzles', 'musical instruments', 'electronics & enclosures', 'outdoor & garden', 'holiday & seasonal',
  'small-business fixtures', 'school & education', 'cosplay & props', 'maps & terrain', 'decorative patterns & texture',
  'kids & toys', 'pets', 'sports & recreation'];
const doy = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + '-01-01')) / 86400e3);
const cats = Array.from({ length: 5 }, (_, i) => WHEEL[(doy * 5 + i) % WHEEL.length]);
log(`generating 25 prompts in: ${cats.join(' · ')}`);

const genText = await llm(
  `You generate synthetic user prompts to probe a CNC/CAM "prompt-to-app" tool (Loom). Follow the generation rules in the PROBE.md excerpt. Output ONLY a JSON array, no fences, of {"id","persona","prior","prompt","note"} — id kebab-case unique, prior one of covered|decline|unsure (your honest prediction), note = one line on what the prompt probes.`,
  `PROBE.md (generation rules — step 3):\n${probeDoc}\n\nCurrent failure-class ledger (for regression re-asks and to avoid re-probing the known-by-design):\n${ledger}\n\nTonight's categories (5 prompts each): ${cats.join(', ')}.\nGenerate the 25 prompts now.`,
  6000);
let prompts;
try {
  prompts = parseJson(genText).filter(p => p?.id && p?.prompt && p?.prior);
} catch (e) {
  attention.push(`generation output unparseable: ${String(e).slice(0, 120)}`);
  finish('generation failed');
}
if (prompts.length < 15) { attention.push(`generation produced only ${prompts.length} prompts`); finish('generation too small'); }
const promptsFile = `${RUNS}${DAY}-prompts.json`;
writeFileSync(promptsFile, JSON.stringify(prompts, null, 1));
log(`${prompts.length} prompts → ${promptsFile}`);
if (dry) finish('dry run — no live probes');

// ---- 4. probe live -----------------------------------------------------
const resultsFile = `${RUNS}${DAY}-results.jsonl`;
writeFileSync(resultsFile, '');   // fresh file — a re-run the same day must not mix batches
log('probing live…');
const probe = runNode('probe.mjs', `./runs/${DAY}-prompts.json`, `./runs/${DAY}-results.jsonl`);
if (!existsSync(resultsFile)) { attention.push(`probe produced no results:\n${probe.out.slice(-400)}`); finish('probe failed'); }
results = readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const errors = results.filter(r => r.outcome === 'ERROR').length;
if (errors >= 3) attention.push(`${errors} probe rows ERRORED — infrastructure suspect`);

// ---- 5. triage ----------------------------------------------------------
tally = {};
for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
priorMisses = results.filter(r =>
  (r.prior === 'covered' && !/FULFILLED/.test(r.outcome ?? '')) ||
  (r.prior === 'decline' && r.outcome === 'FULFILLED'));
const compact = results.map(r => ({
  id: r.id, prior: r.prior, outcome: r.outcome, verified: r.verified,
  prompt: r.prompt, summary: (r.summary ?? '').slice(0, 300),
  pipeline: r.pipeline, skipped: (r.skipped ?? []).slice(0, 4),
  weaveErrors: (r.weaveErrors ?? []).slice(0, 3),
  declined: (r.declined ?? []).map(d => ({ what: d.what, why: (d.why ?? '').slice(0, 200) })),
}));
log('triaging…');
const triText = await llm(
  `You triage probe results for the Loom improvement loop against its failure-class ledger. Rules: classify every non-clean row (declines, verify failures, skips, crashes) to an existing ledger class id when one fits; propose a NEW class only when nothing fits. Separately flag OVERCLAIMS: rows whose summary confidently claims something their pipeline/actions cannot deliver (the verifier cannot catch these — judge summary against pipeline). By-design declines that declined correctly are "working-as-intended", not findings. Output ONLY JSON, no fences: {"classified":[{"id","class","evidence":"one line"}], "newClasses":[{"id","section":"capability|authoring|overclaim|robustness","description","examples":["prompt-id"]}], "overclaims":[{"id","claim","reality"}], "shippedRegressions":[{"id","class"}], "runNote":"one sentence"}`,
  `LEDGER:\n${ledger}\n\nTONIGHT'S RESULTS (${results.length} rows):\n${JSON.stringify(compact, null, 1)}\n\nNEW FUNNEL DECLINES (real users — priority):\n${JSON.stringify(funnelDeclines.map(r => ({ id: r.id, utterance: (r.utterance ?? '').slice(0, 200), declined: r.declined })), null, 1)}`,
  4000);
tri = { classified: [], newClasses: [], overclaims: [], shippedRegressions: [], runNote: 'triage unparseable' };
try { tri = { ...tri, ...parseJson(triText) }; }
catch { attention.push('triage output unparseable — raw saved to runs/'); writeFileSync(`${RUNS}${DAY}-triage-raw.txt`, triText); }
writeFileSync(`${RUNS}${DAY}-triage.json`, JSON.stringify(tri, null, 1));

if (tri.newClasses?.length) attention.push(`NEW failure class(es): ${tri.newClasses.map(c => `${c.id} — ${c.description}`).join('; ')}`);
if (tri.shippedRegressions?.length) attention.push(`SHIPPED-class regression: ${tri.shippedRegressions.map(s => s.id).join(', ')}`);

// ---- 6. grow the corpus --------------------------------------------------
log(runNode('corpus-add.mjs', `./runs/${DAY}-results.jsonl`, DAY).out.trim().replace('\n', ' | '));
if (funnelRows.length) log(runNode('corpus-add.mjs', `./runs/funnel-${DAY}.jsonl`, `funnel-${DAY}`).out.trim().replace('\n', ' | '));

finish(tri.runNote);

// ---- 7+8. run log + attention ---------------------------------------------
function finish(note) {
  const cost = (spendIn * 15e-6 + spendOut * 75e-6
    + (results ?? []).reduce((s, r) => s + (r.usage?.input_tokens ?? 0) * 15e-6 + (r.usage?.output_tokens ?? 0) * 75e-6 + (r.usage?.cache_read_input_tokens ?? 0) * 1.5e-6 + (r.usage?.cache_creation_input_tokens ?? 0) * 18.75e-6, 0)).toFixed(2);
  const outcomes = Object.keys(tally).length
    ? Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') : 'no probes';
  const evidence = tri?.classified?.length
    ? '; evidence: ' + Object.entries(tri.classified.reduce((m, c) => ((m[c.class] = (m[c.class] ?? 0) + 1), m), {})).map(([c, n]) => `${c} +${n}`).join(', ')
    : '';
  const misses = priorMisses.length ? `; ${priorMisses.length} prior-miss (${priorMisses.map(r => r.id).join(', ')})` : '';
  const over = tri?.overclaims?.length ? `; OVERCLAIMS: ${tri.overclaims.map(o => o.id).join(', ')}` : '';
  appendFileSync(`${HERE}ledger.md`,
    `- ${DAY} — nightly: ${outcomes}${misses}${evidence}${over}; funnel +${funnelRows.length} (${funnelDeclines.length} declined); $${cost}; ${note}${attention.length ? ' ⚠ SEE ATTENTION FILE' : ''}\n`);
  if (attention.length) {
    writeFileSync(`${RUNS}ATTENTION-${DAY}.md`, `# Probe attention — ${DAY}\n\n${attention.map(a => `- ${a}`).join('\n\n')}\n`);
    log(`ATTENTION → runs/ATTENTION-${DAY}.md`);
  }
  log(`done: ${outcomes}; $${cost}; ${note}`);
  process.exit(attention.length ? 2 : 0);
}
