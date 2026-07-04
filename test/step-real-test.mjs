// Real-STEP pipeline validation — the whole step_toolpath_app generate flow
// run headlessly against actual STEP files, exactly as main.js does it:
//
//   ReadStepFile (occt-import-js, same 0.0.23 the browser loads from CDN)
//   → convertToThreeMesh (mm→inch) → center min-corner at origin
//   → raycastDepthGrid + detectFeaturesDescendingPlane
//   → detectProfileFromDepthGrid (silhouette-validated profile)
//   → buildJob → composeJob → verifyJob → postJobToSbp (export gate)
//
// The synthetic test (step-job-test.mjs) proves the job logic; this one
// proves the geometry front end feeds it correctly on real BREP data.
//
// Fixtures:
//   Aggregate.stp     — Alibre AP203 part (3 x 7 x 3) that overhangs its
//                       base: the case that proved bottom-face profiles
//                       wrong (silhouette fallback required)
//   test-part-v2.stp  — Brian's test part (3 x 2.5 x 1): edge notch +
//                       shallow step (open-edge pockets must overcut) and
//                       a freeform region for the residual raster
//
// Prerequisites: `npm install` in seams (occt-import-js + three are
// devDeps), and step_toolpath_app/node_modules must symlink to
// ../seams/node_modules so the app's `import 'three'` resolves in Node:
//   ln -sfn ../seams/node_modules step_toolpath_app/node_modules
//
// Usage: node test/step-real-test.mjs [path/to/file.step]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';

