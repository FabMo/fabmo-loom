// Autoprompt — turn the ledger's ranked failure classes into ready-to-run
// fix briefs. Deterministic and free: no model call, no app-code edits.
//
// The nightly measures; conversions stay attended (PROBE.md). This script
// closes the gap between the two: for each OPEN class it gathers every
// night's evidence (the prompts verbatim, what the user was told, the
// failing op) and writes a self-contained prompt a fresh agent session can
// execute — design call first, then AGENTS.md's decline → feature list,
// then the same words re-probed live as the acceptance test.
//
// Usage: node autoprompt.mjs            → runs/fix-prompts/INDEX.md + top 8 briefs
//        node autoprompt.mjs --top 12   → more briefs
//        node autoprompt.mjs v-inlay    → (re)write that one brief and print it
//
// Output lives under runs/ (gitignored). Funnel evidence is cited by query
// id and count only — real users' words never enter a brief.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { isInfraRow } from './model-call.mjs';

const HERE = new URL('./', import.meta.url).pathname;
const RUNS = `${HERE}runs/`;
const OUT = `${RUNS}fix-prompts/`;
const args = process.argv.slice(2);
const topAt = args.indexOf('--top');
const TOP = topAt >= 0 ? Number(args[topAt + 1]) : 8;
const only = args.filter((a, i) => !a.startsWith('--') && !(topAt >= 0 && i === topAt + 1));

