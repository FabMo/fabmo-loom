// The 3D preview: the simulated cut surface (app/sim.mjs) rendered as a
// lit, orbitable heightfield over a stock block. Rotation via
// OrbitControls; rendering is on-demand (no animation loop) so an idle
// preview costs nothing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BASE = new THREE.Color(0xf3ead8);   // stock top (matches the 2D board)
const CUT = new THREE.Color(0x9c7a4e);    // deep-cut tint
const SIDE = new THREE.Color(0xe2d6ba);

// separable box blur of the depth grid (edge-normalized). Feeds the baked
// cavity/ambient-occlusion term: a cell below its neighborhood average is
// inside a recess and gets darkened — the cue that makes grooves and
// pocket walls read as DEPTH from any angle, shadows or not.
function boxBlurGrid(grid, cols, rows, r) {
  const tmp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let row = 0; row < rows; row++) {
    const o = row * cols;
    let sum = 0, n = 0;
    for (let c = 0; c < Math.min(cols, r + 1); c++) { sum += grid[o + c]; n++; }
    for (let c = 0; c < cols; c++) {
      tmp[o + c] = sum / n;
      const add = c + r + 1, drop = c - r;
      if (add < cols) { sum += grid[o + add]; n++; }
      if (drop >= 0) { sum -= grid[o + drop]; n--; }
    }
  }
  for (let c = 0; c < cols; c++) {
    let sum = 0, n = 0;
    for (let row = 0; row < Math.min(rows, r + 1); row++) { sum += tmp[row * cols + c]; n++; }
    for (let row = 0; row < rows; row++) {
      out[row * cols + c] = sum / n;
      const add = row + r + 1, drop = row - r;
      if (add < rows) { sum += tmp[add * cols + c]; n++; }
      if (drop >= 0) { sum -= tmp[drop * cols + c]; n--; }
    }
  }
  return out;
}

// Fleet mesh theming: themes that declare --t-mesh-style: themed (ShopBot
// 1.0's orange glow, ShopBot Light's greyscale, toolpath.net's green)
// restyle 3D models across every labs app. Returns null on every other
// theme — and always in public clones, where no tokens are served — so
// the wood stays what it is: the material, not a theme surface.
export function meshTheme() {
  const css = getComputedStyle(document.body);
  const read = (p, f) => css.getPropertyValue(p).trim() || f;
  if (read('--t-mesh-style', '') !== 'themed') return null;
  return {
    color: read('--t-mesh-default', '#cccccc'),
    board: read('--t-mesh-board', ''),
    opacity: parseFloat(read('--t-mesh-opacity', '1')),
    emissive: read('--t-mesh-emissive', '#000000'),
    emissiveIntensity: parseFloat(read('--t-mesh-emissive-intensity', '0')),
    roughness: parseFloat(read('--t-mesh-roughness', '0.85')),
  };
}

// Heightfield material under a mesh theme: a flat themed color (vertex
// colors are wood tones — SB Light's greyscale must not inherit them);
// the raking sun and shadows keep the relief legible.
export function themedSurfaceMaterial(mt) {
  return new THREE.MeshStandardMaterial({
    color: mt.color,
    roughness: mt.roughness,
    metalness: 0,
    emissive: mt.emissive,
    emissiveIntensity: mt.emissiveIntensity,
    transparent: mt.opacity < 1,
    opacity: mt.opacity,
  });
}

export function themedSideMaterial(mt) {
  return new THREE.MeshStandardMaterial({
    color: (mt.board && mt.board !== 'transparent') ? mt.board : SIDE,
    roughness: mt.roughness,
    metalness: 0,
    emissive: mt.emissive,
    emissiveIntensity: mt.emissiveIntensity * 0.3,
    transparent: mt.opacity < 1,
    opacity: mt.opacity,
  });
}

