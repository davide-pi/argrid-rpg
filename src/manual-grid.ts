// Manual-grid editor: place / adapt / draw a grid by hand (quad + traced lines), loupe, bar controls.
import { S, type ImgPt } from './tactical-state';
import {
  view, manualBar, editChooser, fabWrap, hud, btnEditGrid, colsInput, rowsInput, manualCollapse,
  chooseAdapt, chooseDraw, chooseCancel, colsMinus, colsPlus, rowsMinus, rowsPlus, manualDone, manualCancel,
} from './dom';
import { solveHomography, applyH, makeGridMap } from './overlays';
import { clipLineToRect, buildGrid, intersect, DEFAULT_PARAMS, type Line2, type RawLine } from './grid-detector';
import { activePointers, capturePointer } from './pointer-capture';
import { draw } from './draw-loop';
import { rebuildDebugBar } from './debug-panel';
import { updateInfo } from './hud';
import { updateFabEnabled } from './placement';
import { deselectCell } from './gestures';
import { applyDetectedGrid, updateResultChrome } from './main';

// --- Manual grid editor -----------------------------------------------
// When auto-detection is unreliable the user can place a grid by hand: a quad
// (4 draggable corners) over the photo, tiled into `manualNa × manualNb` cells.
// The quad → unit-square homography gives projective (perspective-correct) cell
// nodes, from which we build the same familyA/familyB Line2[] the detector would,
// so drawing + all tactical tools work unchanged.
export let manualNa = 10;

export let manualNb = 10;

export let manualDragLast: ImgPt | null = null;

export let manualCollapsed = false;

// "Draw by hand" mode: the user TRACES reference lines along columns and rows, and
// the grid is generated from them (buildGrid: family split + fit + extend to frame).
export let manualStrokes: [ImgPt, ImgPt][] = [];

export let strokeStart: ImgPt | null = null;

export let strokeEnd: ImgPt | null = null;

export const DRAW_SENTINEL = 5;

export const PINCH_SENTINEL = 6;

export const ENDPOINT_SENTINEL = 7;

export let drawEndpointDrag: { s: number; e: 0 | 1 } | null = null;

// Live pointer positions (image coords) during manual editing, for pinch.
export const manualPointerPos = new Map<number, ImgPt>();

export let pinchState: { startDist: number; startQuad: ImgPt[]; center: ImgPt } | null = null;

/** Client → image-pixel coordinates (accounts for CSS sizing + the zoom transform,
 * since the canvas backing store is in image pixels). */
export function pointerToImage(clientX: number, clientY: number): ImgPt | null {
  const rect = view.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * view.width,
    y: ((clientY - rect.top) / rect.height) * view.height,
  };
}

/** Line2 (normal form) through two image points. */
export function lineThrough(p1: ImgPt, p2: ImgPt): Line2 {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return { nx, ny, d: nx * p1.x + ny * p1.y };
}

/** Build the two line families from the current quad + cell counts. */
export function manualToFamilies(): { A: Line2[]; B: Line2[] } | null {
  if (!S.manualQuad) return null;
  const [TL, TR, BR, BL] = S.manualQuad;
  const H = solveHomography(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[TL.x, TL.y], [TR.x, TR.y], [BR.x, BR.y], [BL.x, BL.y]],
  );
  if (!H) return null;
  const node = (i: number, j: number): ImgPt => {
    const [x, y] = applyH(H, i / manualNa, j / manualNb);
    return { x, y };
  };
  const A: Line2[] = []; // constant i (columns): na+1 lines
  for (let i = 0; i <= manualNa; i++) A.push(lineThrough(node(i, 0), node(i, manualNb)));
  const B: Line2[] = []; // constant j (rows): nb+1 lines
  for (let j = 0; j <= manualNb; j++) B.push(lineThrough(node(0, j), node(manualNa, j)));
  return { A, B };
}

