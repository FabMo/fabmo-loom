// The weave worker — runRecipe + simulateJob off the main thread.
//
// The weave rail is DOM-free by design (it runs in Node for the gauntlets),
// so it runs in a module worker unchanged: the page posts the recipe and
// values, the worker weaves, verifies, posts, simulates the 3D surface, and
// sends everything back as plain data (the sim grid transferred, not
// copied). Typing and drawing stay responsive while it works.
//
// Protocol (all messages tagged by kind):
//   → { kind:'init', fonts, guestUrls }   fonts = id → ArrayBuffer, once.
//                                         Guest modules are imported HERE
//                                         too — same URLs the page loads,
//                                         same DOM-free run() contract.
//   → { kind:'weave', id, recipe, values, terrains, shop, placement?, wantSim }
//   ← { kind:'wove', id, result, sim }    sim = simulateJob output or null
//   ← { kind:'error', id, message }       a THROW (bug) or a result that
//                                         would not clone — the page falls
//                                         back to weaving on its own thread.
//
// Anything app-level (localStorage, theme, FabMo, the ledger) stays on the
// page; the worker sees only the arguments of one weave at a time.

import { runRecipe } from './runtime.mjs';
import { registerCatalogEntries } from './catalog.mjs';
import { simulateJob } from './sim.mjs';

let FONT_SHELF = null;

const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
};

self.onmessage = async (e) => {
  const m = e.data;

  if (m.kind === 'init') {
    FONT_SHELF = m.fonts;
    for (const url of m.guestUrls ?? []) {
      try {
        const mod = await import(url);
        registerCatalogEntries(mod.entries);
      } catch (err) {
        // the page already reported this guest failing on its own import;
        // here it just means worker weaves decline the guest's verbs too
        console.warn(`weave worker: guest ${url} failed to load:`, err);
      }
    }
    self.postMessage({ kind: 'ready' });
    return;
  }

  if (m.kind === 'weave') {
    try {
      const result = quiet(() => runRecipe(m.recipe, m.values, FONT_SHELF, m.terrains ?? {}, m.shop, m.placement));
      let sim = null;
      if (m.wantSim !== false && result.ok && result.preview?.built?.length) {
        sim = simulateJob(result.preview.built, result.preview.placement ?? { x: 0, y: 0 },
          result.preview.stock, { analyticVee: true });
      }
      self.postMessage({ kind: 'wove', id: m.id, result, sim }, sim ? [sim.grid.buffer] : []);
    } catch (err) {
      self.postMessage({ kind: 'error', id: m.id, message: err?.message ?? String(err) });
    }
  }
};
