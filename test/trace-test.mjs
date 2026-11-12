// Raster → outline gauntlet (app/trace.mjs): a two-tone bitmap becomes an
// SVG that the ordinary asset path lowers, cuts and verifies; a photograph
// is refused with a reason.
//
// Usage: node test/trace-test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceBitmap } from '../app/trace.mjs';
import { svgAssetToRegions } from '../app/svg.mjs';
import { EMPTY_RECIPE, runRecipe, controlDefaults } from '../app/runtime.mjs';
import { applyActions } from '../app/intent.mjs';
import { FONTS } from '../app/fonts.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const FONT_SHELF = {};
for (const f of FONTS) { const b = readFileSync(join(app, f.file)); FONT_SHELF[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
let failures = 0;
const ok = (msg, cond, detail = '') => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ FAIL ${msg}${detail ? ` — ${detail}` : ''}`); } };
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };

// paint(w, h, fn) → RGBA bitmap; fn(x, y) returns grey 0..255 (or [grey, alpha])
function paint(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x + 0.5, y + 0.5), g = Array.isArray(v) ? v[0] : v, a = Array.isArray(v) ? v[1] : 255;
    data.set([g, g, g, a], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}
const ringArea = (regions) => regions.reduce((s, r) => {
  const area = (ring) => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p.x * q.y - q.x * p.y; }, 0) / 2);
  return s + area(r.outer) - r.holes.reduce((t, h) => t + area(h), 0);
}, 0);
const washer = (x, y) => { const d = Math.hypot(x - 100, y - 80); return d < 50 && d > 20 ? 0 : 255; };

console.log('--- a black washer on white, with specks ---');
{
  const bmp = paint(200, 160, (x, y) => (washer(x, y) === 0 ? 0 : (x > 180 && x < 182 && y > 10 && y < 12) ? 0 : 255));
  const t = traceBitmap(bmp);
  ok(`traced: ${t.pieces} piece, ${t.holes} hole, ${t.loops} loops, ink ${(t.ink * 100).toFixed(1)}%`, !t.error && t.pieces === 1 && t.holes === 1 && t.loops === 2, JSON.stringify({ ...t, svg: undefined }));
  ok('the speck is dropped and the outline is simplified, not a staircase', t.svg.length < 6000 && (t.svg.match(/L/g) ?? []).length < 220, `${t.svg.length} chars`);
  const low = svgAssetToRegions(t.svg, { width: 4 });
  const want = Math.PI * (50 * 50 - 20 * 20) * (4 / 100) ** 2;
  const got = low.error ? 0 : ringArea(low.regions);
  ok(`the asset path lowers it: 1 region with 1 hole, area ${got.toFixed(3)} sq in (true ${want.toFixed(3)})`, !low.error && low.regions.length === 1 && low.regions[0].holes.length === 1 && Math.abs(got - want) / want < 0.02, low.error ?? '');
  const xs = low.regions[0].outer.map(p => p.x);
  ok('…at the width asked for', Math.abs(Math.max(...xs) - Math.min(...xs) - 4) < 0.01);

  // the whole way: asset → shape → cutout → verified job
  const rec = structuredClone(EMPTY_RECIPE);
  rec.assets.push({ id: 'washer.png.outline.svg', name: 'washer.png.outline.svg', kind: 'svg', data: t.svg });
  const out = applyActions(rec, { summary: 's', actions: [
    { kind: 'set_shape', shape: { id: 'art', asset: { of: 'washer.png.outline.svg', width: 5 } } },
    { kind: 'add_operation', operation: { id: 'cut', strategy: 'shape_cutout', params: { shape: 'art' } } },
  ] });
  const wr = quiet(() => runRecipe(out.recipe, controlDefaults(out.recipe), FONT_SHELF, {}));
  ok('a traced picture cuts out as a verified job', out.skipped.length === 0 && wr.ok, JSON.stringify({ skipped: out.skipped, errors: wr.errors }).slice(0, 400));
}

console.log('--- polarity, transparency, soft edges ---');
{
  const inv = traceBitmap(paint(200, 160, (x, y) => 255 - washer(x, y)));
  ok('white artwork on black traces the artwork, not the background', !inv.error && inv.pieces === 1 && inv.holes === 1 && inv.inkIsDark === false && inv.ink < 0.5, JSON.stringify({ ...inv, svg: undefined }));
  const alpha = traceBitmap(paint(200, 160, (x, y) => [0, washer(x, y) === 0 ? 255 : 0]));
  ok('a transparent background counts as paper', !alpha.error && alpha.pieces === 1 && alpha.holes === 1);
  const soft = traceBitmap(paint(200, 160, (x, y) => { const d = Math.hypot(x - 100, y - 80); return Math.max(0, Math.min(255, (d - 50) * 60 + 128)); }));
  ok('an anti-aliased edge still reads as two-tone', !soft.error && soft.pieces === 1 && soft.holes === 0, soft.error ?? '');
  const big = traceBitmap(paint(120, 120, (x, y) => (x > 10 && x < 110 && y > 10 && y < 110 ? 0 : 255)));
  ok('artwork that fills most of the frame is still the ink (the border decides)', !big.error && big.pieces === 1 && big.ink > 0.6);
  const diag = traceBitmap(paint(40, 40, (x, y) => ((x > 5 && x < 20 && y > 5 && y < 20) || (x > 20 && x < 35 && y > 20 && y < 35) ? 0 : 255)), { minLoopArea: 4 });
  ok('two squares touching at a corner come out as two closed pieces', !diag.error && diag.pieces === 2 && diag.holes === 0, JSON.stringify({ ...diag, svg: undefined }));
}

console.log('--- refusals: every one with a reason ---');
{
  const photo = traceBitmap(paint(200, 160, (x, y) => Math.round(127 + 100 * Math.sin(x / 23) * Math.cos(y / 17) + 27 * Math.sin((x + y) / 5))));
  ok('a photograph-like picture is refused, and told why', /photograph or a shaded drawing/.test(photo.error ?? ''), JSON.stringify(photo).slice(0, 200));
  ok('a blank picture is refused', !!traceBitmap(paint(64, 64, () => 255)).error);
  ok('a low-contrast picture is refused', /no clear/.test(traceBitmap(paint(64, 64, (x) => (x < 32 ? 120 : 140))).error ?? ''));
  ok('only specks is refused', /specks/.test(traceBitmap(paint(200, 200, (x, y) => (x > 50 && x < 52 && y > 50 && y < 52 ? 0 : 255))).error ?? ''));
  const noise = traceBitmap(paint(256, 256, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 0 : 255)));
  ok('a checker texture is refused as too many outlines', /too many separate outlines/.test(noise.error ?? ''), JSON.stringify(noise).slice(0, 160));
  ok('garbage in is an error, not a throw', !!traceBitmap(null).error && !!traceBitmap({ width: 100, height: 100, data: new Uint8Array(10) }).error);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ntrace gauntlet clean');
process.exit(failures ? 1 : 0);
