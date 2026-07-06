// The intent layer of the Loom app — the ONLY place an LLM touches the
// pipeline, and it never emits code or motion: it emits recipe-CRUD
// actions, validated here against the catalog, applied to a recipe
// DOCUMENT, and then run through the same generate→verify gate as a
// slider drag. Open intake, narrow fulfillment: anything the catalog
// can't express must arrive on the `declined` channel (that's the gap
// report that grows the catalog).
//
// DOM-free and side-effect-free: usable from tests, the browser app, or
// a future server proxy.

import { CATALOG, catalogDoc } from './catalog.mjs';
import { expandTemplate } from './shape.mjs';
import { buildVars, buildShapes } from './runtime.mjs';

// ---------------------------------------------------------------- schema

export const ACTION_TOOL = {
  name: 'apply_recipe_actions',
  description: 'Apply edits to the Loom recipe document, and/or decline out-of-scope requests.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence, user-facing, of what was done (and what was declined).' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['set_name', 'set_thickness', 'add_control', 'set_control', 'remove_control', 'set_derived', 'remove_derived', 'set_shape', 'remove_shape', 'add_operation', 'set_operation', 'remove_operation'] },
            name: { type: 'string', description: 'set_name: the new recipe/app name' },
            thickness: { type: 'number', description: 'set_thickness: the stock material thickness, inches (through-cuts use it)' },
            control: {
              type: 'object', description: 'add_control / set_control',
              properties: {
                id: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'choice'] },
                label: { type: 'string' }, default: {},
                min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' },
                options: {
                  type: 'array', description: 'choice controls only: the selectable values',
                  items: {
                    type: 'object',
                    properties: { value: { type: 'string' }, label: { type: 'string' } },
                    required: ['value'],
                  },
                },
              },
            },
            operation: {
              type: 'object', description: 'add_operation / set_operation',
              properties: {
                id: { type: 'string' },
                strategy: { type: 'string' },
                params: { type: 'object', description: 'literal values, or {"ctrl":"controlId"} bindings' },
                after: { type: 'string', description: 'optional op id to insert after (add_operation)' },
              },
            },
            derived: {
              type: 'object', description: 'set_derived: a named intermediate value, usable as {id} in any expression',
              properties: {
                id: { type: 'string', description: 'the name (letters/digits/_, not a control id)' },
                expr: { type: 'string', description: 'arithmetic over controls and EARLIER derived ids, e.g. "r - t/2"' },
              },
              required: ['id', 'expr'],
            },
            shape: {
              type: 'object', description: 'set_shape: named geometry in the SHARED frame (inches, {arithmetic} allowed), referenced by ops via shape/along params. Give a path, an asset, OR exactly one derivation over EARLIER shapes: inset/outset (offset), band (edge band: outset by overrun minus inset by width — whole-rim rabbets, frames), union/difference/intersect.',
              properties: {
                id: { type: 'string', description: 'the name (letters/digits/_)' },
                path: { type: 'string', description: 'SVG path "d" string; coordinates are INCHES centered on the origin (rescale viewbox paths yourself — a 0..100 box would be a 100-inch part); {arithmetic} of controls/derived allowed' },
                open: { type: 'boolean', description: 'path only: true = an open CURVE (for hole patterns along it), false/absent = a closed outline' },
                asset: {
                  type: 'object', description: 'derive the shape from an UPLOADED SVG asset: its filled artwork, welded and centered on the origin (strokes/text/images inside the file are skipped)',
                  properties: {
                    of: { type: 'string', description: 'the asset name exactly as listed under UPLOADED ASSETS' },
                    width: { type: 'string', description: 'target width in INCHES — a number or {arithmetic} of controls (bind a size control so the user can scale it); omit width AND height to use the file\'s own declared physical size' },
                    height: { type: 'string', description: 'target height, inches; width alone keeps aspect, both stretch' },
                  },
                  required: ['of'],
                },
                inset: { type: 'object', properties: { of: { type: 'string' }, by: { type: 'string', description: 'inches or {arithmetic}' } }, required: ['of', 'by'] },
                outset: { type: 'object', properties: { of: { type: 'string' }, by: { type: 'string' } }, required: ['of', 'by'] },
                band: { type: 'object', description: 'edge band hugging a shape\'s whole outline', properties: { of: { type: 'string' }, width: { type: 'string', description: 'band width into the shape, inches or {arithmetic}' }, overrun: { type: 'string', description: 'overhang past the edge, inches (default 0; use ~0.05 for edge treatments)' } }, required: ['of', 'width'] },
                union: { type: 'array', items: { type: 'string' }, description: 'shape ids to merge' },
                difference: { type: 'array', items: { type: 'string' }, description: 'first shape minus the rest' },
                intersect: { type: 'array', items: { type: 'string' } },
              },
              required: ['id'],
            },
            id: { type: 'string', description: 'remove_control / remove_derived / remove_operation / set_*: the target id' },
          },
          required: ['kind'],
        },
      },
      declined: {
        type: 'array',
        description: 'Requests (or parts of requests) the catalog cannot fulfill.',
        items: {
          type: 'object',
          properties: {
            what: { type: 'string', description: 'the specific thing asked for' },
            why: { type: 'string', description: 'which capability is missing' },
          },
          required: ['what', 'why'],
        },
      },
    },
    required: ['summary', 'actions', 'declined'],
  },
};