import { convertToThreeMesh, autoOrientFlat, calculateBoundingBox, TESSELLATION_PARAMS } from '../../step_toolpath_app/modules/step-loader.js';
import { detectFeaturesDescendingPlane } from '../../step_toolpath_app/modules/descending-plane.js';
import { detectChamferFeatures } from '../../step_toolpath_app/modules/chamfer-detection.js';
import { raycastDepthGrid, detectProfileFromDepthGrid, detectThroughPockets } from '../../step_toolpath_app/modules/depth-map.js';
import { buildJob, depthGridToHeightmap } from '../../step_toolpath_app/modules/job-builder.js';
import { composeJob, postJobToSbp } from '../ir/job.js';
import { verifyJob } from '../ir/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = [
  // Aggregate's long top edges carry MODELED 45° x 0.25 bevels (a single
  // planar band in the BREP — the geometry the roll-off raster used to
  // sweep; the chamfer skill now claims it as the feature it really is)
  { file: path.join(__dirname, 'fixtures', 'Aggregate.stp'), expectModeledChamfers: 2,
    expectProfileSource: 'silhouette' },  // overhangs its base — bottom rim ≠ footprint
  // expectOpenEdgePockets: at least this many pockets must classify open
  // edges (the edge notch; the shallow ramp-bottom facet that used to
  // read as a second open-edge pocket is now correctly occluded by its
  // uphill neighbor facets and left to the residual raster).
  // tunnelSabotage: a part-coords point under the tunnel roof — detection
  // must NOT plan cuts there, and the verifier's part-surface check must
  // reject an op that does.
  {
    file: path.join(__dirname, 'fixtures', 'test-part-v2.stp'),
    expectOpenEdgePockets: 1,
    tunnelSabotage: { x: 1.4, y: 1.5, z: -0.25 },
    expectProfileSource: 'silhouette', // inset bottom rim (5.5 < 5.9 sq in) — mesh loop rejected
    addedChamfer: { width: 0.1, angleDeg: 45 },
    // Full feature coverage, locked 2026-06-10 (app v1.22, all features of
    // the part recognized). Exact pocket count — a dropped feature OR a
    // phantom extra both fail. Depths tolerate ±0.02 (grid spacing 0.012).
    expectFeatures: {
      pockets: [
        { depth: 0.25, openEdges: 0, circular: true }, // round pocket
        { depth: 0.25, openEdges: 0 },                 // closed rectangular step
        { depth: 0.50, openEdges: 3 },                 // edge notch
      ],
      profileDepth: 1.0, // through-cut: full part thickness
      ops: { pocket: 3, surface: 1, profile: 1 },
    },
  },
  // Brian's indicator-light head (2026-06-29): a round part that is ALL
  // nested annular floors — the case that drove tool-select. With only the
  // 1/4" every ring under ~0.25 wide fell back to the raster (which can't
  // reach into them either); with a drawer the knee assigns the 1/8" to
  // the C-channel + the nominal-1/8 O-ring groove (slot fit) and the
  // 1/16 x 0.4 to the narrow 0.32-deep ring. 1/4 keeps the eleven spoke
  // pockets and the all-open rim.
  {
    file: path.join(__dirname, 'fixtures', 'indicator-light-head-lower.stp'),
    endmills: [{ diameter: 0.125 }, { diameter: 0.0625, maxDepth: 0.4 }],
    expectAssignments: {
      'Pocket 12': 0.125,            // ~0.25-wide C-channel around the hub
      'Pocket 13': 0.0625,           // ~1/16-wide ring groove, 0.32 deep
      'Circular Pocket 16': 0.125,   // nominal-1/8 O-ring groove, 0.495 deep
      'Circular Through Hole 1': 0.25, // center hole: spoilboard-floored pocket
    },
    expectNoRasterFallback: true,
    expectResidualBelow: 2.6,
    expectThroughPockets: 1, // the central hole — spoilboard-floored pocket
    // bulk-worth rule: a 1/4 bulk pass on the C-channel would clear only
    // its wide mouth (23% by area, ~0% saved by real cut length) — the
    // whole feature merges down to the 1/8" instead of splitting
    expectMergedBulk: ['Pocket 12'],
    // round part: the traced silhouette snaps to a perfect circle — the
    // pixel-stair wiggle must not reach the exported profile cut
    expectProfileSource: 'circle',
  },
  // Brian's HDPE hood side panel (2026-07-03): arrives in a CAD frame
  // standing on its 0.5" edge (thickness along X) — the part that drove
  // autoOrientFlat. Once flat: a big through window, screw holes, and
  // shallow feature pockets milled into one side. Its flat bottom face IS
  // the true footprint, so this is the one part that exercises the exact
  // mesh-contour profile path (the others all fall back to the silhouette).
  {
    file: path.join(__dirname, 'fixtures', 'hood-left-side-hdpe.stp'),
    endmills: [{ diameter: 0.125 }],
    expectAutoOrient: { laidFlat: true, flipped: false },
    expectProfileSource: 'mesh',
    // louver slots (~0.27 x 0.11, one open edge): the 1/4" clears the
    // coverage bar through the open edge but can't fit its inset — the
    // unfit re-pick must hand them to the 1/8" instead of dropping them.
    // The vents are exact 0.150 circles (mesh-refined from a 4-cell grid
    // blob) and the center hole an exact 0.250 — bit-clearance holes that
    // must come out as bore ops, not "no approved bit fits".
    expectAssignments: {
      'Pocket 5': 0.125,
      'Pocket 6': 0.125,
      'Pocket 10': 0.125,
      'Circular Through Hole 1': 0.25,  // 0.250 hole → 1/4" bore
      'Circular Through Hole 3': 0.125, // 0.150 vents → 1/8" bore + orbit
      'Circular Through Hole 4': 0.125,
      'Circular Through Hole 6': 0.125,
      'Circular Through Hole 7': 0.125,
    },
    expectBoreOps: 5,
  },
  // Brian's HDPE ExoFrame side (2026-07-03): a big 1.4 x 5.1 rectangular
  // window whose simplified trace is just its CORNERS — all concyclic on
  // the circumscribed circle, so it used to snap to a phantom R=2.6
  // "Circular Through Hole" slicing past the part edge (the angular-gap
  // check in detectCircleCNC is the fix). Its 0.25-deep pocket walls also
  // drove the raster chord refinement: the ball climbing a wall base
  // between cell centers used to dip ~14 thou below the constraint arc.
  {
    file: path.join(__dirname, 'fixtures', 'exoframe-right-side-hdpe.stp'),
    endmills: [{ diameter: 0.125 }],
    expectAutoOrient: { laidFlat: true, flipped: true },
    expectProfileSource: 'mesh',
    expectThroughPockets: 9,
    // the window must stay a contour; the small round holes stay circles
    // (9th hole: a ⌀0.20 rim-rescued from a 9-cell grid blob — silently
    // dropped by MIN_CELLS before 2026-07-03's small-hole rescue)
    expectThroughShapes: { circle: 8, contour: 1 },
    // Pocket 1 is a 0.24"-wide shelf band open along its whole inner side —
    // the 1/4" covers it entirely by overhanging the open edges. Its
    // junction fillet chords (0.03–0.09) must chain-classify open, or the
    // spillover can't wrap the corners and a pointless 1/8" rest pass
    // appears (coverage read 96.9% instead of 99.98%).
    expectAssignments: { 'Pocket 1': 0.25 },
    expectNoRest: ['Pocket 1'],
  },
  // Brian's HDPE base plate (2026-07-03): 19 x 16, a huge (9.4 x 10.5)
  // central through window plus ~40 circular pockets. The window drove the
  // rim matcher from vertex-average to AREA centroids: its 57-pt mesh rim
  // and 14-pt grid trace describe the same region (areas within 0.2%) but
  // their vertex averages sat 0.42" apart — 3x the match tolerance — so
  // the window kept the coarse trace and its rounded corners cut as
  // inch-long chords. expectThroughMinPts locks the exact-rim swap.
  {
    file: path.join(__dirname, 'fixtures', 'base-plate-hdpe.stp'),
    endmills: [{ diameter: 0.125 }, { diameter: 0.0625, maxDepth: 0.4 }],
    expectAutoOrient: { laidFlat: false, flipped: true },
    // 37 = 3 window cutouts + 34 small round holes, most rim-rescued from
    // 4-10-cell grid blobs (every counterbore's center bore goes through)
    expectThroughPockets: 37,
    expectThroughShapes: { circle: 34, contour: 3 },
    expectThroughMinPts: { 'Through Cutout 6': 40 },
    // counterbored holes (Brian 2026-07-03): the ⌀0.388 counterbore must be
    // machined FULL DIAMETER by the 1/4" (its center hole flies over — the
    // material is coming out anyway), not as a 1/16"-width annulus; the
    // ⌀0.126 drill hole below it — modeled flat-bottomed 0.050 above the
    // bottom (drill-depth convention) — promotes to a THROUGH cut and
    // bores with the 1/8" (drill graze), not dropped to the raster.
    expectAssignments: {
      'Circular Pocket 11': 0.25,
      'Drilled Through Hole 26': 0.125,
    },
    expectNoRest: ['Circular Pocket 11'],
    expectFullDepthFeatures: ['Drilled Through Hole 26'],
  },
];

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ FAIL ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

