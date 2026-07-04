// Intent layer, step app parser — the schema contract and system prompt.
//
// The deploy boundary is the top rail of the hourglass: the LLM's ONLY job
// is NL → this schema. It never touches geometry, motion, or post — the
// app's deterministic apply layer (step_toolpath_app/modules/intent-apply.js)
// validates every action against current state, buildJob plans, and the
// verifier gates the result exactly as if the user had clicked the form.
//
// Open intake, narrow fulfillment: the model accepts any English request,
// fulfills only what maps onto the action menu below, and routes the rest
// to `declined` with an honest reason. Declines are product signal (the
// contributor backlog), not failures — never force a bad mapping.
//
// Grounding rule: feature ids MUST come from the FEATURES list in the
// request context. The model never invents ids, params outside the enum,
// or bit sizes not in BIT_OPTIONS.
//
// Structured-outputs constraints honored here: additionalProperties:false
// on every object, no numeric min/max (the apply layer clamps), no
// recursion, discriminator via const `type`.

const setParam = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name', 'value'],
  properties: {
    type: { const: 'set_param' },
    name: {
      type: 'string',
      enum: ['bitDiameter', 'depthPerPass', 'feedRate', 'plungeRate', 'rpm', 'safeZ', 'stockThickness'],
    },
    value: { type: 'number', description: 'In the display units given in context — EXCEPT bitDiameter, which is always inches and must be one of BIT_OPTIONS.' },
  },
};

const selectFeatures = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'ids', 'selected'],
  properties: {
    type: { const: 'select_features' },
    ids: { type: 'array', items: { type: 'integer' }, description: 'Feature ids from the FEATURES list only.' },
    selected: { type: 'boolean' },
  },
};

const setVeeBits = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'bits'],
  properties: {
    type: { const: 'set_vee_bits' },
    bits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angleDeg', 'diameter'],
        properties: {
          angleDeg: { type: 'number', description: 'Included angle of the V-bit, degrees.' },
          diameter: { type: 'number', description: 'V-bit diameter, inches.' },
        },
      },
    },
  },
};

const addRimChamfer = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'width', 'angleDeg'],
  properties: {
    type: { const: 'add_rim_chamfer' },
    width: { type: 'number', description: 'Horizontal leg of the chamfer in display units.' },
    angleDeg: { type: 'number', description: 'Face angle from horizontal, degrees (45 = standard).' },
  },
};

export const STEP_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions', 'declined'],
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences, in plain shop language, stating what will be done. Shown to the user before anything is applied.',
    },
    actions: {
      type: 'array',
      items: { anyOf: [setParam, selectFeatures, setVeeBits, addRimChamfer] },
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['request', 'reason'],
        properties: {
          request: { type: 'string', description: 'The part of the user\'s request being declined, paraphrased.' },
          reason: { type: 'string', description: 'Honest, specific reason it is outside this app\'s menu.' },
        },
      },
    },
  },
};

// The complete Messages API request body for one parse — single source of
// truth for BOTH callers: the server proxy (seams/intent/server.js, shop
// key) and the browser's BYO-key path (the user's own Anthropic account,
// called directly from the page so the key never touches our server).
export function buildParseRequest(utterance, context) {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    // a parse is routine work — low effort keeps the round trip snappy
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: STEP_INTENT_SCHEMA },
    },
    system: buildSystemPrompt(context),
    messages: [{ role: 'user', content: utterance }],
  };
}

// context: { units, features, params, bitOptions, veeBits, stock }
export function buildSystemPrompt(context) {
  const { units = 'in', features = [], params = {}, bitOptions = [], veeBits = [], stock = {} } = context;

  const featureLines = features.map(f => {
    const bits = [`id=${f.id}`, f.type, f.label ?? ''];
    if (f.depth != null) bits.push(`depth ${f.depth}`);
    if (f.openEdges) bits.push(`${f.openEdges} open edge(s)`);
    if (f.added) bits.push('user-added');
    bits.push(f.selected === false ? 'DESELECTED' : 'selected');
    return '  - ' + bits.filter(Boolean).join(', ');
  }).join('\n');

  return `You translate a CNC machinist's request into actions for the ShopBot STEP toolpath app.

The app has already analyzed a STEP file. It machines the part top-down on a 3-axis router: detected pockets are cleared with an endmill, a ballnose surface raster sweeps everything else machinable, modeled chamfers are cut with a matching V-bit (or ballnose fallback), and the outer profile is cut last. Every generated program is independently verified against the part geometry before export — your output only configures the plan; it cannot cut anything the verifier rejects.

CURRENT STATE
Units for ALL numeric values you emit: ${units === 'mm' ? 'millimeters' : 'inches'}.
FEATURES (the only valid ids — profile selection controls whether the part is cut free):
${featureLines || '  (none detected)'}
PARAMS: ${JSON.stringify(params)}
BIT_OPTIONS (the only valid bitDiameter values; ALWAYS inches regardless of display units): ${JSON.stringify(bitOptions)}
V-BITS in the drawer: ${JSON.stringify(veeBits)}
STOCK: ${JSON.stringify(stock)}
CHAMFER_DEFAULTS (use when the user asks for a chamfer/edge break without giving a size): ${JSON.stringify(context.chamferDefaults ?? { width: 0.0625, angleDeg: 45 })}

ACTION MENU
- set_param: bitDiameter (from BIT_OPTIONS only), depthPerPass, feedRate, plungeRate, rpm, safeZ, stockThickness.
- select_features / deselect: choose which detected features are machined, by id. "Skip the circular pocket" → selected:false for that id. "Don't cut it out" / "leave it in the sheet" → deselect the profile feature.
- set_vee_bits: declare which V-bits the shop actually has (REPLACES the list). A modeled or added chamfer picks a matching bit from this list, or falls back to the ballnose.
- add_rim_chamfer: break the part's top outer edge with a chamfer the geometry doesn't contain (width + angle).

RULES
- Ground every id in FEATURES; never invent ids or bit sizes. If the user names a feature ambiguously, pick the best match and say which one in the summary.
- If the user gives a bit size not in BIT_OPTIONS, use the closest available option and say so in the summary.
- Emit values in the units stated above. Convert if the user says otherwise ("3mm deep passes" with inch units → 0.118).
- PARTIAL FULFILLMENT: when only part of a request maps onto the menu, DO the supported part and decline only the remainder. "Chamfer all the edges" → add_rim_chamfer for the top outer rim (with CHAMFER_DEFAULTS if no size given) + decline the interior/pocket edges. Never refuse a whole request because one piece of it is unsupported, and never refuse for a missing size when CHAMFER_DEFAULTS applies (say in the summary which defaults you used).
- Anything outside the menu goes in declined with a specific honest reason — e.g. changing the part's geometry (deeper pockets, new holes), tabs/onion skin, multiple endmills in one job, 4th-axis work, feeds-by-material lookup. Do not approximate an unsupported request with a supported one unless the user clearly wants that.
- An empty request, or one that is entirely out of scope, gets actions:[] and the explanation in declined.
- summary describes only what the actions actually do.`;
}
