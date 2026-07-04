// The Loom runtime: render any recipe into one verified Job.
//
// A recipe is a DOCUMENT, not code:
//   {
//     name: 'Name tags',
//     stock: { w, h, thickness },
//     margin: 0.375,                      // content clearance from stock edge
//     controls: [ { id, type:'text'|'number', label, default, min?, max?, step? } ],
//     pipeline: [ { id, strategy, params } ],   // strategy ∈ CATALOG
//   }
// Param values are literals or control bindings: { ctrl: 'controlId' }.
//
// runRecipe resolves bindings, runs each catalog strategy in order (each
// sees the union bbox of what came before), centers the whole group on
// stock, assigns tools, composes ONE Job, verifies it, and posts only on
// a verified OK. Prompts and sliders go through the identical path — the
// LLM can propose a recipe state, but it cannot make an unverified file
// exist.

import { CATALOG } from './catalog.mjs';
import { composeJob, postJobToSbp, postJobToGcode } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

export const EMPTY_RECIPE = {
  name: 'Untitled',
  stock: { w: 8, h: 2.5, thickness: 0.5 },
  margin: 0.375,
  controls: [],
  pipeline: [],
};

export function controlDefaults(recipe) {
  const values = {};
  for (const c of recipe.controls) values[c.id] = c.default;
  return values;
}

function resolveParams(entry, params, controlValues, errors, opId) {
  const out = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    let v = params?.[key];
    if (v && typeof v === 'object' && 'ctrl' in v) {
      if (!(v.ctrl in controlValues)) { errors.push(`op "${opId}": param ${key} bound to missing control "${v.ctrl}"`); continue; }
      v = controlValues[v.ctrl];
    }
    if (v === undefined || v === null || v === '') v = spec.default;
    if (v === undefined) { errors.push(`op "${opId}": required param ${key} missing`); continue; }
    if (spec.type === 'boolean') {
      v = v === true || v === 'true' || v === 'yes';
    }
    if (spec.type === 'number') {
      v = typeof v === 'number' ? v : parseFloat(v);
      if (isNaN(v)) { errors.push(`op "${opId}": param ${key} is not a number`); continue; }
      if (spec.min !== undefined) v = Math.max(spec.min, v);
      if (spec.max !== undefined) v = Math.min(spec.max, v);
    }
    out[key] = v;
  }
  return out;
}

/**
 * @returns {{ ok, errors, warnings, report?, job?, sbp?, gcode?, preview }}
 */
export function runRecipe(recipe, controlValues, fontBuffer) {
  const errors = [];
  const stock = recipe.stock;
  if (!recipe.pipeline.length) {
    return { ok: false, errors: ['the recipe has no operations yet — ask for something'], warnings: [], preview: { empty: true } };
  }

  const ctx = {
    fontBuffer,
    stock,
    safeZ: 0.5,
    rpm: 14000,
    contentBBox: null,
  };

  // ---- run each strategy in local coords, growing the content bbox ----
  const built = [];
  for (const op of recipe.pipeline) {
    const entry = CATALOG[op.strategy];
    if (!entry) { errors.push(`unknown strategy "${op.strategy}"`); continue; }
    const p = resolveParams(entry, op.params, controlValues, errors, op.id);
    if (errors.length) break;
    const r = entry.run(p, ctx);
    if (r.error) { errors.push(`op "${op.id}": ${r.error}`); break; }
    // a catalog verb may lower to SEVERAL machine operations (e.g. a bulk
    // pocket + a smaller-bit rest pass = two tools); each sub-op carries
    // its own tool, moves, and declared target
    for (const sub of (r.ops ?? [r])) built.push({ op, r: sub });
    ctx.contentBBox = ctx.contentBBox
      ? {
          minX: Math.min(ctx.contentBBox.minX, r.bbox.minX), minY: Math.min(ctx.contentBBox.minY, r.bbox.minY),
          maxX: Math.max(ctx.contentBBox.maxX, r.bbox.maxX), maxY: Math.max(ctx.contentBBox.maxY, r.bbox.maxY),
        }
      : { ...r.bbox };
  }
  if (errors.length || !built.length) {
    return { ok: false, errors: errors.length ? errors : ['nothing to machine'], warnings: [], preview: { empty: true } };
  }

  // ---- fit + placement: center the whole group on the stock ----
  const b = ctx.contentBBox;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const margin = recipe.margin ?? 0.375;
  // centering placement is computed BEFORE the fit check so that an
  // over-size error still previews the content centered (overflowing the
  // stock symmetrically) — placed at the corner it reads as a runaway cut
  const placement = {
    x: (stock.w - w) / 2 - b.minX,
    y: (stock.h - h) / 2 - b.minY,
  };
  if (w + 2 * margin > stock.w + 1e-9 || h + 2 * margin > stock.h + 1e-9) {
    return {
      ok: false, warnings: [],
      errors: [`the content needs ${(w + 2 * margin).toFixed(2)}" × ${(h + 2 * margin).toFixed(2)}" (including ${margin}" margins) — stock is ${stock.w}" × ${stock.h}". Enlarge the stock or shrink the content.`],
      preview: { built, placement },
    };
  }

  // ---- tool table: one entry per distinct tool spec, in first-use order ----
  const tools = {};
  const toolNumber = new Map();
  for (const { r } of built) {
    const key = `${r.tool.name}|${r.tool.diameter}`;
    if (!toolNumber.has(key)) {
      const n = toolNumber.size + 1;
      toolNumber.set(key, n);
      tools[n] = { name: r.tool.name, diameter: r.tool.diameter };
    }
  }

  const job = {
    units: 'in',
    stock,
    safeZ: ctx.safeZ,
    spindleSpeed: ctx.rpm,
    tools,
    operations: built.map(({ op, r }) => ({
      name: `${op.id}${r.subName ? ` ${r.subName}` : ''} (${op.strategy})`,
      tool: toolNumber.get(`${r.tool.name}|${r.tool.diameter}`),
      feedRate: r.feedRate,
      plungeRate: r.plungeRate,
      placement,
      moves: r.moves,
      target: r.target,
      allowOverlap: !!r.allowOverlap,
    })),
  };

  const composed = composeJob(job);
  // coverage residual is meaningless for line engraving (see engraver notes);
  // gouge/depth/intrusion stay hard errors.
  const report = verifyJob(job, composed, { coverageWarnPct: 100 });

  const result = {
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    report, job, composed,
    preview: { built, placement },
  };
  if (report.ok) {
    result.sbp = postJobToSbp(job, composed, { title: `Loom — ${recipe.name}` });
    result.gcode = postJobToGcode(job, composed, { title: `Loom — ${recipe.name}` });
  }
  return result;
}
