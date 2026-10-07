// Assembled-view layer: any catalog op may return `assembly` alongside
// its ops — flat panels (rings in the op frame, y-up), each with its spot
// on the sheet and its world pose in the piece's own Y-up frame. This
// module builds one THREE group whose panels BLEND between lying in the
// machined board (blend 0) and standing assembled on top of it (blend 1):
// the piece literally rising out of the plywood.
//
// Pose contract ({ origin:[x,y,z], u:[3], v:[3] }): ring point (a, b)
// maps to origin + a·u + b·v, extruded along w = u×v by the panel
// thickness. Guests emit proper rotations only (det +1 with that w), so
// poses tween as rigid motions — position lerp + quaternion slerp, no
// mirrored meshes.
//
// Frames: sheet poses are working-frame (the same coords as moves, so the
// preview placement shift applies); world poses are Y-up and get composed
// here with a +90°-about-X rotation into the view's Z-up frame, footprint
// centered on the stock, feet on the stock top (z = 0).
//
// Two refinements (AGENTS.md "Mounting a guest app" §4):
// - `pockets: [{ ring, depth }]` are BLIND recesses (dados, blind
//   mortises, stopped bores). They are cut `depth` deep from the machined
//   face, not punched through — a dadoed cabinet side used to render as a
//   side with five slots through it (field report 2026-10-06). The solid
//   is built as slabs stacked from the top face down: a slab inside a
//   pocket's depth carries the pocket ring as a hole, the slab beneath
//   closes its floor; through holes punch every slab.
// - `active: false` marks a panel this weave does NOT cut (it lies on
//   another sheet of a multi-setup layout). It is not in this board, so
//   it has no flat pose: it sits at its assembled pose and fades in
//   ghosted as the blend runs, so the whole piece is always on show.

import * as THREE from 'three';
import { meshTheme, themedSurfaceMaterial, themedSideMaterial } from './view3d.mjs';

const FACE = 0xf3ead8;   // matches the board top
const SIDE = 0xe2d6ba;   // matches the stock shell walls
export const GHOST_OPACITY = 0.42;   // other-sheet panels at full assembly

const UNIT = new THREE.Vector3(1, 1, 1);

function poseToMatrix(pose) {
  const u = new THREE.Vector3(...pose.u);
  const v = new THREE.Vector3(...pose.v);
  const w = new THREE.Vector3().crossVectors(u, v);
  return new THREE.Matrix4()
    .makeBasis(u, v, w)
    .setPosition(new THREE.Vector3(...pose.origin));
}

const toV2 = (ring) => ring.map((q) => new THREE.Vector2(q.x, q.y));

// The panel solid as slabs, local z from 0 (back face) to `thickness`
// (the machined top face). Returns [{ geo, top, bottom }] top-down.
export function panelSlabs(outer, holes, pockets, thickness) {
  const depths = [...new Set((pockets ?? [])
    .map((p) => +Math.min(thickness, Math.max(0, +p.depth || 0)).toFixed(5)))]
    .filter((d) => d > 1e-6 && d < thickness - 1e-6)
    .sort((a, b) => a - b);
  const bounds = [0, ...depths, thickness];   // depths below the top face
  const slabs = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const d0 = bounds[k], d1 = bounds[k + 1];
    const shape = new THREE.Shape(toV2(outer));
    for (const h of holes) if (h?.length >= 3) shape.holes.push(new THREE.Path(toV2(h)));
    for (const p of pockets ?? []) {
      // a pocket reaches this slab when its floor is at or below the slab's bottom
      if (p.ring?.length >= 3 && +p.depth >= d1 - 1e-6) shape.holes.push(new THREE.Path(toV2(p.ring)));
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d1 - d0, bevelEnabled: false });
    geo.translate(0, 0, thickness - d1);
    slabs.push({ geo, top: thickness - d0, bottom: thickness - d1 });
  }
  return slabs;
}

