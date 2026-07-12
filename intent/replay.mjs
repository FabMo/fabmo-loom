#!/usr/bin/env node
// Replay a funnel-log parse by its query id — the "human interpretation
// layer" for bug reports. A user quotes the q_… id shown on their parse;
// this reconstructs exactly what the model saw (utterance + recipe context)
// and what it decided (actions/declines), and can optionally re-run the
// parse against the CURRENT system prompt + catalog to see whether today's
// Loom would interpret it differently.
//
//   node intent/replay.mjs q_1a2b3c4d            # forensics: show the recorded parse
//   node intent/replay.mjs q_1a2b3c4d --live     # re-parse now and diff (spends API tokens)
//   node intent/replay.mjs --list [N]            # last N entries (default 10)
//
// Lookup also accepts a timestamp prefix (e.g. 2026-07-11T19:31) for
// pre-id entries. Live replay uses the shop key from /var/opt/apps/.intent.env
// (or ANTHROPIC_API_KEY); recorded output is always shown as ground truth —
// the replay is what WOULD happen now, never what happened then.

import fs from 'fs';
import path from 'path';

const FUNNEL_FILE = process.env.FUNNEL_FILE ?? '/var/opt/apps/.intent-funnel.jsonl';
const ENV_FILE = '/var/opt/apps/.intent.env';

const args = process.argv.slice(2);
const live = args.includes('--live');
const listMode = args.includes('--list');
const needle = args.find(a => !a.startsWith('--'));

function loadEntries() {
  const text = fs.readFileSync(FUNNEL_FILE, 'utf8');
  return text.split('\n').filter(Boolean).map((l, i) => {
    try { return { line: i + 1, ...JSON.parse(l) }; } catch { return null; }
  }).filter(Boolean);
}

const entries = loadEntries();

if (listMode) {
  const n = Number(needle) || 10;
  for (const e of entries.slice(-n)) {
    console.log(`${e.id ?? '(no id)'}  ${e.ts}  ${e.app ?? '?'}${e.invite ? `  [${e.invite}]` : ''}  ${(e.utterance ?? '').slice(0, 60)}`);
  }
  process.exit(0);
}

if (!needle) {
  console.error('usage: replay.mjs <q_id | ts-prefix> [--live]   |   replay.mjs --list [N]');
  process.exit(1);
}

const matches = entries.filter(e => e.id === needle || (e.ts ?? '').startsWith(needle));
if (!matches.length) { console.error(`no funnel entry matches "${needle}"`); process.exit(1); }
if (matches.length > 1) {
  console.error(`"${needle}" matches ${matches.length} entries — narrow the timestamp:`);
  matches.slice(0, 8).forEach(e => console.error(`  ${e.id ?? '(no id)'}  ${e.ts}  ${(e.utterance ?? '').slice(0, 50)}`));
  process.exit(1);
}
const entry = matches[0];

const showActions = (actions, label) => {
  console.log(`\n${label} (${actions.length} action${actions.length === 1 ? '' : 's'}):`);
  actions.forEach((a, i) => {
    const brief = a.kind === 'add_operation' ? `${a.kind} ${a.operation?.strategy} "${a.operation?.id}"`
      : a.kind === 'add_control' ? `${a.kind} "${a.control?.id}" (${a.control?.type})`
      : a.kind === 'set_name' ? `${a.kind} "${a.name}"`
      : a.kind;
    console.log(`  ${String(i + 1).padStart(2)}. ${brief}`);
  });
};

console.log(`${entry.id ?? '(no id)'} · ${entry.ts} · app=${entry.app} · source=${entry.source}${entry.invite ? ` · guest pass: ${entry.invite}` : ''}`);
console.log(`\nutterance: "${entry.utterance}"`);
console.log(`\nrecorded summary: ${entry.summary ?? '(none)'}`);
if (entry.declined?.length) {
  console.log(`recorded declines:`);
  entry.declined.forEach(d => console.log(`  - ${d.what}: ${d.why}`));
}
showActions(entry.actions ?? [], 'recorded actions (ground truth — what happened THEN)');
if (entry.usage) console.log(`\nusage: ${entry.usage.input}in / ${entry.usage.output}out tokens`);
console.log(`context captured: ${entry.context ? `yes (${JSON.stringify(entry.context).length} bytes — name "${entry.context.name}", ${entry.context.pipeline?.length ?? 0} ops, ${entry.context.controls?.length ?? 0} controls)` : 'NO — pre-context entry; live replay runs from a blank recipe'}`);
console.log(`\nfull action JSON: node -e 'const l = require("fs").readFileSync("${FUNNEL_FILE}", "utf8").split("\\n").find(l => l.includes("${entry.id ?? entry.ts}")); console.log(JSON.stringify(JSON.parse(l).actions, null, 2))'`);

