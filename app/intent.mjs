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
            kind: { type: 'string', enum: ['set_name', 'set_thickness', 'add_control', 'set_control', 'remove_control', 'add_operation', 'set_operation', 'remove_operation'] },
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
            id: { type: 'string', description: 'remove_control / remove_operation / set_*: the target id' },
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
    ? `\n\nUPLOADED ASSETS (embedded in the recipe document, but NOT yet usable: no strategy in the catalog can carve images or graphics yet. If the user asks to engrave/carve/trace one, DECLINE that part — what: the asset use, why: "image/graphic strategies are not in the catalog yet; the upload is stored and ready for when they arrive" — and still apply any other part of the request):\n${recipe.assets.map(a => `- "${a.name}" (${a.kind}${a.width ? `, ${a.width}×${a.height}px` : ''})`).join('\n')}`
    : '';
  return `You edit a "recipe" — the declarative document behind a small CNC app. The user speaks; you emit recipe actions via the apply_recipe_actions tool. You NEVER write code, G-code, or toolpaths: strategies below do the machining and an independent verifier gates every export.

AVAILABLE STRATEGIES (the complete list — nothing else exists):
${catalogDoc()}${assetSection}

RULES:
- Only these strategies and their listed params. A request needing anything else (images, other fonts, STL models, rotated text, ROUNDED-over edges — chamfer cuts a flat 45° face, not a roundover...) goes on the declined channel with what+why. Partial fulfillment is good: apply what you can, decline the rest.
- Quantities a user would tweak (their text, letter height, tag buffer...) should be BOUND to controls ({"ctrl":"id"}), creating the control if needed with a sensible label/default/min/max. One control may feed several ops. A param that picks from a fixed set (the font) binds to a "choice" control whose options are the allowed values (use the ids as values and friendlier labels).
- Params marked bindable are the usual candidates; other params are usually literals.
- Operation order is machining order: engraving, pockets, dishes, and holes first, any cutout (tag_cutout, disc_cutout, shape_cutout) LAST — the cutout frees the part. A hole positioned "above"/"corners" etc. must come BEFORE the cutout so the tag wraps around it.
- An outline the catalog does not name (ellipse, star, heart, arch, hexagon, shield…) is NOT a decline: AUTHOR it yourself as an SVG path via shape_cutout (or pocket_shape with shape "custom") — the path authoring rules are in shape_cutout's doc.
- A shape whose OWN dimensions must be adjustable ("an arch with adjustable thickness and radius") is also NOT a decline: write {arithmetic} of number-control ids inside the path with width/height 0 — the arch example is in shape_cutout's doc. Such dimensions (band thickness, radius…) are recipe controls; set_thickness is ONLY for the stock material.
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
