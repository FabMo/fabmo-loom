// The Loom font shelf — curated open-license fonts the text strategies
// offer. Every entry ships in the repo (app/fonts/, OFL license alongside
// each file) so recipes stay reproducible: a recipe names a font id, never
// a URL. The blurb is written for the intent model: it is how the LLM
// decides which font matches "something handwritten".
//
// Paths are relative to app/ (the browser fetches them; test.mjs resolves
// them from this file's directory).

export const FONTS = [
  {
    id: 'bold-sans',
    label: 'Bold Sans (DejaVu)',
    file: '../examples/engraver/assets/DejaVuSans-Bold.ttf',
    blurb: 'sturdy neutral default; wide strokes pocket and V-carve well at any size',
  },
  {
    id: 'serif',
    label: 'Serif (Crimson Text)',
    file: 'fonts/CrimsonText-SemiBold.ttf',
    blurb: 'classic bookish serif; elegant for plaques and coasters, fine serifs favor V-carving over pocketing',
  },
  {
    id: 'script',
    label: 'Script (Pacifico)',
    file: 'fonts/Pacifico-Regular.ttf',
    blurb: 'flowing connected handwriting; the pick for "cursive"/"handwritten"; connected letters merge into one carved stroke',
  },
  {
    id: 'slab',
    label: 'Slab (Arvo Bold)',
    file: 'fonts/Arvo-Bold.ttf',
    blurb: 'heavy slab serifs with thick even strokes; reads strongly pocketed or carved, good for signs',
  },
  {
    id: 'condensed',
    label: 'Condensed (Bebas Neue)',
    file: 'fonts/BebasNeue-Regular.ttf',
    blurb: 'tall narrow all-caps display; fits long words on small tags (lowercase input renders as caps)',
  },
];

export const DEFAULT_FONT = 'bold-sans';

export function fontById(id) {
  return FONTS.find(f => f.id === id) ?? null;
}
