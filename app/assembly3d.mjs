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

import * as THREE from 'three';

const FACE = 0xf3ead8;   // matches the board top
const SIDE = 0xe2d6ba;   // matches the stock shell walls

const UNIT = new THREE.Vector3(1, 1, 1);

function poseToMatrix(pose) {
  const u = new THREE.Vector3(...pose.u);
  const v = new THREE.Vector3(...pose.v);
  const w = new THREE.Vector3().crossVectors(u, v);
  return new THREE.Matrix4()
    .makeBasis(u, v, w)
    .setPosition(new THREE.Vector3(...pose.origin));
}

export function buildAssemblyLayer(assemblies, placement, stock) {
  const group = new THREE.Group();
  const parts = [];
  const faceMat = new THREE.MeshStandardMaterial({ color: FACE, roughness: 0.85, metalness: 0 });
  const sideMat = new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9, metalness: 0 });

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
      const shape = new THREE.Shape(outer.map((q) => new THREE.Vector2(q.x, q.y)));
      for (const h of holes) {
        shape.holes.push(new THREE.Path(h.map((q) => new THREE.Vector2(q.x, q.y))));
      }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: panel.thickness, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, [faceMat, sideMat]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;

      // pose 0: flat in the board, exactly where it is cut (top at z=0)
      const m0 = new THREE.Matrix4().makeTranslation(
        (panel.sheet?.x ?? 0) + (placement?.x ?? 0),
        (panel.sheet?.y ?? 0) + (placement?.y ?? 0),
        -panel.thickness);
      // pose 1: assembled
      const m1 = poseToMatrix(panel.world).premultiply(up);

      const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion();
      const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m0.decompose(p0, q0, s);
      m1.decompose(p1, q1, s);
      group.add(mesh);
      parts.push({ mesh, p0, q0, p1, q1 });
    }
  }

  // panels lift over an arc as they travel — enough to clear the board,
  // scaled so a 1:6 model doesn't fling parts to the ceiling
  const lift = Math.max(0.75, stock.thickness * 4);
  const STAGGER = 0.35;   // later panels trail the earlier ones slightly

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  function setBlend(t) {
    const n = parts.length;
    parts.forEach((part, i) => {
      const lead = n > 1 ? (i / (n - 1)) * STAGGER : 0;
      const ti = Math.min(1, Math.max(0, t * (1 + STAGGER) - lead));
      pos.copy(part.p0).lerp(part.p1, ti);
      pos.z += Math.sin(Math.PI * ti) * lift;
      quat.copy(part.q0).slerp(part.q1, ti);
      part.mesh.matrix.compose(pos, quat, UNIT);
    });
  }
  setBlend(0);

  function dispose() {
    for (const { mesh } of parts) mesh.geometry.dispose();
    faceMat.dispose();
    sideMat.dispose();
  }

  return { group, setBlend, dispose, count: parts.length };
}
