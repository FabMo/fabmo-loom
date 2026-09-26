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
import { GLYPHS } from './glyphs.mjs';

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
            kind: { type: 'string', enum: ['set_name', 'set_thickness', 'add_control', 'set_control', 'remove_control', 'set_derived', 'remove_derived', 'set_shape', 'remove_shape', 'set_terrain', 'remove_terrain', 'add_operation', 'set_operation', 'remove_operation'] },
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
                frame: { type: 'string', description: 'mount this operation INSIDE a frame published by an EARLIER operation (a furniture panel id like "seat"): the content is authored panel-local — it centers on that panel\'s face, place/posX/posY compose within the panel — and rides the panel wherever it nests, at any rotation. Omit for ordinary shared-frame operations.' },
              },
            },
            terrain: {
              type: 'object', description: 'set_terrain: a real-world terrain reference, resolved and fetched by the app in the user\'s browser (never by you). Give a place-name query (geocoded on first weave) OR an explicit lat/lng box for precise regions. Referenced by terrain_relief\'s terrain param.',
              properties: {
                id: { type: 'string', description: 'the name (letters/digits/_)' },
                query: { type: 'string', description: 'place-name search, e.g. "Grand Canyon" — the app geocodes it and pins the resolved box into the recipe' },
                south: { type: 'number', description: 'explicit region instead of query: south latitude, degrees' },
                west: { type: 'number', description: 'explicit region: west longitude, degrees' },
                north: { type: 'number', description: 'explicit region: north latitude, degrees' },
                east: { type: 'number', description: 'explicit region: east longitude, degrees' },
              },
              required: ['id'],
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
              type: 'object', description: 'set_shape: named geometry in the SHARED frame (inches, {arithmetic} allowed), referenced by ops via shape/along params. Give a path, an asset, a drawing (draw — the user sketches it in the app), a glyph, OR exactly one derivation over EARLIER shapes: inset/outset (offset), band (edge band: outset by overrun minus inset by width — whole-rim rabbets, frames), union/difference/intersect, fit (self-sizing around content), around (self-sizing rounded rect around content — no base shape), pattern (repeat one cell into a grid or a ring).',
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
                    posX: { type: 'string', description: 'shift the placed artwork right (+) / left (−), inches or {arithmetic}; default centered on the origin' },
                    posY: { type: 'string', description: 'shift the placed artwork up (+) / down (−), inches or {arithmetic}' },
                  },
                  required: ['of'],
                },
                draw: {
                  type: 'object', description: 'the shape the USER SKETCHES in the app (a Draw “<name>” button appears at the top of the panel for it; mouse or tablet stylus): identical to asset once drawn, but it may be authored BEFORE any drawing exists. Use this whenever the outline is hand-drawn, traced, or has to differ per person/per part. Ops referencing it simply skip until the drawing is made, so author the whole recipe in one pass; redrawing it re-weaves everything that references it.',
                  properties: {
                    of: { type: 'string', description: 'the name the drawing will be saved under — pick a short descriptive one ("outline", "tag"); the app pre-fills it in the draw dialog, so it does NOT need to already exist' },
                    width: { type: 'string', description: 'target width in INCHES — a number or {arithmetic} of controls; omit width AND height to keep the drawing at the size it was sketched' },
                    height: { type: 'string', description: 'target height, inches; width alone keeps aspect, both stretch' },
                    posX: { type: 'string', description: 'shift the placed drawing right (+) / left (−), inches or {arithmetic}; default centered on the origin' },
                    posY: { type: 'string', description: 'shift the placed drawing up (+) / down (−), inches or {arithmetic}' },
                  },
                  required: ['of'],
                },
                glyph: {
                  type: 'object', description: 'derive the shape from a BUILT-IN signage glyph (see GLYPH LIBRARY) — standard symbols, no upload needed',
                  properties: {
                    of: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'object', properties: { ctrl: { type: 'string' } }, required: ['ctrl'], additionalProperties: false },
                      ],
                      description: 'the glyph id (see GLYPH LIBRARY), OR {"ctrl":"id"} bound to a "choice" control whose option VALUES are glyph ids — that gives the user a glyph DROPDOWN that re-lowers the sign live when switched',
                    },
                    width: { type: 'string', description: 'target width in INCHES — a number or {arithmetic} of controls (bind a size control so the user can scale it); default 3' },
                    height: { type: 'string', description: 'target height, inches; width alone keeps the glyph\'s aspect' },
                    posX: { type: 'string', description: 'shift the placed glyph right (+) / left (−), inches or {arithmetic}; default centered on the origin' },
                    posY: { type: 'string', description: 'shift the placed glyph up (+) / down (−), inches or {arithmetic} — a sign\'s glyph usually sits ABOVE its text' },
                  },
                  required: ['of'],
                },
                inset: { type: 'object', properties: { of: { type: 'string' }, by: { type: 'string', description: 'inches or {arithmetic}' } }, required: ['of', 'by'] },
                outset: { type: 'object', properties: { of: { type: 'string' }, by: { type: 'string' } }, required: ['of', 'by'] },
                band: { type: 'object', description: 'edge band hugging a shape\'s whole outline', properties: { of: { type: 'string' }, width: { type: 'string', description: 'band width into the shape, inches or {arithmetic}' }, overrun: { type: 'string', description: 'overhang past the edge, inches (default 0; use ~0.05 for edge treatments)' } }, required: ['of', 'width'] },
                union: { type: 'array', items: { type: 'string' }, description: 'shape ids to merge' },
                difference: { type: 'array', items: { type: 'string' }, description: 'first shape minus the rest' },
                intersect: { type: 'array', items: { type: 'string' } },
                fit: {
                  type: 'object', description: 'derive a SELF-SIZING outline: the base shape scaled uniformly about the origin until everything machined BEFORE the first op that references this shape clears its edge by margin. THE way to put content inside a shaped outline (a name in a heart) — never guess the shape\'s absolute size',
                  properties: {
                    of: { type: 'string', description: 'the base shape id — authored at any convenient size but CENTERED ON THE ORIGIN (only its center matters; fit supplies the size)' },
                    margin: { type: 'string', description: 'clearance between content and the shape edge, inches or {arithmetic} — bind it to a control, like tag_cutout\'s buffer' },
                  },
                  required: ['of'],
                },
                pattern: {
                  type: 'object', description: 'REPEAT an earlier shape into a grid or a ring — ONE authored cell becomes a whole checkerboard, honeycomb, or ring of marks. NEVER author repeated cells one by one (dozens of hand-written copies overrun your response budget and the build dies half-written): author one cell centered on the origin, pattern it, and pocket/cut/bore-along the PATTERN shape. Grid mode: cols × rows copies spaced dx/dy center-to-center, staggerX shifts every other row (checkerboard = one square, 4 cols × 8 rows, dx twice the square, staggerX one square; honeycomb = staggered hexes). Ring mode: count copies on a circle of radius (hour marks, bolt-pattern decorations). Patterning an open curve concatenates the copies (rows of hole-lines for bore_hole along).',
                  properties: {
                    of: { type: 'string', description: 'the base shape id (one cell), authored CENTERED ON THE ORIGIN' },
                    cols: { type: 'string', description: 'grid: columns, a number or {arithmetic} (default 1)' },
                    rows: { type: 'string', description: 'grid: rows, a number or {arithmetic} (default 1)' },
                    dx: { type: 'string', description: 'grid: column spacing center-to-center, inches or {arithmetic} (required when cols > 1)' },
                    dy: { type: 'string', description: 'grid: row spacing center-to-center, inches or {arithmetic} (required when rows > 1)' },
                    staggerX: { type: 'string', description: 'grid: shift EVERY OTHER row right by this much, inches or {arithmetic} — checkerboards and honeycombs (default 0)' },
                    count: { type: 'string', description: 'ring: number of copies, evenly spaced around the circle (giving count/radius selects ring mode)' },
                    radius: { type: 'string', description: 'ring: circle radius to the copy centers, inches or {arithmetic}' },
                    startDeg: { type: 'string', description: 'ring: angle of the first copy in degrees (default 90 = top; counter-clockwise)' },
                    spin: { type: 'boolean', description: 'ring: rotate each copy so its authored "up" faces outward from the center (default false = copies keep their orientation)' },
                  },
                  required: ['of'],
                },
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
      suggest: {
        type: 'array',
        description: 'Two or three suggested NEXT prompts — shown as clickable chips under this turn. Each is the FULL sentence the user would type, aimed at THIS recipe after these actions, and doable with the listed strategies (never suggest what you would have to decline). Use ___ where the user supplies their own value ("carve ___ in the seat"). MANDATORY: if any action added a feature the user did not ask for (a design move — e.g. a grab handle), one suggestion must offer to change or remove that feature, so the move is visible as a choice. After a decline, suggest the concrete path forward you named in the summary (draw it, upload the SVG).',
        items: { type: 'string' },
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

export function buildSystemPrompt(recipe, shop = {}) {
  // the user's declared physical limits (app settings, not the recipe) —
  // grounding the model in what the shop can actually cut turns "make it
  // fit my machine" from a guess into arithmetic
  const shopBits = [];
  if (shop?.machineW > 0 && shop?.machineH > 0) shopBits.push(`the machine's cutting area is ${shop.machineW}" × ${shop.machineH}"`);
  if (shop?.materialW > 0 && shop?.materialH > 0) shopBits.push(`material comes as ${shop.materialW}" × ${shop.materialH}" sheets`);
  const shopRule = shopBits.length
    ? `\n- THE USER'S SHOP (from their settings — physical facts, not preferences): ${shopBits.join('; ')}. Strategies that lay parts out honor these limits automatically on every weave, splitting a layout into several setups when it needs them. A SINGLE part bigger than the machine or the sheet cannot be cut by any layout — offer a smaller design or a scale model (a strategy with a model/scale param) instead of pretending it fits.`
    : '';
  // a pinned blank (recipe.stock.width/height) is a HARD footprint for THIS
  // design — the board is that exact piece, not grown to the content
  const st = recipe.stock;
  const blankRule = (st.width > 0 && st.height > 0)
    ? `The user has PINNED A BLANK — a real piece ${st.width}" × ${st.height}" × ${st.thickness}". The WHOLE design (content + margins) MUST fit inside ${st.width}" × ${st.height}", and every cut depth must stay within the ${st.thickness}" thickness. Design to this exact piece; you cannot enlarge the board, so a part that overruns it is a fail — make it smaller or fewer/tighter elements.`
    : `Stock WIDTH and HEIGHT are AUTO-SIZED from the content (plus margins) and shown to the user as the minimum board they need — you cannot and need not set them.`;
  const assetSection = recipe.assets?.length
    ? `\n\nUPLOADED ASSETS (embedded in the recipe document; reference by NAME, never by content — the bytes are not shown to you):\n${recipe.assets.map(a => `- "${a.name}" (${a.kind}${a.width ? `, ${a.width}×${a.height}px` : ''})`).join('\n')}
An SVG asset IS usable as a shape: set_shape with asset {of: "<name>", width: <inches or {arithmetic}>} lowers the file's FILLED artwork to a closed outline in the shared frame (strokes, text, and embedded images inside the file are skipped with warnings). Reference that shape id from shape_cutout (cut the logo out), pocket_shape (recess it), or bore_hole's along (holes around its outline). Bind width to a size control when the user might rescale it. A raster IMAGE (png/jpeg photo) is NOT usable: if the user asks to carve/engrave/trace one, DECLINE that part — what: the image use, why: "raster image carving is not in the catalog yet; the upload is stored for when it arrives" — and still apply the rest of the request.`
    : '';
  const glyphSection = `\n\nGLYPH LIBRARY (built-in signage symbols, the AIGA/DOT set — no upload needed; set_shape with glyph {of: "<id>", width: <inches or {arithmetic}>} lowers one to a closed outline exactly like an SVG asset, then pocket_shape recesses it or shape_cutout cuts it out):\n${GLYPHS.map(g => `- "${g.id}" — ${g.blurb}`).join('\n')}
GLYPH DROPDOWN: to let the user SWITCH the symbol, first add a "choice" control whose option VALUES are glyph ids (label them nicely) and bind glyph.of to it: add_control {id:"symbol", type:"choice", default:"men", options:[{value:"men",label:"Men"},{value:"women",label:"Women"},{value:"restroom",label:"All-gender"},{value:"accessible",label:"Accessible"}]} then set_shape {id:"fig", glyph:{of:{ctrl:"symbol"}, width:2}}. Offer the glyphs relevant to the sign. Create the control BEFORE the set_shape.
SIGN LAYOUT — pipeline order is MACHINING order, NOT position: every text/glyph/braille element defaults to the SAME spot (centered on the content so far) and they OVERLAP unless you stack them. To stack a sign vertically, set place:"below" on each element after the top one — it drops that element a gap beneath everything machined so far, with NO coordinates to compute. Top-to-bottom = pipeline order. Pick the SPECIFIC glyph: a men's room sign is glyph "men" + text "Men"; women's is "women"; only an all-gender/family restroom uses "restroom". SIGN TEXT IS EDITABLE: bind the visible text AND the braille to text controls so the user can retype them — and when the braille says the same thing as the visible sign text, bind BOTH to the SAME control (ADA wants them identical, and one edit then updates both). A men's sign, in full: add_control {id:"label", type:"text", default:"Men"}; set_shape fig = glyph {of:"men", width:2}; pocket_shape shape:"fig" (the glyph, on top); vcarve_text text:{ctrl:"label"} place:"below" (drops under the glyph); braille_text text:{ctrl:"label"} place:"below" (same control — braille tracks the text); tag_cutout last (the plaque). Only reach for posX/posY when the user wants a specific off-center position.`;
  const terrainSection = `\n\nTERRAIN (real-world elevation carving): set_terrain {id, query:"<place name>"} stores a REFERENCE — the app geocodes it and downloads public elevation tiles IN THE USER'S BROWSER on the next weave (you never fetch or invent elevation data), then pins the resolved lat/lng box and metadata into the recipe. Reference it from terrain_relief's terrain param. Once resolved, the terrain entry in CURRENT RECIPE carries meta (center lat/lng, elevation range, place name) — when the user wants coordinates CARVED on the piece, prefer those resolved numbers over memory; on the first turn (before any weave) your best-knowledge coordinates are fine and can be corrected after resolution. The classic terrain plaque, in full — NOTE: no coordinates anywhere (never posX/posY plaque text onto a terrain; you cannot know rendered text widths — the plaque param places the pad): add_control {id:"place", type:"text", default:"Grand Canyon"}; set_terrain {id:"land", query:"Grand Canyon"}; vcarve_text text:{ctrl:"place"} letterHeight 0.5 (default position); vcarve_text "36.06°N 112.14°W" letterHeight 0.3 place:"below" (stacks under the name); terrain_relief terrain:"land" width 10 plaque:"sw" (the terrain rectangle positions itself so the text's flat pad sits in the lower-left corner); tag_cutout buffer 0.4 LAST. For a precise region ("the stretch of coast from X to Y") give set_terrain an explicit south/west/north/east box instead of a query.`;
  return `You edit a "recipe" — the declarative document behind a small CNC app. The user speaks; you emit recipe actions via the apply_recipe_actions tool. You NEVER write code, G-code, or toolpaths: strategies below do the machining and an independent verifier gates every export.

AVAILABLE STRATEGIES (the complete list — nothing else exists):
${catalogDoc()}${assetSection}${glyphSection}${terrainSection}

RULES:
- Only these strategies and their listed params. A request needing anything else (raster images/photos, other fonts, STL models, rotated text, ROUNDED-over edges — chamfer cuts a flat 45° face, not a roundover...) goes on the declined channel with what+why. Partial fulfillment is good: apply what you can, decline the rest.
- Quantities a user would tweak (their text, letter height, tag buffer...) should be BOUND to controls ({"ctrl":"id"}), creating the control if needed with a sensible label/default/min/max. One control may feed several ops. A param that picks from a fixed set (the font) binds to a "choice" control whose options are the allowed values (use the ids as values and friendlier labels).
- Params marked bindable are the usual candidates; other params are usually literals.
- Operation order is machining order: engraving, pockets, dishes, and holes first, any cutout (tag_cutout, disc_cutout, shape_cutout) LAST — the cutout frees the part. A hole positioned "above"/"corners" etc. must come BEFORE the cutout so the tag wraps around it.
- A GEOMETRIC or SYMBOLIC outline the catalog does not name (ellipse, star, heart, arch, hexagon, shield, arrow, cloud, chevron, crescent, gear, cross, simple leaf…) is NOT a decline: check the GLYPH LIBRARY first — a standard signage symbol (restroom figures, wheelchair access, stairs, first aid…) comes from there, never hand-drawn. Otherwise AUTHOR it yourself as an SVG path via shape_cutout (or pocket_shape with shape "custom") — the path authoring rules are in shape_cutout's doc. (But NOT a recognizable likeness — see the next rule.)
- A RECOGNIZABLE, REPRESENTATIONAL subject is the ONE kind of outline you must NEVER freehand: a specific animal (a bull, an eagle), a person or face, a vehicle, a building, a brand/team LOGO, the map of a real place. You author outlines from a handful of geometric primitives, and a likeness needs visual detail you cannot see — so a hand-drawn one is a blob that passes every toolpath check yet looks nothing like the subject, which is WORSE than nothing (a naive user just sees a bad drawing and gets frustrated). DECLINE that part — what: the drawing (e.g. "a bull outline"); why: "I build shapes from geometry (circles, stars, hearts, arches), so I can't reliably freehand a recognizable bull — it would come out as a blob." Then in the SUMMARY, give the real paths forward AND head off the wrong one: the user can DRAW it themselves (set_shape draw — see the DRAWN SHAPES rule; best when they have the picture in their head, not in a file) or UPLOAD the artwork as an SVG or image (set_shape asset) — either becomes a shape, and a name inside it or a cutout of it then composes normally — while MORE DESCRIPTION WILL NOT HELP, because you don't turn words into pictures; the outline has to come from their hand or a file. Never author a substitute blob to seem helpful: if the likeness is the whole point (a cutout OF the bull), decline the AUTHORED shape and offer the drawn one. The line: if recognizing it would take more than a few arcs/béziers, or leans on detail you can't see, don't author it — a drawn or uploaded outline beats a bad one you invented.
- DRAWN SHAPES — a HAND-DRAWN, sketched, traced, or tablet/stylus outline is NOT a decline: set_shape draw {of:"<name>", width:…} is an outline the USER sketches in the app (authoring it puts a Draw “<name>” button at the top of the panel; mouse or tablet pen), and it is an ordinary shape from then on — shape_cutout of it, pocket_shape it, bore_hole along it, fit content inside it. Size it with width (uniform), or with maxWidth + maxHeight to scale the sketch down evenly until it just fits that box (aspect kept — the right sizing when the part must stay within a window, like a 3.5×2.5 badge). Author it EVEN THOUGH NOTHING IS DRAWN YET: the ops referencing it skip with a "waiting on the drawing" note while the rest of the recipe (typed text, controls, other cutouts) previews normally, and the moment the user draws, everything referencing it weaves. So build the WHOLE app in one pass and say in the summary which name to draw. Redrawing under the same name re-weaves every op that uses it — that is the PER-PERSON / per-part shape input (each nametag its own drawn outline, same typed-name machinery). Prefer draw over declining whenever the outline lives in the user's hand rather than in a file; prefer an SVG asset when they already have the file; prefer a glyph or an authored path when it's a standard symbol or plain geometry.
- A shape whose OWN dimensions must be adjustable ("an arch with adjustable thickness and radius") is also NOT a decline: write {arithmetic} of number-control ids inside the path with width/height 0 — the arch example is in shape_cutout's doc. Such dimensions (band thickness, radius…) are recipe controls; set_thickness is ONLY for the stock material.
- Name intermediate values ONCE with set_derived (e.g. m = "r - t/2", innerR = "r - t") and write {m}, {innerR} everywhere — do this whenever an expression would repeat across params or operations. Derived values may reference controls and earlier derived ids; they are recomputed on every slider move.
- Define geometry ONCE with set_shape and reference it by id: closed outlines feed shape_cutout's shape param / pocket_shape's shape param; open curves (open: true) feed bore_hole's along param. Shapes live in the SHARED frame and re-lower on every slider move. CRITICAL: shape coordinates are INCHES, CENTERED ON THE ORIGIN (where prior content like engraved text centers). NEVER paste an SVG-viewbox path unscaled — a heart in a 0..100 box becomes a 100-INCH part 50 inches off-center. A 3" heart spans roughly -1.5..1.5 around the origin; rescale and re-center the coordinates yourself (or use {arithmetic} of a size control) before authoring the path. The parametric arch app in full: derived inner="r-t", mid="r-t/2"; shape arch = "M {-r} 0 A {r} {r} 0 0 1 {r} 0 L {inner} 0 A {inner} {inner} 0 0 0 {-inner} 0 Z"; shape centerline (open) = "M {-mid} 0 A {mid} {mid} 0 0 1 {mid} 0"; ops: bore_hole along "centerline" count 5, then shape_cutout shape "arch".
- Shapes can also be DERIVED from earlier shapes instead of authored: inset/outset {of, by} (offset), band {of, width, overrun} (a band hugging the whole outline — frames, whole-rim rabbets and ledges: pocket the band with edgeTreatment true before the cutout of the same base shape), union/difference/intersect [ids], fit {of, margin} (self-sizing, below), around {margin, cornerRadius} (self-sizing rounded rect, below), pattern {of, …} (repeat one cell — below). Derivations are computed geometry — prefer them over re-authoring offset outlines by hand.
- A REPEATED layout — a checkerboard, a honeycomb, rows of identical cells, a ring of marks — is NOT a decline, and must NEVER be authored cell-by-cell: author ONE cell as a shape centered on the origin, derive set_shape pattern from it, and pocket/cut the pattern shape. (Hand-writing dozens of copies overruns your response budget and the build dies half-written — one cell + one pattern is always the move.) Chess board in full: control "sq" (square size, default 2); shape "cell" = path "M {-sq/2} {-sq/2} L {sq/2} {-sq/2} L {sq/2} {sq/2} L {-sq/2} {sq/2} Z"; shape "darks" = pattern {of:"cell", cols:"4", rows:"8", dx:"2*sq", dy:"sq", staggerX:"sq"}; ops: pocket_shape shape "darks", then tag_cutout LAST (buffer 0 hugs the board). Clock hour marks: one tick shape, pattern {of:"tick", count:"12", radius:"4.5", spin:true}, pocket it before the disc_cutout — and size the radius so the patterned content FITS the disc. Overlapping copies weld into one outline, so patterns make grilles and lattices too. A pattern of plain HOLES still wants bore_hole (along a shape, or at centers) — pattern is for shaped cells.
- Content INSIDE a shaped outline ("engrave a name and cut it out as a heart") is a FIT, not a guess: author the base outline at any convenient size CENTERED ON THE ORIGIN, then set_shape tag = fit {of: base, margin: m} and cut/pocket THAT. fit scales the base uniformly (about the origin) until everything machined before the referencing op clears its edge by margin — so a longer name simply makes a bigger heart, exactly like tag_cutout's buffer. Bind margin to a control; put the content operations FIRST in the pipeline. Never size such a shape with a fixed width — a width the user's text has outgrown is a fit conflict.
- around {margin, cornerRadius} is fit's sibling for when NO base outline should scale: a snug rounded RECTANGLE around everything machined before the referencing op (tag_cutout's geometry as a derivable shape you can compose). Its signature use is FIXED-SIZE content over a FIXED-SIZE outline: when a shape must keep its size (a drawn sketch held to a card window with maxWidth/maxHeight) and the text must keep ITS size too, neither may scale — so cut union [sketch, aroundRect] instead. Whenever the sketch already contains the text the rectangle is swallowed and invisible; when it doesn't (a long name over a skinny sketch), the text carries its own rounded tab into the cutout and the job still verifies, instead of failing the fit check or growing something the user pinned.
- Give every authored shape the controls a user would naturally grab, and pick the shape's OWN parameters over generic stretch: an arch gets radius and band thickness, a rounded shape gets its corner radius, a star gets inner/outer radius. Organic outlines (hearts, shields, leaves) distort badly under independent width/height — give them ONE uniform size control, or better, fit + a margin control when content sits inside. Independent width/height stretch is right only for boxy shapes (plaques, frames, rectangles).
- A RABBET / ledge / stepped edge along a cutout's edge is also NOT a decline: whole-rim = a band-derived shape pocketed with edgeTreatment true; a PARTIAL edge (one side only) = a pocket_shape "custom" band you author hugging that edge — the recipe is in pocket_shape's doc.
- Content ON A PART of a larger build ("carve EMMA in the bench seat") is NOT a decline when an operation publishes FRAMES (furniture_design publishes each panel id): put the content op AFTER the publisher with "frame": "<panel id>" on the OPERATION (not in params). Framed content authors panel-local — it centers on the panel face; place:"below"/posX/posY compose within the panel — and follows the panel wherever it nests. Surface textures can't ride a frame yet; text engraving and outlines can.
- A PATTERN of holes (a row of five, a bolt circle, holes along an arc) is NOT a decline: bore_hole's "along" spaces count holes evenly by arc length on any shape (open curve end-to-end, closed outline all the way around); "at" takes explicit centers for irregular layouts.
- Keep ids short and meaningful (e.g. "engrave", "cutout"). Use set_operation with a partial params object to change an existing op's parameters. set_operation may also include a different "strategy" to CONVERT the op (e.g. a rectangular tag_cutout into a disc_cutout) — its params are then replaced by the ones you provide. Use remove_operation only when the user wants the operation gone.
- Operations have NO enable/disable param — never invent one. Text ops skip themselves when their bound text is BLANK, so bound text is already optional: "make the caption optional" needs no actions — answer (in summary) that clearing the text field omits it. An optional NON-text feature is a decline (what: an on/off toggle for that op); remove_operation when the user says to drop it.
- CUTTING MANY PARTS FROM ONE SHEET, and tracking what's already been cut, is NOT a decline — but it takes NO actions, because it is an app SETTING, not part of the recipe: the Current board tracker (inside "Board & material" at the top of the app panel) holds one physical board's size plus every footprint already committed to it, nests each new design into the free space, and reports what's left. Answer it in the SUMMARY: enter the board's W × H under "Current board" (in "Board & material"), then hit "Add to board" after each verified design — the next part nests into the remainder, and the chip shows the % free. It persists across designs and re-weaves, so a run of many one-at-a-time parts (nametags, tags, coasters) is exactly what it's for. Do NOT try to model the sheet, the nesting, or the run history as controls or ops — one recipe still describes ONE part, and that part is what the ledger places. (Only furniture_design nests many panels WITHIN a single design.)
- If the recipe is empty and the user asks for an app, also set_name it.
- YOU GET A SECOND LOOK. After your actions are applied, the app weaves the recipe and shows you the result as a tool result: what applied, what was skipped and why, the pipeline as it now stands, and the verifier's verdict. You then get one more call to correct anything that failed and to write the FINAL summary with the built thing in view. So: on this first call build boldly and write a plain summary; do not hedge about outcomes you have not seen yet.
- SUGGESTED NEXT PROMPTS (the suggest field): always offer 2–3. They are the user's second turn, pre-written — the refinements THIS design most invites, each a complete sentence they could type verbatim, each within the strategies above. ___ marks a blank the user fills. An UNREQUESTED design move (a feature you added on taste, not on ask) must surface here as an adjust-or-remove suggestion — proactive choices stay visible as choices.
- ${blankRule} Stock THICKNESS is ${JSON.stringify(recipe.stock.thickness)}" — DESIGN CUT DEPTHS WITHIN IT: a pocket or engraving is shallower than the stock, a through-cut goes exactly through, and nothing is cut deeper than the material. set_thickness when the user names a different material thickness.${shopRule}

CURRENT RECIPE:
${JSON.stringify(promptRecipeView(recipe), null, 1)}`;
}

export function buildParseRequest(recipe, utterance, { model = 'claude-opus-4-8', shop = {} } = {}) {
  return {
    model,
    // generous: geometry-heavy builds (multi-shape recipes, big edits)
    // were hitting 2000 and truncating mid-action-list, which reads as a
    // silent half-build — the app also surfaces stop_reason max_tokens
    max_tokens: 8000,
    system: buildSystemPrompt(recipe, shop),
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

  const applyOne = (a) => {
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
        // accept the flattened form {kind, id, expr} the model sometimes
        // emits (seen 3× in one response) — the intent is unambiguous
        const d = a.derived ?? (typeof a.expr === 'string' ? { id: a.id, expr: a.expr } : undefined);
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
        const forms = ['path', 'asset', 'draw', 'glyph', 'inset', 'outset', 'band', 'union', 'difference', 'intersect', 'fit', 'around', 'pattern'].filter(k => s[k] !== undefined);
        if (forms.length !== 1) {
          skipped.push(`set_shape "${s.id}": give a path, an asset, a drawing, a glyph, OR one derivation (inset/outset/band/union/difference/intersect/fit/around/pattern)`); break;
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
      case 'set_terrain': {
        const t = a.terrain;
        if (!t?.id || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.id)) {
          skipped.push('set_terrain: needs an id (letters/digits/_)'); break;
        }
        const hasBox = [t.south, t.west, t.north, t.east].every((v) => Number.isFinite(v));
        if (!t.query?.trim() && !hasBox) {
          skipped.push(`set_terrain "${t.id}": give a place-name query or a full south/west/north/east box`); break;
        }
        if (hasBox && !(t.south < t.north && t.west < t.east && Math.abs(t.south) <= 85 && Math.abs(t.north) <= 85)) {
          skipped.push(`set_terrain "${t.id}": box must have south < north (within ±85°) and west < east`); break;
        }
        const entry = {
          id: t.id,
          ...(t.query?.trim() ? { query: t.query.trim() } : {}),
          ...(hasBox ? { bbox: { south: t.south, west: t.west, north: t.north, east: t.east } } : {}),
        };
        next.terrains ??= [];
        const existing = next.terrains.findIndex((x) => x.id === t.id);
        // an edited reference drops its pinned resolution — the app
        // re-resolves and re-pins on the next weave
        if (existing >= 0) next.terrains[existing] = entry;
        else next.terrains.push(entry);
        applied.push(`terrain "${t.id}" (${entry.query ?? `${t.south}..${t.north}, ${t.west}..${t.east}`})`);
        break;
      }
      case 'remove_terrain': {
        next.terrains ??= [];
        const used = next.pipeline.some((o) => o.params && o.params.terrain === a.id);
        if (used) { skipped.push(`remove_terrain: "${a.id}" is still referenced by an operation`); break; }
        const before = next.terrains.length;
        next.terrains = next.terrains.filter((x) => x.id !== a.id);
        before === next.terrains.length ? skipped.push(`remove_terrain: no "${a.id}"`) : applied.push(`removed terrain "${a.id}"`);
        break;
      }
      case 'remove_shape': {
        next.shapes ??= [];
        const used = next.pipeline.some(o =>
          o.params && (o.params.shape === a.id || o.params.along === a.id));
        if (used) { skipped.push(`remove_shape: "${a.id}" is still referenced by an operation`); break; }
        const usedByShape = next.shapes.some(x => x.id !== a.id && (
          x.inset?.of === a.id || x.outset?.of === a.id || x.band?.of === a.id || x.fit?.of === a.id
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
        if (o.frame) op.frame = String(o.frame);
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
        if (a.operation?.frame !== undefined) {
          a.operation.frame ? op.frame = String(a.operation.frame) : delete op.frame;
        }
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
  };

  // The model's action list is data from a good-faith author who
  // sometimes gets the ORDER wrong (a shape emitted one action before
  // the control it binds; a derived chain listed backwards). Rescue
  // instead of cascading skips:
  //   1. controls first — pure additions nothing else can invalidate,
  //      and the thing everything else binds to;
  //   2. everything else in document order;
  //   3. failed set_derived / set_shape entries retried until a full
  //      sweep makes no progress (chains settle in ≤ n sweeps), then the
  //      survivors' reasons are reported.
  // Operations are NOT retried: pipeline position is machining order,
  // and their shape/control references are checked here in full.
  const actions = (payload.actions ?? []).filter(a => a && typeof a === 'object');
  const ordered = [
    ...actions.filter(a => a.kind === 'add_control'),
    ...actions.filter(a => a.kind !== 'add_control'),
  ];
  const RETRYABLE = new Set(['set_derived', 'set_shape']);
  const sweep = (list) => {
    const failed = [];
    for (const a of list) {
      const before = skipped.length;
      applyOne(a);
      if (skipped.length > before && RETRYABLE.has(a.kind)) {
        failed.push({ a, msgs: skipped.splice(before) });
      }
    }
    return failed;
  };
  let failed = sweep(ordered);
  while (failed.length) {
    const again = sweep(failed.map(f => f.a));
    if (again.length === failed.length) {
      for (const f of again) skipped.push(...f.msgs);
      break;
    }
    failed = again;
  }
  // suggested next prompts ride through sanitized: model output is data —
  // strings only, trimmed, capped at 3 chips of sane length
  const suggest = (Array.isArray(payload.suggest) ? payload.suggest : [])
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => s.trim())
    .filter(s => s.length <= 160)
    .slice(0, 3);
  return { recipe: next, applied, skipped, declined: payload.declined ?? [], summary: payload.summary ?? '', suggest };
}


// ------------------------------------------------------------------ the loop
//
// One-shot parsing left the author blind: the model wrote its user-facing
// summary in the same breath as its actions — before the app applied them,
// before the weave ran, before the verifier spoke. Seventeen nightly probes
// put the cost at 4–11 of 25 prompts whose summary confidently described a
// build the pipeline had refused, emptied, or never contained. The loop
// closes that gap the way a sighted author works: act, look at what
// happened, then say what was built — and fix it when the catalog can.
//
// The boundary does not move. The model still emits only recipe actions;
// what it sees between turns is the app's own deterministic report
// (applyActions' skips, the pipeline, the verifier's numbers), never a
// place to write motion. The observation is a tool_result on the same
// conversation, so the system prompt stays byte-identical across turns
// and prompt caching keeps a revise call cheap.

const MAX_OBS_ITEMS = 8;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

// What the app did with a turn's actions, as data. weaveResult is a
// runRecipe() result or null (no weave available / not run).
export function buildObservation(applyOut, weaveResult, recipe) {
  const rec = recipe ?? applyOut.recipe;
  const r = weaveResult;
  const stats = r?.report?.stats;
  const targets = (stats?.targets ?? []).map(t => ({
    name: t.name, type: t.type,
    gouges: t.gouges ?? 0, depthViolations: t.depthViolations ?? 0,
    maskViolations: t.maskViolations ?? 0, intrusionArea: t.intrusionArea ?? 0,
  }));
  const awaitingDraw = (rec.shapes ?? []).filter(sh => sh.draw).map(sh => sh.draw.of ?? sh.id);
  return {
    applied: applyOut.applied ?? [],
    skipped: applyOut.skipped ?? [],
    controls: (rec.controls ?? []).map(c => c.id),
    derived: (rec.derived ?? []).map(d => d.id),
    shapes: (rec.shapes ?? []).map(sh => sh.id),
    pipeline: (rec.pipeline ?? []).map(o => ({ id: o.id, strategy: o.strategy, ...(o.frame ? { frame: o.frame } : {}) })),
    weaved: !!r,
    ok: r ? !!r.ok : null,
    errors: (r?.errors ?? []).map(e => clip(String(e), 300)),
    warnings: (r?.warnings ?? []).map(w => clip(String(w), 300)),
    stock: r?.preview?.stock ? { w: r.preview.stock.w, h: r.preview.stock.h, thickness: r.preview.stock.thickness, pinned: !!r.preview.stock.pinned } : null,
    runTimeMin: stats?.estRunTimeMin ?? null,
    targets,
    awaitingDraw,
  };
}

// Anything here that a second look could improve?
export function observationTroubled(obs) {
  return !!(obs.skipped.length || obs.ok === false || !obs.pipeline.length || obs.errors.length);
}

// The observation as the model reads it — terse, numbers first.
export function observationText(obs) {
  const lines = [];
  const list = (arr) => arr.slice(0, MAX_OBS_ITEMS).map(x => `  - ${x}`).join('\n') + (arr.length > MAX_OBS_ITEMS ? `\n  - …and ${arr.length - MAX_OBS_ITEMS} more` : '');
  lines.push(`APPLIED (${obs.applied.length}):${obs.applied.length ? '\n' + list(obs.applied) : ' nothing'}`);
  if (obs.skipped.length) lines.push(`SKIPPED (${obs.skipped.length}) — these did NOT happen:\n${list(obs.skipped)}`);
  lines.push(`RECIPE NOW: controls [${obs.controls.join(', ')}]${obs.derived.length ? `; derived [${obs.derived.join(', ')}]` : ''}${obs.shapes.length ? `; shapes [${obs.shapes.join(', ')}]` : ''}`);
  lines.push(obs.pipeline.length
    ? `PIPELINE (machining order): ${obs.pipeline.map(o => `${o.id} (${o.strategy}${o.frame ? ` in frame ${o.frame}` : ''})`).join(' → ')}`
    : 'PIPELINE: EMPTY — nothing will be machined');
  if (!obs.weaved) lines.push('WEAVE: not run');
  else if (obs.ok) {
    const bits = ['WEAVE: VERIFIED — the job posts'];
    if (obs.stock) bits.push(`board ${obs.stock.w}" × ${obs.stock.h}" × ${obs.stock.thickness}"${obs.stock.pinned ? ' (pinned blank)' : ' (auto-sized)'}`);
    if (obs.runTimeMin != null) bits.push(`about ${Math.max(1, Math.round(obs.runTimeMin))} min of machine time`);
    lines.push(bits.join('; '));
    const bad = obs.targets.filter(t => t.gouges || t.depthViolations || t.maskViolations || t.intrusionArea);
    if (obs.targets.length) lines.push(`VERIFIER TARGETS: ${obs.targets.length} checked${bad.length ? `; flagged: ${bad.map(t => t.name).join(', ')}` : ', all clean'}`);
  } else {
    lines.push(`WEAVE: FAILED — the job will NOT post. Errors:\n${list(obs.errors.length ? obs.errors : ['(no error text)'])}`);
  }
  if (obs.warnings.length) lines.push(`WARNINGS:\n${list(obs.warnings)}`);
  if (obs.awaitingDraw.length) lines.push(`AWAITING THE USER'S DRAWING: ${obs.awaitingDraw.join(', ')} (ops using these skip until drawn — that is expected, not a failure)`);
  return lines.join('\n');
}

const REVISE_TEXT = `That is what the app did with your actions: the recipe as it stands and the weave/verify result. Look before you speak:
1. If something was SKIPPED, the weave FAILED, or a thing the user asked for is missing from the pipeline — and the catalog can express it — emit corrective actions now. They apply ON TOP of the current recipe: set_operation / set_shape / set_control to change what exists, add_operation only for what is missing, remove_operation for what should go. Never re-add what is already there.
2. If it cannot be built, put it on declined (what + why). Do not leave it implied as done.
3. Rewrite summary FROM SCRATCH to describe only what is built and verified NOW — or, if it still fails, say plainly what failed. Never describe an intention as a result.
4. Keep 2–3 suggest chips.
An empty actions list is the right answer when nothing needs to change.`;

const FINAL_TEXT = `That is the result after your corrections. This is the LAST call: emit NO actions. Give only the honest summary of the state shown (built and verified, or what still fails and why), the declined list, and 2–3 suggest chips.`;

// The next request in the same conversation: the model's previous content
// (with its tool_use) as the assistant turn, then our observation as the
// tool_result plus the instruction. System, tools, and tool_choice are
// unchanged so the cached prefix is reused.
export function buildReviseRequest(prevReq, assistantContent, toolUseId, observation, { final = false } = {}) {
  return {
    ...prevReq,
    messages: [
      ...prevReq.messages,
      { role: 'assistant', content: assistantContent },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: observationText(observation) },
          { type: 'text', text: final ? FINAL_TEXT : REVISE_TEXT },
        ],
      },
    ],
  };
}

// Errors the app shows verbatim (kept here so every caller says the same
// thing). `retryable` tells the UI nothing was applied.
export class IntentError extends Error {
  constructor(message, { retryable = true } = {}) { super(message); this.retryable = retryable; }
}

const dedupeDeclined = (list) => {
  const seen = new Set(), out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const k = String(d.what ?? '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(d);
  }
  return out;
};

// Drive a full intent turn: parse → apply → weave → (revise → apply →
// weave)* until the model has nothing left to change, up to maxTurns
// model calls. The last summary is written with the final state in view.
//
//   call(req)   → Promise<Anthropic messages response JSON>
//   weave(rec)  → Promise<runRecipe result> (or omit: apply-only observations)
//   mode        'always' (default) — every action-bearing turn gets a look;
//               'trouble' — only when the observation has skips/failures;
//               'off' — the old one-shot behavior.
//
// Returns { recipe, turns, summary, firstSummary, declined, suggest, usage,
//           revised, fixes } — turns[i] carries payload/applied/skipped/
//           observation for logging and measurement.
export async function runIntentLoop({ recipe, utterance, shop = {}, model, call, weave = null, maxTurns = 3, mode = 'always' }) {
  const turns = [];
  // Anthropic's usage fields, summed across calls (the probe prices from them)
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let req = buildParseRequest(recipe, utterance, { ...(model ? { model } : {}), shop });
  let cur = recipe;
  const cap = mode === 'off' ? 1 : Math.max(1, maxTurns);
  for (let t = 0; t < cap; t++) {
    const data = await call(req);
    usage.calls++;
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage[k] += data?.usage?.[k] ?? 0;
    const toolUse = data?.content?.find(b => b.type === 'tool_use');
    if (!toolUse) {
      if (t === 0) throw new IntentError('the model returned no actions');
      break;   // a revise turn that produced nothing: keep the state we have
    }
    // a response cut off at the token ceiling arrives as a PARTIAL action
    // list that would half-build silently — refuse the whole first turn;
    // on a later turn keep the previous state and stop
    if (data.stop_reason === 'max_tokens') {
      if (t === 0) throw new IntentError('that answer overran its budget mid-build, so nothing was applied — ask for it in smaller pieces (and describe repeated layouts as a pattern rather than listing every piece)');
      break;
    }
    const p0 = toolUse.input ?? {};
    if (t === 0 && !p0.actions?.length && !p0.declined?.length && !p0.summary?.trim()) {
      throw new IntentError('the model came back empty-handed — nothing was applied; hit Generate again');
    }
    const out = applyActions(cur, p0);
    cur = out.recipe;
    const turn = {
      payload: p0, applied: out.applied, skipped: out.skipped, declined: out.declined,
      summary: out.summary, suggest: out.suggest, usage: data.usage ?? null, observation: null,
    };
    turns.push(turn);
    const hadActions = (p0.actions ?? []).filter(a => a && typeof a === 'object').length > 0;
    // nothing changed → nothing new to look at: a pure decline on turn 0,
    // or a revise turn that wrote its summary with the state already in view
    if (!hadActions) break;
    if (t === cap - 1) break;
    const result = weave ? await weave(cur) : null;
    turn.observation = buildObservation(out, result, cur);
    if (mode === 'trouble' && !observationTroubled(turn.observation)) break;
    req = buildReviseRequest(req, data.content, toolUse.id, turn.observation, { final: t === cap - 2 });
  }
  const first = turns[0], last = turns[turns.length - 1];
  const suggest = last.suggest?.length ? last.suggest : first.suggest;
  return {
    recipe: cur,
    turns,
    summary: (last.summary ?? '').trim() || (first.summary ?? ''),
    firstSummary: first.summary ?? '',
    declined: dedupeDeclined(turns.flatMap(x => x.declined ?? [])),
    suggest,
    usage,
    revised: turns.length > 1,
    fixes: turns.slice(1).reduce((n, x) => n + x.applied.length, 0),
  };
}
