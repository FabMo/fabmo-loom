// Canonical motion rail ("moves") for the composition IR.
//
// This is the output-rail neck of the fabrication hourglass: every strategy
// lowers to this form, and every post/verifier/simulator consumes it.
// Ported from v_engraver/modules/toolpaths.js (the most complete of the
// per-app copies of "movesToSbp/movesToGcode") and extended with two move
// types composition needs that no single app did: 'feed' and 'toolchange'.
//
// A move is one of:
//   {type:'rapid',      x?, y?, z?}          jog; omitted axes hold position
//   {type:'linear',     x?, y?, z?}          feed move; omitted axes hold
//   {type:'arc',        x, y, z?, i?, j?, cw} arc in XY plane, center-offset
//   {type:'feed',       xy?, z?}             set feed rates in units/min;
//                                            omitted rate is left unchanged
//   {type:'toolchange', tool, name?, rpm?}   switch active tool (number);
//                                            rpm = spindle speed for the new
//                                            tool (posts emit TR/S with it)
//   {type:'comment',    text}
//
// Coordinates are job-space, absolute. Units are whatever the surrounding
// Job declares (canonical: inches). Z=0 is stock top, negative into material.

export function movesToSbp(moves) {
  let sbp = '';
  let lastPos = { x: 0, y: 0, z: 0 };
  // The spindle must be stopped across a tool change, and speed/start belong
  // AFTER the change (&Tool, C9) so they apply to the new tool. The first
  // toolchange in a stream is therefore where the spindle starts — posts
  // must not C6 in their header when the stream contains a toolchange.
  let spindleOn = false;

  moves.forEach(move => {
    if (move.type === 'comment') {
      sbp += `'${move.text}\n`;
      return;
    }

    if (move.type === 'feed') {
      // MS,<xy in/sec>,<z in/sec> — blank field leaves that rate unchanged
      const xy = move.xy !== undefined ? (move.xy / 60).toFixed(4) : '';
      const z = move.z !== undefined ? (move.z / 60).toFixed(4) : '';
      sbp += `MS,${xy},${z}\n`;
      return;
    }

    if (move.type === 'toolchange') {
      if (spindleOn) sbp += `C7\n`;
      sbp += `'Tool change: T${move.tool}${move.name ? ' (' + move.name + ')' : ''}\n`;
      sbp += `&Tool = ${move.tool}\n`;
      sbp += `C9\n`;
      if (move.rpm !== undefined) sbp += `TR,${move.rpm}\n`;
      sbp += `C6\n`;
      sbp += `PAUSE 2\n`;
      spindleOn = true;
      return;
    }

    const x = move.x !== undefined ? move.x : lastPos.x;
    const y = move.y !== undefined ? move.y : lastPos.y;
    const z = move.z !== undefined ? move.z : lastPos.z;

    if (move.type === 'rapid') {
      if (move.x === undefined && move.y === undefined) {
        sbp += `JZ,${z.toFixed(6)}\n`;
      } else if (move.z === undefined) {
        sbp += `J2,${x.toFixed(6)},${y.toFixed(6)}\n`;
      } else {
        sbp += `J3,${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}\n`;
      }
      lastPos = { x, y, z };
      return;
    }
    if (move.type === 'linear') {
      if (move.x === undefined && move.y === undefined) {
        sbp += `MZ,${z.toFixed(6)}\n`;
      } else if (move.z === undefined) {
        sbp += `M2,${x.toFixed(6)},${y.toFixed(6)}\n`;
      } else {
        sbp += `M3,${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}\n`;
      }
      lastPos = { x, y, z };
      return;
    }
    if (move.type === 'arc') {
      const dir = move.cw ? 1 : -1;
      sbp += `CG, ,${x.toFixed(6)},${y.toFixed(6)},${(move.i ?? 0).toFixed(6)},${(move.j ?? 0).toFixed(6)},T,${dir}\n`;
      lastPos = { x, y, z };
    }
  });
  return sbp;
}

