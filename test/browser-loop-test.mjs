// Browser validation of the closed intent loop in the live app: a scripted
// Anthropic endpoint (request interception) plays a model that overclaims
// on its first call, is shown the weave, fixes the build, and writes an
// honest summary on the last call. Checks the conversation threading the
// page sends, the turn the user reads, the recipe that results, and what
// the funnel log records about the loop.
//
// NOT part of npm test (needs the production server up):
//   node test/browser-loop-test.mjs [url]

import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const SCRIPT = [
  { summary: 'Built a nameplate with a v-carved name and a rounded tag cutout.', actions: [
    { kind: 'set_name', name: 'Nameplate' },
    { kind: 'add_control', control: { id: 'word', type: 'text', label: 'Name', default: 'Ada' } },
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1, roundover: 1 } } },
  ], declined: [], suggest: ['make the letters taller'] },
  { summary: 'Built a nameplate: the name v-carved, cut out as a rounded tag.', actions: [
    { kind: 'add_operation', operation: { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'word' }, letterHeight: 1 } } },
    { kind: 'add_operation', operation: { id: 'tag', strategy: 'tag_cutout', params: { buffer: 0.4 } } },
  ], declined: [], suggest: ['make the tag buffer bigger'] },
  { summary: 'Nameplate: v-carved name on a rounded tag, verified.', actions: [], declined: [], suggest: ['make the letters ___ inches tall'] },
];

