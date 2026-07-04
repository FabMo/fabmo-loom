// The weaving activity animation — the loom logo brought to life while a
// prompt is being processed. Warp threads (navy, via-pad tops, like the
// logo's circuit traces) stand vertical; weft strips in the logo's red /
// sky / navy shuttle across, passing over and under in a true basket
// weave, and the cloth grows upward one row per pass.
//
// Self-contained: startWeave(panel) drops an overlay into `panel`
// (which must be position:relative) and returns a stop() that removes
// it. Honors prefers-reduced-motion with a static message.

const NAVY = '#1b2a6b', SKY = '#7ba3d4', RED = '#cc2229';
const WEFT_COLORS = [RED, SKY, NAVY];

export function startWeave(panel, label = 'weaving…') {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: absolute; inset: 0; z-index: 20; border-radius: 12px;
    background: rgba(247,246,242,0.92);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  `;
  const note = document.createElement('div');
  note.textContent = label;
  note.style.cssText = 'font-size: .9rem; color: #6a7086; font-style: italic;';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    overlay.append(note);
    panel.append(overlay);
    return () => overlay.remove();
  }

  const W = 380, H = 230;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.cssText = `width:${W}px; height:${H}px;`;
  overlay.append(canvas, note);
  panel.append(overlay);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ---- geometry ----
  const COLS = 8;
  const warpW = 9;
  const colGap = (W - 60) / (COLS - 1);
  const colX = (i) => 30 + i * colGap;
  const padTopY = 26;                 // via pads row
  const clothTop = 48, clothBot = H - 16;
  const rowH = 15, rowGap = 6, rowPitch = rowH + rowGap;
  const maxRows = Math.floor((clothBot - clothTop) / rowPitch);

  // rows[0] is the newest (bottom); grows until maxRows then oldest drops
  const rows = [];
  let rowCounter = 0;
  let current = { color: WEFT_COLORS[0], parity: 0, progress: 0 };
  const ROW_MS = 700;
  let lastT = performance.now();
  let raf = 0;

  const ease = (t) => 1 - Math.pow(1 - t, 3);

  function drawWeftStrip(y, color, frac) {
    if (frac <= 0) return;
    const x0 = 18, x1 = 18 + frac * (W - 36);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x0, y, x1 - x0, rowH, rowH / 2);
    ctx.fill();
  }

  function overSegments(y, color, frac, parity) {
    // re-draw the weft over the warp at alternating crossings
    const tip = 18 + frac * (W - 36);
    ctx.fillStyle = color;
    for (let c = 0; c < COLS; c++) {
      if ((c + parity) % 2 !== 0) continue;
      const x = colX(c);
      if (tip < x + warpW) continue;   // strip hasn't fully crossed this warp yet
      ctx.fillRect(x - warpW / 2 - 2, y, warpW + 4, rowH);
    }
  }

  function frame(t) {
    const dt = t - lastT;
    lastT = t;
    current.progress += dt / ROW_MS;
    if (current.progress >= 1) {
      rows.unshift({ color: current.color, parity: current.parity });
      if (rows.length > maxRows) rows.pop();
      rowCounter++;
      current = { color: WEFT_COLORS[rowCounter % WEFT_COLORS.length], parity: rowCounter % 2, progress: 0 };
    }

    ctx.clearRect(0, 0, W, H);

    // the woven block anchors at the bottom of the canvas and grows upward;
    // the newest row (and the in-flight one) sit at the top of the block —
    // the fell of the cloth, where a real loom weaves
    const blockRows = rows.length;
    const yOf = (idx) => clothBot - rowH - (blockRows - 1 - idx) * rowPitch; // rows[0]=newest → highest
    const yCurrent = clothBot - rowH - blockRows * rowPitch;

    // 1. weft under-pass
    rows.forEach((r, i) => drawWeftStrip(yOf(i), r.color, 1));
    if (yCurrent > clothTop - rowH) drawWeftStrip(yCurrent, current.color, ease(Math.min(1, current.progress)));

    // 2. warp threads + via pads (the logo's circuit-trace look)
    for (let c = 0; c < COLS; c++) {
      const x = colX(c);
      ctx.strokeStyle = NAVY;
      ctx.lineWidth = warpW;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, padTopY + 8);
      ctx.lineTo(x, clothBot + 4);
      ctx.stroke();
      // pad: donut
      ctx.fillStyle = c % 2 ? SKY : NAVY;
      ctx.beginPath();
      ctx.arc(x, padTopY, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(247,246,242,1)';
      ctx.beginPath();
      ctx.arc(x, padTopY, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. weft over-pass (the actual weave)
    rows.forEach((r, i) => overSegments(yOf(i), r.color, 1, r.parity));
    if (yCurrent > clothTop - rowH) {
      const fr = ease(Math.min(1, current.progress));
      overSegments(yCurrent, current.color, fr, current.parity);
      // the shuttle: a small pad-like dot leading the strip
      const tip = 18 + fr * (W - 36);
      ctx.fillStyle = NAVY;
      ctx.beginPath();
      ctx.arc(Math.min(tip, W - 18), yCurrent + rowH / 2, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(247,246,242,1)';
      ctx.beginPath();
      ctx.arc(Math.min(tip, W - 18), yCurrent + rowH / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    overlay.remove();
  };
}