export function movesToGcode(moves, { feedRate } = {}) {
  let gcode = '';
  let currentFeed = null;          // feed rate currently active on the machine
  let pendingFeed = feedRate ?? null; // feed rate the next cut should run at
  let lastPos = { x: 0, y: 0, z: 0 };
  let spindleOn = false;           // same contract as movesToSbp

  const feedWord = () => {
    if (pendingFeed != null && pendingFeed !== currentFeed) {
      currentFeed = pendingFeed;
      return ` F${pendingFeed.toFixed(3)}`;
    }
    return '';
  };

  moves.forEach(move => {
    if (move.type === 'comment') {
      gcode += `(${move.text})\n`;
      return;
    }

    if (move.type === 'feed') {
      if (move.xy !== undefined) pendingFeed = move.xy;
      return;
    }

    if (move.type === 'toolchange') {
      if (spindleOn) gcode += 'M5\n';
      gcode += `(Tool change: T${move.tool}${move.name ? ' ' + move.name : ''})\n`;
      gcode += `T${move.tool} M6\n`;
      gcode += move.rpm !== undefined ? `M3 S${move.rpm}\n` : 'M3\n';
      gcode += 'G4 P2\n';
      spindleOn = true;
      return;
    }

    const x = move.x !== undefined ? move.x : lastPos.x;
    const y = move.y !== undefined ? move.y : lastPos.y;
    const z = move.z !== undefined ? move.z : lastPos.z;

    if (move.type === 'rapid') {
      let coords = '';
      if (move.x !== undefined) coords += ` X${x.toFixed(6)}`;
      if (move.y !== undefined) coords += ` Y${y.toFixed(6)}`;
      if (move.z !== undefined) coords += ` Z${z.toFixed(6)}`;
      gcode += `G0${coords}\n`;
      lastPos = { x, y, z };
      return;
    }
    if (move.type === 'linear') {
      let coords = '';
      if (move.x !== undefined) coords += ` X${x.toFixed(6)}`;
      if (move.y !== undefined) coords += ` Y${y.toFixed(6)}`;
      if (move.z !== undefined) coords += ` Z${z.toFixed(6)}`;
      gcode += `G1${coords}${feedWord()}\n`;
      lastPos = { x, y, z };
      return;
    }
    if (move.type === 'arc') {
      const code = move.cw ? 'G2' : 'G3';
      gcode += `${code} X${x.toFixed(6)} Y${y.toFixed(6)} Z${z.toFixed(6)} I${(move.i ?? 0).toFixed(6)} J${(move.j ?? 0).toFixed(6)}${feedWord()}\n`;
      lastPos = { x, y, z };
    }
  });

  return gcode;
}

// Walk moves resolving sticky coordinates; cb(state, move) sees the resolved
// position AFTER the move plus the feed/tool in effect. The shared chassis
// for stats, verification, and simulation.
export function walkMoves(moves, cb, start = { x: 0, y: 0, z: 0 }) {
  const state = {
    x: start.x, y: start.y, z: start.z,
    prev: { x: start.x, y: start.y, z: start.z },
    feedXY: null, feedZ: null, tool: null,
  };
  for (const move of moves) {
    if (move.type === 'comment') continue;
    if (move.type === 'feed') {
      if (move.xy !== undefined) state.feedXY = move.xy;
      if (move.z !== undefined) state.feedZ = move.z;
      cb(state, move);
      continue;
    }
    if (move.type === 'toolchange') {
      state.tool = move.tool;
      cb(state, move);
      continue;
    }
    state.prev = { x: state.x, y: state.y, z: state.z };
    if (move.x !== undefined) state.x = move.x;
    if (move.y !== undefined) state.y = move.y;
    if (move.z !== undefined) state.z = move.z;
    cb(state, move);
  }
  return state;
}
