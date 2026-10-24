// Server-side Loom turns (intent/loom-jobs.js + loom-job-worker.mjs): a job
// runs the real closed loop in a worker thread against canned model
// responses (no network, no key), persists its result, meters through the
// caller's hooks, refuses other passes, and hands interrupted jobs back as
// orphans after a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LoomJobs, validateJobInput, resolveLoomApp } from '../intent/loom-jobs.js';

const appDir = resolveLoomApp();
if (!fs.existsSync(new URL('runtime.mjs', appDir).pathname)) {
  console.log(`loom-jobs: no Loom app at ${appDir} — skipped`);
  process.exit(0);
}
const { EMPTY_RECIPE } = await import(`${appDir}runtime.mjs`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-jobs-'));
const TOKEN = 'lk_testpass000000000', OTHER = 'lk_otherpass00000000';

// a verified corpus row's first turn (house-number-arrow) and a second-look
// turn that stands pat — the shape runIntentLoop sees from Anthropic
const toolUse = (input, id) => ({
  id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${id}`, name: 'apply_recipe_actions', input }],
  usage: { input_tokens: 1000, output_tokens: 200 },
});
const BUILD = toolUse({
  summary: 'Built a left-pointing arrow house-number sign with "4512" V-carved about 5" tall.',
  actions: [
    { kind: 'set_name', name: 'Driveway Arrow House Number' },
    { kind: 'add_control', id: 'number', control: { id: 'number', type: 'text', label: 'House Number', default: '4512' } },
    { kind: 'add_control', id: 'numHeight', control: { id: 'numHeight', type: 'number', label: 'Number Height (in)', default: 5, min: 1, max: 10, step: 0.25 } },
    { kind: 'set_shape', shape: { id: 'arrow', path: 'M -14 0 L -6 -8 L -6 -3.5 L 14 -3.5 L 14 3.5 L -6 3.5 L -6 8 Z', width: 0, height: 0 } },
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'number' }, letterHeight: { ctrl: 'numHeight' }, font: 'slab', maxDepth: 0.25, posX: 2 } } },
    { kind: 'add_operation', operation: { id: 'cutout', strategy: 'shape_cutout', params: { shape: 'arrow', tabs: true } } },
  ],
  declined: [],
}, 1);
const STAND_PAT = toolUse({ summary: 'Built and verified: the arrow sign with 4512 V-carved, cut out with tabs.', actions: [], declined: [] }, 2);

const input = {
  recipe: structuredClone(EMPTY_RECIPE),
  utterance: 'A house number sign that says 4512, numbers about 5 inches tall, shaped like an arrow pointing left',
  model: 'claude-opus-5-5', image: null, exemplars: null, values: {}, shop: {},
};

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; console.log(`  ✓ ${what}`); };

// ---- validation -----------------------------------------------------------
console.log('validateJobInput');
ok(validateJobInput(input).ok, 'a plain ask validates');
ok(!validateJobInput({ ...input, recipe: {} }).ok, 'a recipe without a pipeline is refused');
ok(!validateJobInput({ ...input, utterance: '' }).ok, 'an empty utterance is refused');
ok(!validateJobInput({ ...input, utterance: 'x'.repeat(2001) }).ok, 'an overlong utterance is refused');
ok(!validateJobInput({ ...input, model: 'gpt-9' }).ok, 'a non-Claude model is refused');
ok(!validateJobInput({ ...input, image: { media_type: 'image/tiff', data: 'AAAA' } }).ok, 'an unsupported image type is refused');
ok(validateJobInput({ ...input, image: { media_type: 'image/jpeg', data: 'AAAA' } }).input.image.media_type === 'image/jpeg', 'a jpeg rides along');
ok(!validateJobInput({ ...input, exemplars: [{}, {}, {}] }).ok, 'more than two exemplars are refused');
ok(validateJobInput({ ...input, values: 'nope', shop: [1] }).input.values && Object.keys(validateJobInput({ ...input, values: 'nope' }).input.values).length === 0, 'junk values/shop fall back to empty objects');

// ---- a job runs the loop and persists ------------------------------------
console.log('a canned build');
const metered = [];
const jobs = new LoomJobs({
  dir, appDir, maxActive: 1,
  onDone: (m) => metered.push({ done: true, ...m }),
  onFailed: (m) => metered.push({ done: false, ...m }),
  log: { warn() {}, error(...a) { console.error(...a); } },
});
const id = jobs.start({ token: TOKEN, input, canned: [BUILD, STAND_PAT] });
ok(/^lj_/.test(id), 'start returns a job id');
ok(jobs.busy(), 'one running job fills a maxActive of 1');
ok(jobs.get(id, TOKEN)?.status === 'running', 'the job reports running to its own pass');
ok(jobs.get(id, OTHER) === null, 'another pass cannot see it');
ok(jobs.get('lj_nope', TOKEN) === null, 'an unknown id is null');
const view = await jobs.wait(id, TOKEN, { timeoutMs: 90_000 });
ok(view.status === 'done', `the job finishes done${view.error ? ` (${view.error})` : ''}`);
ok(!jobs.busy(), 'the worker is released');
const r = view.result;
ok(r.recipe.pipeline.length === 2 && r.recipe.name === 'Driveway Arrow House Number', 'the result carries the woven recipe');
ok(r.turns.length === 2 && r.turns[0].observation?.ok === true, 'two turns ran and the first weave verified');
ok(r.turns.every(t => !('recipe' in t)), 'per-turn recipe snapshots are not shipped');
ok(typeof r.summary === 'string' && r.summary.length > 0, 'a summary came back');
ok(r.usage.calls === 2 && r.usage.input_tokens === 2000, 'usage sums both calls');
ok(metered.length === 1 && metered[0].done && metered[0].token === TOKEN && metered[0].usage.output_tokens === 400, 'onDone fired once with the token and usage');
const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
ok(onDisk.status === 'done' && onDisk.result?.recipe && !('input' in onDisk), 'the result is on disk, the input is not');
ok(view.utterance === input.utterance && view.hadImage === false, 'the view names the ask');

// ---- a failed build refunds -------------------------------------------------
console.log('a build the model fumbles');
const bad = toolUse({ summary: '', actions: [], declined: [] }, 3);
const id2 = jobs.start({ token: TOKEN, input, canned: [bad] });
const v2 = await jobs.wait(id2, TOKEN, { timeoutMs: 90_000 });
ok(v2.status === 'failed' && /empty-handed/.test(v2.error), `an empty first turn fails with Loom's own words: "${v2.error}"`);
ok(metered.length === 2 && metered[1].done === false && metered[1].token === TOKEN, 'onFailed fired with the token (the caller refunds)');

// ---- a restart hands running jobs back as orphans --------------------------
console.log('restart');
fs.writeFileSync(path.join(dir, 'lj_orphan.json'), JSON.stringify({ id: 'lj_orphan', token: TOKEN, status: 'running', stage: 'weaving…', startedAt: Date.now() - 60_000, utterance: 'x' }));
fs.writeFileSync(path.join(dir, 'lj_stale.json'), JSON.stringify({ id: 'lj_stale', token: TOKEN, status: 'done', startedAt: Date.now() - 48 * 3600_000, utterance: 'old' }));
const again = new LoomJobs({ dir, appDir, log: { warn() {}, error() {} } });
const orphans = again.takeOrphans();
ok(orphans.length === 1 && orphans[0].id === 'lj_orphan' && orphans[0].token === TOKEN, 'the interrupted job is handed back once');
ok(again.takeOrphans().length === 0, 'and only once');
ok(again.get('lj_orphan', TOKEN)?.status === 'failed' && /restarted/.test(again.get('lj_orphan', TOKEN).error), 'it now reads failed, naming the restart');
ok(again.get(id, TOKEN)?.status === 'done' && again.get(id, TOKEN).result.recipe.pipeline.length === 2, 'the finished build survived the restart');
ok(again.get('lj_stale', TOKEN) === null && !fs.existsSync(path.join(dir, 'lj_stale.json')), 'a build older than a day is gone');

await jobs.close(); await again.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nall ${pass} loom-jobs checks passed`);