if (!live) process.exit(0);

// ---------------------------------------------------------------- --live
if (entry.app !== 'loom' && entry.app !== 'step_toolpath') {
  console.error(`\n--live supports loom and step_toolpath entries (this is "${entry.app}")`);
  process.exit(1);
}

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch { return null; }
}
const key = readKey();
if (!key) { console.error('no API key (ANTHROPIC_API_KEY or /var/opt/apps/.intent.env)'); process.exit(1); }

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: key });

let req, extractActions;
if (entry.app === 'loom') {
  // resolve the Loom app dir: sibling of this file in the fabmo-loom copy,
  // the workspace checkout from seams, or LOOM_APP override
  const candidates = [
    process.env.LOOM_APP,
    new URL('../app', import.meta.url).pathname,
    '/var/opt/apps/contributors/brian.o/fabmo-loom/app',
  ].filter(Boolean);
  const loomApp = candidates.find(c => fs.existsSync(path.join(c, 'intent.mjs')));
  if (!loomApp) { console.error(`Loom app not found (tried ${candidates.join(', ')}) — set LOOM_APP`); process.exit(1); }

  const { buildParseRequest } = await import(path.join(loomApp, 'intent.mjs'));
  const { registerCatalogEntries } = await import(path.join(loomApp, 'catalog.mjs'));
  const { EMPTY_RECIPE, migrateRecipe } = await import(path.join(loomApp, 'runtime.mjs'));

  // mount the deployment's guest verbs so the live prompt matches the app's
  // (guests.local.mjs lists same-origin URLs; map /c/<user>/<app>/… to disk)
  try {
    const guestList = (await import(path.join(loomApp, 'guests.local.mjs'))).default ?? [];
    for (const url of guestList) {
      const m = url.match(/^\/c\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const fsPath = `/var/opt/apps/contributors/${m[1]}/${m[2]}`;
      const { entries: guestEntries } = await import(fsPath);
      registerCatalogEntries(guestEntries);
      console.log(`\n[guest mounted: ${url}]`);
    }
  } catch (e) { console.log(`\n[no guest mounts: ${e.message}]`); }

  const recipe = entry.context ? migrateRecipe(structuredClone(entry.context)) : structuredClone(EMPTY_RECIPE);
  req = buildParseRequest(recipe, entry.utterance);
  extractActions = (resp) => resp.content.find(b => b.type === 'tool_use')?.input ?? {};
} else {
  const { buildParseRequest } = await import(new URL('./step-schema.js', import.meta.url).pathname);
  req = buildParseRequest(entry.utterance, entry.context ?? {});
  extractActions = (resp) => {
    const text = resp.content.find(b => b.type === 'text')?.text;
    return text ? JSON.parse(text) : {};
  };
}

console.log(`\n--- live replay against the CURRENT prompt/catalog (model ${req.model}) ---`);
const resp = await client.messages.create(req);
const out = extractActions(resp);
const replayed = out.actions ?? [];
console.log(`replayed summary: ${out.summary ?? '(none)'}`);
if (out.declined?.length) {
  console.log('replayed declines:');
  out.declined.forEach(d => console.log(`  - ${d.what}: ${d.why}`));
}
showActions(replayed, 'replayed actions (what would happen NOW)');
console.log(`replay usage: ${resp.usage.input_tokens}in / ${resp.usage.output_tokens}out tokens`);

const a = JSON.stringify(entry.actions ?? []);
const b = JSON.stringify(replayed);
if (a === b) {
  console.log('\nVERDICT: action documents are IDENTICAL');
} else {
  const n = Math.max(entry.actions?.length ?? 0, replayed.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if (JSON.stringify((entry.actions ?? [])[i]) !== JSON.stringify(replayed[i])) { firstDiff = i; break; }
  }
  console.log(`\nVERDICT: DIFFERS from recorded (first difference at action ${firstDiff + 1}) — expected across model/prompt versions; judge, don't assume regression`);
  console.log('\nreplayed action JSON:');
  console.log(JSON.stringify(replayed, null, 2));
}