/** Recompute families + grid map from the quad and redraw. */
export function applyManual() {
  const fam = manualToFamilies();
  if (!fam || !S.lastResult) return;
  S.lastResult.familyA = fam.A;
  S.lastResult.familyB = fam.B;
  S.gridMap = makeGridMap(fam.A, fam.B);
  S.gridDims = { na: fam.A.length, nb: fam.B.length };
  S.gridReliable = true;
  draw();
}

/**
 * Commit the manual grid, EXTENDING the lattice past the drawn quad to fill the
 * whole frame (like the detector's extend:'frame'): continue the same projective
 * lattice outward from each edge while the line still crosses the image, capped and
 * with a crowding guard. Cells beyond the drawn quad are flagged extended (drawn
 * faint). Returns false if there's no valid quad to commit.
 */
export function commitManualGrid(): boolean {
  if (!S.manualQuad || !S.lastResult) return false;
  const [TL, TR, BR, BL] = S.manualQuad;
  const H = solveHomography(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[TL.x, TL.y], [TR.x, TR.y], [BR.x, BR.y], [BL.x, BL.y]],
  );
  if (!H) return false;
  const W = S.lastResult.width;
  const Ht = S.lastResult.height;
  const node = (i: number, j: number): ImgPt => {
    const [x, y] = applyH(H, i / manualNa, j / manualNb);
    return { x, y };
  };
  const CAP = 200; // hard cap on extended lines per side
  const MIN_GAP = 2; // stop once adjacent lines crowd below this (px) — near a VP
  const colLine = (i: number) => lineThrough(node(i, 0), node(i, manualNb));
  const rowLine = (j: number) => lineThrough(node(0, j), node(manualNa, j));
  const midJ = manualNb / 2;
  const midI = manualNa / 2;
  const colGap = (i: number) => Math.hypot(node(i, midJ).x - node(i - 1, midJ).x, node(i, midJ).y - node(i - 1, midJ).y);
  const rowGap = (j: number) => Math.hypot(node(midI, j).x - node(midI, j - 1).x, node(midI, j).y - node(midI, j - 1).y);
  const crosses = (l: Line2) => !!clipLineToRect(l, W, Ht);

  let iMin = 0;
  let iMax = manualNa;
  let jMin = 0;
  let jMax = manualNb;
  for (let i = -1; i > -CAP; i--) {
    if (!crosses(colLine(i)) || colGap(i + 1) < MIN_GAP) break;
    iMin = i;
  }
  for (let i = manualNa + 1; i < manualNa + CAP; i++) {
    if (!crosses(colLine(i)) || colGap(i) < MIN_GAP) break;
    iMax = i;
  }
  for (let j = -1; j > -CAP; j--) {
    if (!crosses(rowLine(j)) || rowGap(j + 1) < MIN_GAP) break;
    jMin = j;
  }
  for (let j = manualNb + 1; j < manualNb + CAP; j++) {
    if (!crosses(rowLine(j)) || rowGap(j) < MIN_GAP) break;
    jMax = j;
  }

  const A: Line2[] = [];
  for (let i = iMin; i <= iMax; i++) {
    const l = colLine(i);
    if (i < 0 || i > manualNa) {
      l.extended = true;
      l.filled = true;
    }
    A.push(l);
  }
  const B: Line2[] = [];
  for (let j = jMin; j <= jMax; j++) {
    const l = rowLine(j);
    if (j < 0 || j > manualNb) {
      l.extended = true;
      l.filled = true;
    }
    B.push(l);
  }
  S.lastResult.familyA = A;
  S.lastResult.familyB = B;
  S.gridMap = makeGridMap(A, B);
  S.gridDims = { na: A.length, nb: B.length };
  S.gridReliable = true;
  return true;
}

/** Radius (image px) within which a tap grabs a corner handle. */
export function manualHandleRadius(): number {
  const W = S.lastResult?.width ?? view.width;
  const H = S.lastResult?.height ?? view.height;
  return Math.max(W, H) * 0.045;
}

export function pointInQuad(p: ImgPt, q: ImgPt[]): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i];
    const b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

export function showManualBar(show: boolean) {
  manualBar.hidden = !show;
  manualBar.classList.toggle('collapsed', manualCollapsed);
}

