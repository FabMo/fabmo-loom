// "Download nested vectors": the woven layout as a DXF a CAM program
// (VCarve, Aspire, Fusion) imports to do its own toolpathing — the design
// lines in sheet coordinates (X0 Y0 at the board's bottom-left corner,
// inches), NOT the toolpaths. One layer per cut kind so each is one
// selection in VCarve:
//
//   SHEET            the board outline (the stock the weave sized or pinned)
//   PROFILE          each piece's outer outline — the cut-out
//   THROUGH          cutouts nested inside another cutout, and pockets
//                    whose floor is the full stock thickness
//   POCKET_D<depth>  pockets, one layer per floor depth; island rings ride
//                    the same layer (nested vectors on one layer ARE
//                    islands to a CAM program)
//   VCARVE           V-carved letter / shape outlines (counters as holes)
//   HOLES_D<dia>     bored holes as CIRCLEs, one layer per diameter
//   ENGRAVE          on-the-line traces (part labels)
//   RELIEF_BOUNDARY  the outline of a 3D relief (terrain, image carve) —
//                    the relief itself has no vectors; a warning says so
//
// Source: the weave result's preview.built entries — the same preview*
// fields the canvas, the 3D view and the picture-of-the-cut draw — plus
// each op's declared target when it has no preview field (guest ops), all
// shifted by preview.placement into sheet coordinates. Design lines, not
// kerf-offset paths: VCarve applies its own tool offsets.
//
// File flavour: strict R12 (AC1009), LTYPE table, only POLYLINE/VERTEX
// and CIRCLE entities — the one form every importer agrees on (the step
// app learned the hard way that VCarve drops LWPOLYLINE/R14 layer tables;
// see step_toolpath_app/modules/dxf-export.js).

const pair = (code, val) => `${code}\n${val}\n`;
const num = (v) => { const s = (Math.abs(v) < 1e-9 ? 0 : v).toFixed(5); return s.replace(/\.?0+$/, ''); };
const depthTag = (d) => num(Math.round(d * 1000) / 1000);

const LAYER_COLORS = { SHEET: 8, PROFILE: 7, THROUGH: 1, VCARVE: 6, ENGRAVE: 3, RELIEF_BOUNDARY: 9 };
const POCKET_COLOR = 5, HOLES_COLOR = 4;

function polylineEntity(points, layer, closed = true) {
  let e = pair(0, 'POLYLINE') + pair(8, layer) + pair(66, 1) + pair(70, closed ? 1 : 0)
    + pair(10, 0) + pair(20, 0) + pair(30, 0);
  for (const p of points) e += pair(0, 'VERTEX') + pair(8, layer) + pair(10, num(p.x)) + pair(20, num(p.y)) + pair(30, 0);
  return e + pair(0, 'SEQEND') + pair(8, layer);
}
const circleEntity = (c, r, layer) =>
  pair(0, 'CIRCLE') + pair(8, layer) + pair(10, num(c.x)) + pair(20, num(c.y)) + pair(30, 0) + pair(40, num(r));

// a closed ring without a duplicated closing vertex (the closed flag
// supplies that edge; a zero-length segment upsets some importers)
function cleanRing(ring) {
  const pts = ring.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
  return pts.length >= 3 ? pts : null;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const ringArea = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y); return Math.abs(a) / 2; };

// a target's rings, whatever shape it was declared in
function targetRings(target) {
  if (!target) return [];
  if (Array.isArray(target.rings)) return target.rings;
  if (Array.isArray(target.outer)) return [target.outer, ...(target.holes ?? [])];
  return [];
}

/**
 * weaveToDxf(result, { name }) → { dxf, warnings, entities, layers } or
 * { error } when the weave has nothing with a shape.
 */
