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
import { expandTemplate, pathToRegions, pathToCurve } from './shape.mjs';
import { composeJob, postJobToSbp, postJobToGcode } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

export const EMPTY_RECIPE = {
  version: 2,                  // recipe grammar version (migrations key on this)
  name: 'Untitled',
  stock: { thickness: 0.5 },   // W×H are DERIVED: stock auto-sizes to the content
  margin: 0.375,
  controls: [],
  // named intermediate values: ordered [{ id, expr }], each expr an
  // arithmetic expression over controls and EARLIER derived ids. One
  // definition, referenced as {id} anywhere expressions are allowed —
  // the antidote to re-deriving "r - t/2" in five places.
  derived: [],
  // named geometry: ordered [{ id, path, open? }], authored in the SHARED
  // frame (inches, y flips, no recentering); ops reference by id
  shapes: [],
  pipeline: [],
  // uploaded images/graphics, embedded so recipes stay self-contained:
  // { id, name, kind: 'image'|'svg', data (dataURL or svg text), width?, height? }
  // No strategy consumes them yet — they are the raw material for the
  // image/graphic strategies to come (the runtime ignores them).
  assets: [],
};

// old saved recipes load forever: fill in the fields their era lacked
export function migrateRecipe(recipe) {
  recipe.version ??= 2;
  recipe.derived ??= [];
  recipe.shapes ??= [];
  recipe.assets ??= [];
  return recipe;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// controls + derived, evaluated in order → the namespace every
// {expression} sees. Returns { vars } or { error }.
export function buildVars(recipe, controlValues) {
  const vars = { ...controlValues };
  for (const d of recipe.derived ?? []) {
    if (!ID_RE.test(d.id ?? '')) return { error: `derived value has a bad id "${d.id}"` };
    if (d.id in controlValues) return { error: `derived "${d.id}" clashes with a control of the same name` };
    const ex = expandTemplate(`{${d.expr}}`, vars);
    if (ex.error) return { error: `derived "${d.id}": ${ex.error}` };
    vars[d.id] = parseFloat(ex.value);
  }
  return { vars };
}

// Lower the shapes section once per weave: template-expand each path
// with the full namespace, then parse. Shapes always live in the SHARED
// frame (inches, y-flip, no recentering) — that is what makes an op
// referencing "arch" and a curve derived alongside it align by
// construction. Returns { shapes } or { error }.
export function buildShapes(recipe, vars) {
  const shapes = {};
  for (const s of recipe.shapes ?? []) {
    if (!ID_RE.test(s.id ?? '')) return { error: `shape has a bad id "${s.id}"` };
    const ex = expandTemplate(s.path ?? '', vars);
    if (ex.error) return { error: `shape "${s.id}": ${ex.error}` };
    if (s.open) {
      const c = pathToCurve(ex.value);
      if (c.error) return { error: `shape "${s.id}": ${c.error}` };
      shapes[s.id] = { kind: 'curve', polylines: c.polylines };
    } else {
      const r = pathToRegions(ex.value, {});   // anchored true-size
      if (r.error) return { error: `shape "${s.id}": ${r.error}` };
      shapes[s.id] = { kind: 'region', regions: r.regions };
    }
  }
  return { shapes };
}

export function controlDefaults(recipe) {
  const values = {};
  for (const c of recipe.controls) values[c.id] = c.default;
  return values;
}

function resolveParams(entry, params, controlValues, vars, errors, opId) {
  const out = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    let v = params?.[key];
    if (v && typeof v === 'object' && 'ctrl' in v) {
      if (!(v.ctrl in controlValues)) { errors.push(`op "${opId}": param ${key} bound to missing control "${v.ctrl}"`); continue; }
      v = controlValues[v.ctrl];
    }
    if (v === undefined || v === null || v === '') v = spec.default;
    if (v === undefined) { errors.push(`op "${opId}": required param ${key} missing`); continue; }
    // template params (spec.template) may hold {expressions} over the
    // controls + derived namespace — how a shape's internal geometry
    // binds to sliders. Opt-in per param spec: ordinary string params
    // (engraved text!) keep literal braces.
    if (spec.template && typeof v === 'string' && v.includes('{')) {
      const ex = expandTemplate(v, vars);
      if (ex.error) { errors.push(`op "${opId}": param ${key}: ${ex.error}`); continue; }
      v = ex.value;
    }
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
 * @param {Object} fonts  font id → ArrayBuffer (the loaded font shelf,
 *                        see fonts.mjs); strategies look up by param
 * @returns {{ ok, errors, warnings, report?, job?, sbp?, gcode?, preview }}
 */
export function runRecipe(recipe, controlValues, fonts) {
  const errors = [];
  const stock = recipe.stock;
  if (!recipe.pipeline.length) {
    return { ok: false, errors: ['the recipe has no operations yet — ask for something'], warnings: [], preview: { empty: true } };
  }

  // ---- namespace: controls + derived values, evaluated in order ----
  const bv = buildVars(recipe, controlValues);
  if (bv.error) {
    return { ok: false, errors: [bv.error], warnings: [], preview: { empty: true } };
  }
  const vars = bv.vars;

  const bs = buildShapes(recipe, vars);
  if (bs.error) {
    return { ok: false, errors: [bs.error], warnings: [], preview: { empty: true } };
  }

  const ctx = {
    fonts,
    vars,
    shapes: bs.shapes,
    stock: { thickness: stock.thickness },   // W×H not known until content runs
    safeZ: 0.5,
    rpm: 14000,
    contentBBox: null,
  };

  // ---- run each strategy in local coords, growing the content bbox ----
  const built = [];
  const strategyWarnings = [];
  for (const op of recipe.pipeline) {
    const entry = CATALOG[op.strategy];
    if (!entry) { errors.push(`unknown strategy "${op.strategy}"`); continue; }
    const p = resolveParams(entry, op.params, controlValues, vars, errors, op.id);
    if (errors.length) break;
    const r = entry.run(p, ctx);
    if (r.error) { errors.push(`op "${op.id}": ${r.error}`); break; }
    // a catalog verb may lower to SEVERAL machine operations (e.g. a bulk
    // pocket + a smaller-bit rest pass = two tools); each sub-op carries
    // its own tool, moves, and declared target
    for (const sub of (r.ops ?? [r])) {
      built.push({ op, r: sub });
      for (const w of sub.warnings ?? []) strategyWarnings.push(`op "${op.id}": ${w}`);
    }
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

  // ---- stock auto-sizes to the content: minimum board, quarter-inch
  // rounded, margins included. "Doesn't fit" cannot happen; the user is
  // told the minimum stock they must fixture instead.
  const b = ctx.contentBBox;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const margin = recipe.margin ?? 0.375;
  const roundQ = (x) => Math.ceil((x - 1e-9) / 0.25) * 0.25;
  const autoStock = {
    w: roundQ(w + 2 * margin),
    h: roundQ(h + 2 * margin),
    thickness: stock.thickness,
  };
  const placement = {
    x: (autoStock.w - w) / 2 - b.minX,
    y: (autoStock.h - h) / 2 - b.minY,
  };

  // ---- tool table: one entry per distinct tool spec, in first-use order ----
  const tools = {};
  const toolNumber = new Map();
  for (const { r } of built) {
    const key = `${r.tool.name}|${r.tool.diameter}`;
    if (!toolNumber.has(key)) {
      const n = toolNumber.size + 1;
      toolNumber.set(key, n);
      // kind/angleDeg ride along: the verifier's heightmap check models
      // the cutter (ball/vee/flat) from the tool table entry
      const t = { name: r.tool.name, diameter: r.tool.diameter };
      if (r.tool.kind) t.kind = r.tool.kind;
      if (r.tool.angleDeg) t.angleDeg = r.tool.angleDeg;
      tools[n] = t;
    }
  }

  const job = {
    units: 'in',
    stock: autoStock,
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
    warnings: [...strategyWarnings, ...report.warnings],
    report, job, composed,
    preview: { built, placement, stock: autoStock },
  };
  if (report.ok) {
    result.sbp = postJobToSbp(job, composed, { title: `Loom — ${recipe.name}` });
    result.gcode = postJobToGcode(job, composed, { title: `Loom — ${recipe.name}` });
  }
  return result;
}
