// ESM wrapper over d3-delaunay's self-contained UMD dist build (delaunator
// and robust-predicates are inlined by upstream's rollup).
//
// Why not `import { Delaunay } from 'd3-delaunay'`: that bare specifier only
// resolves through the page's import map, and module WORKERS do not inherit
// import maps — the weave worker's graph must resolve on relative paths
// alone. The UMD build attaches to globalThis.d3 in page, worker, and Node
// alike, so this wrapper is the one resolvable spelling everywhere.

import '../node_modules/d3-delaunay/dist/d3-delaunay.js';

export const { Delaunay } = globalThis.d3;
