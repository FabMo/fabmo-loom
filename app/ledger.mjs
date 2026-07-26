// The sheet ledger — a local, persistent record of ONE physical piece of stock
// and what's already been cut from it, so a single operator can keep pulling
// parts from the same sheet over many designs without overlapping past cuts.
//
// State (app-level, localStorage 'loom:sheet' — outlives every recipe, like the
// shop settings): a sheet W×H×T plus a list of occupied footprints (bbox
// keep-outs), origin bottom-left, inches. A new design nests into the free
// space via placeOnSheet(); on a VERIFIED EXPORT its footprint is appended.
//
// This module is PURE geometry/state (no DOM, no storage) so it tests headless;
// persistence + the status chip + the append-on-export hook live in main.js.
// The packer is a small bottom-left-fill heuristic — the reusable nesting
// primitive public Loom/seams didn't have yet (the shelfPack one is private).

/** A fresh sheet with no cuts recorded. */
export function makeSheet(w, h, thickness) {
  return { w, h, thickness, occupied: [] };
}

/** True when the sheet is actually declared (both dimensions positive). */
export function sheetActive(sheet) {
  return !!(sheet && sheet.w > 0 && sheet.h > 0);
}

const rectsOverlap = (a, b, gap = 0) =>
  !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);

function fitsAt(sheet, x, y, w, h, gap) {
  if (x < -1e-9 || y < -1e-9 || x + w > sheet.w + 1e-9 || y + h > sheet.h + 1e-9) return false;
  const cand = { x, y, w, h };
  return !(sheet.occupied ?? []).some((o) => rectsOverlap(cand, o, gap));
}

/**
 * Find a free spot for an fw×fh footprint on the sheet, avoiding occupied
 * regions (bottom-left-fill: try the sheet origin and the right/top edges of
 * every placed part, keep the lowest-then-leftmost fit). Tries both
 * orientations unless allowRotate is false.
 *
 * @returns {{x,y,w,h,rotated}|null}  null = it doesn't fit in the remaining space
 */
export function placeOnSheet(sheet, fw, fh, { gap = 0.25, allowRotate = true } = {}) {
  if (!sheetActive(sheet) || !(fw > 0) || !(fh > 0)) return null;
  const orients = allowRotate && Math.abs(fw - fh) > 1e-9
    ? [[fw, fh, false], [fh, fw, true]]
    : [[fw, fh, false]];
  const anchors = [{ x: 0, y: 0 }];
  for (const o of sheet.occupied ?? []) {
    anchors.push({ x: o.x + o.w + gap, y: o.y });   // to the right of a placed part
    anchors.push({ x: o.x, y: o.y + o.h + gap });   // above it
  }
  const valid = [];
  for (const [w, h, rotated] of orients)
    for (const a of anchors)
      if (fitsAt(sheet, a.x, a.y, w, h, gap)) valid.push({ x: a.x, y: a.y, w, h, rotated });
  if (!valid.length) return null;
  valid.sort((p, q) => (p.y - q.y) || (p.x - q.x));  // bottom, then left
  return valid[0];
}

/** Does an fw×fh footprint fit in the sheet's remaining space? */
export function fitsOnSheet(sheet, fw, fh, opts) {
  return placeOnSheet(sheet, fw, fh, opts) !== null;
}

/** Percent of the sheet AREA still free (0..100). Area, not layout — the chip. */
export function sheetFreePct(sheet) {
  if (!sheetActive(sheet)) return 100;
  const area = sheet.w * sheet.h;
  const used = (sheet.occupied ?? []).reduce((s, o) => s + o.w * o.h, 0);
  return Math.max(0, Math.round((1 - used / area) * 100));
}

/**
 * Record a cut: place an fw×fh footprint and return a NEW sheet with it added
 * to occupied. Returns { sheet, placement } on success, or { error } when the
 * design won't fit the remaining space (nothing recorded).
 */
export function recordCut(sheet, fw, fh, label = '', opts) {
  const placement = placeOnSheet(sheet, fw, fh, opts);
  if (!placement) {
    return { error: `${fw}" × ${fh}" won't fit the ${sheetFreePct(sheet)}%-free space left on your ${sheet.w}" × ${sheet.h}" sheet` };
  }
  const occ = { x: placement.x, y: placement.y, w: placement.w, h: placement.h, label };
  return { sheet: { ...sheet, occupied: [...(sheet.occupied ?? []), occ] }, placement };
}

/** Wipe the cut history (a fresh sheet / the board was flipped or replaced). */
export function clearCuts(sheet) {
  return { ...sheet, occupied: [] };
}