console.log(`=== browser closed-loop validation: ${URL} ===\n`);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => fail(`pageerror: ${e.message}`));
  page.on('workercreated', w => { if (process.env.VERBOSE === '1') console.log(`  [worker] ${w.url().slice(-40)}`); });
  const VERBOSE = process.env.VERBOSE === '1';
  if (VERBOSE) {
    page.on('console', m => console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('requestfailed', r => console.log(`  [requestfailed] ${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    page.on('response', r => { if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.url().slice(0, 140)}`); if (/anthropic|intent/.test(r.url())) console.log(`  [response] ${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  }
  // The scripted model lives INSIDE the page as a fetch stub: network-level
  // request interception stalls the weave worker's module imports (a
  // puppeteer limitation with dedicated workers), so the app must see an
  // untouched network. The stub answers api.anthropic.com from SCRIPT and
  // records every request body; the funnel POST passes through, recorded.
  await page.evaluateOnNewDocument((script) => {
    localStorage.clear();
    localStorage.setItem('loom:apiKey', 'sk-ant-test-not-real');
    localStorage.setItem('loom:introSeen', '1');
    window.__calls = [];
    window.__funnel = null;
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, init = {}) => {
      const u = typeof url === 'string' ? url : url?.url ?? String(url);
      if (u.startsWith('https://api.anthropic.com/v1/messages')) {
        const body = JSON.parse(init.body || '{}');
        window.__calls.push(body);
        const p = script[Math.min(window.__calls.length - 1, script.length - 1)];
        const resp = { stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'tool_use', id: `tu_${window.__calls.length}`, name: 'apply_recipe_actions', input: p }] };
        return Promise.resolve(new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (u.endsWith('/api/intent/log') && init.method === 'POST') window.__funnel = JSON.parse(init.body || '{}');
      return realFetch(url, init);
    };
  }, SCRIPT);
  const modelCalls = [];
  let funnel = null;
  const syncCalls = async () => { modelCalls.splice(0, modelCalls.length, ...(await page.evaluate(() => window.__calls))); funnel = await page.evaluate(() => window.__funnel); };
  await page.goto(URL, { waitUntil: 'networkidle2' });
  // dismiss any intro overlay that may sit over the prompt box
  await page.evaluate(() => document.querySelectorAll('#introOverlay').forEach(el => el.remove()));
  await page.evaluate(() => { document.getElementById('prompt').value = 'a nameplate for Ada, cut out as a tag'; });
  await page.click('#generate');

  // the user's turn appears once the loop is done (an error turn ends the wait too)
  await page.waitForFunction(() => document.querySelector('#history .turn .did')?.textContent.includes('verified.') || document.querySelector('#history .turn.err'), { timeout: 30000 })
    .catch(() => {});
  if (VERBOSE) {
    for (let i = 0; i < 6; i++) {
      const st = await page.evaluate(() => ({ pending: window.loomWeave?.pending?.(), badge: document.getElementById('badge')?.textContent, hist: document.getElementById('history')?.children.length }));
      console.log(`  [poll ${i}] ${JSON.stringify(st)}`);
      if (st.hist) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  await syncCalls();
  const histText = await page.evaluate(() => document.getElementById('history')?.innerText.slice(0, 500));
  if (/verified\./.test(histText ?? '')) pass('turn rendered with the FINAL summary');
  else {
    const st = await page.evaluate(() => ({ badge: document.getElementById('badge')?.textContent, gen: document.getElementById('generate')?.textContent, worker: window.loomWeave?.workerActive?.(), overlayLabel: document.querySelector('#appPanel > div:last-child div')?.textContent }));
    fail(`no final turn — history: ${JSON.stringify(histText)}; model calls so far: ${modelCalls.length}; page: ${JSON.stringify(st)}`); throw new Error('no turn');
  }
  const turnHtml = await page.evaluate(() => document.querySelector('#history .turn').innerHTML);
  if (/checked against the weave — 2 corrections applied, summary revised/.test(turnHtml)) pass('loop note: 2 corrections, summary revised');
  else fail(`loop note missing: ${turnHtml.slice(0, 400)}`);
  if (!/skipped:/.test(turnHtml)) pass('the fixed skip is not shown as a leftover'); else fail('stale skip shown');

  if (modelCalls.length === 3) pass('three model calls'); else fail(`model calls: ${modelCalls.length}`);
  const m2 = modelCalls[1]?.messages ?? [];
  const obs1 = m2[2]?.content?.[0];
  if (m2.length === 3 && m2[1].role === 'assistant' && obs1?.type === 'tool_result' && obs1.tool_use_id === 'tu_1' && /SKIPPED \(1\)/.test(obs1.content) && /roundover/.test(obs1.content) && /PIPELINE: EMPTY/.test(obs1.content))
    pass('second call threads the tool_result with the skip and the empty pipeline');
  else fail(`second call shape: ${JSON.stringify(m2.map(m => m.role))} ${String(obs1?.content).slice(0, 200)}`);
  const m3 = modelCalls[2]?.messages ?? [];
  const obs2 = m3[4]?.content?.[0];
  if (m3.length === 5 && /WEAVE: VERIFIED/.test(obs2?.content ?? '') && /engrave \(vcarve_text\) → tag \(tag_cutout\)/.test(obs2?.content ?? '') && /LAST call/.test(m3[4]?.content?.[1]?.text ?? ''))
    pass('third call saw the verified pipeline (the page\'s own weave) and the final-turn instruction');
  else fail(`third call shape: ${JSON.stringify(m3.map(m => m.role))} ${String(obs2?.content).slice(0, 300)}`);
  if (modelCalls[1].system === modelCalls[0].system) pass('system prompt byte-identical across turns (cacheable)'); else fail('system prompt changed between turns');

  await page.waitForFunction(() => document.getElementById('badge')?.textContent === 'VERIFIED', { timeout: 30000 });
  pass('final recipe weaves to VERIFIED in the page');
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('loom:recipe')));
  if (rec.pipeline.map(o => o.id).join(',') === 'engrave,tag' && rec.about === SCRIPT[2].summary) pass('persisted recipe: corrected pipeline, about = final summary');
  else fail(`recipe: ${rec.pipeline.map(o => o.id)} / ${rec.about}`);

  for (let i = 0; i < 20 && !funnel; i++) { await new Promise(r => setTimeout(r, 200)); await syncCalls(); }
  if (funnel?.intent?.loop?.turns === 3 && funnel.intent.loop.fixes === 2 && funnel.intent.loop.firstSummary === SCRIPT[0].summary && funnel.intent.summary === SCRIPT[2].summary && funnel.usage?.calls === 3)
    pass('funnel log records first vs final summary, turns, fixes, calls');
  else fail(`funnel: ${JSON.stringify(funnel?.intent?.loop)} usage ${JSON.stringify(funnel?.usage)}`);
  const chips = await page.evaluate(() => [...document.querySelectorAll('#chips button, #chips .chip')].map(b => b.textContent.trim()));
  if (chips.some(c => /make the letters ___ inches tall/.test(c))) pass('chips come from the final turn'); else fail(`chips: ${chips.join(' | ')}`);
} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
