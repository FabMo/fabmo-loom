// Terrain resolver — turns a recipe's terrain REFERENCES into elevation
// grids, in the user's browser, on the user's connection.
//
// A terrains-section entry is a claim ticket, not data: { id, query,
// bbox?, zoom?, meta? }. resolveTerrains() geocodes an unpinned query
// (OSM Nominatim), PINS the resolved bbox/zoom/meta back into the entry
// (geocoding rankings drift; tiles are static content addressed by
// z/x/y — so after the first weave the document names an exact region
// forever), fetches AWS Terrain Tiles (Terrarium PNGs, public S3, no
// key), and returns { id: { grid: {elev, cols, rows}, meta } } ready for
// runRecipe. Grids are cached per pinned region for the session, so
// slider moves that don't touch the region never refetch.
//
// BROWSER-ONLY by design (createImageBitmap/OffscreenCanvas): this file
// is the network seam ABOVE the rail. The lowering in catalog.mjs is a
// pure function of the returned grid, and the gauntlet feeds it a
// synthetic fixture — nothing below this module ever touches the net.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const TILE_SIZE = 256;
// ≤ 64 tiles ≈ 2048 px on the long axis — more samples than a ballnose
// raster can express on any board Loom will see, at ~1.5 MB of tiles
const MAX_TILES = 64;

const cache = new Map();   // pinned-region key → { grid, meta }

function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}
function lngToTileX(lng, zoom) { return ((lng + 180) / 360) * Math.pow(2, zoom); }
function latToTileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom);
}

function pickZoom(bbox) {
  for (let z = 14; z >= 1; z--) {
    const nw = latLngToTile(bbox.north, bbox.west, z);
    const se = latLngToTile(bbox.south, bbox.east, z);
    if ((se.x - nw.x + 1) * (se.y - nw.y + 1) <= MAX_TILES) return z;
  }
  return 1;
}

// geocode a place name; the top Nominatim result decides the region
// (trusting its importance ranking — see terrain_carver's field lesson:
// "prefer polygons" picks the town of Mount Rainier over the volcano)
async function geocode(query) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '3' });
  const resp = await fetch(`${NOMINATIM_URL}/search?${params}`);
  if (!resp.ok) throw new Error(`place search failed (${resp.status})`);
  const results = await resp.json();
  if (!results.length) throw new Error(`no place found for "${query}"`);
  const top = results[0];
  let bbox = {
    south: parseFloat(top.boundingbox[0]), north: parseFloat(top.boundingbox[1]),
    west: parseFloat(top.boundingbox[2]), east: parseFloat(top.boundingbox[3]),
  };
  // point features (a peak, a landmark) come back as near-zero boxes;
  // countries as continental ones. Normalize to a carvable region.
  const MIN = 0.08, MAX = 4;
  const cLat = (bbox.south + bbox.north) / 2, cLng = (bbox.west + bbox.east) / 2;
  const latSpan = Math.min(MAX, Math.max(MIN, bbox.north - bbox.south));
  const lngSpan = Math.min(MAX, Math.max(MIN, bbox.east - bbox.west));
  bbox = { south: cLat - latSpan / 2, north: cLat + latSpan / 2, west: cLng - lngSpan / 2, east: cLng + lngSpan / 2 };
  return { bbox, name: top.display_name };
}

async function fetchTile(z, x, y, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const img = await createImageBitmap(await resp.blob());
      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const c2d = canvas.getContext('2d');
      c2d.drawImage(img, 0, 0);
      const px = c2d.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < elev.length; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      return elev;
    } catch (err) {
      if (attempt >= tries) throw new Error(`elevation tile ${z}/${x}/${y}: ${err.message}`);
    }
  }
}

