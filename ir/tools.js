// Shared shop tool drawer + feeds/speeds engine.
//
// The drawer is a SHOP fact, like loom's machine/material limits: which
// bits the user actually owns and what &Tool number each one answers to on
// their machine. It lives at shop level — one drawer for every app — under
// the Design Store convention (localStorage 'shopbot:tools'), entered by
// the user (there is nothing to detect: tool numbers are however their
// toolchanger/collet workflow is set up).
//
// ToolLibrary {
//   version: 1,
//   machine: { minRPM, maxRPM, maxFeed },   // spindle band + feed cap (in/min)
//   tools: [ Tool ]
// }
// Tool {
//   number,            // REAL &Tool number on the user's machine
//   kind,              // 'flat' | 'ball' | 'vee'
//   diameter,          // inches (canonical, SBP-native)
//   flutes,            // tooth count (feeds scale with it)
//   angleDeg?,         // vee only: included angle
//   maxDepth?,         // flute reach; omitted = assume 4x diameter
//   available?,        // false = in the drawer but not on the machine today
//                      //   (broken, loaned out, vetoed from a plan) — apps
//                      //   must not assign it; anything !== false counts
//                      //   as available
//   name?              // user label; describeTool() when omitted
// }
//
// Feeds/speeds are DERIVED, not stored: chipload tables (in/tooth, Onsrud-
// style mid-range values, 2-flute basis is irrelevant — chipload is per
// tooth) keyed by material, piecewise-linear in diameter. feed = rpm ×
// flutes × chipload, clamped to the machine band; plunge and depth-per-pass
// are material factors. Deterministic and offline — the same grounding
// philosophy as the verifier: recommendations you can read, not a model's
// guess. The user can always override at the app layer.

export const TOOLS_STORAGE_KEY = 'shopbot:tools';

export const DEFAULT_MACHINE = { minRPM: 6000, maxRPM: 24000, maxFeed: 360 };

// Preferred spindle speed when nothing constrains it — the wood-cutting
// sweet spot on a 24k spindle; the feed cap pulls rpm DOWN from here so
// small bits keep their chipload instead of rubbing.
const PREFERRED_RPM = 18000;

// chipload: [diameter, in/tooth] breakpoints, interpolated linearly and
// clamped at the ends. depthFactor × diameter = depth per pass; plunge =
// plungeFactor × feed. rpmCap: plastics melt and aluminum chatters at the
// top of the band.
export const MATERIALS = {
  softwood: { label: 'Softwood (pine, cedar)', depthFactor: 0.5, plungeFactor: 0.33,
    chipload: [[0.0625, 0.002], [0.125, 0.004], [0.25, 0.011], [0.375, 0.017], [0.5, 0.021]] },
  hardwood: { label: 'Hardwood (oak, maple)', depthFactor: 0.4, plungeFactor: 0.3,
    chipload: [[0.0625, 0.002], [0.125, 0.004], [0.25, 0.009], [0.375, 0.014], [0.5, 0.019]] },
  plywood: { label: 'Plywood / baltic birch', depthFactor: 0.5, plungeFactor: 0.33,
    chipload: [[0.0625, 0.002], [0.125, 0.004], [0.25, 0.011], [0.375, 0.015], [0.5, 0.019]] },
  mdf: { label: 'MDF / particle board', depthFactor: 0.5, plungeFactor: 0.33,
    chipload: [[0.0625, 0.0025], [0.125, 0.005], [0.25, 0.012], [0.375, 0.018], [0.5, 0.022]] },
  acrylic: { label: 'Acrylic', depthFactor: 0.35, plungeFactor: 0.25, rpmCap: 18000,
    chipload: [[0.0625, 0.002], [0.125, 0.004], [0.25, 0.008], [0.375, 0.010], [0.5, 0.012]] },
  hdpe: { label: 'HDPE / soft plastic', depthFactor: 0.5, plungeFactor: 0.3,
    chipload: [[0.0625, 0.0025], [0.125, 0.005], [0.25, 0.010], [0.375, 0.013], [0.5, 0.016]] },
  aluminum: { label: 'Aluminum', depthFactor: 0.1, plungeFactor: 0.15, rpmCap: 16000,
    chipload: [[0.0625, 0.001], [0.125, 0.002], [0.25, 0.004], [0.375, 0.005], [0.5, 0.006]] },
};