// ---- ledger: class → { section, status, note, funnel, open } -------------
const SECTIONS = [
  [/^## Capability gaps/, 'capability'], [/^## By-design/, 'by-design'],
  [/^## Authoring-quality/, 'authoring'], [/^## Semantic overclaims/, 'overclaim'],
  [/^## Robustness/, 'robustness'], [/^## /, null],
];
const slug = (s) => s.replace(/^NEW\s+/i, '').split(/\s+[\/+]\s+|\s+\(|\s+—\s+/)[0].trim().toLowerCase();
const ledger = new Map();
const byDesign = [];
{
  let section = null;
  for (const line of readFileSync(`${HERE}ledger.md`, 'utf8').split('\n')) {
    if (line.startsWith('## ')) { section = SECTIONS.find(([re]) => re.test(line))[1]; continue; }
    if (section === 'by-design' && line.trim()) byDesign.push(...line.split(';').map(s => slug(s.trim())).filter(Boolean));
    if (!section || !line.startsWith('| ') || /^\| class|^\|---/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const struck = cells[0].startsWith('~~');
    const name = cells[0].replace(/~~/g, '');
    const status = cells.at(-1);
    const funnel = section === 'capability' ? Number((cells[1].split('/')[1] ?? '0').trim()) || 0 : 0;
    const funnelIds = [...(cells[2] ?? '').matchAll(/\bq_[0-9a-f]+\b/g)].map(m => m[0]);
    ledger.set(slug(name), {
      section, name, status, funnel, funnelIds,
      open: !struck && !/SHIPPED|FIXED|CAUGHT|guarded/.test(status),
    });
  }
}

// ---- evidence: every night's triage, joined to its result rows ------------
const classes = new Map();
const infra = [];
for (const f of readdirSync(RUNS).filter(f => /^\d{4}-\d\d-\d\d(-manual)?-triage\.json$/.test(f)).sort()) {
  const day = f.replace('-triage.json', '');
  let tri; try { tri = JSON.parse(readFileSync(RUNS + f, 'utf8')); } catch { continue; }
  const rows = new Map();
  // text rows and the night's picture rows (photo-pick.mjs lane) both feed triage
  for (const f of [`${RUNS}${day}-results.jsonl`, `${RUNS}${day}-photo-results.jsonl`]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); rows.set(r.id, r); } catch { /* torn line */ }
    }
  }
  for (const c of tri.classified ?? []) {
    if (!c?.class || !c.id) continue;
    const row = rows.get(c.id);
    // a dropped connection in the probe is not a Loom failure
    // (INFRA_ERROR rows since 2026-10-05; the legacy regex on row.error before)
    if (isInfraRow(row)) { infra.push(`${day}:${c.id}`); continue; }
    const key = slug(c.class);
    if (key === 'working-as-intended' || /by-design/i.test(c.class) || byDesign.includes(key)) continue;
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push({ day, id: c.id, evidence: c.evidence, row });
  }
}

// ---- rank -----------------------------------------------------------------
const today = Date.now();
const ranked = [...classes.entries()].map(([key, ev]) => {
  const L = ledger.get(key);
  const prompts = new Set(ev.map(e => e.id));
  const isRecent = (e) => today - Date.parse(e.day.slice(0, 10)) < 14 * 864e5;
  const recent = ev.filter(isRecent).length;
  const recentDistinct = new Set(ev.filter(isRecent).map(e => e.id)).size;
  const funnel = L?.funnel ?? 0;
  return {
    key, ev, L, funnel, recent, distinct: prompts.size,
    nights: new Set(ev.map(e => e.day)).size,
    section: L?.section ?? 'unlisted',
    open: L ? L.open : true,
    // real demand outweighs synthetic; what the probe still hits outweighs
    // what it last hit months ago (often closed since by an unrelated fix)
    score: funnel * 5 + recentDistinct * 2 + (prompts.size - recentDistinct) * 0.25,
  };
}).sort((a, b) => b.score - a.score);
const open = ranked.filter(c => c.open);
const closedButRecurring = ranked.filter(c => !c.open && c.recent > 0);

// ---- the brief ------------------------------------------------------------
const KIND = {
  capability: {
    title: 'capability gap',
    plan: `This class is a CAPABILITY GAP: the model honestly declines (or builds a partial) because the catalog has no way to express the ask. Make the design call first, in writing, before any code:
   a. Is it a new catalog entry, a new param on an existing entry, a new \`set_shape\` kind, or a guest-app change (furniture/braille live in their own repos)?
   b. Or should it be a BY-DESIGN decline (needs hardware, data or a modality Loom deliberately lacks)? If so, STOP: write that recommendation and change no code.
   Then convert it by exactly the "decline → feature" checklist in \`AGENTS.md\` (strategy + catalog entry with honest \`doc\`, remove it from the decline examples in \`buildSystemPrompt\`, scripted payload in \`app/test.mjs\`).`,
  },
  authoring: {
    title: 'authoring-quality slip',
    plan: `This class is an AUTHORING SLIP: the catalog can express the ask, but the model authors it wrong. Prefer the cheapest fix that removes the trap rather than warning about it:
   a. Can the runtime simply accept what the model keeps writing (a formula where only a number is taken, an alias, a default)? Do that.
   b. Can the failure reason shown on the second look name the exact fix? Sharpen it.
   c. Only then add a rule to \`buildSystemPrompt\` (app/intent.mjs). Prompt edits shift behaviour invisibly: run the blast-radius re-probe from PROBE.md (a fixed 20+ prompt sample, before and after) and report the diff.`,
  },
  robustness: {
    title: 'robustness bug',
    plan: `This class is a ROBUSTNESS BUG. Reproduce it from the recorded row before touching code (\`node replay.mjs\` re-weaves recorded actions at zero API cost), find the root cause, and fix it where it originates. Add the recorded payload as a scripted case in \`app/test.mjs\`.`,
  },
};
KIND.overclaim = { title: 'semantic overclaim', plan: `This class is a SEMANTIC OVERCLAIM the verifier cannot see. The fix is a new check in \`checkClaims\` (app/intent.mjs), with a sweep of the whole recorded corpus for precision before it ships (the v0.81 bar: zero false positives).` };
KIND.unlisted = { title: 'triage-only class (not yet in the ledger tables)', plan: `Triage keeps naming this class but the ledger has no table row for it. First decide what it IS (capability gap, authoring slip, or robustness bug) from the evidence below, add the row to the right ledger table, then proceed as that kind:\n   - capability → AGENTS.md "decline → feature" checklist (or recommend a by-design decline and stop);\n   - authoring → make the runtime accept it, or sharpen the second-look reason, before adding a prompt rule;\n   - robustness → reproduce from the recorded row with \`replay.mjs\`, fix at the root.` };

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function brief(c) {
  const kind = KIND[c.section] ?? KIND.unlisted;
  // newest first, one entry per prompt id, at most 6 shown in full
  const seen = new Set();
  const shown = [...c.ev].reverse().filter(e => !seen.has(e.id) && seen.add(e.id)).slice(0, 6);
  const retest = shown.filter(e => e.row?.prompt).slice(0, 4).map(e => e.id);
  const evidence = shown.map(e => {
    const r = e.row;
    const out = [`### ${e.id} (${e.day})`];
    if (r?.prompt) out.push(`Ask: "${r.prompt}"`);
    out.push(`Triage: ${e.evidence ?? '—'}`);
    if (r) {
      out.push(`Outcome: ${r.outcome}${r.verified ? ', verified' : ', NOT verified'}; pipeline: ${(r.pipeline ?? []).join(' → ') || '(empty)'}`);
      for (const d of (r.declined ?? []).slice(0, 3)) out.push(`Declined: ${clip(d.what, 160)} — ${clip(d.why, 260)}`);
      for (const w of (r.weaveErrors ?? []).slice(0, 3)) out.push(`Weave error: ${clip(w, 260)}`);
      for (const s of (r.skipped ?? []).slice(0, 3)) out.push(`Skipped action: ${clip(s, 260)}`);
      if (r.error) out.push(`Error: ${clip(r.error, 260)}`);
      if (r.summary) out.push(`What the user read: ${clip(r.summary, 420)}`);
    }
    return out.join('\n');
  }).join('\n\n');

  return `# Fix brief — ${c.key}

You are working in the fabmo-loom repo (\`/var/opt/apps/contributors/brian.o/fabmo-loom\`). Close the "${c.key}" failure class found by the nightly probe. This brief is self-contained; read it fully, then read \`AGENTS.md\` and \`INTENT.md\` before designing.

## The class

- Kind: ${kind.title}
- Ledger entry: ${c.L ? clip(c.L.name, 300) : '(none — triage-only)'}
- Ledger status / design note: ${c.L ? clip(c.L.status, 500) : '—'}
- Evidence: ${c.distinct} distinct synthetic prompt${c.distinct === 1 ? '' : 's'} over ${c.nights} night${c.nights === 1 ? '' : 's'} (${c.recent} hit${c.recent === 1 ? '' : 's'} in the last 14 days)${c.funnel ? `; ${c.funnel} REAL user ask${c.funnel === 1 ? '' : 's'} in the funnel (${c.L.funnelIds.join(', ') || 'ids in ledger.md'} — read them in tools/synth-probe/corpus.local.jsonl, never copy their text into commits or docs)` : '; no real-user asks yet'}

## Evidence (synthetic prompts, verbatim)

${evidence}
${c.distinct > shown.length ? `\n(+${c.distinct - shown.length} more prompt ids: ${[...new Set(c.ev.map(e => e.id))].filter(id => !shown.some(s => s.id === id)).join(', ')} — rows in tools/synth-probe/runs/<day>-results.jsonl)\n` : ''}
## What to do

1. ${kind.plan}
2. Keep the rails honest. Do NOT loosen a verifier gate to make a row pass — a scoped, justified allowance is the pattern (see how edgeTreatment is allowed). By-design declines must keep declining. If a strategy or kernel file is mirrored in the seams repo, mirror the change there and say so (the copies differ; never straight-copy).
3. Keep the summary honest: whatever part of these asks still cannot be done after your change must still be declined by name.

## Acceptance (all required)

- \`npm test\` green in the repo root (includes the recorded-corpus replay; expect IMPROVED lines, zero REGRESSIONS).
- The same words now work, live:
  \`cd tools/synth-probe && node live-retest.mjs ${retest.join(' ') || '<prompt-ids>'}\`
  (real API calls on the shop key, roughly $0.15 per prompt). Each should end verified with an .sbp, or with an honest decline of only what is truly still out of scope.
- If the corpus replay shows IMPROVED rows, review them and \`node test-corpus.mjs --bless\`.
- Move the class in \`tools/synth-probe/ledger.md\` to SHIPPED/FIXED with the version and one line on how it was closed.
- Bump the \`app-version\` span by one minor.

## Boundaries

- Do not commit and do not push: fabmo-loom is a public repo and Brian reviews conversions. Leave the working tree changed and finish with a report: the design call, files touched, test output tail, live-retest outcome per prompt id, and anything you chose not to do.
- If the design call is "by-design decline" or the fix needs more than about a day of work or a new dependency, stop after step 1 and report the recommendation instead of building.
`;
}

// ---- write ------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const file = (key) => `${key.replace(/[^a-z0-9-]+/g, '-')}.md`;
if (only.length) {
  for (const k of only) {
    const c = ranked.find(c => c.key === k.toLowerCase());
    if (!c) { console.error(`no evidence for class "${k}" — known: ${ranked.map(c => c.key).join(', ')}`); process.exit(1); }
    const text = brief(c);
    writeFileSync(OUT + file(c.key), text);
    console.log(text);
  }
  process.exit(0);
}
const picked = open.slice(0, TOP);
for (const c of picked) writeFileSync(OUT + file(c.key), brief(c));
const row = (c, i) => `| ${i + 1} | ${picked.includes(c) ? `[${c.key}](${file(c.key)})` : c.key} | ${c.section} | ${c.distinct} | ${c.funnel} | ${c.recent} | ${c.ev.at(-1).day} |`;
writeFileSync(`${OUT}INDEX.md`, `# Fix-prompt queue — generated ${new Date().toISOString().slice(0, 10)}

Ranked open failure classes (score = 5 × real-user asks + 2 × distinct synthetic prompts in the last 14 days + ¼ × older ones). The top ${picked.length} have a ready-to-run brief; hand one to a fresh agent session in fabmo-loom. Regenerate with \`node autoprompt.mjs\`; one class with \`node autoprompt.mjs <class>\`.

| # | class | kind | synthetic prompts | funnel asks | last 14 d | last seen |
|---|---|---|---|---|---|---|
${open.map(row).join('\n')}
${closedButRecurring.length ? `\n## Closed in the ledger but still recurring (regression watch)\n\n${closedButRecurring.map(c => `- ${c.key} — ${c.recent} hit${c.recent === 1 ? '' : 's'} in the last 14 days (ledger: ${clip(c.L.status, 90)})`).join('\n')}\n` : ''}${infra.length ? `\n## Excluded as probe infrastructure (dropped connection, not Loom)\n\n${infra.join(', ')}\n` : ''}`);
console.log(`[autoprompt] ${open.length} open classes ranked; ${picked.length} briefs → runs/fix-prompts/ (top: ${picked.slice(0, 5).map(c => c.key).join(', ')})`);