export function updateManualBar() {
  colsInput.value = String(manualNa);
  rowsInput.value = String(manualNb);
}

/** Seed the editable quad + counts from the CURRENT grid (its outer lines), so the
 * user edits the existing grid rather than a fresh default. Returns false if there's
 * no usable grid to seed from. */
export function seedQuadFromCurrentGrid(): boolean {
  if (!S.lastResult) return false;
  const fA = S.lastResult.familyA;
  const fB = S.lastResult.familyB;
  if (fA.length < 2 || fB.length < 2) return false;
  // The detector's two families aren't labelled vertical/horizontal, so map them to the
  // manual grid's COLUMNS (vertical lines) and ROWS (horizontal lines) by orientation —
  // a vertical line has a ~horizontal normal (|nx| > |ny|). Otherwise the seeded Colonne
  // and Righe counts (and the quad's u/v axes) come out swapped.
  const absNx = (f: typeof fA) => f.reduce((s, l) => s + Math.abs(l.nx), 0) / f.length;
  const [cols, rows] = absNx(fA) >= absNx(fB) ? [fA, fB] : [fB, fA];
  const c00 = intersect(cols[0], rows[0]);
  const c10 = intersect(cols[cols.length - 1], rows[0]);
  const c11 = intersect(cols[cols.length - 1], rows[rows.length - 1]);
  const c01 = intersect(cols[0], rows[rows.length - 1]);
  if (!c00 || !c10 || !c11 || !c01) return false;
  S.manualQuad = [
    { x: c00.x, y: c00.y },
    { x: c10.x, y: c10.y },
    { x: c11.x, y: c11.y },
    { x: c01.x, y: c01.y },
  ];
  manualNa = Math.max(1, cols.length - 1); // columns (subdivide the top/bottom edge)
  manualNb = Math.max(1, rows.length - 1); // rows
  return true;
}

export function manualDefaultQuad() {
  if (!S.lastResult) return;
  const W = S.lastResult.width;
  const H = S.lastResult.height;
  // A centred SQUARE 10×10 grid (square cells) — a clean, predictable starting point
  // the user then drags to fit. (Adapting to a photo's aspect gave odd default counts.)
  const side = Math.min(W, H) * 0.76;
  const x0 = (W - side) / 2;
  const y0 = (H - side) / 2;
  S.manualQuad = [
    { x: x0, y: y0 },
    { x: x0 + side, y: y0 },
    { x: x0 + side, y: y0 + side },
    { x: x0, y: y0 + side },
  ];
  manualNa = 10;
  manualNb = 10;
}

// Draw-mode bar variant: the grid comes from the traced lines, so there are no cell
// steppers and nothing to collapse — the bar is just a slim head (Annulla / Fatto).
export function applyManualBarMode() {
  manualBar.classList.toggle('draw-mode', S.manualDrawPending);
  manualCollapse.hidden = S.manualDrawPending;
}

export function enterManualMode(mode: 'adapt' | 'draw' = 'adapt') {
  if (!S.lastCapture || !S.lastResult) return;
  S.manualActive = true;
  editChooser.hidden = true;
  fabWrap.hidden = true;
  hud.hidden = true;
  btnEditGrid.hidden = true;
  manualCollapsed = false;
  S.manualDrawPending = mode === 'draw';
  manualStrokes = [];
  strokeStart = null;
  strokeEnd = null;
  drawEndpointDrag = null;
  manualPointerPos.clear();
  pinchState = null;
  applyManualBarMode();
  showManualBar(true);
  rebuildDebugBar(); // hide the debug step bar while editing a manual grid
  if (S.manualDrawPending) {
    // No grid yet — wait for the user to trace lines. Show the photo alone.
    S.manualQuad = null;
    S.gridReliable = false;
    S.gridMap = null;
    updateManualBar();
    draw();
  } else {
    // Start from the current grid when it's usable, else a default quad — so a
    // well-detected grid is only tweaked, but a bad/absent one starts from scratch.
    if (!S.gridReliable || !seedQuadFromCurrentGrid()) manualDefaultQuad();
    updateManualBar(); // sync the counters AFTER na/nb are set (was showing stale values)
    applyManual();
  }
  updateInfo();
}