// '1/4' | '0.25' → 0.25 (the fraction habit is universal in bit sizes)
export function parseInches(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
  const v = m ? parseFloat(m[1]) / parseFloat(m[2]) : parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
}

const FRACTIONS = { 0.0625: '1/16', 0.125: '1/8', 0.1875: '3/16', 0.25: '1/4', 0.3125: '5/16', 0.375: '3/8', 0.5: '1/2', 0.625: '5/8', 0.75: '3/4' };
export const formatInches = d =>
  FRACTIONS[+d.toFixed(4)] ? `${FRACTIONS[+d.toFixed(4)]}"` : `${+d.toFixed(4)}"`;

export function describeTool(t) {
  if (t.name) return t.name;
  if (t.kind === 'vee') return `${t.angleDeg}° ${formatInches(t.diameter)} V-bit`;
  if (t.kind === 'ball') return `${formatInches(t.diameter)} ballnose`;
  return `${formatInches(t.diameter)} endmill`;
}

// ---------- persistence (injectable storage so Node tests need no DOM) ----

export function loadToolLibrary(storage = globalThis.localStorage) {
  const base = { version: 1, machine: { ...DEFAULT_MACHINE }, tools: [] };
  try {
    const raw = storage?.getItem(TOOLS_STORAGE_KEY);
    if (!raw) return base;
    const lib = JSON.parse(raw);
    return {
      version: 1,
      machine: { ...DEFAULT_MACHINE, ...(lib.machine ?? {}) },
      tools: (lib.tools ?? []).filter(t =>
        t && t.number > 0 && t.diameter > 0 && ['flat', 'ball', 'vee'].includes(t.kind))
        .map(t => ({ flutes: 2, ...t })),
    };
  } catch { return base; }
}

export function saveToolLibrary(lib, storage = globalThis.localStorage) {
  try { storage?.setItem(TOOLS_STORAGE_KEY, JSON.stringify(lib)); return true; }
  catch { return false; }
}

// ---------- feeds/speeds ----------

function chiploadFor(material, diameter) {
  const pts = material.chipload;
  if (diameter <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (diameter <= pts[i][0]) {
      const [d0, c0] = pts[i - 1], [d1, c1] = pts[i];
      return c0 + (c1 - c0) * (diameter - d0) / (d1 - d0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * recommendFeeds(tool, materialKey, machine?) →
 *   { rpm, feedRate, plungeRate, depthPerPass, chipload } (rates in in/min)
 * or null when the material is unknown (caller keeps its manual feeds).
 *
 * V-bits engage far less diameter than they measure (the cut happens near
 * the tip), so they read the table at 1/8" regardless of shank size —
 * conservative by design; depth per pass for a vee is the strategy's
 * business (V-carve depth follows the geometry), so the returned value is
 * only a cap.
 */
export function recommendFeeds(tool, materialKey, machine = DEFAULT_MACHINE) {
  const mat = MATERIALS[materialKey];
  if (!mat) return null;
  const flutes = tool.flutes > 0 ? tool.flutes : 2;
  const effDia = tool.kind === 'vee' ? Math.min(tool.diameter, 0.125) : tool.diameter;
  const ipt = chiploadFor(mat, effDia);

  const rpmTop = Math.min(machine.maxRPM, mat.rpmCap ?? Infinity);
  let rpm = Math.max(machine.minRPM, Math.min(PREFERRED_RPM, rpmTop));
  let feed = rpm * flutes * ipt;
  if (feed > machine.maxFeed) {
    // keep the chipload, shed rpm — rubbing dulls bits faster than cutting
    rpm = Math.max(machine.minRPM, machine.maxFeed / (flutes * ipt));
    feed = Math.min(machine.maxFeed, rpm * flutes * ipt);
  }
  rpm = Math.round(rpm / 100) * 100;

  return {
    rpm,
    feedRate: Math.max(1, Math.round(feed)),
    plungeRate: Math.max(1, Math.round(feed * mat.plungeFactor)),
    depthPerPass: Math.max(0.01, +(mat.depthFactor * tool.diameter).toFixed(3)),
    chipload: +ipt.toFixed(4),
  };
}
