// Machinability sweep: replay every corpus row (zero API cost) and run the
// machinability gate (ir/machinability.js) over each woven job, with every
// check at 'warn' so nothing is refused — the point is to COUNT what each
// check would touch before its level is raised to an error.
//
//   node machinability-sweep.mjs [--out report.json] [--workers N]
//
// Prints one line per check with the number of jobs and ops it flags, the
// worst offenders, and the time the gate adds per weave.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnv, readCorpus, syntheticGrids, usesGuestStrategy } from './corpus-lib.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const FILES = [`${HERE}corpus.jsonl`, `${HERE}corpus.local.jsonl`];
const argAfter = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
// a child gets an explicit list of row indexes (--idx 3,4,9); the parent
// builds the lists
const span = argAfter('--range')?.split(':').map(Number) ?? null;   // older form: a:b
const range = argAfter('--idx')?.split(',').map(Number) ?? (span ? Array.from({ length: span[1] - span[0] }, (_, k) => span[0] + k) : null);
const rows = FILES.flatMap(p => readCorpus(p) ?? []);

if (!range) {
  const self = fileURLToPath(import.meta.url);
  const workers = Number(argAfter('--workers')) || 2;
  // small chunks: a child's heap grows with every weave, and a child that
  // dies at its heap limit loses the rest of its chunk (60 rows did, once)
  const CHUNK = Number(argAfter('--chunk')) || 20;
  // --resume report.json: keep the rows already measured, weave only the rest
  const resume = argAfter('--resume');
  const all = resume && existsSync(resume) ? JSON.parse(readFileSync(resume, 'utf8')) : [];
  const have = new Set(all.map(r => r.key));
  const todo = rows.map((r, i) => i).filter(i => !have.has(rows[i].key));
  if (resume) console.log(`resuming: ${all.length} rows on file, ${todo.length} to weave`);
  const chunks = [];
  for (let a = 0; a < todo.length; a += CHUNK) chunks.push(todo.slice(a, a + CHUNK));
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < chunks.length) {
      const idx = chunks[next++];
      await new Promise((resolve) => {
        const child = spawn(process.execPath, ['--max-old-space-size=768', self, '--idx', idx.join(',')], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        child.stdout.on('data', d => { buf += d; });
        child.on('close', () => {
          for (const line of buf.split('\n')) if (line.startsWith('[row] ')) all.push(JSON.parse(line.slice(6)));
          resolve();
        });
      });
    }
  }));
  const missing = rows.filter(r => !all.some(x => x.key === r.key)).length;
  if (missing) console.log(`NOTE: ${missing} corpus rows have no result (a child died, or guest rows were skipped) — rerun with --resume <report>`);
  report(all);
  const out = argAfter('--out') ?? resume;
  if (out) writeFileSync(out, JSON.stringify(all));
  process.exit(0);
}

// ---- child: one chunk ----
const env = await loadEnv();
const { checkMachinability } = await import('../../ir/machinability.js');
const log = console.log;
for (const i of range) {
  const row = rows[i];
  if (!env.guestsLoaded && usesGuestStrategy(row, env)) continue;
  const rec = { key: row.key, woven: false };
  try {
    const recipe = row.context ? structuredClone(row.context) : structuredClone(env.EMPTY_RECIPE);
    console.log = console.warn = () => {};
    const out = env.applyActions(recipe, { summary: '', actions: row.payload.actions ?? [], declined: [] });
    if (out.recipe.pipeline.length) {
      const t0 = performance.now();
      const r = env.runRecipe(out.recipe, env.controlDefaults(out.recipe), env.fonts, syntheticGrids(out.recipe));
      const t1 = performance.now();
      if (r.job) {
        rec.woven = true; rec.verified = !!r.ok; rec.weaveMs = Math.round(t1 - t0);
        // the runtime may already carry the gate's report; measure a fresh
        // one with every check at warn so levels do not hide anything
        const m = checkMachinability(r.job, { levels: { reach: 'warn', passDepth: 'warn', retention: 'warn', web: 'warn' } });
        rec.gateMs = Math.round(performance.now() - t1);
        rec.ops = m.ops.map(o => ({ n: o.name, d: o.diameter, k: o.kind, deep: o.deepest, reach: o.reach, pass: o.maxPass, lim: o.passLimit, chk: o.passChecked }));
        rec.pieces = m.pieces;
        rec.webs = m.webs.length; rec.ms = m.ms;
        rec.warnings = m.warnings;
      }
    }
  } catch (e) { rec.crash = String(e?.message ?? e).slice(0, 200); }
  console.log = log;
  log('[row] ' + JSON.stringify(rec));
}

