// Assembled-view layer gauntlet (node, no DOM): blind pockets render as
// recesses, not through slots; panels of another sheet ghost in at their
// assembled pose; the active panels still travel from board to piece.
import { buildAssemblyLayer, panelSlabs, GHOST_OPACITY } from '../app/assembly3d.mjs';

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures++; console.log(`  ✗ FAIL ${m}`); };

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const outer = rect(0, 0, 8, 4);
const throughHole = rect(6, 1, 7, 3);
const dado = { ring: rect(1, 0.5, 1.75, 3.5), depth: 0.375 };   // half of 3/4 stock
const stopped = { ring: rect(3, 1, 4, 2), depth: 0.5 };

console.log('--- panelSlabs: pockets cut from the top face, floors closed ---');
{
  const slabs = panelSlabs(outer, [throughHole], [dado, stopped], 0.75);
  // depths 0.375 and 0.5 → three slabs: 0–0.375, 0.375–0.5, 0.5–0.75 below the top
  if (slabs.length === 3) pass('two pocket depths → 3 slabs');
  else fail(`slab count ${slabs.length}`);
  const span = (g) => { g.computeBoundingBox(); return [+g.boundingBox.min.z.toFixed(4), +g.boundingBox.max.z.toFixed(4)]; };
  const spans = slabs.map((s) => span(s.geo));
  const want = [[0.375, 0.75], [0.25, 0.375], [0, 0.25]];
  if (JSON.stringify(spans) === JSON.stringify(want)) pass(`slabs stack top-down ${JSON.stringify(spans)}`);
  else fail(`slab z spans ${JSON.stringify(spans)} want ${JSON.stringify(want)}`);
  // hole count per slab shows in the vertex count: top slab carries the
  // through hole + both pockets, middle slab the through hole + the deeper
  // pocket, bottom slab the through hole only
  const nv = slabs.map((s) => s.geo.getAttribute('position').count);
  if (nv[0] > nv[1] && nv[1] > nv[2]) pass(`hole complexity falls with depth (${nv.join(' > ')} vertices)`);
  else fail(`vertex counts ${nv.join(', ')}`);
  const plain = panelSlabs(outer, [throughHole], [], 0.75);
  if (plain.length === 1 && span(plain[0].geo)[1] === 0.75) pass('no pockets → one full-thickness slab (the old behavior)');
  else fail(`plain slab wrong: ${plain.length}`);
  const through = panelSlabs(outer, [], [{ ring: throughHole, depth: 0.75 }], 0.75);
  if (through.length === 1) pass('a pocket as deep as the stock is a through hole — no extra slab');
  else fail(`full-depth pocket made ${through.length} slabs`);
}

console.log('--- layer: ghosts of the other sheet, active panels travel ---');
{
  const asm = {
    opId: 'cab', box: [8, 4, 4],
    panels: [
      { id: 'side_a', thickness: 0.75, rings: [outer], pockets: [dado], sheet: { x: 1, y: 1, rot: 0 },
        world: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, setup: 1, active: true },
      { id: 'shelf', thickness: 0.75, rings: [outer], sheet: { x: 1, y: 6, rot: 0 },
        world: { origin: [0, 2, 0], u: [1, 0, 0], v: [0, 0, 1] }, setup: 2, active: false },
    ],
  };
  const layer = buildAssemblyLayer([asm], { x: 0, y: 0 }, { w: 20, h: 12, thickness: 0.75 });
  if (layer.count === 2 && layer.activeCount === 1 && layer.ghostCount === 1) pass('2 panels: 1 in this board, 1 ghost');
  else fail(`counts ${layer.count}/${layer.activeCount}/${layer.ghostCount}`);
  const [a, g] = layer.parts;
  const posOf = (node) => { const e = node.matrix.elements; return [e[12], e[13], e[14]]; };
  layer.setBlend(0);
  if (!g.node.visible) pass('ghost hidden at blend 0 (it is not in this board)');
  else fail('ghost visible at blend 0');
  const a0 = posOf(a.node);
  if (Math.abs(a0[2] + 0.75) < 1e-9 && Math.abs(a0[0] - 1) < 1e-9) pass(`active panel lies in the board at blend 0 (${a0.map((v) => v.toFixed(2)).join(', ')})`);
  else fail(`active flat pose wrong ${a0}`);
  layer.setBlend(1);
  const a1 = posOf(a.node), g1 = posOf(g.node);
  if (g.node.visible && Math.hypot(...a1.map((v, i) => v - a0[i])) > 1) pass('at blend 1 the active panel travelled and the ghost shows');
  else fail(`blend 1: ghost visible ${g.node.visible}, travel ${Math.hypot(...a1.map((v, i) => v - a0[i]))}`);
  const mat = g.node.children[0].material[0];
  if (mat.transparent && Math.abs(mat.opacity - GHOST_OPACITY) < 1e-9 && mat.depthWrite === false) pass(`ghost material see-through at ${GHOST_OPACITY}`);
  else fail(`ghost material ${JSON.stringify({ t: mat.transparent, o: mat.opacity, dw: mat.depthWrite })}`);
  layer.setBlend(0.5);
  const gMid = posOf(g.node);
  if (gMid.every((v, i) => Math.abs(v - g1[i]) < 1e-9) && Math.abs(mat.opacity - GHOST_OPACITY / 2) < 1e-9) pass('ghost holds its assembled pose and fades with the blend');
  else fail('ghost moved or did not fade');
  if (a.node.children.length === 2 && g.node.children.length === 1) pass('dadoed side is 2 slabs, plain shelf is 1');
  else fail(`slab children ${a.node.children.length}/${g.node.children.length}`);
  layer.dispose();
}

console.log(failures === 0 ? '\nALL ASSEMBLY3D CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
