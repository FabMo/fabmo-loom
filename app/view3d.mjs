// The 3D preview: the simulated cut surface (app/sim.mjs) rendered as a
// lit, orbitable heightfield over a stock block. Rotation via
// OrbitControls; rendering is on-demand (no animation loop) so an idle
// preview costs nothing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BASE = new THREE.Color(0xf3ead8);   // stock top (matches the 2D board)
const CUT = new THREE.Color(0x9c7a4e);    // deep-cut tint
const SIDE = new THREE.Color(0xe2d6ba);

export function createView3D(container, { width = 1160, height = 600 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.style.cssText = 'width:100%; height:auto; display:block; border-radius:10px; border:1px solid #e3e1d8;';
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfdfdfb);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 200);
  camera.up.set(0, 0, 1);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8272, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, -3, 5);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xfff4e0, 0.5);
  fill.position.set(-3, 2, -2);   // underside fill so low orbits stay readable
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', () => renderer.render(scene, camera));

  let group = null;
  let framedFor = '';

  function disposeGroup() {
    if (!group) return;
    group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    scene.remove(group);
    group = null;
  }

  function frame(stock) {
    const key = `${stock.w}|${stock.h}`;
    if (framedFor === key) return;     // keep the user's rotation across re-weaves
    framedFor = key;
    const cx = stock.w / 2, cy = stock.h / 2;
    const span = Math.max(stock.w, stock.h);
    camera.position.set(cx, cy - span * 1.15, span * 0.95);
    controls.target.set(cx, cy, -stock.thickness / 2);
    controls.update();
  }

  /**
   * @param {ReturnType<import('./sim.mjs').simulateJob>|null} sim
   * @param {{w,h,thickness}} stock
   */
  function update(sim, stock) {
    disposeGroup();
    group = new THREE.Group();

    // stock block, top face a hair below Z=0 so the heightfield owns the surface
    const t = stock.thickness;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(stock.w, stock.h, t - 0.002),
      new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9 }),
    );
    box.position.set(stock.w / 2, stock.h / 2, -(t + 0.002) / 2);
    group.add(box);

    if (sim) {
      const { grid, cols, rows, dx } = sim;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(cols * rows * 3);
      const col = new Float32Array(cols * rows * 3);
      const tmp = new THREE.Color();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const z = Math.max(grid[i], -t + 0.001);   // stay a hair above the box bottom
          pos[i * 3] = c * dx;
          pos[i * 3 + 1] = r * dx;
          pos[i * 3 + 2] = z;
          const frac = Math.min(1, -grid[i] / Math.max(t, 1e-6));
          tmp.copy(BASE).lerp(CUT, frac === 0 ? 0 : 0.25 + 0.75 * frac);
          col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
        }
      }
      const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let k = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
          idx[k++] = a; idx[k++] = b; idx[k++] = d;
          idx[k++] = b; idx[k++] = e; idx[k++] = d;
        }
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })));
    }

    scene.add(group);
    frame(stock);
    renderer.render(scene, camera);
  }

  return { update, domElement: renderer.domElement };
}
