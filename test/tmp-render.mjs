import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
const [recipePath, outPrefix] = process.argv.slice(2);
const recipe = readFileSync(recipePath, 'utf8');
const shop = JSON.stringify({ machineW: 48, machineH: 48, materialW: 48, materialH: 48 });
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
page.on('pageerror', e => console.log('pageerror', e.message));
const url = 'http://127.0.0.1:4000/c/brian.o/fabmo-loom/app/';
for (const view of ['2d', '3d']) {
  await page.goto(url);
  await page.evaluate((r, s, v) => { localStorage.setItem('loom:recipe', r); localStorage.setItem('loom:shop', s); localStorage.setItem('loom:view', v); }, recipe, shop, view);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /VERIFIED|REFUSED|ERROR/.test(document.querySelector('#badge')?.textContent ?? ''), { timeout: 120000 });
  console.log(view, 'badge:', await page.$eval('#badge', e => e.textContent.trim()));
  if (view === '3d') {
    await page.waitForFunction(() => window.loomAssembly && !window.loomAssembly.introPlaying(), { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
  }
  const el = await page.$(view === '2d' ? '#preview' : '#preview3d');
  try { await el.screenshot({ path: `${outPrefix}-${view}.png` }); }
  catch (e) { console.log(view, 'element shot failed:', e.message.slice(0, 80), '— full page'); await page.screenshot({ path: `${outPrefix}-${view}.png` }); }
}
await browser.close();