/** A traced stroke → a RawLine (rho, thetaDeg) in image coords for buildGrid. */
export function strokeToRaw(p1: ImgPt, p2: ImgPt): RawLine {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  // Normal (nx,ny) = (-dy, dx); its angle in [0,180).
  let thetaDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  thetaDeg = ((thetaDeg % 180) + 180) % 180;
  const nx = Math.cos((thetaDeg * Math.PI) / 180);
  const ny = Math.sin((thetaDeg * Math.PI) / 180);
  return { rho: nx * p1.x + ny * p1.y, thetaDeg };
}

/** Generate the grid from the traced lines (buildGrid does the family split, VP,
 * lattice fit and frame extension). Needs ≥2 lines in each of the two directions. */
export function regenerateFromStrokes() {
  if (!S.lastResult) return;
  if (manualStrokes.length < 2) {
    S.gridReliable = false;
    S.gridMap = null;
    draw();
    return;
  }
  const raw = manualStrokes.map(([a, b]) => strokeToRaw(a, b));
  const res = buildGrid(raw, 1, S.lastResult.width, S.lastResult.height, {
    ...DEFAULT_PARAMS,
    extend: 'frame',
  });
  if (res.familyA.length >= 2 && res.familyB.length >= 2) {
    S.lastResult.familyA = res.familyA;
    S.lastResult.familyB = res.familyB;
    S.gridMap = makeGridMap(res.familyA, res.familyB);
    S.gridReliable = !!S.gridMap;
    S.gridDims = { na: res.familyA.length, nb: res.familyB.length };
  } else {
    S.gridReliable = false;
    S.gridMap = null;
  }
  draw();
}

/** Leave manual editing. keep=true commits the grid; false discards it (back to the
 * fallback panel). */
export function exitManualMode(keep: boolean) {
  if (keep) {
    if (S.manualDrawPending) {
      // Draw mode: keep the grid generated from the traced lines (already extended).
      if (!S.gridReliable || !S.gridMap) keep = false;
    } else if (!S.manualQuad || !S.gridMap) {
      keep = false; // nothing to commit
    }
  }
  const wasDraw = S.manualDrawPending;
  S.manualActive = false;
  S.manualDrag = null;
  manualDragLast = null;
  S.manualDrawPending = false;
  manualStrokes = [];
  strokeStart = null;
  strokeEnd = null;
  drawEndpointDrag = null;
  manualPointerPos.clear();
  pinchState = null;
  manualBar.classList.remove('draw-mode');
  showManualBar(false);
  if (keep) {
    if (!wasDraw) commitManualGrid(); // adjust mode: extend the drawn quad to frame
    fabWrap.hidden = false;
    updateFabEnabled(); // a committed manual grid enables it; an empty result leaves it inert
  } else {
    // Cancel → restore the auto-detected grid (don't throw it away just because the
    // user opened the editor and changed their mind).
    S.manualQuad = null;
    applyDetectedGrid();
    deselectCell();
  }
  draw();
  updateResultChrome();
}

