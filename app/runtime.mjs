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
import { expandTemplate, pathToRegions, pathToCurve, offsetRegions, booleanRegions, fitRegionsSnug } from './shape.mjs';
import { svgAssetToRegions } from './svg.mjs';
import { GLYPHS, glyphById } from './glyphs.mjs';
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
  // SVG assets are consumed via the shapes section ({ id, asset: {of,
  // width?, height?} }); raster images await the image strategies.
  assets: [],
  // terrain FETCH SPECS — references, not data: { id, query, bbox?:
  // {south, west, north, east}, zoom?, meta? }. The model authors the
  // query; the app resolves it in the BROWSER (geocode → public DEM
  // tiles) and pins the resolved bbox/zoom/meta back into the entry so
  // the document names an exact region from then on. The elevation grid
  // itself never enters the recipe — it is re-fetched (and cached) on
  // the user's own connection and handed to runRecipe as `terrains`.
  terrains: [],
};

// old saved recipes load forever: fill in the fields their era lacked
export function migrateRecipe(recipe) {
  recipe.version ??= 2;
  recipe.derived ??= [];
  recipe.shapes ??= [];
  recipe.assets ??= [];
  recipe.terrains ??= [];
  return recipe;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Artwork shapes (assets, glyphs) lower centered on the origin; optional
// posX/posY translate the placed piece so multi-element layouts (a sign's
// glyph above its text) don't stack everything at the same spot.
function placeArtwork(regions, spec, shapeId, num) {
  const off = { posX: 0, posY: 0 };
  for (const k of ['posX', 'posY']) {
    if (spec[k] === undefined || spec[k] === null || spec[k] === '') continue;
    const d = num(spec[k], k, shapeId);
    if (d.error) return d;
    off[k] = d.value;
  }
  if (!off.posX && !off.posY) return { regions };
  const mv = (ring) => ring.map(q => ({ x: q.x + off.posX, y: q.y + off.posY }));
  return { regions: regions.map(r => ({ outer: mv(r.outer), holes: r.holes.map(mv) })) };
}

// "h - t/2"-style expression evaluation against the controls + derived
// namespace (extras lose to a user's own ids). Guest strategies get this
// as ctx.evalNumber; the UI rebuilds the same closure for handoff hooks.
export function makeEvalNumber(vars) {
  return (v, extras = {}) => {
    if (typeof v === 'number') return { value: v };
    const src = String(v).trim().replace(/^\{([^{}]*)\}$/, '$1');
    const ex = expandTemplate(`{${src}}`, { ...extras, ...vars });
    if (ex.error) return { error: ex.error };
    return { value: parseFloat(ex.value) };
  };
}

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

// Lower the shapes section once per weave: template-expand with the
// full namespace, then parse (path shapes) or derive (algebra shapes:
// inset/outset/band/union/difference/intersect/fit over EARLIER shapes —
// document order is definition order). Shapes always live in the SHARED
// frame (inches, y-flip, no recentering) — that is what makes an op
// referencing "arch" and a curve derived alongside it align by
// construction. Each lowered shape carries `root`: the base path shape
// its derivation chain started from (itself for path shapes) — the
// lineage that lets a rabbet band and the cutout that consumes the same
// base shape be recognized as related. Returns { shapes, warnings } or
// { error }.
//
// `fit` derivations self-size around CONTENT, which does not exist until
// the pipeline runs — so with { defer: true } a fit entry (and anything
// derived from it) is left out of `shapes` and listed in `pending`;
// runRecipe resolves each via resolve(id, ctx) at the first op that
// references it, when content-so-far is exactly what it must wrap.
// Without defer (the intent layer's dry-run), fit resolves as the base
// at scale 1: structure and expressions are what validation checks.
export function buildShapes(recipe, vars, { defer = false } = {}) {
  const shapes = {};
  const warnings = [];
  const num = (v, what, id) => {
    if (typeof v === 'number') return { value: v };
    // "0.2", "rw", "r - t/2", and "{rw}" all work — the model writes
    // braces out of path habit, so strip an outer pair if present
    const src = String(v).trim().replace(/^\{([^{}]*)\}$/, '$1');
    const ex = expandTemplate(`{${src}}`, vars);
    if (ex.error) return { error: `shape "${id}" ${what}: ${ex.error}` };
    return { value: parseFloat(ex.value) };
  };
  const baseOf = (ref, id, what) => {
    const b = shapes[ref];
    if (!b) return { error: `shape "${id}": ${what} references "${ref}", which is not defined ABOVE it` };
    if (b.kind !== 'region') return { error: `shape "${id}": ${what} needs a closed shape, but "${ref}" is an open curve` };
    return { base: b };
  };
  // per-entry lowering; success mutates shapes/warnings, failure returns
  // { error }. ctx (content machined so far) is consulted only by fit.
  const lowerEntry = (s, ctx) => {
    if (s.path !== undefined) {
      const ex = expandTemplate(s.path ?? '', vars);
      if (ex.error) return { error: `shape "${s.id}": ${ex.error}` };
      if (s.open) {
        const c = pathToCurve(ex.value);
        if (c.error) return { error: `shape "${s.id}": ${c.error}` };
        shapes[s.id] = { kind: 'curve', polylines: c.polylines, root: s.id };
      } else {
        const r = pathToRegions(ex.value, {});   // anchored true-size
        if (r.error) return { error: `shape "${s.id}": ${r.error}` };
        shapes[s.id] = { kind: 'region', regions: r.regions, root: s.id };
      }
    } else if (s.asset) {
      // an UPLOADED SVG file as a shape: the filled artwork, welded and
      // sized, becomes ordinary region geometry — cutouts, pockets, and
      // along-derivations neither know nor care it came from a file
      const spec = s.asset;
      const asset = (recipe.assets ?? []).find(a => a.id === spec.of || a.name === spec.of);
      if (!asset) {
        const names = (recipe.assets ?? []).map(a => `"${a.name}"`).join(', ');
        return { error: `shape "${s.id}": no uploaded file "${spec.of}" — uploads: ${names || 'none'}` };
      }
      if (asset.kind !== 'svg') {
        return { error: `shape "${s.id}": "${asset.name}" is a raster image — only SVG uploads lower to shapes (image carving is not in the catalog yet)` };
      }
      const size = {};
      for (const k of ['width', 'height']) {
        if (spec[k] === undefined || spec[k] === null || spec[k] === '') continue;
        const d = num(spec[k], k, s.id);
        if (d.error) return d;
        size[k] = d.value;
      }
      const r = svgAssetToRegions(asset.data, size);
      if (r.error) return { error: `shape "${s.id}": ${r.error}` };
      warnings.push(...r.warnings.map(w => `shape "${s.id}" (${asset.name}): ${w}`));
      const placed = placeArtwork(r.regions, spec, s.id, num);
      if (placed.error) return placed;
      shapes[s.id] = { kind: 'region', regions: placed.regions, root: s.id };
    } else if (s.glyph) {
      // a BUILT-IN signage glyph (app/glyphs.mjs, the AIGA/DOT symbol
      // set): identical lowering to an uploaded SVG, no upload required.
      // Library entries are pre-curated region-native files — clean by
      // construction, so no warnings ride along.
      const spec = s.glyph;
      // `of` is a literal glyph id OR a {ctrl:"id"} binding to a choice
      // control (option values = glyph ids) — that's the glyph DROPDOWN:
      // picking re-lowers the shape and the whole sign updates live.
      let glyphId = spec.of;
      if (glyphId && typeof glyphId === 'object' && 'ctrl' in glyphId) {
        if (!(glyphId.ctrl in vars)) {
          return { error: `shape "${s.id}": glyph bound to missing control "${glyphId.ctrl}"` };
        }
        glyphId = vars[glyphId.ctrl];
      }
      const g = glyphById(glyphId);
      if (!g) {
        return { error: `shape "${s.id}": no built-in glyph "${glyphId}" — the library: ${GLYPHS.map(x => x.id).join(', ')}` };
      }
      const size = {};
      for (const k of ['width', 'height']) {
        if (spec[k] === undefined || spec[k] === null || spec[k] === '') continue;
        const d = num(spec[k], k, s.id);
        if (d.error) return d;
        size[k] = d.value;
      }
      if (size.width === undefined && size.height === undefined) size.width = 3;
      const r = svgAssetToRegions(g.svg, size);
      if (r.error) return { error: `shape "${s.id}": ${r.error}` };
      const placed = placeArtwork(r.regions, spec, s.id, num);
      if (placed.error) return placed;
      shapes[s.id] = { kind: 'region', regions: placed.regions, root: s.id };
    } else if (s.inset || s.outset) {
      const spec = s.inset ?? s.outset;
      const b = baseOf(spec.of, s.id, s.inset ? 'inset' : 'outset');
      if (b.error) return b;
      const d = num(spec.by, 'by', s.id);
      if (d.error) return d;
      const regions = offsetRegions(b.base.regions, s.inset ? -d.value : d.value);
      if (!regions.length) return { error: `shape "${s.id}": ${s.inset ? 'inset' : 'outset'} by ${d.value} leaves nothing of "${spec.of}"` };
      shapes[s.id] = { kind: 'region', regions, root: b.base.root };
    } else if (s.band) {
      const b = baseOf(s.band.of, s.id, 'band');
      if (b.error) return b;
      const w = num(s.band.width, 'width', s.id);
      if (w.error) return w;
      const ov = num(s.band.overrun ?? 0, 'overrun', s.id);
      if (ov.error) return ov;
      const outer = offsetRegions(b.base.regions, ov.value);
      const inner = offsetRegions(b.base.regions, -w.value);
      const diff = inner.length ? booleanRegions('difference', [outer, inner]) : { regions: outer };
      if (diff.error || !diff.regions.length) return { error: `shape "${s.id}": band of "${s.band.of}" is empty` };
      shapes[s.id] = { kind: 'region', regions: diff.regions, root: b.base.root };
    } else if (s.union || s.difference || s.intersect) {
      const op = s.union ? 'union' : s.difference ? 'difference' : 'intersect';
      const refs = s[op];
      if (!Array.isArray(refs) || refs.length < 2) return { error: `shape "${s.id}": ${op} needs a list of at least two shape ids` };
      const sets = [];
      for (const ref of refs) {
        const b = baseOf(ref, s.id, op);
        if (b.error) return b;
        sets.push(b.base.regions);
      }
      const out = booleanRegions(op, sets);
      if (out.error) return { error: `shape "${s.id}": ${out.error}` };
      if (!out.regions.length) return { error: `shape "${s.id}": ${op} of ${refs.join(', ')} is empty` };
      // boolean results have mixed ancestry; the first operand's root
      // stands in (difference keeps the body it carves from)
      shapes[s.id] = { kind: 'region', regions: out.regions, root: shapes[refs[0]].root };
    } else if (s.fit) {
      // self-sizing: scale the base uniformly about the ORIGIN until all
      // content clears its edge by margin — the tag_cutout ergonomic for
      // any outline. The base's absolute size is irrelevant; its CENTER
      // matters (content centers at the origin).
      const b = baseOf(s.fit.of, s.id, 'fit');
      if (b.error) return b;
      const m = num(s.fit.margin ?? 0, 'margin', s.id);
      if (m.error) return m;
      if (!(m.value >= 0)) return { error: `shape "${s.id}": fit margin must be a number ≥ 0` };
      if (!ctx) {
        // validation dry-run: content does not exist yet — the base at
        // scale 1 stands in; references and expressions are what's checked
        shapes[s.id] = { kind: 'region', regions: b.base.regions, root: b.base.root, fitted: true };
        return;
      }
      const pts = contentPoints(ctx);
      if (!pts.length) {
        return { error: `shape "${s.id}": fit has nothing to wrap yet — the operations it must contain (engraving, pockets, holes) go BEFORE the operation that references it` };
      }
      const f = fitRegionsSnug(b.base.regions, m.value, pts);
      if (f.error) return { error: `shape "${s.id}": fit of "${s.fit.of}" ${f.error}` };
      shapes[s.id] = { kind: 'region', regions: f.regions, root: b.base.root, fitted: true, scale: f.scale };
    } else {
      return { error: `shape "${s.id}" needs a path, an asset, or a derivation (inset/outset/band/union/difference/intersect/fit)` };
    }
  };

  const refsOf = (s) =>
    s.inset ? [s.inset.of]
    : s.outset ? [s.outset.of]
    : s.band ? [s.band.of]
    : s.fit ? [s.fit.of]
    : (s.union ?? s.difference ?? s.intersect ?? []);

  const pending = new Map();   // id → entry, waiting for content
  for (const s of recipe.shapes ?? []) {
    if (!ID_RE.test(s.id ?? '')) return { error: `shape has a bad id "${s.id}"` };
    const refs = refsOf(s);
    if (defer && (s.fit !== undefined || (Array.isArray(refs) && refs.some(r => pending.has(r))))) {
      pending.set(s.id, s);
      continue;
    }
    const e = lowerEntry(s, null);
    if (e?.error) return e;
  }

  // resolve one pending shape (and its pending dependencies, which are
  // earlier in document order) against the content machined so far
  const resolve = (id, ctx) => {
    const s = pending.get(id);
    if (!s) return null;
    const refs = refsOf(s);
    if (Array.isArray(refs)) {
      for (const r of refs) {
        const e = resolve(r, ctx);
        if (e) return e;
      }
    }
    const e = lowerEntry(s, ctx);
    if (e?.error) return e;
    pending.delete(id);
    return null;
  };

  return { shapes, warnings, pending, resolve };
}

// ---- frames: native verbs mounted inside guest geometry -------------
//
// An op may PUBLISH frames (`r.frames`: [{ id, cx, cy, rot, w, h }] —
// e.g. the furniture guest publishes each placed panel body), and any
// LATER op may carry `frame: "<id>"` at the op level. A framed op runs
// in a clean panel-local context (content centers on the panel face,
// place/posX/posY compose panel-locally), then its whole result —
// moves, target rings, previews — is rotated by `rot` and translated to
// (cx, cy), so everything downstream (compose, verify, sim) sees
// ordinary working-frame ops and the export gate is unchanged. A carve
// that strays off its panel overlaps the panel's own cuts and is
// REFUSED by the same footprint machinery that guards everything else.

function frameTransformers(frame) {
  const th = ((frame.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const pt = (q) => ({
    ...q,
    x: +(frame.cx + q.x * cos - q.y * sin).toFixed(6),
    y: +(frame.cy + q.x * sin + q.y * cos).toFixed(6),
  });
  const ring = (rr) => rr.map(pt);
  const region = (rg) => ({ ...rg, outer: ring(rg.outer), holes: (rg.holes ?? []).map(ring) });
  const moves = (arr) => {
    let last = { x: 0, y: 0 };   // ops open with a rapid XY, so this never leaks
    return arr.map((m) => {
      if (m.x === undefined && m.y === undefined) return { ...m };
      const x = m.x ?? last.x, y = m.y ?? last.y;
      last = { x, y };
      const out = { ...m, ...pt({ x, y }) };
      if (m.i !== undefined || m.j !== undefined) {
        // arc centers are relative vectors: rotate, don't translate;
        // rotation is proper so `cw` is preserved
        const i = m.i ?? 0, j = m.j ?? 0;
        out.i = +(i * cos - j * sin).toFixed(6);
        out.j = +(i * sin + j * cos).toFixed(6);
      }
      return out;
    });
  };
  return { pt, ring, region, moves };
}

// transform one strategy result into its frame, in place. Returns
// { error } for result shapes that can't ride a frame yet.
function applyFrame(r, frame, opId) {
  const t = frameTransformers(frame);
  for (const sub of (r.ops ?? [r])) {
    if (sub.target?.type === 'heightmap') {
      return { error: `"${opId}" machines a 3D surface — surface targets can't mount into a frame yet (texture on a panel is a future move); engraving and outline text work today` };
    }
    if (sub.moves) sub.moves = t.moves(sub.moves);
    if (sub.target?.rings) sub.target = { ...sub.target, rings: sub.target.rings.map(t.ring) };
    if (sub.previewRing) sub.previewRing = t.ring(sub.previewRing);
    if (sub.previewRegions) sub.previewRegions = sub.previewRegions.map(t.region);
    if (sub.previewVee) {
      sub.previewVee = {
        ...sub.previewVee,
        branches: sub.previewVee.branches.map((b) => b.map(t.pt)),
        regions: sub.previewVee.regions.map(t.region),
      };
    }
  }
  if (r.bbox) {
    const corners = [
      { x: r.bbox.minX, y: r.bbox.minY }, { x: r.bbox.maxX, y: r.bbox.minY },
      { x: r.bbox.minX, y: r.bbox.maxY }, { x: r.bbox.maxX, y: r.bbox.maxY },
    ].map(t.pt);
    r.bbox = {
      minX: Math.min(...corners.map((q) => q.x)), minY: Math.min(...corners.map((q) => q.y)),
      maxX: Math.max(...corners.map((q) => q.x)), maxY: Math.max(...corners.map((q) => q.y)),
    };
  }
  return null;
}

// every cut point the pipeline has produced so far — what a fit-derived
// shape must wrap. True outlines when strategies recorded them, bbox
// perimeter as the fallback (same preference order as the cutout's own
// fit check, which independently confirms the result).
function contentPoints(ctx) {
  if (ctx.contentRings?.length) return ctx.contentRings.flat();
  const b = ctx.contentBBox;
  if (!b) return [];
  const pts = [];
  const step = 0.05;
  for (let x = b.minX; x <= b.maxX + 1e-9; x += step) { pts.push({ x, y: b.minY }, { x, y: b.maxY }); }
  for (let y = b.minY; y <= b.maxY + 1e-9; y += step) { pts.push({ x: b.minX, y }, { x: b.maxX, y }); }
  return pts;
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
export function runRecipe(recipe, controlValues, fonts, terrains = {}) {
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

  const bs = buildShapes(recipe, vars, { defer: true });
  if (bs.error) {
    return { ok: false, errors: [bs.error], warnings: [], preview: { empty: true } };
  }
  // construction geometry for the preview (drawn even when an op fails,
  // so a fit conflict shows WHERE instead of a blank canvas), plus
  // authoring sanity warnings. fit-derived shapes are added as they
  // resolve mid-pipeline, so the array is filled by addOutline.
  const shapeOutlines = [];
  const shapesWarnings = bs.warnings;
  const outlined = new Set();
  const addOutline = (id, sh) => {
    outlined.add(id);
    const rings = sh.kind === 'region'
      ? sh.regions.flatMap(r => [r.outer, ...r.holes])
      : sh.polylines.map(p => p.points);
    shapeOutlines.push({ id, rings, open: sh.kind === 'curve' });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const q of ring) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const off = Math.hypot((minX + maxX) / 2, (minY + maxY) / 2);
    // shapes are authored in INCHES around the origin; both mistakes
    // below come from pasting an SVG-viewbox path unscaled. A viewbox
    // path sits ~0.7 spans off-origin; deliberate small offsets pass.
    if (off > Math.max(2, span * 0.5)) {
      shapesWarnings.push(`shape "${id}" is centered ${off.toFixed(1)}" from the origin — prior content centers AT the origin; author shapes around it`);
    }
  };
  for (const [id, sh] of Object.entries(bs.shapes)) addOutline(id, sh);

  const ctx = {
    fonts,
    vars,
    // resolved elevation grids keyed by terrain id ({ grid: {elev, cols,
    // rows}, meta }); terrainSpecs = the recipe's declared references, so
    // an entry can tell "unknown id" from "declared but not fetched yet"
    terrains,
    terrainSpecs: recipe.terrains ?? [],
    shapes: bs.shapes,
    stock: { thickness: stock.thickness },   // W×H not known until content runs
    safeZ: 0.5,
    rpm: 14000,
    contentBBox: null,
    evalNumber: makeEvalNumber(vars),
  };

  // ---- run each strategy in local coords, growing the content bbox ----
  const built = [];
  const strategyWarnings = [];
  // assembled-view data: an entry (guest furniture) may return `assembly`
  // alongside its ops — flat panels with sheet placements and world poses.
  // Collected op-level and handed to the preview; app/assembly3d.mjs
  // renders it as the parts rising out of the machined board.
  const assemblies = [];
  // published frames (id → {cx, cy, rot, w, h, ctx}) — see applyFrame above
  const frames = {};
  for (const op of recipe.pipeline) {
    const entry = CATALOG[op.strategy];
    if (!entry) { errors.push(`unknown strategy "${op.strategy}"`); continue; }
    const p = resolveParams(entry, op.params, controlValues, vars, errors, op.id);
    if (errors.length) break;
    // fit-derived shapes lower HERE, at first reference: the content
    // machined so far is exactly what they must wrap
    for (const v of Object.values(p)) {
      if (typeof v !== 'string' || !bs.pending.has(v)) continue;
      const e = bs.resolve(v, ctx);
      if (e) { errors.push(`op "${op.id}": ${e.error}`); break; }
    }
    if (errors.length) break;
    // framed ops run in the frame's own persistent context: content
    // centers on the panel face, and a second framed op on the SAME
    // panel sees the first as content-so-far (place:"below" stacks
    // panel-locally, exactly like it does on a sign)
    let frame = null;
    if (op.frame) {
      frame = frames[op.frame];
      if (!frame) {
        const have = Object.keys(frames);
        errors.push(`op "${op.id}": no frame "${op.frame}" — ${have.length
          ? `published frames: ${have.join(', ')}`
          : 'the operation that publishes frames (the furniture build) must come BEFORE this one'}`);
        break;
      }
      frame.ctx ??= { ...ctx, contentBBox: null, contentRings: [] };
    }
    const r = entry.run(p, frame ? frame.ctx : ctx);
    if (r.error) { errors.push(`op "${op.id}": ${r.error}`); break; }
    if (frame) {
      // panel-local extent accumulates BEFORE the transform (that is what
      // the next framed op on this panel must compose against)
      const lb = r.bbox;
      if (lb) {
        frame.ctx.contentBBox = frame.ctx.contentBBox
          ? {
              minX: Math.min(frame.ctx.contentBBox.minX, lb.minX), minY: Math.min(frame.ctx.contentBBox.minY, lb.minY),
              maxX: Math.max(frame.ctx.contentBBox.maxX, lb.maxX), maxY: Math.max(frame.ctx.contentBBox.maxY, lb.maxY),
            }
          : { ...lb };
        if (lb.maxX - lb.minX > frame.w + 1e-6 || lb.maxY - lb.minY > frame.h + 1e-6) {
          strategyWarnings.push(`op "${op.id}": the content (${(lb.maxX - lb.minX).toFixed(1)}" × ${(lb.maxY - lb.minY).toFixed(1)}") overflows the "${op.frame}" panel (${frame.w}" × ${frame.h}") — it will cross the panel's own cuts and be refused`);
        }
      }
      const fe = applyFrame(r, frame, op.id);
      if (fe) { errors.push(`op "${op.id}": ${fe.error}`); break; }
    }
    if (r.assembly) assemblies.push({ opId: op.id, ...r.assembly });
    for (const f of r.frames ?? []) frames[f.id] = { ...f };
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
  // shapes resolved mid-pipeline (fit chains) join the construction
  // preview — on failure too, so a bad fit still shows where it landed
  for (const [id, sh] of Object.entries(bs.shapes)) {
    if (!outlined.has(id)) addOutline(id, sh);
  }
  if (errors.length || !built.length) {
    // degrade gracefully: the JOB is refused, but the user still gets a
    // picture. Preview whatever built before the failure plus the
    // construction shapes — a fit conflict then shows WHERE.
    // diagnostic extent = built content UNION the shapes section, so a
    // misplaced shape and the content it missed are both in frame
    let bb = ctx.contentBBox ? { ...ctx.contentBBox } : null;
    if (shapeOutlines.length) {
      bb ??= { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const so of shapeOutlines) for (const ring of so.rings) for (const q of ring) {
        bb.minX = Math.min(bb.minX, q.x); bb.maxX = Math.max(bb.maxX, q.x);
        bb.minY = Math.min(bb.minY, q.y); bb.maxY = Math.max(bb.maxY, q.y);
      }
    }
    if (!bb) {
      return { ok: false, errors: errors.length ? errors : ['nothing to machine'], warnings: [...shapesWarnings], preview: { empty: true } };
    }
    const margin = recipe.margin ?? 0.375;
    const failStock = {
      w: Math.max(1, bb.maxX - bb.minX + 2 * margin),
      h: Math.max(1, bb.maxY - bb.minY + 2 * margin),
      thickness: stock.thickness,
    };
    const failPlace = {
      x: (failStock.w - (bb.maxX - bb.minX)) / 2 - bb.minX,
      y: (failStock.h - (bb.maxY - bb.minY)) / 2 - bb.minY,
    };
    return {
      ok: false,
      errors: errors.length ? errors : ['nothing to machine'],
      warnings: [...shapesWarnings, ...strategyWarnings],
      preview: { built, placement: failPlace, stock: failStock, shapeOutlines, failed: true },
    };
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

  // scoped overlap allowances: an edge treatment derived from shape X
  // may overlap ONLY the ops that cut X free — the verifier still flags
  // it against anything unrelated (the blanket allowOverlap flag is the
  // legacy fallback for edge treatments with no shape lineage)
  built.forEach(({ r: a }, i) => {
    if (!a.edgeScopeRoot) return;
    const names = built
      .map(({ r: b }, j) => (j !== i && b.cutsRoot === a.edgeScopeRoot ? job.operations[j].name : null))
      .filter(Boolean);
    if (names.length) job.operations[i].allowOverlapWith = names;
    else job.operations[i].allowOverlap = true;   // no cutout consumes it (yet) — fall back
  });

  // a shop-scale sanity check: a shape pasted from a 100-unit SVG
  // viewbox comes out 100 INCHES wide, verifies honestly, and previews
  // as a giant blank-looking board — say so. The viewbox lesson only
  // applies when there ARE authored shapes; big furniture is just big.
  if (autoStock.w > 60 || autoStock.h > 60) {
    const hint = recipe.shapes?.length
      ? ' — shapes are authored in INCHES; a path pasted from an SVG viewbox unscaled comes out viewbox-units wide'
      : '';
    shapesWarnings.push(`this part needs a ${autoStock.w}" × ${autoStock.h}" board${hint}`);
  }

  const composed = composeJob(job);
  // coverage residual is meaningless for line engraving (see engraver notes);
  // gouge/depth/intrusion stay hard errors.
  const report = verifyJob(job, composed, { coverageWarnPct: 100 });

  const result = {
    ok: report.ok,
    errors: report.errors,
    warnings: [...shapesWarnings, ...strategyWarnings, ...report.warnings],
    report, job, composed,
    preview: { built, placement, stock: autoStock, shapeOutlines, assemblies },
  };
  if (report.ok) {
    result.sbp = postJobToSbp(job, composed, { title: `Loom — ${recipe.name}` });
    result.gcode = postJobToGcode(job, composed, { title: `Loom — ${recipe.name}` });
  }
  return result;
}