// fetch + assemble + crop the DEM for a pinned bbox at a zoom
async function fetchGrid(bbox, zoom, onStatus) {
  const nw = latLngToTile(bbox.north, bbox.west, zoom);
  const se = latLngToTile(bbox.south, bbox.east, zoom);
  const tCols = se.x - nw.x + 1, tRows = se.y - nw.y + 1;
  onStatus?.(`fetching ${tCols * tRows} elevation tiles…`);
  const tiles = await Promise.all(
    Array.from({ length: tCols * tRows }, (_, i) =>
      fetchTile(zoom, nw.x + (i % tCols), nw.y + Math.floor(i / tCols))),
  );
  // mosaic, then crop to the exact bbox in fractional tile coords
  const fullW = tCols * TILE_SIZE, fullH = tRows * TILE_SIZE;
  const c0 = Math.round((lngToTileX(bbox.west, zoom) - nw.x) * TILE_SIZE);
  const c1 = Math.round((lngToTileX(bbox.east, zoom) - nw.x) * TILE_SIZE);
  const r0 = Math.round((latToTileY(bbox.north, zoom) - nw.y) * TILE_SIZE);
  const r1 = Math.round((latToTileY(bbox.south, zoom) - nw.y) * TILE_SIZE);
  const cols = Math.max(2, c1 - c0), rows = Math.max(2, r1 - r0);
  const elev = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const fy = Math.min(fullH - 1, r0 + r);
    const tr = Math.floor(fy / TILE_SIZE), py = fy % TILE_SIZE;
    for (let c = 0; c < cols; c++) {
      const fx = Math.min(fullW - 1, c0 + c);
      const tc = Math.floor(fx / TILE_SIZE), pxc = fx % TILE_SIZE;
      elev[r * cols + c] = tiles[tr * tCols + tc][py * TILE_SIZE + pxc];
    }
  }
  // no-data fill (failed decode regions, true voids): Terrarium voids sit
  // at -32768 and would swallow the whole relief range — clamp them to
  // the lowest VALID elevation so they read as "floor", with a warning
  let vMin = Infinity, bad = 0;
  for (let i = 0; i < elev.length; i++) if (elev[i] > -500 && elev[i] < vMin) vMin = elev[i];
  if (!Number.isFinite(vMin)) throw new Error('the region has no valid elevation data');
  for (let i = 0; i < elev.length; i++) if (elev[i] <= -500) { elev[i] = vMin; bad++; }
  const warnings = bad ? [`${bad} no-data elevation samples filled with the region's lowest valid elevation`] : [];
  return { elev, cols, rows, warnings };
}

/**
 * Resolve every terrain reference in the recipe: geocode unpinned queries
 * (writing bbox/zoom/meta back into the recipe entries — call persist()
 * after), fetch grids (cached per pinned region), and return the
 * { id: { grid, meta } } map runRecipe expects.
 */
export async function resolveTerrains(recipe, onStatus) {
  const out = {};
  for (const t of recipe.terrains ?? []) {
    if (!t.bbox) {
      if (!t.query?.trim()) continue;   // the entry op will report it honestly
      onStatus?.(`finding "${t.query}"…`);
      const g = await geocode(t.query);
      t.bbox = g.bbox;
      t.meta = { ...(t.meta ?? {}), name: g.name };
    }
    t.zoom ??= pickZoom(t.bbox);
    const key = JSON.stringify([t.bbox, t.zoom]);
    if (!cache.has(key)) {
      const { elev, cols, rows, warnings } = await fetchGrid(t.bbox, t.zoom, onStatus);
      let eMin = Infinity, eMax = -Infinity;
      for (let i = 0; i < elev.length; i++) { if (elev[i] < eMin) eMin = elev[i]; if (elev[i] > eMax) eMax = elev[i]; }
      const meta = {
        name: t.meta?.name ?? t.query ?? t.id,
        centerLat: (t.bbox.south + t.bbox.north) / 2,
        centerLng: (t.bbox.west + t.bbox.east) / 2,
        elevMinM: Math.round(eMin), elevMaxM: Math.round(eMax),
        warnings,
      };
      cache.set(key, { grid: { elev, cols, rows }, meta });
    }
    const resolved = cache.get(key);
    // pin the human-facing facts into the recipe so the intent model can
    // author true coordinates/elevations on later turns (grids stay out)
    t.meta = {
      name: resolved.meta.name,
      centerLat: Math.round(resolved.meta.centerLat * 1e4) / 1e4,
      centerLng: Math.round(resolved.meta.centerLng * 1e4) / 1e4,
      elevMinM: resolved.meta.elevMinM, elevMaxM: resolved.meta.elevMaxM,
    };
    out[t.id] = resolved;
  }
  return out;
}