// Pointer gestures while editing a manual grid (routed from the map handlers).
export function manualPointerDown(e: PointerEvent) {
  const p = pointerToImage(e.clientX, e.clientY);
  if (!p) return;
  manualPointerPos.set(e.pointerId, p);
  activePointers.add(e.pointerId);

  // Two fingers on an adjustable quad → pinch-resize the grid about its centre.
  if (manualPointerPos.size === 2 && !S.manualDrawPending && S.manualQuad) {
    const [a, b] = [...manualPointerPos.values()];
    const cx = (S.manualQuad[0].x + S.manualQuad[1].x + S.manualQuad[2].x + S.manualQuad[3].x) / 4;
    const cy = (S.manualQuad[0].y + S.manualQuad[1].y + S.manualQuad[2].y + S.manualQuad[3].y) / 4;
    pinchState = {
      startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startQuad: S.manualQuad.map((c) => ({ ...c })),
      center: { x: cx, y: cy },
    };
    S.manualDrag = PINCH_SENTINEL;
    return;
  }
  if (manualPointerPos.size !== 1) {
    S.manualDrag = null; // a 3rd finger / can't-pinch state → cancel the current drag
    return;
  }

  if (S.manualDrawPending) {
    // Hit an existing stroke's delete badge or endpoint first; else start a new line.
    const hr = manualStrokeHandleRadius() * 0.6;
    for (let si = manualStrokes.length - 1; si >= 0; si--) {
      const [a, b] = manualStrokes[si];
      if (Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2) <= hr) {
        manualStrokes.splice(si, 1); // delete badge (midpoint)
        S.manualDrag = null;
        regenerateFromStrokes();
        return;
      }
      if (Math.hypot(p.x - a.x, p.y - a.y) <= hr) {
        drawEndpointDrag = { s: si, e: 0 };
        S.manualDrag = ENDPOINT_SENTINEL;
        capturePointer(e.pointerId);
        return;
      }
      if (Math.hypot(p.x - b.x, p.y - b.y) <= hr) {
        drawEndpointDrag = { s: si, e: 1 };
        S.manualDrag = ENDPOINT_SENTINEL;
        capturePointer(e.pointerId);
        return;
      }
    }
    strokeStart = p;
    strokeEnd = p;
    S.manualDrag = DRAW_SENTINEL;
    capturePointer(e.pointerId);
    return;
  }
  if (!S.manualQuad) return;
  const r = manualHandleRadius();
  let hit = -1;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(S.manualQuad[i].x - p.x, S.manualQuad[i].y - p.y) <= r) {
      hit = i;
      break;
    }
  }
  if (hit < 0 && pointInQuad(p, S.manualQuad)) hit = 4; // inside → translate the whole grid
  if (hit < 0) return;
  S.manualDrag = hit;
  manualDragLast = p;
  capturePointer(e.pointerId);
}

export function manualPointerMove(e: PointerEvent) {
  const p = pointerToImage(e.clientX, e.clientY);
  if (!p) return;
  if (manualPointerPos.has(e.pointerId)) manualPointerPos.set(e.pointerId, p);

  if (S.manualDrag === PINCH_SENTINEL) {
    if (!pinchState) return;
    const pts = [...manualPointerPos.values()];
    if (pts.length < 2) return;
    e.preventDefault();
    const s = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) / pinchState.startDist;
    const ctr = pinchState.center;
    S.manualQuad = pinchState.startQuad.map((c) => ({
      x: ctr.x + (c.x - ctr.x) * s,
      y: ctr.y + (c.y - ctr.y) * s,
    }));
    applyManual();
    return;
  }
  if (S.manualDrag === ENDPOINT_SENTINEL) {
    if (!drawEndpointDrag) return;
    e.preventDefault();
    manualStrokes[drawEndpointDrag.s][drawEndpointDrag.e] = p;
    regenerateFromStrokes();
    return;
  }
  if (S.manualDrag === DRAW_SENTINEL) {
    e.preventDefault();
    strokeEnd = p;
    draw();
    return;
  }
  if (S.manualDrag === null || !S.manualQuad || !manualDragLast) return;
  e.preventDefault();
  if (S.manualDrag < 4) {
    S.manualQuad[S.manualDrag] = p;
  } else {
    const dx = p.x - manualDragLast.x;
    const dy = p.y - manualDragLast.y;
    for (const c of S.manualQuad) {
      c.x += dx;
      c.y += dy;
    }
  }
  manualDragLast = p;
  applyManual();
}