// ------------------------------------------------------- grounding prompt

// The recipe as shown to the model: asset payloads (base64 images, svg
// text) are replaced by a byte count — they would drown the prompt and the
// model has no use for the bytes (it references assets by name/id only).
export function promptRecipeView(recipe) {
  if (!recipe.assets?.length) return recipe;
  return {
    ...recipe,
    assets: recipe.assets.map(a => ({ ...a, data: `<${a.data?.length ?? 0} chars omitted>` })),
  };
}

export function buildSystemPrompt(recipe) {
  const assetSection = recipe.assets?.length
    ? `\n\nUPLOADED ASSETS (embedded in the recipe document; reference by NAME, never by content — the bytes are not shown to you):\n${recipe.assets.map(a => `- "${a.name}" (${a.kind}${a.width ? `, ${a.width}×${a.height}px` : ''})`).join('\n')}
An SVG asset IS usable as a shape: set_shape with asset {of: "<name>", width: <inches or {arithmetic}>} lowers the file's FILLED artwork to a closed outline in the shared frame (strokes, text, and embedded images inside the file are skipped with warnings). Reference that shape id from shape_cutout (cut the logo out), pocket_shape (recess it), or bore_hole's along (holes around its outline). Bind width to a size control when the user might rescale it. A raster IMAGE (png/jpeg photo) is NOT usable: if the user asks to carve/engrave/trace one, DECLINE that part — what: the image use, why: "raster image carving is not in the catalog yet; the upload is stored for when it arrives" — and still apply the rest of the request.`
    : '';
  return `You edit a "recipe" — the declarative document behind a small CNC app. The user speaks; you emit recipe actions via the apply_recipe_actions tool. You NEVER write code, G-code, or toolpaths: strategies below do the machining and an independent verifier gates every export.

AVAILABLE STRATEGIES (the complete list — nothing else exists):
${catalogDoc()}${assetSection}

RULES:
- Only these strategies and their listed params. A request needing anything else (raster images/photos, other fonts, STL models, rotated text, ROUNDED-over edges — chamfer cuts a flat 45° face, not a roundover...) goes on the declined channel with what+why. Partial fulfillment is good: apply what you can, decline the rest.
- Quantities a user would tweak (their text, letter height, tag buffer...) should be BOUND to controls ({"ctrl":"id"}), creating the control if needed with a sensible label/default/min/max. One control may feed several ops. A param that picks from a fixed set (the font) binds to a "choice" control whose options are the allowed values (use the ids as values and friendlier labels).
- Params marked bindable are the usual candidates; other params are usually literals.
- Operation order is machining order: engraving, pockets, dishes, and holes first, any cutout (tag_cutout, disc_cutout, shape_cutout) LAST — the cutout frees the part. A hole positioned "above"/"corners" etc. must come BEFORE the cutout so the tag wraps around it.
- An outline the catalog does not name (ellipse, star, heart, arch, hexagon, shield…) is NOT a decline: AUTHOR it yourself as an SVG path via shape_cutout (or pocket_shape with shape "custom") — the path authoring rules are in shape_cutout's doc.
- A shape whose OWN dimensions must be adjustable ("an arch with adjustable thickness and radius") is also NOT a decline: write {arithmetic} of number-control ids inside the path with width/height 0 — the arch example is in shape_cutout's doc. Such dimensions (band thickness, radius…) are recipe controls; set_thickness is ONLY for the stock material.
- Name intermediate values ONCE with set_derived (e.g. m = "r - t/2", innerR = "r - t") and write {m}, {innerR} everywhere — do this whenever an expression would repeat across params or operations. Derived values may reference controls and earlier derived ids; they are recomputed on every slider move.
- Define geometry ONCE with set_shape and reference it by id: closed outlines feed shape_cutout's shape param / pocket_shape's shape param; open curves (open: true) feed bore_hole's along param. Shapes live in the SHARED frame and re-lower on every slider move. CRITICAL: shape coordinates are INCHES, CENTERED ON THE ORIGIN (where prior content like engraved text centers). NEVER paste an SVG-viewbox path unscaled — a heart in a 0..100 box becomes a 100-INCH part 50 inches off-center. A 3" heart spans roughly -1.5..1.5 around the origin; rescale and re-center the coordinates yourself (or use {arithmetic} of a size control) before authoring the path. The parametric arch app in full: derived inner="r-t", mid="r-t/2"; shape arch = "M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z"; shape centerline (open) = "M {-mid} 0 A {mid} {mid} 0 0 1 {mid} 0"; ops: bore_hole along "centerline" count 5, then shape_cutout shape "arch".
- Shapes can also be DERIVED from earlier shapes instead of authored: inset/outset {of, by} (offset), band {of, width, overrun} (a band hugging the whole outline — frames, whole-rim rabbets and ledges: pocket the band with edgeTreatment true before the cutout of the same base shape), union/difference/intersect [ids]. Derivations are computed geometry — prefer them over re-authoring offset outlines by hand.
- A RABBET / ledge / stepped edge along a cutout's edge is also NOT a decline: whole-rim = a band-derived shape pocketed with edgeTreatment true; a PARTIAL edge (one side only) = a pocket_shape "custom" band you author hugging that edge — the recipe is in pocket_shape's doc.
- A PATTERN of holes (a row of five, a bolt circle, holes along an arc) is NOT a decline: bore_hole's "along" spaces count holes evenly by arc length on any shape (open curve end-to-end, closed outline all the way around); "at" takes explicit centers for irregular layouts.
- Keep ids short and meaningful (e.g. "engrave", "cutout"). Use set_operation with a partial params object to change an existing op's parameters. set_operation may also include a different "strategy" to CONVERT the op (e.g. a rectangular tag_cutout into a disc_cutout) — its params are then replaced by the ones you provide. Use remove_operation only when the user wants the operation gone.
- If the recipe is empty and the user asks for an app, also set_name it.
- Stock WIDTH and HEIGHT are AUTO-SIZED from the content (plus margins) and shown to the user as the minimum board they need — you cannot and need not set them. Stock THICKNESS is ${JSON.stringify(recipe.stock.thickness)}" — set_thickness when the user names a material thickness; through-cuts cut exactly through it.

CURRENT RECIPE:
${JSON.stringify(promptRecipeView(recipe), null, 1)}`;
}

