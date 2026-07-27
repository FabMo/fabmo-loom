// Example recipes for the "What is this?" intro — one click loads a
// working app, because the fastest way to understand Loom is to hold one.
//
// Each entry is a complete recipe document (the same thing Save recipe
// writes), plus a one-line pitch and a "what to try" note that lands in
// the history when it loads. Keep them SMALL and offline: no terrains, no
// embedded rasters, nothing that needs a key — the point is that a brand
// new visitor without an AI key can load one, move a slider, and watch
// the verifier re-measure the cut.
//
// Every example is woven by the gauntlet (app/test.mjs) on every npm
// test, so a catalog or schema change that breaks one fails CI instead
// of greeting the next first-timer with REJECTED.

export const EXAMPLES = [
  {
    id: 'name_badge',
    title: 'Name badge',
    blurb: 'Draw the outline by hand, type a name, cut it out — the shape self-sizes around the name.',
    next: 'Step 1: hit “✏ Draw” and sketch a badge outline (the design waits for it). Then type a name and watch it re-weave.',
    recipe: {
      version: 2,
      name: 'Name badges',
      stock: { thickness: 0.25 },
      margin: 0.375,
      controls: [
        { id: 'name', type: 'text', label: 'Name', default: 'Brian' },
        { id: 'letterH', type: 'number', label: 'Letter height', default: 0.6, min: 0.3, max: 1.2, step: 0.05 },
      ],
      derived: [],
      shapes: [
        { id: 'profile', draw: { of: 'profile', width: '3.5' } },
        { id: 'tag', fit: { of: 'profile', margin: 0.3 } },
      ],
      assets: [],
      terrains: [],
      pipeline: [
        { id: 'engrave', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: { ctrl: 'letterH' } } },
        { id: 'cutout', strategy: 'shape_cutout', params: { shape: 'tag' } },
      ],
    },
  },
  {
    id: 'welcome_sign',
    title: 'Welcome sign',
    blurb: 'V-carved lettering on a rounded tag with holding tabs — the classic first cut.',
    next: 'Change the words, drag the letter height, and watch the tag re-size around them. Tabs hold the sign in the board.',
    recipe: {
      version: 2,
      name: 'Welcome sign',
      stock: { thickness: 0.75 },
      margin: 0.375,
      controls: [
        { id: 'words', type: 'text', label: 'The sign says', default: 'WELCOME' },
        { id: 'letterH', type: 'number', label: 'Letter height', default: 1.5, min: 0.5, max: 3, step: 0.125 },
      ],
      derived: [],
      shapes: [],
      assets: [],
      terrains: [],
      pipeline: [
        { id: 'carve', strategy: 'vcarve_text', params: { text: { ctrl: 'words' }, letterHeight: { ctrl: 'letterH' } } },
        { id: 'cutout', strategy: 'tag_cutout', params: { buffer: 0.5, cornerRadius: 0.75, tabs: true } },
      ],
    },
  },
  {
    id: 'coaster',
    title: 'Monogram coaster',
    blurb: 'Initials in the middle of a 4" disc, cut through with tabs.',
    next: 'Type different initials, then try the diameter slider — the verifier refuses the cut if the letters outgrow the disc.',
    recipe: {
      version: 2,
      name: 'Monogram coaster',
      stock: { thickness: 0.25 },
      margin: 0.375,
      controls: [
        { id: 'initials', type: 'text', label: 'Initials', default: 'AB' },
        { id: 'dia', type: 'number', label: 'Diameter (in)', default: 4, min: 3, max: 6, step: 0.25 },
      ],
      derived: [],
      shapes: [],
      assets: [],
      terrains: [],
      pipeline: [
        { id: 'carve', strategy: 'vcarve_text', params: { text: { ctrl: 'initials' }, letterHeight: 1.2 } },
        { id: 'disc', strategy: 'disc_cutout', params: { diameter: { ctrl: 'dia' }, tabs: true } },
      ],
    },
  },
  {
    id: 'textured_plaque',
    title: 'Textured plaque',
    blurb: 'A name left raised and clean while a ballnose textures the field around it.',
    next: 'Switch the texture dropdown — waves, hammered, woodgrain — and the whole field re-weaves around the name.',
    recipe: {
      version: 2,
      name: 'Textured plaque',
      stock: { thickness: 0.5 },
      margin: 0.375,
      controls: [
        { id: 'name', type: 'text', label: 'Name', default: 'Ada' },
        {
          id: 'tex', type: 'choice', label: 'Texture', default: 'waves',
          options: [
            { value: 'waves', label: 'waves' },
            { value: 'ripples', label: 'ripples' },
            { value: 'hammered', label: 'hammered' },
            { value: 'woodgrain', label: 'woodgrain' },
            { value: 'basketweave', label: 'basketweave' },
          ],
        },
      ],
      derived: [],
      shapes: [],
      assets: [],
      terrains: [],
      // no cutout: the board IS the plaque (the sign example demos tag_cutout)
      pipeline: [
        { id: 'carve', strategy: 'vcarve_text', params: { text: { ctrl: 'name' }, letterHeight: 1 } },
        { id: 'field', strategy: 'texture_field', params: { texture: { ctrl: 'tex' }, buffer: 0.35 } },
      ],
    },
  },
];