export function manualPointerUp(e: PointerEvent) {
  manualPointerPos.delete(e.pointerId);
  activePointers.delete(e.pointerId);
  if (S.manualDrag === PINCH_SENTINEL) {
    if (manualPointerPos.size < 2) {
      pinchState = null;
      S.manualDrag = null;
    }
    return;
  }
  if (S.manualDrag === ENDPOINT_SENTINEL) {
    S.manualDrag = null;
    drawEndpointDrag = null;
    return;
  }
  if (S.manualDrag === DRAW_SENTINEL) {
    S.manualDrag = null;
    if (strokeStart && strokeEnd && Math.hypot(strokeEnd.x - strokeStart.x, strokeEnd.y - strokeStart.y) >= 12) {
      manualStrokes.push([strokeStart, strokeEnd]);
      strokeStart = null;
      strokeEnd = null;
      regenerateFromStrokes();
    } else {
      strokeStart = null;
      strokeEnd = null;
      draw();
    }
    return;
  }
  S.manualDrag = null;
  manualDragLast = null;
}

/** Radius (image px) for a traced-line endpoint / delete handle hit-test + draw. */
export function manualStrokeHandleRadius(): number {
  const W = S.lastResult?.width ?? view.width;
  const H = S.lastResult?.height ?? view.height;
  return Math.max(W, H) * 0.028;
}

/** Draw the traced reference lines + their endpoint/delete handles + the in-progress
 * stroke (draw mode). */
export function drawStrokes(ctx: CanvasRenderingContext2D) {
  const lw = Math.max(2, view.width / 300);
  const r = manualStrokeHandleRadius();
  ctx.save();
  ctx.lineCap = 'round';
  const seg = (a: ImgPt, b: ImgPt) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  // Committed strokes: line + 2 endpoint handles + a delete (×) at the midpoint.
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = lw;
  for (const [a, b] of manualStrokes) {
    seg(a, b);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.30)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.strokeStyle = '#22d3ee';
      ctx.stroke();
    }
    // delete badge at the midpoint
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.beginPath();
    ctx.arc(mx, my, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, r * 0.14);
    const k = r * 0.26;
    ctx.beginPath();
    ctx.moveTo(mx - k, my - k);
    ctx.lineTo(mx + k, my + k);
    ctx.moveTo(mx + k, my - k);
    ctx.lineTo(mx - k, my + k);
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#22d3ee';
  }
  // In-progress stroke (no handles yet).
  if (strokeStart && strokeEnd) seg(strokeStart, strokeEnd);
  ctx.restore();
}

// Magnifier loupe over the point being dragged (a grid corner or a traced-line
// endpoint), so the finger doesn't hide where it lands. Drawn in two steps so it sits
// ABOVE the handles: (1) CAPTURE the clean photo+grid region into an offscreen canvas
// BEFORE the handles are drawn; (2) DRAW the loupe last, over everything.
export let loupeSrc: HTMLCanvasElement | null = null;

/** Capture the clean magnified source around `c` and return the loupe placement. */
export function captureLoupe(c: ImgPt): { cx: number; cy: number; R: number } {
  const zoom = 2.5;
  const R = Math.max(48, view.width * 0.14);
  const srcR = R / zoom;
  let cx = c.x;
  let cy = c.y - R * 1.7;
  if (cy - R < 0) cy = c.y + R * 1.7; // flip below if near the top edge
  cx = Math.max(R, Math.min(view.width - R, cx));
  cy = Math.max(R, Math.min(view.height - R, cy));
  if (!loupeSrc) loupeSrc = document.createElement('canvas');
  const s = Math.max(2, Math.round(srcR * 2));
  loupeSrc.width = s;
  loupeSrc.height = s;
  const lctx = loupeSrc.getContext('2d')!;
  lctx.clearRect(0, 0, s, s);
  lctx.drawImage(view, c.x - srcR, c.y - srcR, srcR * 2, srcR * 2, 0, 0, s, s);
  return { cx, cy, R };
}

/** Draw the loupe (ring + magnified capture + crosshair) on top of everything. */
export function drawLoupe(ctx: CanvasRenderingContext2D, p: { cx: number; cy: number; R: number }) {
  const { cx, cy, R } = p;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  if (loupeSrc) ctx.drawImage(loupeSrc, cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
  const lw = Math.max(2, view.width / 300);
  ctx.save();
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, lw * 0.6);
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.32, cy);
  ctx.lineTo(cx + R * 0.32, cy);
  ctx.moveTo(cx, cy - R * 0.32);
  ctx.lineTo(cx, cy + R * 0.32);
  ctx.stroke();
  ctx.restore();
}