const occt = await occtimportjs();

async function runPart(stepPath, expect = {}) {
  console.log(`\n=== real-STEP pipeline: ${path.basename(stepPath)} ===\n`);

  // ---- parse (browser: loadSTEPFile)
  const fileBuffer = new Uint8Array(fs.readFileSync(stepPath));
  const result = occt.ReadStepFile(fileBuffer, TESSELLATION_PARAMS);
  if (!result.success || !result.meshes?.length) {
    fail(`occt parse failed (success=${result.success}, meshes=${result.meshes?.length})`);
    return;
  }
  pass(`occt parsed ${result.meshes.length} mesh(es)`);

  // ---- mesh + centering (browser: convertToThreeMesh + autoOrientFlat + centerOnTable)
  const meshGroup = convertToThreeMesh(result);
  const orientation = autoOrientFlat(meshGroup);
  if (orientation.laidFlat || orientation.flipped) {
    console.log(`  auto-orient: laidFlat=${orientation.laidFlat} flipped=${orientation.flipped}`);
  }
  if (expect.expectAutoOrient) {
    const e = expect.expectAutoOrient;
    if (orientation.laidFlat === e.laidFlat && orientation.flipped === e.flipped) {
      pass(`auto-orient: laidFlat=${orientation.laidFlat}, flipped=${orientation.flipped}`);
    } else {
      fail(`auto-orient laidFlat=${orientation.laidFlat}/flipped=${orientation.flipped}, expected laidFlat=${e.laidFlat}/flipped=${e.flipped}`);
    }
  }
  {
    // centerOnTable's core: min corner of the precise bbox at the origin
    const bbox0 = calculateBoundingBox(meshGroup);
    meshGroup.position.x -= bbox0.min.x;
    meshGroup.position.y -= bbox0.min.y;
    meshGroup.position.z -= bbox0.min.z;
  }
  meshGroup.updateMatrixWorld(true);
  const bbox = calculateBoundingBox(meshGroup);
  const sz = bbox.size;
  console.log(`  part: ${sz.x.toFixed(3)} x ${sz.z.toFixed(3)} x ${sz.y.toFixed(3)} in (X x Y x thickness)`);
  if (sz.x > 0.05 && sz.y > 0.05 && sz.z > 0.05) pass('non-degenerate bounding box, min corner at origin');
  else fail(`degenerate bbox ${JSON.stringify(sz)}`);

  // ---- detection + depth grid (browser: detectFeatures, same order)
  const depthGrid = raycastDepthGrid(meshGroup);
  const detected = detectFeaturesDescendingPlane(meshGroup, depthGrid);
  const gridProfile = detectProfileFromDepthGrid(depthGrid, meshGroup);
  if (gridProfile) detected.profile = gridProfile;

  if (depthGrid && depthGrid.gridW > 10 && depthGrid.gridH > 10) {
    // NaN in the grid is by design: ray miss = no material (through-hole or
    // beyond the silhouette). The HEIGHTMAP must map those to full depth.
    let nanCount = 0, maxD = -Infinity;
    for (const d of depthGrid.depths) {
      if (Number.isFinite(d)) maxD = Math.max(maxD, d);
      else nanCount++;
    }
    console.log(`  depth grid ${depthGrid.gridW}x${depthGrid.gridH}, ${nanCount} miss cells (no material)`);
    if (maxD <= sz.y + 1e-6) pass(`max sampled depth ${maxD.toFixed(3)} ≤ part thickness ${sz.y.toFixed(3)}`);
    else fail(`depth ${maxD} exceeds part thickness ${sz.y}`);
    const hm = depthGridToHeightmap(depthGrid);
    let badH = 0;
    for (const h of hm.heights) {
      if (!Number.isFinite(h) || h > 0 || h < -depthGrid.depthRange - 1e-9) badH++;
    }
    if (badH === 0) pass(`heightmap all finite within [-${depthGrid.depthRange.toFixed(3)}, 0] (misses → full depth)`);
    else fail(`${badH} heightmap cells out of range`);
  } else {
    fail(`depth grid degenerate: ${depthGrid && `${depthGrid.gridW}x${depthGrid.gridH}`}`);
  }

  // modeled-chamfer detection: exact count per fixture. Underside overhang
  // bevels and fillet tessellation strips must NOT read as chamfers; the
  // real modeled bevels MUST.
  const modeledChamfers = detectChamferFeatures(meshGroup, depthGrid);
  const expectCh = expect.expectModeledChamfers ?? 0;
  if (modeledChamfers.length === expectCh) pass(`exactly ${expectCh} modeled chamfer(s) detected${expectCh ? `: ${modeledChamfers.map(c => c.label).join(', ')}` : ''}`);
  else fail(`expected ${expectCh} modeled chamfers, found ${modeledChamfers.length}: ${modeledChamfers.map(c => c.label).join(', ')}`);

  console.log(`  detected: ${detected.pockets.length} pocket(s), profile=${!!detected.profile}`);
  for (const p of detected.pockets) {
    console.log(`    • ${p.label || 'pocket'}: depth ${p.depth.toFixed(3)}, ${p.contour?.length ?? 0} pts, openEdges=${p.openEdges?.length ?? 0}`);
  }
  if (!detected.profile) fail('no outer profile detected');
  else pass(`profile detected: depth ${detected.profile.depth.toFixed(3)}, ${detected.profile.contour?.length ?? 0} pts`);

  // profile source: which geometry won (mesh bottom face / pixel
  // silhouette / circle snap) — and a snapped circle must BE one
  if (expect.expectProfileSource && detected.profile) {
    const src = detected.profile.source;
    if (src === expect.expectProfileSource) pass(`profile source: ${src}`);
    else fail(`profile source ${src}, expected ${expect.expectProfileSource}`);
    if (src === 'circle') {
      const c = detected.profile.contour;
      const cx = detected.profile.x + detected.profile.w / 2;
      const cy = detected.profile.y + detected.profile.h / 2;
      const rs = c.map(q => Math.hypot(q.x - cx, q.y - cy));
      const rAvg = rs.reduce((a, b) => a + b, 0) / rs.length;
      const dev = Math.max(...rs.map(r => Math.abs(r - rAvg)));
      if (dev < 0.001 && c.length >= 64) pass(`circular profile: R=${rAvg.toFixed(4)}, max radial dev ${dev.toFixed(5)} (${c.length} pts)`);
      else fail(`circular profile not round: dev ${dev.toFixed(4)}, ${c.length} pts`);
    }
  }

  if (expect.expectOpenEdgePockets) {
    const n = detected.pockets.filter(p => (p.openEdges?.length ?? 0) > 0).length;
    if (n >= expect.expectOpenEdgePockets) pass(`${n} pocket(s) with open edges classified`);
    else fail(`expected ≥${expect.expectOpenEdgePockets} open-edge pockets, found ${n}`);
  }

  // ---- feature coverage: every known feature of the part must be detected,
  // and nothing extra (greedy unique matching by depth + open-edge count)
  if (expect.expectFeatures) {
    const ef = expect.expectFeatures;
    const TOL = 0.02;
    if (detected.pockets.length === ef.pockets.length) pass(`exactly ${ef.pockets.length} pockets detected`);
    else fail(`expected exactly ${ef.pockets.length} pockets, found ${detected.pockets.length}: ${detected.pockets.map(p => p.label).join(', ')}`);
    const unmatched = [...detected.pockets];
    for (const spec of ef.pockets) {
      const i = unmatched.findIndex(p =>
        Math.abs(p.depth - spec.depth) <= TOL &&
        (p.openEdges?.length ?? 0) === spec.openEdges &&
        (!spec.circular || /circular/i.test(p.label || '')));
      if (i >= 0) {
        pass(`feature: ${unmatched[i].label} matches {depth ${spec.depth}, ${spec.openEdges} open edges${spec.circular ? ', circular' : ''}}`);
        unmatched.splice(i, 1);
      } else {
        fail(`no detected pocket matches {depth ${spec.depth}, ${spec.openEdges} open edges${spec.circular ? ', circular' : ''}}`);
      }
    }
    if (detected.profile && Math.abs(detected.profile.depth - ef.profileDepth) <= TOL) {
      pass(`profile at full expected depth ${ef.profileDepth}`);
    } else {
      fail(`profile depth ${detected.profile?.depth?.toFixed(3)} != expected ${ef.profileDepth}`);
    }
  }

  // ---- through-regions (spoilboard-floored pockets), as main.js adds them
  const throughPockets = detectThroughPockets(depthGrid, meshGroup);
  for (const t of throughPockets) {
    console.log(`    • ${t.label}: ${t.w.toFixed(2)} x ${t.h.toFixed(2)}, depth ${t.depth.toFixed(3)} (through)`);
  }
  if (expect.expectThroughPockets != null) {
    if (throughPockets.length === expect.expectThroughPockets) {
      pass(`exactly ${expect.expectThroughPockets} through region(s) detected`);
    } else {
      fail(`expected ${expect.expectThroughPockets} through regions, found ${throughPockets.length}: ${throughPockets.map(t => t.label).join(', ')}`);
    }
    for (const t of throughPockets) {
      if (Math.abs(t.depth - depthGrid.depthRange) < 1e-6) pass(`${t.label}: cuts to the spoilboard (depth ${t.depth.toFixed(3)})`);
      else fail(`${t.label}: depth ${t.depth} != part thickness ${depthGrid.depthRange}`);
    }
  }
  // drill-depth promotion: features the CAD models flat-bottomed a sliver
  // above the part bottom must declare FULL thickness (cut to spoilboard)
  if (expect.expectFullDepthFeatures) {
    for (const lbl of expect.expectFullDepthFeatures) {
      const f = detected.pockets.find(p => p.label === lbl);
      if (!f) { fail(`no detected feature labeled "${lbl}"`); continue; }
      if (f.through && Math.abs(f.depth - depthGrid.depthRange) < 1e-6) {
        pass(`${lbl}: promoted to a through cut (depth ${f.depth.toFixed(3)})`);
      } else {
        fail(`${lbl}: through=${!!f.through} depth=${f.depth?.toFixed(3)} — expected full ${depthGrid.depthRange.toFixed(3)}`);
      }
    }
  }

  // contour density: a big through region must carry the exact mesh rim
  // (dozens of points tracing its corner arcs), not the coarse grid trace
  if (expect.expectThroughMinPts) {
    for (const [label, minPts] of Object.entries(expect.expectThroughMinPts)) {
      const t = throughPockets.find(q => q.label === label);
      if (!t) { fail(`no through region labeled "${label}"`); continue; }
      if (t.contour.length >= minPts) pass(`${label}: ${t.contour.length}-pt contour (exact mesh rim)`);
      else fail(`${label}: only ${t.contour.length} contour pts (< ${minPts}) — grid trace, not mesh rim`);
    }
  }

  // shape split: a rectangular window's concyclic corners must NOT read as
  // a circle (and real round holes must)
  if (expect.expectThroughShapes) {
    const counts = { circle: 0, contour: 0 };
    for (const t of throughPockets) counts[t.shape === 'circle' ? 'circle' : 'contour']++;
    const e = expect.expectThroughShapes;
    if (counts.circle === e.circle && counts.contour === e.contour) {
      pass(`through shapes: ${counts.circle} circle(s), ${counts.contour} contour(s)`);
    } else {
      fail(`through shapes ${counts.circle} circle / ${counts.contour} contour, expected ${e.circle} / ${e.contour}`);
    }
  }

  // ---- features list exactly as main.js assembles it (all selected)
  const features = [
    ...detected.pockets.map(p => ({ type: 'pocket', ...p, selected: true, autoDetected: true })),
    ...throughPockets.map(t => ({ ...t, selected: true, autoDetected: true })),
    ...modeledChamfers.map(c => ({ ...c, selected: true, autoDetected: true })),
    ...(detected.profile ? [{ type: 'profile', ...detected.profile, selected: true, autoDetected: true }] : []),
  ];

  // ---- buildJob with main.js's default tool params (90° V-bit on hand)
  const PARAMS = {
    diameter: 0.25, depthPerPass: 0.125, feedRate: 100, plungeRate: 30,
    rpm: 18000, safeZ: 0.5,
    stockThickness: sz.y,
    stepoverPct: 40,
    toolLibrary: {
      veeBits: [{ angleDeg: 90, diameter: 0.5 }],
      endmills: expect.endmills ?? [],
    },
  };
  const built = buildJob(features, depthGrid, PARAMS);
  for (const w of built.warnings) console.log(`  warning: ${w}`);
  if (!built.job) {
    fail(`buildJob produced no job: ${built.warnings.join('; ')}`);
    return;
  }
  const { info } = built;
  console.log(`  ops: ${info.pocketOps} pocket, ${info.surfaceOps} surface, ${info.chamferOps} chamfer, ${info.profileOps} profile; residual ${info.residualArea?.toFixed?.(2)} sq in`);
  if (info.chamferOps === expectCh) pass(`${expectCh} chamfer op(s) routed`);
  else fail(`expected ${expectCh} chamfer ops, got ${info.chamferOps}`);
  if (info.profileOps === 1) pass('profile op emitted');
  else fail(`expected 1 profile op, got ${info.profileOps}`);
  if (expect.expectFeatures?.ops) {
    const eo = expect.expectFeatures.ops;
    if (info.pocketOps === eo.pocket && info.surfaceOps === eo.surface && info.profileOps === eo.profile) {
      pass(`op counts match: ${eo.pocket} pocket / ${eo.surface} surface / ${eo.profile} profile`);
    } else {
      fail(`op counts ${info.pocketOps}/${info.surfaceOps}/${info.profileOps} != expected ${eo.pocket}/${eo.surface}/${eo.profile}`);
    }
  }
  const lastOp = built.job.operations[built.job.operations.length - 1];
  if (/profile/i.test(lastOp.name || lastOp.kind || '')) pass(`profile is last op (${lastOp.name})`);
  else fail(`last op is "${lastOp.name}" — profile must come last`);

  // ---- open-edge semantics: pockets with open edges overcut PAST their
  // contour (centerline reaches R beyond an open edge); closed pockets
  // stay inside theirs (slot-fit passes may graze by SLOT_GRAZE). Measured
  // per open edge along its outward normal — a bbox measure under-reads
  // rotated pockets. R comes from the op's ASSIGNED tool, not the default.
  {
    for (const f of features) {
      if (f.type !== 'pocket') continue;
      const op = built.job.operations.find(o => o.name.startsWith(`${f.label} (pocket,`));
      if (!op) continue;
      const R = (built.job.tools[op.tool]?.diameter ?? PARAMS.diameter) / 2;
      // sample along cut segments, not just endpoints: the outermost ring
      // of a small rectangular pocket is 4 corners whose projections all
      // fall outside the open edges' spans — vertices alone under-read
      const xy = [];
      let pos = null;
      for (const m of op.moves) {
        const next = { x: m.x ?? pos?.x, y: m.y ?? pos?.y };
        if (m.type === 'linear' && (m.x !== undefined || m.y !== undefined) &&
            pos && pos.x !== undefined) {
          const segLen = Math.hypot(next.x - pos.x, next.y - pos.y);
          const steps = Math.max(1, Math.ceil(segLen / 0.02));
          for (let s = 1; s <= steps; s++) {
            xy.push({ x: pos.x + ((next.x - pos.x) * s) / steps, y: pos.y + ((next.y - pos.y) * s) / steps });
          }
        }
        if (m.x !== undefined || m.y !== undefined) pos = next;
      }
      if (!xy.length) continue;
      const n = f.contour.length;
      const area = f.contour.reduce((a, p, i) => {
        const q = f.contour[(i + 1) % n];
        return a + p.x * q.y - q.x * p.y;
      }, 0) / 2;
      // how far past edge (a,b) do centerline points reach, along its
      // outward normal, counting only points whose projection is on the edge
      const beyondEdge = i => {
        const a = f.contour[i], b = f.contour[(i + 1) % n];
        const ex = b.x - a.x, ey = b.y - a.y;
        const len = Math.hypot(ex, ey);
        if (len < 1e-9) return -Infinity;
        const nx = (area > 0 ? ey : -ey) / len, ny = (area > 0 ? -ex : ex) / len;
        let best = -Infinity;
        for (const p of xy) {
          const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / (len * len);
          if (t < -0.1 || t > 1.1) continue;
          best = Math.max(best, (p.x - a.x) * nx + (p.y - a.y) * ny);
        }
        return best;
      };
      if ((f.openEdges?.length ?? 0) > 0) {
        // R/2 threshold, not R: short open edges pinched between wall
        // corners bow the round-join inset, legitimately limiting how far
        // the centerline can reach past them. Half the radius still proves
        // the open-edge overcut engaged (a walled pocket reaches ≤ 0).
        const reach = Math.max(...f.openEdges.map(beyondEdge));
        if (reach > 0.5 * R) pass(`${f.label}: overcuts ${reach.toFixed(3)} past its open edges (R=${R})`);
        else fail(`${f.label} has ${f.openEdges.length} open edges but only reaches ${reach.toFixed(4)} past them`);
      } else {
        // actual excursion: distance to the polygon for points OUTSIDE it.
        // beyondEdge would false-positive here — its projection window
        // scales with edge length, so an interior point near a reflex
        // corner reads as "beyond" the adjacent long edge's extended line.
        let stray = 0;
        for (const p of xy) {
          let inside = false;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const a = f.contour[i], b = f.contour[j];
            if ((a.y > p.y) !== (b.y > p.y) &&
                p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
          }
          if (inside) continue;
          let dMin = Infinity;
          for (let i = 0; i < n; i++) {
            const a = f.contour[i], b = f.contour[(i + 1) % n];
            const ex = b.x - a.x, ey = b.y - a.y;
            const t = Math.max(0, Math.min(1,
              ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
            dMin = Math.min(dMin, Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey)));
          }
          stray = Math.max(stray, dMin);
        }
        if (stray > 0.006) fail(`${f.label} is fully walled but its centerline leaves the contour by ${stray.toFixed(4)}`);
      }
    }
  }

  // ---- bore ops: bit-clearance holes get plunge/orbit bores
  if (expect.expectBoreOps) {
    const n = built.job.operations.filter(o => /\(bore,/.test(o.name)).length;
    if (n === expect.expectBoreOps) pass(`${n} bore op(s) emitted`);
    else fail(`${n} bore ops, expected ${expect.expectBoreOps}`);
  }

  // ---- bit assignment (tool-select knee): named features land on the
  // expected bits, nothing important falls back to the raster
  if (expect.expectAssignments) {
    const plan = built.info.toolPlan;
    for (const [label, dia] of Object.entries(expect.expectAssignments)) {
      const tf = plan.features.find(t => t.label === label);
      if (!tf) { fail(`no tool-plan entry for "${label}"`); continue; }
      // the expected bit must MACHINE the feature — as the bulk bit or as a
      // rest pass in its chain (rest machining may promote a bigger bit to
      // bulk and demote this one to the corners it alone reaches)
      const chain = [tf.assigned, ...(tf.rest ?? [])];
      if (chain.includes(dia)) pass(`${label} machined by the ${dia}" bit (chain ${chain.join(' → ')}, coverage ${(tf.coverage * 100).toFixed(0)}%)`);
      else fail(`${label} chain [${chain.join(', ')}] does not include expected ${dia}`);
    }
  }
  // features that must NOT split into rest passes (a fully-open-sided
  // region the bulk bit reaches everywhere by overhanging)
  if (expect.expectNoRest) {
    const plan = built.info.toolPlan;
    for (const label of expect.expectNoRest) {
      const tf = plan.features.find(t => t.label === label);
      if (!tf) { fail(`no tool-plan entry for "${label}"`); continue; }
      if ((tf.rest ?? []).length === 0) pass(`${label}: single-bit plan, no rest pass (coverage ${(tf.coverage * 100).toFixed(1)}%)`);
      else fail(`${label}: unexpected rest chain [${tf.rest.join(', ')}]`);
    }
  }

  // rest ops, whenever present, must declare the blend-band overlap
  for (const op of built.job.operations.filter(o => o.name.includes('(rest,'))) {
    if (!op.allowOverlap) fail(`${op.name}: rest op must declare allowOverlap (blend band)`);
  }
  if (expect.expectMergedBulk) {
    for (const label of expect.expectMergedBulk) {
      const merged = built.warnings.some(w => w.startsWith(`${label}:`) && w.includes('merged to the'));
      const restOp = built.job.operations.some(o => o.name.startsWith(`${label} (rest,`));
      if (merged && !restOp) pass(`${label}: bulk merged away (no split, no rest op)`);
      else fail(`${label}: expected bulk merge (merged warning ${merged}, rest op ${restOp})`);
    }
  }
  if (expect.expectNoRasterFallback) {
    const dropped = built.warnings.filter(w => w.includes('left to the residual surface pass'));
    if (!dropped.length) pass('every detected pocket got a pocket op (no raster fallback)');
    else fail(`pockets fell back to raster: ${dropped.join(' | ')}`);
  }
  if (expect.expectResidualBelow != null) {
    if (built.info.residualArea < expect.expectResidualBelow) {
      pass(`residual ${built.info.residualArea} sq in < ${expect.expectResidualBelow}`);
    } else {
      fail(`residual ${built.info.residualArea} sq in ≥ ${expect.expectResidualBelow}`);
    }
  }

  // ---- compose + verify (the headline: real geometry passes its declared targets)
  const composed = composeJob(built.job);
  const report = verifyJob(built.job, composed);
  for (const w of report.warnings) console.log(`  verify warning: ${w}`);
  if (report.ok) {
    const s = report.stats;
    pass(`VERIFIED: ${s.targets.length} target(s), ${s.toolchangeCount} toolchange(s), cut ${s.cutLength.toFixed(1)}", ~${s.estCutTimeMin.toFixed(1)} min`);
  } else {
    for (const e of report.errors) console.log(`  verify error: ${e}`);
    fail(`verification failed with ${report.errors.length} error(s)`);
  }

  // ---- part-surface safety net: an op cutting under the tunnel roof must
  // be rejected by verifyJob's global surface check (independent of the
  // op's own declared target)
  if (expect.tunnelSabotage && report.ok) {
    const { x, y, z } = expect.tunnelSabotage;
    const evil = {
      ...built.job,
      operations: [...built.job.operations, {
        name: 'tunnel sabotage', tool: 1, feedRate: 100, plungeRate: 30,
        placement: { x: built.composedShift.x, y: built.composedShift.y },
        moves: [
          { type: 'rapid', x, y, z: built.job.safeZ },
          { type: 'linear', x, y, z },
          { type: 'linear', x: x + 0.05, y, z },
          { type: 'rapid', x, y, z: built.job.safeZ },
        ],
      }],
    };
    const evilReport = verifyJob(evil, composeJob(evil));
    const hit = evilReport.errors.find(e => /below the part surface/.test(e));
    if (!evilReport.ok && hit) pass(`part-surface check rejects a tunnel cut (${hit.match(/cuts [\d.]+ below/)?.[0]})`);
    else fail(`tunnel sabotage not caught (ok=${evilReport.ok}; ${evilReport.errors.join(' | ').slice(0, 160)})`);
  }

  // ---- export gate (browser: exportToolpath)
  if (report.ok) {
    const sbp = postJobToSbp(built.job, composed, { title: 'real-step validation' });
    const lines = sbp.split('\n');
    if (/^MS,/m.test(sbp)) pass('SBP has MS feed/plunge header');
    else fail('SBP missing MS header');
    if (sbp.includes('M3') || sbp.includes('J3')) pass(`SBP posted: ${lines.length} lines`);
    else fail('SBP has no motion lines');
    const out = path.join(__dirname, 'out');
    fs.mkdirSync(out, { recursive: true });
    const name = path.basename(stepPath).replace(/\.[^.]+$/, '');
    fs.writeFileSync(path.join(out, `step-real-${name}.sbp`), sbp);
    console.log(`  wrote ${path.join(out, `step-real-${name}.sbp`)}`);
  }

  // ---- ADDED chamfer (prompt intent, not in the geometry): break the
  // outer profile's top edge; the imprinted intended surface must verify
  // with a matching V-bit AND with the ballnose fallback
  if (expect.addedChamfer && detected.profile?.contour?.length >= 3) {
    const contour = detected.profile.contour;
    const ccw = contour.reduce((a, p, i) => {
      const q = contour[(i + 1) % contour.length];
      return a + p.x * q.y - q.x * p.y;
    }, 0) > 0;
    const chamferFeature = {
      type: 'chamfer', added: true, selected: true,
      edge: { points: ccw ? contour : [...contour].reverse(), closed: true },
      width: expect.addedChamfer.width, angleDeg: expect.addedChamfer.angleDeg ?? 45,
      label: 'added rim chamfer',
    };
    for (const [mode, lib] of [
      ['V-bit', { veeBits: [{ angleDeg: 90, diameter: 0.5 }] }],
      ['ballnose fallback', { veeBits: [] }],
    ]) {
      const b2 = buildJob([...features, chamferFeature], depthGrid, { ...PARAMS, toolLibrary: lib });
      if (!b2.job) { fail(`added chamfer (${mode}): no job`); continue; }
      if (b2.info.chamferOps !== 1) { fail(`added chamfer (${mode}): ${b2.info.chamferOps} chamfer ops`); continue; }
      const rep2 = verifyJob(b2.job, composeJob(b2.job));
      if (rep2.ok) pass(`added rim chamfer VERIFIED with ${mode} (${b2.job.operations.find(o => o.name.includes('chamfer')).name})`);
      else {
        for (const e of rep2.errors.slice(0, 3)) console.log(`  added-chamfer error: ${e}`);
        fail(`added rim chamfer failed verification with ${mode}`);
      }
    }
  }
}

if (process.argv[2]) {
  await runPart(process.argv[2]);
} else {
  for (const f of FIXTURES) await runPart(f.file, f);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