export function weaveToDxf(result, { name = 'loom' } = {}) {
  const pre = result?.preview;
  const built = pre?.built ?? [];
  if (!pre || pre.empty || !built.length) return { error: 'nothing is built yet — there are no vectors to export' };
  const P = pre.placement ?? { x: 0, y: 0 };
  const stock = pre.stock ?? null;
  const T = (p) => ({ x: p.x + P.x, y: p.y + P.y });
  const warnings = [];
  const layers = new Map([['SHEET', LAYER_COLORS.SHEET]]);
  const useLayer = (n, color) => { if (!layers.has(n)) layers.set(n, color); return n; };
  let ents = '';
  let entities = 0;
  const addRing = (ring, layer, closed = true) => {
    const pts = cleanRing(ring.map(T));
    if (!pts) return;
    ents += polylineEntity(pts, layer, closed);
    entities++;
  };

  if (stock?.w > 0 && stock?.h > 0) {
    ents += polylineEntity([{ x: 0, y: 0 }, { x: stock.w, y: 0 }, { x: stock.w, y: stock.h }, { x: 0, y: stock.h }], 'SHEET');
  }
  const thickness = stock?.thickness ?? Infinity;
  const isThrough = (depth) => Number.isFinite(depth) && depth >= thickness - 1e-6;

  // ---- cutouts first: PROFILE, or THROUGH when nested inside another cutout
  const cutouts = [];
  const samePoint = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  for (const b of built) {
    const r = b?.r ?? {};
    const hasRing = Array.isArray(r.previewRing) && r.previewRing.length >= 3;
    if (hasRing) cutouts.push({ ring: r.previewRing, op: b.op?.id });
    // a profile target's OTHER rings are through-cuts inside the piece (a
    // furniture panel's mortises ride on its release op as rings[1..])
    if (r.target?.type === 'profile' && r.target.side !== 'on' && (hasRing || (!r.previewRegions && !r.previewVee && !r.previewHoles))) {
      for (const ring of targetRings(r.target)) {
        if (!(ring?.length >= 3) || (hasRing && samePoint(ring[0], r.previewRing[0]))) continue;
        cutouts.push({ ring, op: b.op?.id });
      }
    }
  }
  cutouts.sort((a, b) => ringArea(b.ring) - ringArea(a.ring));   // outer before inner
  for (let i = 0; i < cutouts.length; i++) {
    const c = cutouts[i];
    const nested = cutouts.some((o, j) => j < i && o !== c && pointInRing(c.ring[0], o.ring) && ringArea(o.ring) > ringArea(c.ring) * 1.0001);
    addRing(c.ring, nested ? useLayer('THROUGH', LAYER_COLORS.THROUGH) : useLayer('PROFILE', LAYER_COLORS.PROFILE));
  }

  // ---- everything else, op by op
  const skipped3d = [];
  for (const b of built) {
    const r = b?.r ?? {};
    const opId = b.op?.id ?? '?';
    let drew = false;
    if (r.previewVee?.regions?.length) {
      for (const reg of r.previewVee.regions) {
        if (!(reg?.outer?.length >= 3)) continue;
        const layer = useLayer('VCARVE', LAYER_COLORS.VCARVE);
        addRing(reg.outer, layer);
        for (const h of reg.holes ?? []) if (h?.length >= 3) addRing(h, layer);
        drew = true;
      }
    } else if (r.previewRegions?.length) {
      const relief = r.target?.type === 'heightmap';
      const depth = r.target?.depth;
      const layer = relief ? useLayer('RELIEF_BOUNDARY', LAYER_COLORS.RELIEF_BOUNDARY)
        : isThrough(depth) ? useLayer('THROUGH', LAYER_COLORS.THROUGH)
          : useLayer(`POCKET_D${depthTag(Number.isFinite(depth) && depth > 0 ? depth : 0)}`, POCKET_COLOR);
      for (const reg of r.previewRegions) {
        if (!(reg?.outer?.length >= 3)) continue;
        addRing(reg.outer, layer);
        for (const h of reg.holes ?? []) if (h?.length >= 3) addRing(h, layer);
        drew = true;
      }
      if (relief) skipped3d.push(opId);
    }
    if (r.previewHoles?.length) {
      for (const hh of r.previewHoles) {
        const c = hh?.x != null ? hh : hh?.center ?? hh?.at;
        const rad = hh?.r ?? (hh?.diameter ?? hh?.d ?? 0.25) / 2;
        if (!(c?.x != null && rad > 0)) continue;
        ents += circleEntity(T(c), rad, useLayer(`HOLES_D${depthTag(2 * rad)}`, HOLES_COLOR));
        entities++;
        drew = true;
      }
    }
    if (drew || (Array.isArray(r.previewRing) && r.previewRing.length >= 3)) continue;
    // no preview field: the declared target is the honest fallback (guest ops)
    const t = r.target;
    if (!t) continue;
    if (t.type === 'profile') {
      if (t.side !== 'on') continue;   // 'outside'/'inside' profiles were drawn with the cutouts above
      for (const ring of targetRings(t)) addRing(ring, useLayer('ENGRAVE', LAYER_COLORS.ENGRAVE));
    } else if (t.type === 'region') {
      const rings = targetRings(t);
      if (!rings.length) continue;
      const layer = isThrough(t.depth) ? useLayer('THROUGH', LAYER_COLORS.THROUGH) : useLayer(`POCKET_D${depthTag(t.depth > 0 ? t.depth : 0)}`, POCKET_COLOR);
      for (const ring of rings) addRing(ring, layer);
    } else if (t.type === 'heightmap') {
      skipped3d.push(opId);
    }
  }
  if (skipped3d.length) warnings.push(`3D relief op${skipped3d.length === 1 ? '' : 's'} ${skipped3d.map(s => `"${s}"`).join(', ')}: a relief has no vectors — only its boundary is drawn (RELIEF_BOUNDARY); carve it from Loom's own file`);
  if (!entities) return { error: 'nothing here has a vector outline to export' };

  let table = '';
  for (const [n, color] of layers) table += pair(0, 'LAYER') + pair(2, n) + pair(70, 0) + pair(62, color) + pair(6, 'CONTINUOUS');
  const header = pair(0, 'SECTION') + pair(2, 'HEADER')
    + pair(9, '$ACADVER') + pair(1, 'AC1009')
    + pair(9, '$INSUNITS') + pair(70, 1)
    + pair(9, '$EXTMIN') + pair(10, 0) + pair(20, 0) + pair(30, 0)
    + pair(9, '$EXTMAX') + pair(10, num(stock?.w ?? 0)) + pair(20, num(stock?.h ?? 0)) + pair(30, 0)
    + pair(0, 'ENDSEC');
  const ltypes = pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1)
    + pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0) + pair(3, 'Solid line') + pair(72, 65) + pair(73, 0) + pair(40, '0.0')
    + pair(0, 'ENDTAB');
  const tables = pair(0, 'SECTION') + pair(2, 'TABLES') + ltypes
    + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.size) + table + pair(0, 'ENDTAB')
    + pair(0, 'ENDSEC');
  const dxf = pair(999, `Loom — ${name} — nested vectors, inches, X0 Y0 = board corner`) + header + tables
    + pair(0, 'SECTION') + pair(2, 'ENTITIES') + ents + pair(0, 'ENDSEC') + pair(0, 'EOF');
  return { dxf, warnings, entities, layers: [...layers.keys()] };
}