export function buildParseRequest(recipe, utterance, { model = 'claude-opus-4-8' } = {}) {
  return {
    model,
    max_tokens: 2000,
    system: buildSystemPrompt(recipe),
    messages: [{ role: 'user', content: utterance }],
    tools: [ACTION_TOOL],
    tool_choice: { type: 'tool', name: 'apply_recipe_actions' },
  };
}

// ------------------------------------------------------------------ apply
//
// Validates each action against the catalog and the evolving recipe;
// invalid actions are skipped with a reason (never a throw — the model's
// output is data, not trusted code). Returns a NEW recipe.

export function applyActions(recipe, payload) {
  const next = structuredClone(recipe);
  const applied = [], skipped = [];
  const ctrlIds = () => new Set(next.controls.map(c => c.id));
  const opIds = () => new Set(next.pipeline.map(o => o.id));

  const validParams = (strategy, params, forbidUnknown = true) => {
    const entry = CATALOG[strategy];
    const out = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      if (!(k in entry.params)) { if (forbidUnknown) return { bad: `unknown param "${k}" for ${strategy}` }; continue; }
      if (v && typeof v === 'object' && 'ctrl' in v && !ctrlIds().has(v.ctrl)) {
        return { bad: `param "${k}" bound to missing control "${v.ctrl}"` };
      }
      out[k] = v;
    }
    return { out };
  };

  for (const a of payload.actions ?? []) {
    switch (a.kind) {
      case 'set_name':
        if (typeof a.name === 'string' && a.name.trim()) { next.name = a.name.trim(); applied.push(`named it "${next.name}"`); }
        else skipped.push('set_name: no name');
        break;
      case 'set_thickness': {
        if (typeof a.thickness === 'number' && a.thickness > 0) {
          next.stock.thickness = a.thickness;
          applied.push(`stock thickness ${a.thickness}"`);
        } else skipped.push('set_thickness: no thickness');
        break;
      }
      case 'add_control': {
        const c = a.control;
        if (!c?.id || !['text', 'number', 'choice'].includes(c.type)) { skipped.push('add_control: bad control'); break; }
        if (ctrlIds().has(c.id)) { skipped.push(`add_control: "${c.id}" exists`); break; }
        let options;
        if (c.type === 'choice') {
          options = (c.options ?? []).filter(o => o && typeof o.value === 'string' && o.value);
          if (!options.length) { skipped.push(`add_control "${c.id}": choice control needs options`); break; }
        }
        const fallback = c.type === 'text' ? '' : c.type === 'choice' ? options[0].value : 0;
        let dflt = c.default ?? fallback;
        if (c.type === 'choice' && !options.some(o => o.value === dflt)) dflt = options[0].value;
        next.controls.push({ id: c.id, type: c.type, label: c.label ?? c.id, default: dflt, min: c.min, max: c.max, step: c.step, options });
        applied.push(`control "${c.id}"`);
        break;
      }
      case 'set_control': {
        const c = next.controls.find(x => x.id === (a.control?.id ?? a.id));
        if (!c) { skipped.push(`set_control: no "${a.control?.id ?? a.id}"`); break; }
        for (const k of ['label', 'default', 'min', 'max', 'step']) if (a.control?.[k] !== undefined) c[k] = a.control[k];
        if (c.type === 'choice' && a.control?.options !== undefined) {
          const options = (a.control.options ?? []).filter(o => o && typeof o.value === 'string' && o.value);
          if (options.length) {
            c.options = options;
            if (!options.some(o => o.value === c.default)) c.default = options[0].value;
          }
        }
        applied.push(`control "${c.id}" updated`);
        break;
      }
      case 'remove_control': {
        const used = next.pipeline.some(o => Object.values(o.params ?? {}).some(v => v && typeof v === 'object' && v.ctrl === a.id));
        if (used) { skipped.push(`remove_control: "${a.id}" still bound to an operation`); break; }
        const before = next.controls.length;
        next.controls = next.controls.filter(c => c.id !== a.id);
        before === next.controls.length ? skipped.push(`remove_control: no "${a.id}"`) : applied.push(`removed control "${a.id}"`);
        break;
      }
      case 'set_derived': {
        const d = a.derived;
        if (!d?.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.id) || typeof d.expr !== 'string' || !d.expr.trim()) {
          skipped.push('set_derived: needs an id (letters/digits/_) and an expr'); break;
        }
        if (ctrlIds().has(d.id)) { skipped.push(`set_derived: "${d.id}" is already a control`); break; }
        // dry-evaluate the FINAL chain in stored order against control
        // defaults, so a broken expression is skipped here, not at weave
        next.derived ??= [];
        const existing = next.derived.find(x => x.id === d.id);
        const finalChain = existing
          ? next.derived.map(x => (x.id === d.id ? { id: d.id, expr: d.expr } : x))
          : [...next.derived, { id: d.id, expr: d.expr }];
        const probe = {};
        for (const c of next.controls) probe[c.id] = c.default;
        let bad = null;
        for (const x of finalChain) {
          const ex = expandTemplate(`{${x.expr}}`, probe);
          if (ex.error && x.id === d.id) { bad = ex.error; break; }
          probe[x.id] = ex.error ? NaN : parseFloat(ex.value);
        }
        if (bad) { skipped.push(`set_derived "${d.id}": ${bad}`); break; }
        if (existing) existing.expr = d.expr;
        else next.derived.push({ id: d.id, expr: d.expr });
        applied.push(`derived "${d.id}" = ${d.expr}`);
        break;
      }
      case 'remove_derived': {
        next.derived ??= [];
        const usedBy = next.derived.some(x => x.id !== a.id && new RegExp(`\\b${a.id}\\b`).test(x.expr));
        if (usedBy) { skipped.push(`remove_derived: "${a.id}" is referenced by another derived value`); break; }
        const before = next.derived.length;
        next.derived = next.derived.filter(x => x.id !== a.id);
        before === next.derived.length ? skipped.push(`remove_derived: no "${a.id}"`) : applied.push(`removed derived "${a.id}"`);
        break;
      }
      case 'set_shape': {
        const s = a.shape;
        if (!s?.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.id)) {
          skipped.push('set_shape: needs an id (letters/digits/_)'); break;
        }
        // the stored entry: a path, an asset, or exactly one derivation
        const forms = ['path', 'asset', 'inset', 'outset', 'band', 'union', 'difference', 'intersect'].filter(k => s[k] !== undefined);
        if (forms.length !== 1) {
          skipped.push(`set_shape "${s.id}": give a path, an asset, OR one derivation (inset/outset/band/union/difference/intersect)`); break;
        }
        const entry = { id: s.id, [forms[0]]: s[forms[0]], ...(forms[0] === 'path' && s.open ? { open: true } : {}) };
        // dry-lower the FINAL shapes list through the real buildShapes so
        // a broken path/derivation is skipped here with a reason
        next.shapes ??= [];
        const finalShapes = next.shapes.some(x => x.id === s.id)
          ? next.shapes.map(x => (x.id === s.id ? entry : x))
          : [...next.shapes, entry];
        const probeVals = {};
        for (const c of next.controls) probeVals[c.id] = c.default;
        const bv = buildVars({ derived: next.derived ?? [] }, probeVals);
        if (bv.error) { skipped.push(`set_shape "${s.id}": ${bv.error}`); break; }
        // assets ride along: an asset-derived shape dry-lowers the real
        // uploaded file, so a wrong name or an unusable file skips HERE
        const bs = buildShapes({ shapes: finalShapes, assets: next.assets ?? [] }, bv.vars);
        if (bs.error) { skipped.push(`set_shape "${s.id}": ${bs.error}`); break; }
        next.shapes = finalShapes;
        applied.push(`shape "${s.id}" (${forms[0] === 'path' ? (s.open ? 'curve' : 'outline') : forms[0]})`);
        break;
      }
      case 'remove_shape': {
        next.shapes ??= [];
        const used = next.pipeline.some(o =>
          o.params && (o.params.shape === a.id || o.params.along === a.id));
        if (used) { skipped.push(`remove_shape: "${a.id}" is still referenced by an operation`); break; }
        const usedByShape = next.shapes.some(x => x.id !== a.id && (
          x.inset?.of === a.id || x.outset?.of === a.id || x.band?.of === a.id
          || x.union?.includes(a.id) || x.difference?.includes(a.id) || x.intersect?.includes(a.id)));
        if (usedByShape) { skipped.push(`remove_shape: "${a.id}" is referenced by another shape's derivation`); break; }
        const before = next.shapes.length;
        next.shapes = next.shapes.filter(x => x.id !== a.id);
        before === next.shapes.length ? skipped.push(`remove_shape: no "${a.id}"`) : applied.push(`removed shape "${a.id}"`);
        break;
      }
      case 'add_operation': {
        const o = a.operation;
        if (!o?.id || !CATALOG[o.strategy]) { skipped.push(`add_operation: unknown strategy "${o?.strategy}"`); break; }
        if (opIds().has(o.id)) { skipped.push(`add_operation: "${o.id}" exists`); break; }
        const vp = validParams(o.strategy, o.params);
        if (vp.bad) { skipped.push(`add_operation "${o.id}": ${vp.bad}`); break; }
        const op = { id: o.id, strategy: o.strategy, params: vp.out };
        const idx = o.after ? next.pipeline.findIndex(x => x.id === o.after) : -1;
        idx >= 0 ? next.pipeline.splice(idx + 1, 0, op) : next.pipeline.push(op);
        applied.push(`operation "${o.id}" (${o.strategy})`);
        break;
      }
      case 'set_operation': {
        const op = next.pipeline.find(x => x.id === (a.operation?.id ?? a.id));
        if (!op) { skipped.push(`set_operation: no "${a.operation?.id ?? a.id}"`); break; }
        const newStrategy = a.operation?.strategy;
        if (newStrategy && newStrategy !== op.strategy) {
          // converting an op to a different strategy: params are REPLACED,
          // not merged — the old strategy's params don't belong to the new one
          if (!CATALOG[newStrategy]) { skipped.push(`set_operation "${op.id}": unknown strategy "${newStrategy}"`); break; }
          const vp = validParams(newStrategy, a.operation?.params);
          if (vp.bad) { skipped.push(`set_operation "${op.id}": ${vp.bad}`); break; }
          op.strategy = newStrategy;
          op.params = vp.out;
          applied.push(`operation "${op.id}" converted to ${newStrategy}`);
          break;
        }
        const vp = validParams(op.strategy, a.operation?.params);
        if (vp.bad) { skipped.push(`set_operation "${op.id}": ${vp.bad}`); break; }
        op.params = { ...op.params, ...vp.out };
        applied.push(`operation "${op.id}" updated`);
        break;
      }
      case 'remove_operation': {
        const before = next.pipeline.length;
        next.pipeline = next.pipeline.filter(o => o.id !== a.id);
        before === next.pipeline.length ? skipped.push(`remove_operation: no "${a.id}"`) : applied.push(`removed operation "${a.id}"`);
        break;
      }
      default:
        skipped.push(`unknown action kind "${a.kind}"`);
    }
  }
  return { recipe: next, applied, skipped, declined: payload.declined ?? [], summary: payload.summary ?? '' };
}
