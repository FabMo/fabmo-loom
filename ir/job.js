// Layer A of the composition IR: the Job.
//
// A Job is the unit of composition — what a prompt (or a recipe) ultimately
// produces, and what gets lowered to one moves[] program and posted once.
//
//   Job {
//     units: 'in' | 'mm',            // canonical: 'in' (SBP-native)
//     stock: { w, h, thickness },    // origin bottom-left, Z=0 = stock top
//     safeZ,                         // retract height, > 0
//     spindleSpeed,                  // default rpm; tools may override
//     tools: { [n]: { name, rpm? } },// tool table, keyed by tool number
//     operations: [ Operation ]
//   }
//   Operation {
//     name?,
//     tool,                          // tool number into job.tools
//     feedRate, plungeRate,          // units/min, in op-local units
//     units?,                        // op-local units if != job.units
//     placement?,                    // op-local → job coords (see placement.js)
//     moves: Move[]                  // op-local moves on the canonical rail
//   }
//
// Composition contract (what the verifier later enforces):
//   - the composer owns ALL program-level motion: initial retract, retract
//     before every operation and before every tool change, final retract+home
//   - an operation's moves are mid-program: they must begin with a rapid XY
//     positioning move (entry happens from safeZ) and must not assume any
//     particular prior position
//   - feeds are set by the composer per operation, from op.feedRate/plungeRate

import { movesToSbp, movesToGcode } from './moves.js';
import { applyPlacement } from './placement.js';

const MM_PER_IN = 25.4;

// Lower a whole Job to one moves[] program (no program header/footer — the
// posts below own those).
export function composeJob(job) {
  const moves = [];
  let currentTool = null;

  for (const op of job.operations) {
    const unitScale = unitFactor(op.units ?? job.units, job.units);

    moves.push({ type: 'comment', text: `--- Operation: ${op.name ?? 'unnamed'} ---` });
    moves.push({ type: 'rapid', z: job.safeZ });

    if (op.tool !== currentTool) {
      moves.push({
        type: 'toolchange',
        tool: op.tool,
        name: job.tools?.[op.tool]?.name,
        rpm: job.tools?.[op.tool]?.rpm ?? job.spindleSpeed,
      });
      currentTool = op.tool;
      // After a tool change Z position is not trustworthy — re-assert safe Z.
      moves.push({ type: 'rapid', z: job.safeZ });
    }

    moves.push({
      type: 'feed',
      xy: op.feedRate * unitScale,
      z: op.plungeRate * unitScale,
    });

    // no spread: a dense op (adaptively-sampled V-carve of long text) can
    // exceed the JS engine's argument limit around 65k moves
    for (const m of applyPlacement(op.moves, op.placement, unitScale)) moves.push(m);
  }

  moves.push({ type: 'comment', text: '--- End of job ---' });
  moves.push({ type: 'rapid', z: job.safeZ });
  moves.push({ type: 'rapid', x: 0, y: 0 });
  return moves;
}

function unitFactor(from, to) {
  if (from === to) return 1;
  if (from === 'mm' && to === 'in') return 1 / MM_PER_IN;
  if (from === 'in' && to === 'mm') return MM_PER_IN;
  throw new Error(`unknown unit conversion ${from} -> ${to}`);
}

// ---------- posts: Job + composed moves → complete program ----------
// Same header/footer shape as v_engraver's generateSbp/generateGcode, owned
// once here instead of per-app.

export function postJobToSbp(job, moves, { title = 'Seams composer' } = {}) {
  const lines = [];
  lines.push(`'${title}`);
  lines.push(`'Stock: ${job.stock.w} x ${job.stock.h} x ${job.stock.thickness} ${job.units}`);
  for (const [n, t] of Object.entries(job.tools ?? {})) {
    lines.push(`'Tool ${n}: ${t.name}`);
  }
  lines.push('');
  lines.push('SA');
  // Spindle start belongs to the first toolchange (C7-if-running, &Tool, C9,
  // TR, C6 — see movesToSbp); starting it here would run the wrong speed
  // through the change. Only spin up in the header for tool-less streams.
  if (!moves.some(m => m.type === 'toolchange')) {
    lines.push(`TR,${job.spindleSpeed}`);
    lines.push('C6');
    lines.push('PAUSE 2');
  }
  lines.push(`JZ,${job.safeZ.toFixed(4)}`);
  lines.push('');
  lines.push(movesToSbp(moves));
  lines.push('C7');
  lines.push('END');
  return lines.join('\n');
}

export function postJobToGcode(job, moves, { title = 'Seams composer' } = {}) {
  const lines = [];
  lines.push(`(${title})`);
  lines.push(`(Stock: ${job.stock.w} x ${job.stock.h} x ${job.stock.thickness} ${job.units})`);
  for (const [n, t] of Object.entries(job.tools ?? {})) {
    lines.push(`(Tool ${n}: ${t.name})`);
  }
  lines.push('G90');
  lines.push(job.units === 'mm' ? 'G21' : 'G20');
  lines.push('G17');
  lines.push(`G0 Z${job.safeZ.toFixed(4)}`);
  if (!moves.some(m => m.type === 'toolchange')) {
    lines.push(`M3 S${job.spindleSpeed}`);
    lines.push('G4 P2');
  }
  lines.push('');
  lines.push(movesToGcode(moves));
  lines.push('M5');
  lines.push('M30');
  return lines.join('\n');
}