export function buildAssemblyLayer(assemblies, placement, stock) {
  const group = new THREE.Group();
  const parts = [];
  // panels follow the fleet mesh theme (SB1 glow, SB Light greyscale);
  // wood otherwise — same rule as the board in view3d.mjs
  const mt = meshTheme();
  const faceMat = mt ? themedSurfaceMaterial(mt)
    : new THREE.MeshStandardMaterial({ color: FACE, roughness: 0.85, metalness: 0 });
  const sideMat = mt ? themedSideMaterial(mt)
    : new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9, metalness: 0 });
  // ghosts: the same look, see-through, never writing depth (so the real
  // panels behind them stay crisp); opacity rides the blend
  const ghostFace = faceMat.clone(), ghostSide = sideMat.clone();
  for (const m of [ghostFace, ghostSide]) { m.transparent = true; m.opacity = 0; m.depthWrite = false; }
  const geos = [];

  for (const asm of assemblies) {
    // assembled placement in the view frame: piece Y-up → view Z-up
    // (proper rotation), footprint centered over the stock, feet at z=0.
    // After Rx(+90°): world (X, Y, Z) → view (X, −Z, Y).
    const [W = 0, , D = 0] = asm.box ?? [];
    const up = new THREE.Matrix4().makeRotationX(Math.PI / 2)
      .premultiply(new THREE.Matrix4().makeTranslation(
        stock.w / 2 - W / 2, stock.h / 2 + D / 2, 0));

    for (const panel of asm.panels ?? []) {
      const [outer, ...holes] = panel.rings;
      if (!outer?.length) continue;
      const active = panel.active !== false;
      const mats = active ? [faceMat, sideMat] : [ghostFace, ghostSide];
      const node = new THREE.Group();
      node.matrixAutoUpdate = false;
      for (const slab of panelSlabs(outer, holes, panel.pockets, panel.thickness)) {
        const mesh = new THREE.Mesh(slab.geo, mats);
        mesh.castShadow = active;
        mesh.receiveShadow = true;
        node.add(mesh);
        geos.push(slab.geo);
      }

      // pose 1: assembled
      const m1 = poseToMatrix(panel.world).premultiply(up);
      // pose 0: flat in the board, exactly where it is cut (top at z=0).
      // sheet.rot (degrees, about the op origin BEFORE translation) mirrors
      // the guest's own placement math — a nested panel lies turned. A
      // panel of ANOTHER sheet is not in this board: its pose 0 is pose 1.
      const m0 = active
        ? new THREE.Matrix4().makeRotationZ(((panel.sheet?.rot ?? 0) * Math.PI) / 180)
          .premultiply(new THREE.Matrix4().makeTranslation(
            (panel.sheet?.x ?? 0) + (placement?.x ?? 0),
            (panel.sheet?.y ?? 0) + (placement?.y ?? 0),
            -panel.thickness))
        : m1;

      const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion();
      const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m0.decompose(p0, q0, s);
      m1.decompose(p1, q1, s);
      group.add(node);
      parts.push({ node, p0, q0, p1, q1, active, id: panel.id, setup: panel.setup ?? 1 });
    }
  }
  const activeParts = parts.filter((p) => p.active);
  activeParts.forEach((p, i) => { p.k = i; });

  // panels lift over an arc as they travel — enough to clear the board,
  // scaled so a 1:6 model doesn't fling parts to the ceiling
  const lift = Math.max(0.75, stock.thickness * 4);
  const STAGGER = 0.35;   // later panels trail the earlier ones slightly

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  function setBlend(t) {
    const tc = Math.min(1, Math.max(0, t));
    ghostFace.opacity = ghostSide.opacity = GHOST_OPACITY * tc;
    const n = activeParts.length;
    for (const part of parts) {
      if (!part.active) {
        part.node.visible = tc > 0.01;
        part.node.matrix.compose(part.p1, part.q1, UNIT);
        continue;
      }
      const lead = n > 1 ? (part.k / (n - 1)) * STAGGER : 0;
      const ti = Math.min(1, Math.max(0, t * (1 + STAGGER) - lead));
      pos.copy(part.p0).lerp(part.p1, ti);
      pos.z += Math.sin(Math.PI * ti) * lift;
      quat.copy(part.q0).slerp(part.q1, ti);
      part.node.matrix.compose(pos, quat, UNIT);
    }
  }
  setBlend(0);

  function dispose() {
    for (const g of geos) g.dispose();
    faceMat.dispose();
    sideMat.dispose();
    ghostFace.dispose();
    ghostSide.dispose();
  }

  return {
    group, setBlend, dispose,
    count: parts.length,
    activeCount: activeParts.length,
    ghostCount: parts.length - activeParts.length,
    parts,
  };
}
