# Engrave Anything

Type a word → real font outlines → medial-axis V-carve → **verified** →
cut it. Run it from the repo root with any static server:

```bash
npx http-server .    # then open /examples/engraver/
```

`node examples/engraver/test.mjs` runs its gauntlet (also part of `npm test`).

## The prompt that builds this app

Apps on Loom are meant to be *regenerable* — the foundation is the asset,
the app is the disposable interface. This app is what an AI coding agent
pointed at this repo should produce from roughly this prompt:

> Build a single-page app in `examples/` of this repo: visitors type a
> word or short phrase, watch a live preview of it V-carved into a wood
> blank, and download the toolpath to cut it. Use a real font, bundled so
> the app works offline, and the medial-axis V-carve kernel that's
> already in `vendor/v_engraver`. Letter height, stock size (default
> 8 × 2.5 × 0.5") and V-bit angle (default 60°) should be adjustable. It
> has to be simple enough for a stranger at a fair booth to drive with no
> instructions, and it must never hand out a file the verifier hasn't
> accepted — show the verifier's numbers on screen. Include a test that
> proves it both ways: clean text verifies, sabotaged motion gets
> rejected.

Note the division of labor. Everything **in** the prompt is something
only the human knows: who the users are, the offline constraint, the
shop's stock and bit. Everything **absent** is supplied by the
foundation: the CAM geometry (kernels), the file formats (posts), the
module map and the discipline (AGENTS.md — "never hand out an unverified
file" is a non-negotiable there whether or not the prompt repeats it).

The foundation doesn't make the prompt smarter; it makes the prompt
*shorter*. Without this repo, the same request would need hundreds of
lines of unverified CAM expertise. With it, ~110 words of intent is the
entire human contribution.

## The second prompt: iteration

Generation is half the story; a bespoke tool earns its keep when the next
request is cheap. The tag-cutout feature in this app came from exactly
this prompt:

> Also add an automatic profile to cut out the V-carved text, with a
> buffer of about 0.25" around the text and rounded corners (roughly
> 0.5" radius).

~30 words, because the expensive parts already exist: the outside-profile
strategy (`strategies/profile.js`, ramp entry, depth passes), the
composer (owns the toolchange), and the verifier (a profile target with
`side:'outside'` makes "the endmill wandered into the tag body" an error
with measured area). The feature is one more operation in the same Job —
two tools, two independent declarations, one verified program. Iteration
stays cheap as long as requests decompose onto the foundation; the day
one doesn't, that's a gap report — file it.

## Build notes an agent (or human) will want

- **opentype.js v2's shaper throws** on some fonts' GSUB tables (DejaVu's
  lookup type 6 format 2). Layout glyph-by-glyph — `charToGlyph` +
  advances + kern pairs — instead of `font.getPath(string)`. Cost:
  ligatures; fine for engraving.
- **Counters must arrive as holes** (the enclosed bowls of e, o, p), or
  the V-carve plows through them. Containment depth by even-odd counting;
  don't trust font winding conventions. For verifier region targets,
  holes must wind **opposite** their outers (nonzero fill).
- **Hairline tools need per-sample containment checks.** An area-based
  intrusion test erodes a 0.002"-wide stray ribbon to nothing — the
  sabotage passes silently. The region target's per-sample gouge check
  catches any single sample outside the letterforms. When a sabotage
  test passes, fix the declaration — never loosen the verifier.
- **The V-bit is declared as the point tip the kernel models**
  (`tipDiameter: 0.002`): the medial axis cuts exactly into corner
  apexes, where a physical tip flat overhangs by half its width —
  sub-visible, below the platform's tolerance floor, documented in
  `pipeline.mjs`.
- **`vendor/` imports the bare specifier `d3-delaunay`** (it's synced
  from the workspace and can't be edited here); the browser resolves it
  via the importmap in `index.html` pointing into `node_modules` —
  `npm install` first.