/** Minimal reader for tests: entities as { type, layer, points, closed, center, r }. */
export function parseDxfEntities(dxf) {
  const lines = dxf.split(/\r?\n/);
  const out = [];
  let section = null, cur = null, vertex = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = +lines[i].trim(), val = lines[i + 1].trim();
    if (code === 0) {
      if (val === 'SECTION') { section = null; continue; }
      if (val === 'ENDSEC') { flush(); section = null; continue; }
      if (section !== 'ENTITIES') continue;
      if (val === 'VERTEX' && cur?.type === 'POLYLINE') { vertex = { x: NaN, y: NaN }; cur.points.push(vertex); continue; }
      if (val === 'SEQEND') { flush(); vertex = null; continue; }
      flush(); vertex = null; cur = { type: val, layer: '', points: [], closed: false, center: null, r: null };
      continue;
    }
    if (code === 2 && section === null && val === 'ENTITIES') { section = 'ENTITIES'; continue; }
    if (!cur) continue;
    if (code === 8 && !vertex) cur.layer = val;
    if (vertex) { if (code === 10) vertex.x = +val; if (code === 20) vertex.y = +val; continue; }
    if (cur.type === 'POLYLINE' && code === 70) cur.closed = (+val & 1) === 1;
    if (cur.type === 'CIRCLE') {
      if (code === 10) cur.center = { ...(cur.center ?? {}), x: +val };
      if (code === 20) cur.center = { ...(cur.center ?? {}), y: +val };
      if (code === 40) cur.r = +val;
    }
  }
  flush();
  return out;
}