function report(all) {
  const woven = all.filter(r => r.woven), ver = woven.filter(r => r.verified);
  const pct = (n, d) => d ? `${n} (${(100 * n / d).toFixed(1)}%)` : '0';
  console.log(`rows ${all.length}, woven ${woven.length}, verified ${ver.length}, gate crashes ${all.filter(r => r.crash).length}`);
  for (const [label, set] of [['ALL WOVEN', woven], ['VERIFIED ONLY', ver]]) {
    const reach = set.filter(r => r.ops.some(o => o.reach != null && o.deep > o.reach + 1e-3));
    const pass = set.filter(r => r.ops.some(o => o.pass != null && o.pass > o.lim + Math.max(0.01, 0.05 * o.d)));
    const unchecked = set.filter(r => r.ops.some(o => o.k !== 'vee' && o.d && o.deep > 0 && !o.chk));
    const frees = set.filter(r => r.pieces.length);
    const loose = set.filter(r => r.pieces.some(p => p.need && !p.held));
    const web = set.filter(r => r.webs > 0);
    console.log(`\n== ${label} (${set.length} jobs)`);
    console.log(`  reach exceeded        ${pct(reach.length, set.length)}`);
    console.log(`  pass depth over 1×D   ${pct(pass.length, set.length)}`);
    console.log(`  pass depth unmeasured ${pct(unchecked.length, set.length)}`);
    console.log(`  jobs that free pieces ${pct(frees.length, set.length)}`);
    console.log(`  …with a loose piece   ${pct(loose.length, set.length)}`);
    console.log(`  thin web              ${pct(web.length, set.length)}`);
  }
  const worst = (f, n = 6) => ver.flatMap(r => r.ops.map(o => ({ key: r.key, ...o }))).filter(f).sort((a, b) => (b.pass / b.d) - (a.pass / a.d)).slice(0, n);
  console.log('\nworst pass depth (verified):');
  for (const o of worst(o => o.pass != null && o.pass > o.lim + 0.01)) console.log(`  ${(o.pass / o.d).toFixed(1)}×D  ${o.pass}" with ${o.d}" ${o.k}  ${o.key} :: ${o.n}`);
  const byStrat = {};
  for (const r of ver) for (const o of r.ops) {
    const s = (o.n.match(/\(([a-z_]+)\)$/) ?? [])[1] ?? '?';
    const b = byStrat[s] ??= { ops: 0, pass: 0, reach: 0 };
    b.ops++;
    if (o.pass != null && o.pass > o.lim + Math.max(0.01, 0.05 * o.d)) b.pass++;
    if (o.reach != null && o.deep > o.reach + 1e-3) b.reach++;
  }
  console.log('\nby strategy (verified): ops / over-pass / over-reach');
  for (const [s, b] of Object.entries(byStrat).sort((a, b) => b[1].pass + b[1].reach - a[1].pass - a[1].reach)) if (b.pass || b.reach) console.log(`  ${s.padEnd(22)} ${b.ops} / ${b.pass} / ${b.reach}`);
  const ms = woven.map(r => r.gateMs).sort((a, b) => a - b), wm = woven.map(r => r.weaveMs).sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(`\ngate time ms: median ${q(ms, .5)}, p90 ${q(ms, .9)}, max ${q(ms, 1)}   (weave: median ${q(wm, .5)}, p90 ${q(wm, .9)})`);
}