export function createView3D(container, { width = 1160, height = 600 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // physical lighting divides by π, which parks the whole matte scene in a
  // dim narrow band and crushes every depth cue (tint, hillshade, shadow)
  // into a few gray levels. Linear exposure lifts the top face to ~90%
  // white so the cut colors have real contrast range below it.
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 2.0;
  renderer.domElement.style.cssText = 'width:100%; height:auto; display:block; border-radius:10px; border:1px solid #e3e1d8;';
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfdfdfb);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 200);
  camera.up.set(0, 0, 1);

  // more directional than ambient: groove walls must shade differently
  // from the flat top or carves read as painted lines. The sun casts
  // shadows — a raking light self-shadowing the grooves is the cue that
  // finally makes 0.1"-deep carving read as depth at board scale.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8272, 0.55));
  // intensity sized so sun-facing groove walls stay below clip at the
  // linear exposure above (tinted albedo ≤ ~0.76 × irradiance ~1.9 × 2.0/π)
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  // bias tuned for engraving-scale features: normalBias comparable to a
  // groove width erases exactly the self-shadowing that reads as depth
  sun.shadow.bias = -0.00005;
  sun.shadow.normalBias = 0.001;
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xfff4e0, 0.4);
  fill.position.set(-3, 2, -2);   // underside fill so low orbits stay readable
  scene.add(fill);

  // aim the raking sun and fit its shadow camera to this stock
  function placeSun(stock) {
    const cx = stock.w / 2, cy = stock.h / 2;
    const span = Math.max(stock.w, stock.h);
    sun.position.set(cx + span * 0.7, cy - span * 0.9, span * 0.55);
    sun.target.position.set(cx, cy, 0);
    const sc = sun.shadow.camera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span;
    sc.near = 0.05; sc.far = span * 4;
    sc.updateProjectionMatrix();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', () => renderer.render(scene, camera));

  let group = null;
  let framedFor = '';

  function disposeGroup() {
    if (!group) return;
    group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
    });
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
   * @param {number} zScale  vertical scale for the whole solid (stock slab
   *   included). Callers pass 1 (true scale) — vee carves render their ideal
   *   analytic surface (see vcarve-surface.mjs) so depth reads without any
   *   exaggeration; kept as a param for one-off diagnostics.
   * @param {number} [tintRange]  depth (positive inches) that maps to the
   *   full cut tint — pass the job's FEATURE depth so an engraving next to
   *   a through cut still uses the whole color scale
   */
  let lastArgs = null;   // retheme() rebuilds the board under a new theme

  function update(sim, stock, zScale = 1, tintRange = null) {
    lastArgs = [sim, stock, zScale, tintRange];
    const mt = meshTheme();
    disposeGroup();
    group = new THREE.Group();
    group.scale.z = zScale;

    // stock shell: side walls + bottom ONLY. A top face — even a hair
    // below Z=0 — sits ABOVE every cut surface and occludes the whole
    // carving (the preview then shows a flat lid with 0.002" of relief).
    // The heightfield owns the top; BoxGeometry group 4 is +Z, hidden.
    const t = stock.thickness;
    const sideMat = mt ? themedSideMaterial(mt)
      : new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9 });
    const hiddenTop = new THREE.MeshStandardMaterial({ visible: false });
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(stock.w, stock.h, t),
      [sideMat, sideMat, sideMat, sideMat, hiddenTop, sideMat],
    );
    box.position.set(stock.w / 2, stock.h / 2, -t / 2);
    box.receiveShadow = true;
    group.add(box);

    if (sim) {
      const { grid, cols, rows, dx } = sim;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(cols * rows * 3);
      const col = new Float32Array(cols * rows * 3);
      const nrm = new Float32Array(cols * rows * 3);
      const tmp = new THREE.Color();
      // depth tint normalized to THIS job's feature depth: a 0.05"
      // engraving uses the whole tint scale instead of 10% of a
      // through-cut's
      const depthRange = Math.max(0.03, tintRange ?? -sim.minZ);
      // cavity term: blur window ~0.06" wide so an engraving stroke's
      // interior sits below its blurred neighborhood and darkens
      const blur = boxBlurGrid(grid, cols, rows, Math.min(40, Math.max(2, Math.round(0.06 / dx))));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const z = Math.max(grid[i], -t + 0.001);   // stay a hair above the box bottom
          pos[i * 3] = c * dx;
          pos[i * 3 + 1] = r * dx;
          pos[i * 3 + 2] = z;
          const zl = grid[i - (c > 0 ? 1 : 0)], zr = grid[i + (c < cols - 1 ? 1 : 0)];
          const zd = grid[i - (r > 0 ? cols : 0)], zu = grid[i + (r < rows - 1 ? cols : 0)];
          // tint keys on the deepest of the cell and its 8 neighbors: a
          // rim vertex atop a steep wall takes the WALL's color, so wall
          // triangles don't interpolate white speckle down from the rim —
          // diagonals included, or staircase corner cells slip through
          // (and cut edges pick up a crisp hairline outline)
          const il = c > 0 ? -1 : 0, ir = c < cols - 1 ? 1 : 0;
          const id = r > 0 ? -cols : 0, iu = r < rows - 1 ? cols : 0;
          const zref = Math.min(grid[i], zl, zr, zd, zu,
            grid[i + id + il], grid[i + id + ir], grid[i + iu + il], grid[i + iu + ir]);
          // sub-linear ramp: shallow cuts (engraving on a thick board)
          // still pick up a readable share of the tint scale
          const frac = Math.pow(Math.min(1, -zref / depthRange), 0.6);
          tmp.copy(BASE).lerp(CUT, frac === 0 ? 0 : 0.25 + 0.75 * frac);
          // hillshade baked into vertex color: darken by local slope so
          // groove walls stay readable from any orbit angle (the classic
          // heightfield relief cue; lighting alone washes out at 3/4 view)
          const slope = Math.hypot(zr - zl, zu - zd) / (2 * dx);
          let shade = 1 - 0.35 * Math.min(1, slope / 1.8);
          // baked ambient occlusion: depth below the local neighborhood
          const cav = Math.min(1, Math.max(0, (blur[i] - grid[i]) / 0.05));
          shade *= 1 - 0.45 * cav;
          tmp.multiplyScalar(shade);
          col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
          // smooth normals from the same central differences: per-facet
          // normals (computeVertexNormals) alternate direction down a
          // quantized staircase wall and render as sun-lit speckle
          const nx = -(zr - zl) / (2 * dx), ny = -(zu - zd) / (2 * dx);
          const nl = 1 / Math.hypot(nx, ny, 1);
          nrm[i * 3] = nx * nl; nrm[i * 3 + 1] = ny * nl; nrm[i * 3 + 2] = nl;
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
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      const mesh = new THREE.Mesh(geo, mt ? themedSurfaceMaterial(mt)
        : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    scene.add(group);
    placeSun(stock);
    frame(stock);
    renderer.render(scene, camera);
  }

  // theme switches rebuild the board under the new theme's mesh tokens
  function retheme() {
    if (lastArgs) update(...lastArgs);
    else renderer.render(scene, camera);
  }

  // camera/controls/scene exposed for deterministic poses and geometry
  // probes in headless checks
  return { update, retheme, domElement: renderer.domElement, camera, controls, scene, render: () => renderer.render(scene, camera) };
}
