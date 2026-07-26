// Shared replay machinery for the recorded-model-output corpus.
//
// A corpus row is one REAL model response (from a probe run or the
// funnel log) frozen with the recipe context it ran against and the
// outcome it produced at record time:
//
//   { key, source: 'synthetic'|'funnel', prompt, context,          // context = starting recipe (null → EMPTY_RECIPE)
//     payload: { summary, actions, declined },
//     blessed: { outcome, verified, applied, skipped },            // behavior at bless time
//     recordedAt }
//
// Replaying a row costs nothing (no API): applyActions → runRecipe →
// verify, exactly the path the browser takes after the model answers.
// The corpus is therefore a regression suite made of every model
// response ever recorded — including the malformed ones.

import { readFileSync, existsSync } from 'node:fs';

const LOOM = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

export async function loadEnv() {
  const runtime = await import(`${LOOM}/app/runtime.mjs`);
  const intent = await import(`${LOOM}/app/intent.mjs`);
  const catalog = await import(`${LOOM}/app/catalog.mjs`);
  const { FONTS } = await import(`${LOOM}/app/fonts.mjs`);

  // strategies that exist BEFORE guests mount — rows using anything else
  // are guest rows and only testable where the guest modules live
  const baseStrategies = new Set(Object.keys(catalog.CATALOG));

  // mount guests exactly as the deployment does: guests.local.mjs lists
  // same-origin URL paths (/c/<user>/<app>/…); on the workspace those map
  // to contributor directories. A public clone has neither — guest rows
  // are skipped there, never failed.
  let guestsLoaded = false;
  const guestsFile = `${LOOM}/app/guests.local.mjs`;
  if (existsSync(guestsFile)) {
    try {
      const urls = (await import(guestsFile)).default ?? [];
      for (const u of urls) {
        const m = u.match(/^\/c\/([^/]+)\/([^/]+)\/(.+)$/);
        const p = m ? `/var/opt/apps/contributors/${m[1]}/${m[2]}/${m[3]}` : u;
        if (!existsSync(p)) continue;
        catalog.registerCatalogEntries((await import(p)).entries);
        guestsLoaded = true;
      }
    } catch { /* guests are optional everywhere */ }
  }

  const fonts = {};
  for (const f of FONTS) {
    const b = readFileSync(new URL(f.file, `file://${LOOM}/app/`).pathname);
    fonts[f.id] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }

  return { ...runtime, ...intent, CATALOG: catalog.CATALOG, baseStrategies, guestsLoaded, fonts };
}

export function usesGuestStrategy(row, env) {
  return (row.payload.actions ?? []).some(a =>
    a?.operation?.strategy && !env.baseStrategies.has(a.operation.strategy));
}

// deterministic stand-in grids for terrain references (the browser
// resolver can't run here; the reference is what's under test)
function syntheticGrids(recipe) {
  const grids = {};
  for (const t of recipe.terrains ?? []) {
    const cols = 200, rows = 150, elev = new Float32Array(cols * rows);
    for (let i = 0; i < elev.length; i++)
      elev[i] = 1500 + 600 * Math.sin((i % cols) / 17) * Math.sin(Math.floor(i / cols) / 13);
    grids[t.id] = { grid: { elev, cols, rows }, meta: { name: 'fixture', center: { lat: 36.1, lng: -112.1 }, min: 900, max: 2100 } };
  }
  return grids;
}

const quiet = (fn) => {
  const o = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = o; console.warn = w; }
};

// replay one row against the CURRENT pipeline. Never throws; a crash is
// an outcome, not an exception (crashes are exactly what this catches).
export function replayRow(row, env) {
  const recipe = row.context ? structuredClone(row.context) : structuredClone(env.EMPTY_RECIPE);
  let out;
  try {
    out = env.applyActions(recipe, {
      summary: row.payload.summary ?? '',
      actions: row.payload.actions ?? [],
      declined: row.payload.declined ?? [],
    });
  } catch (e) {
    return { outcome: 'APPLY_CRASH', error: String(e?.stack ?? e).slice(0, 500) };
  }
  const res = {
    applied: out.applied.length,
    skipped: out.skipped.length,
    skippedMsgs: out.skipped,
    declined: (row.payload.declined ?? []).length,
  };
  if (!out.recipe.pipeline.length) {
    res.verified = null;
  } else {
    try {
      const r = quiet(() => env.runRecipe(out.recipe, env.controlDefaults(out.recipe), env.fonts, syntheticGrids(out.recipe)));
      res.verified = !!r.ok;
      res.weaveErrors = r.errors ?? [];
    } catch (e) {
      return { ...res, outcome: 'WEAVE_CRASH', error: String(e?.stack ?? e).slice(0, 500) };
    }
  }
  res.outcome =
    res.declined && res.applied ? 'PARTIAL' :
    res.declined ? 'DECLINED' :
    res.skipped && !res.applied ? 'ALL_SKIPPED' :
    res.verified === false ? 'FULFILLED_UNVERIFIED' : 'FULFILLED';
  return res;
}

export function blessOf(replay) {
  return {
    outcome: replay.outcome,
    verified: replay.verified ?? null,
    applied: replay.applied ?? 0,
    skipped: replay.skipped ?? 0,
  };
}

// regression = the current pipeline handles this recorded response WORSE
// than at bless time. Improvements are reported, never failed.
export function compareToBlessed(replay, blessed) {
  if (/CRASH/.test(replay.outcome) && !/CRASH/.test(blessed.outcome)) return { verdict: 'REGRESSION', why: `now ${replay.outcome}` };
  if (blessed.verified === true && replay.verified === false) return { verdict: 'REGRESSION', why: 'verified → verify FAIL' };
  if ((replay.skipped ?? 0) > blessed.skipped) return { verdict: 'REGRESSION', why: `skips ${blessed.skipped} → ${replay.skipped}: ${replay.skippedMsgs?.slice(0, 2).join(' | ')}` };
  if ((replay.applied ?? 0) < blessed.applied) return { verdict: 'REGRESSION', why: `applied ${blessed.applied} → ${replay.applied}` };
  if ((blessed.verified === false || blessed.verified === null) && replay.verified === true) return { verdict: 'IMPROVED', why: 'now verifies' };
  if ((replay.skipped ?? 0) < blessed.skipped) return { verdict: 'IMPROVED', why: `skips ${blessed.skipped} → ${replay.skipped}` };
  return { verdict: 'OK' };
}

export function readCorpus(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
