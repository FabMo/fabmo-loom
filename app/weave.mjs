// The weaving activity animation — the loom logo brought to life while a
// prompt is being processed, seen in ISOMETRIC perspective: warp threads
// alternating navy/sky (via-pad ends, like the logo's circuit traces) run
// down one diagonal, and red weft strips slide in along the other,
// passing over and under in a true basket weave. The cloth grows away
// from the weaver, one row per pass.
//
// All weave logic lives in flat "cloth space"; a single canvas transform
// maps it onto the isometric plane (cloth x → down-right, cloth y →
// down-left). Crossings get a device-space drop shadow so over/under
// reads as depth.
//
// Self-contained: startWeave(panel) drops an overlay into `panel`
// (position:relative) and returns a stop() that removes it. Honors
// prefers-reduced-motion with a static message.

const NAVY = '#1b2a6b', SKY = '#7ba3d4', RED = '#cc2229';

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

  const W = 420, H = 250;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.cssText = `width:${W}px; height:${H}px;`;
  overlay.append(canvas, note);
  panel.append(overlay);

  const ctx = canvas.getContext('2d');

  // ---- cloth space ----
  // x: the weft (red) direction — strips slide in +x
  // y: the warp direction — threads run the full length
  const Wc = 215, Hc = 185;
  const COLS = 7;                     // warp threads
  const warpW = 11;
  const colGap = (Wc - 40) / (COLS - 1);
  const colX = (i) => 20 + i * colGap;
  const rowH = 16, rowGap = 7, rowPitch = rowH + rowGap;
  const clothTop = 26, clothBot = Hc - 6;

  // ---- isometric mapping: cloth x → down-right, cloth y → down-left ----
  const ISO = { ax: 0.866, ay: 0.5 };
  const tx = 20 + ISO.ax * Hc;        // leftmost point (x=0, y=Hc) lands at 20
  const ty = 26;                      // room for the via pads above the fell
  const setIso = () => ctx.setTransform(
    dpr * ISO.ax, dpr * ISO.ay,
    -dpr * ISO.ax, dpr * ISO.ay,
    dpr * tx, dpr * ty,
  );

  // Continuous diagonal scroll: the cloth drifts along the warp at exactly
  // one row-pitch per pick, so each red strip weaves in WHILE it drifts
  // away from the fell (just below the pads), and old rows slide off the
  // end of the warp forever. row.age ∈ [0,1] is its weaving progress;
  // y = fellY + rowPitch · totalAge is its drift.
  const fellY = clothTop;
  const rows = [];                    // [{ parity, born }], newest last
  let rowCounter = 0;
  const ROW_MS = 700;
  let lastSpawn = -Infinity;
  let raf = 0;
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  function weftStrip(y, frac) {
    if (frac <= 0) return;
    const x0 = 6, x1 = 6 + frac * (Wc - 12);
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.roundRect(x0, y, x1 - x0, rowH, rowH / 2);
    ctx.fill();
  }

  function overSegments(y, frac, parity, shadow) {
    const tip = 6 + frac * (Wc - 12);
    if (shadow) {
      ctx.shadowColor = 'rgba(30,30,50,0.35)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 2.5 * dpr;
    }
    ctx.fillStyle = RED;
    for (let c = 0; c < COLS; c++) {
      if ((c + parity) % 2 !== 0) continue;
      const x = colX(c);
      if (tip < x + warpW) continue;
      ctx.fillRect(x - warpW / 2 - 2.5, y, warpW + 5, rowH);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  // start with the cloth already woven: seed picks with back-dated births
  // as if the loom had been running forever, then just keep the cadence
  let seeded = false;
  function seed(t0) {
    const N = Math.ceil((clothBot - fellY) / rowPitch) + 1;
    for (let k = 0; k < N; k++) {
      rows.push({ parity: k % 2, born: t0 - (N - k) * ROW_MS });
    }
    rowCounter = N;
    lastSpawn = t0 - ROW_MS;   // a fresh pick spawns on this first frame
  }

  function frame(t) {
    if (!seeded) { seed(t); seeded = true; }
    if (t - lastSpawn >= ROW_MS) {
      rows.push({ parity: rowCounter % 2, born: t });
      rowCounter++;
      lastSpawn = t;
    }
    // drop rows that have drifted past the end of the warp
    while (rows.length && fellY + rowPitch * ((t - rows[0].born) / ROW_MS) > clothBot + rowH) rows.shift();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W * dpr, H * dpr);
    setIso();

    const yOf = (r) => fellY + rowPitch * ((t - r.born) / ROW_MS);
    const frOf = (r) => ease(Math.min(1, (t - r.born) / ROW_MS));

    // weft passes are clipped to the warp's extent so departing rows
    // slide off the end of the threads instead of floating past them
    const clipWeft = (fn) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, fellY - 2, Wc, clothBot - fellY + rowH * 0.6);
      ctx.clip();
      fn();
      ctx.restore();
    };

    // 1. weft under-pass
    clipWeft(() => rows.forEach((r) => weftStrip(yOf(r), frOf(r))));

    // 2. warp threads, alternating navy/sky, via-pad ends
    for (let c = 0; c < COLS; c++) {
      const x = colX(c);
      const color = c % 2 ? SKY : NAVY;
      ctx.strokeStyle = color;
      ctx.lineWidth = warpW;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, clothBot + 3);
      ctx.stroke();
      // via pad (a circle in cloth space renders as an isometric ellipse)
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, 4, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(247,246,242,1)';
      ctx.beginPath();
      ctx.arc(x, 4, 4.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. weft over-pass — the crossings, with depth shadow
    clipWeft(() => rows.forEach((r) => overSegments(yOf(r), frOf(r), r.parity, true)));

    // the shuttle rides the youngest, still-weaving row
    const young = rows[rows.length - 1];
    if (young && (t - young.born) < ROW_MS) {
      const fr = frOf(young);
      const tip = Math.min(6 + fr * (Wc - 12), Wc - 8);
      ctx.fillStyle = NAVY;
      ctx.beginPath();
      ctx.arc(tip, yOf(young) + rowH / 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(247,246,242,1)';
      ctx.beginPath();
      ctx.arc(tip, yOf(young) + rowH / 2, 2.8, 0, Math.PI * 2);
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