/** The point currently being dragged that should get a loupe (or null). */
export function loupePoint(): ImgPt | null {
  if (S.manualDrawPending) {
    if (S.manualDrag === ENDPOINT_SENTINEL && drawEndpointDrag) {
      return manualStrokes[drawEndpointDrag.s][drawEndpointDrag.e];
    }
    return null;
  }
  if (S.manualDrag !== null && S.manualDrag >= 0 && S.manualDrag <= 3 && S.manualQuad) {
    return S.manualQuad[S.manualDrag];
  }
  return null;
}

/** Draw the 4 corner handles over the manual grid. */
export function drawManualHandles(ctx: CanvasRenderingContext2D) {
  if (!S.manualQuad) return;
  const r = manualHandleRadius() * 0.5;
  ctx.save();
  for (const c of S.manualQuad) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.28)';
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.strokeStyle = '#22d3ee';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(2, r * 0.18), 0, Math.PI * 2);
    ctx.fillStyle = '#eaf1fb';
    ctx.fill();
  }
  ctx.restore();
}

// Manual-grid bar controls.
export const MANUAL_MIN_CELLS = 1;

export const MANUAL_MAX_CELLS = 60;

/** Clamp + apply a cell count, syncing the input fields. */
export function setManualCount(which: 'cols' | 'rows', value: number) {
  const v = Math.max(MANUAL_MIN_CELLS, Math.min(MANUAL_MAX_CELLS, Math.round(value)));
  if (which === 'cols') manualNa = v;
  else manualNb = v;
  updateManualBar();
  applyManual();
}

export function bumpManual(which: 'cols' | 'rows', delta: number) {
  setManualCount(which, (which === 'cols' ? manualNa : manualNb) + delta);
}

// Direct numeric entry: apply live while a valid number is typed, normalise (clamp +
// rewrite the field) on commit.
export const liveCount = (which: 'cols' | 'rows', el: HTMLInputElement) => () => {
  const n = parseInt(el.value, 10);
  if (Number.isFinite(n) && n >= MANUAL_MIN_CELLS) {
    const v = Math.min(MANUAL_MAX_CELLS, n);
    if (which === 'cols') manualNa = v;
    else manualNb = v;
    applyManual();
  }
};

export function initManualGrid() {
// Manual-grid chooser (opened by the top-bar edit button): two ways in.
chooseAdapt.addEventListener('click', () => {
  editChooser.hidden = true;
  enterManualMode('adapt');
});
chooseDraw.addEventListener('click', () => {
  editChooser.hidden = true;
  enterManualMode('draw');
});
chooseCancel.addEventListener('click', () => {
  editChooser.hidden = true;
});





colsMinus.addEventListener('click', () => bumpManual('cols', -1));
colsPlus.addEventListener('click', () => bumpManual('cols', +1));
rowsMinus.addEventListener('click', () => bumpManual('rows', -1));
rowsPlus.addEventListener('click', () => bumpManual('rows', +1));

colsInput.addEventListener('input', liveCount('cols', colsInput));
rowsInput.addEventListener('input', liveCount('rows', rowsInput));
colsInput.addEventListener('change', () => setManualCount('cols', parseInt(colsInput.value, 10) || manualNa));
rowsInput.addEventListener('change', () => setManualCount('rows', parseInt(rowsInput.value, 10) || manualNb));
manualCollapse.addEventListener('click', () => {
  manualCollapsed = !manualCollapsed;
  manualBar.classList.toggle('collapsed', manualCollapsed);
});
manualDone.addEventListener('click', () => exitManualMode(true));
manualCancel.addEventListener('click', () => exitManualMode(false));
// Top-bar "edit grid" — open the chooser (adapt a grid / draw one by hand).
btnEditGrid.addEventListener('click', () => {
  if (!S.showingResult) return;
  editChooser.hidden = false;
});
}
