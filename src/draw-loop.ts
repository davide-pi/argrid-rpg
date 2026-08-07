// The single draw() pass (photo + grid + tactical overlays on one canvas) and its helpers.
import { S } from './tactical-state';
import { view } from './dom';
import { clipLineToRect, intersect, type Line2 } from './grid-detector';
import { areaCells, moveCells, movePareto, ringColor, gridDir, creatureBlock, type Overlay } from './overlays';
import { tokenBlock, tokenObstaclesFor, threatCountMaps, oppThreatAreas, flankedEnemies } from './board';
import {
  moveGroup, threatSidesToShow, selectedPiece, ringActive, ringOriginGrid,
  ringHandleGrid, currentFixedAngles,
} from './placement';
import { loupePoint, captureLoupe, drawStrokes, drawManualHandles, drawLoupe } from './manual-grid';
import { drawDebugStep, debugStepActive } from './debug-panel';

// A pointer drag fires far more often than the screen refreshes, and every draw()
// repaints the full-resolution photo plus every overlay. Coalesce to ONE repaint per
// animation frame: interactive callers (drag, rotate, HUD edits) go through
// requestDraw(); draw() itself stays synchronous for the places that need the pixels
// right away (post-detection, debug panel, the DEV hook).
let drawQueued = false;

export function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

export function draw() {
  if (!S.lastResult || !S.lastCapture) return;
  const r = S.lastResult;
  // Debug: a pipeline-stage preview replaces the photo+overlay entirely.
  if (debugStepActive()) {
    drawDebugStep();
    return;
  }
  // Assigning width/height RESETS the canvas (reallocating its buffer) even when the
  // value doesn't change — so only touch it on a real size change. The photo below
  // covers the whole canvas, so no clear is needed.
  if (view.width !== r.width) view.width = r.width;
  if (view.height !== r.height) view.height = r.height;
  const ctx = view.getContext('2d')!;

  ctx.drawImage(S.lastCapture, 0, 0, r.width, r.height);

  if (S.debug) {
    if (r.edges) {
      if (!S.edgeCanvas) S.edgeCanvas = document.createElement('canvas');
      S.edgeCanvas.width = r.edges.width;
      S.edgeCanvas.height = r.edges.height;
      S.edgeCanvas.getContext('2d')!.putImageData(r.edges, 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(S.edgeCanvas, 0, 0, r.width, r.height);
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,80,80,0.55)';
    ctx.lineWidth = Math.max(1, r.width / 900);
    for (const l of r.rawLines) drawLine(ctx, l, r.width, r.height);
    ctx.restore();
  }

  const lw = Math.max(2, r.width / 350);
  // Each family is clipped to the grid's own border (the extreme lines of the
  // other family), so lines don't protrude past the outer rows/columns. Both
  // directions share one colour — a soft white — since we don't distinguish them.
  const gridColor = '#eaf1fb';
  // Draw the grid when it's trustworthy, or while the user is adjusting a manual
  // quad. An unreliable auto fit (or the "draw a cell" step before a cell exists)
  // shows the photo alone, not a wrong grid.
  const showManualGrid = S.manualActive && !S.manualDrawPending && !!S.manualQuad;
  if (S.gridReliable || showManualGrid) {
    drawFamily(ctx, r.familyA, r.familyB, r.width, r.height, gridColor, lw);
    drawFamily(ctx, r.familyB, r.familyA, r.width, r.height, gridColor, lw);
  }

  if (S.manualActive) {
    // Capture the clean loupe source (photo+grid) BEFORE drawing handles/strokes, so
    // the magnifier can be drawn LAST — on top of every other handle.
    const lp = loupePoint();
    const place = lp ? captureLoupe(lp) : null;
    if (S.manualDrawPending) drawStrokes(ctx);
    else drawManualHandles(ctx);
    if (place) drawLoupe(ctx, place);
    return; // no tactical layer while editing the grid
  }

  // Tactical layer: overlay → path preview → threat/counters → flanking → tokens
  // → blocked squares → selection + ring.
  if (S.gridMap) {
    if (S.activeOverlay) drawOverlay(ctx, S.activeOverlay, lw);
    drawPaths(ctx, lw);
    drawThreat(ctx, lw);
    drawFlanking(ctx, lw);
    drawTokens(ctx, lw);
    drawBlockedX(ctx, lw);
    if (S.selectedCell) {
      drawSelection(ctx, lw);
      drawAngleRing(ctx, lw);
    }
    // Magnifier over the finger while dragging a piece / an area / the arrival, or
    // rotating — the same loupe the manual grid uses, for the same reason: the finger
    // covers exactly the cell being aimed at. Captured LAST, so it magnifies the
    // finished frame (grid + overlay + pieces), then drawn on top of it.
    if (S.dragPoint) drawLoupe(ctx, captureLoupe(S.dragPoint));
  }
}

export const ENEMY_COL = '#ff2d2d';

export const ALLY_COL = '#22e06a';

// Reach of the shown tokens, bordered per cell. A cell threatened by only one
// side gets that side's solid border; a cell CONTESTED by both sides gets an
// alternating red/green dashed border. Drawn over the overlay so it stays visible
// during movement.
export function drawThreat(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap) return;
  const sides = threatSidesToShow();
  if (sides.length === 0) return;
  const { enemy, ally } = threatCountMaps();
  const showEnemy = sides.includes('enemy');
  const showAlly = sides.includes('ally');
  const cells = new Set([...(showEnemy ? enemy.keys() : []), ...(showAlly ? ally.keys() : [])]);
  const w2 = Math.max(2.5, lw * 1.2);
  const dash = Math.max(4, lw * 2.4);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = w2;
  for (const k of cells) {
    const en = showEnemy ? enemy.get(k) ?? 0 : 0;
    const al = showAlly ? ally.get(k) ?? 0 : 0;
    if (en === 0 && al === 0) continue;
    const [i, j] = k.split(',').map(Number);
    const quad: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    if (en > 0 && al > 0) {
      // Contested: interleave the two colours' dashes (offset the 2nd by one dash).
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = ENEMY_COL;
      gridPath(ctx, quad);
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = ALLY_COL;
      gridPath(ctx, quad);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    } else {
      ctx.strokeStyle = en > 0 ? ENEMY_COL : ALLY_COL;
      gridPath(ctx, quad);
      ctx.stroke();
    }
  }
  ctx.restore();
  drawThreatCounts(ctx, lw, sides);
}

export function drawThreatCounts(ctx: CanvasRenderingContext2D, lw: number, sides: Array<'ally' | 'enemy'>) {
  if (!S.gridMap) return;
  const { enemy, ally } = threatCountMaps();
  const showEnemy = sides.includes('enemy');
  const showAlly = sides.includes('ally');
  const cells = new Set([...(showEnemy ? enemy.keys() : []), ...(showAlly ? ally.keys() : [])]);
  const fs = Math.max(11, lw * 4);
  ctx.save();
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const k of cells) {
    const en = showEnemy ? enemy.get(k) ?? 0 : 0;
    const al = showAlly ? ally.get(k) ?? 0 : 0;
    const contested = en > 0 && al > 0; // threatened by BOTH groups
    // Show a side's counter when it ganks a cell with 2+ reaches, OR whenever the
    // cell is contested by both groups (even a single reach each).
    const showEn = en >= 2 || (contested && en >= 1);
    const showAl = al >= 2 || (contested && al >= 1);
    if (!showEn && !showAl) continue;
    const [i, j] = k.split(',').map(Number);
    const [x, y] = S.gridMap.toImage(i + 0.5, j + 0.5);
    if (showEn) badge(ctx, String(en), x - fs * 0.55, y - fs * 0.5, fs, '#ef4444');
    if (showAl) badge(ctx, String(al), x + fs * 0.55, y - fs * 0.5, fs, '#22c55e');
  }
  ctx.restore();
}

export function badge(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fs: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, fs * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,10,16,0.82)';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, fs * 0.12);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + fs * 0.04);
}

// --- Movement path preview -------------------------------------------
// Cap the preview (and its colouring) at 5 movements.
export const MAX_PATH_MOVES = 5;

// Select an arrival cell → show the (movements ↔ threats) Pareto set of routes to
// it: the FASTEST route first (drawn boldest — "il più visibile"), then each route
// that spends +1 movement to be threatened by FEWER creatures, down to 0 or the
// cap. Threats are counted PER DISTINCT CREATURE (including the start square). Each
// route is a line coloured by its movement band, with a badge = creatures met.
// movePareto is the heaviest thing a redraw can trigger (a multi-label Dijkstra over
// cell × parity × creature-mask). Dragging repaints every frame while the inputs usually
// stay the same, so memoize the last result on everything it depends on.
let pathCache: { key: string; routes: ReturnType<typeof movePareto> } | null = null;

export function drawPaths(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap || S.activeOverlay?.kind !== 'move' || !S.moveTarget) return;
  const ov = S.activeOverlay;
  const { na, nb } = S.gridDims;
  const group = moveGroup();
  const obs = tokenObstaclesFor(group);
  const cappedMv = { ...ov, moves: Math.min(ov.moves, MAX_PATH_MOVES) };

  const key = JSON.stringify([
    cappedMv.cell, cappedMv.speedCells, cappedMv.moves, cappedMv.creatureCells, group,
    S.moveTarget, na, nb, S.tokens.map((t) => [t.kind, t.i, t.j, t.w]),
  ]);
  if (pathCache?.key !== key)
    pathCache = {
      key,
      routes: movePareto(cappedMv, na, nb, S.moveTarget, MAX_PATH_MOVES, oppThreatAreas(group), obs),
    };
  const routes = pathCache.routes;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Draw slowest→fastest so the fastest (index 0) lands on top and reads clearest
  // ("il più visibile"): boldest line, the alternatives progressively thinner.
  for (let idx = routes.length - 1; idx >= 0; idx--) {
    const r = routes[idx];
    const color = ringColor(r.move);
    const width = idx === 0 ? Math.max(5, lw * 2.2) : Math.max(2, lw * 1);
    ctx.globalAlpha = idx === 0 ? 1 : 0.9;
    drawRouteLine(ctx, r.cells, color, width, lw);
  }
  ctx.globalAlpha = 1;
  // Creatures-met badges last so they sit above every line. Place each on its
  // route's APEX (the cell farthest from the straight origin→target line) so
  // routes that share the middle don't stack their badges on top of each other.
  const fs = Math.max(11, lw * 3.6);
  for (const r of routes) {
    if (r.cells.length < 2) continue;
    const [ox, oy] = r.cells[0];
    const [tx, ty] = r.cells[r.cells.length - 1];
    const dx = tx - ox;
    const dy = ty - oy;
    const len = Math.hypot(dx, dy) || 1;
    let best = r.cells[Math.floor(r.cells.length / 2)];
    let bestD = -1;
    for (const [ci, cj] of r.cells) {
      const perp = Math.abs((ci - ox) * dy - (cj - oy) * dx) / len;
      if (perp > bestD) {
        bestD = perp;
        best = [ci, cj];
      }
    }
    if (bestD < 0.75) best = r.cells[Math.floor(r.cells.length / 2)]; // ~straight → midpoint
    const [x, y] = S.gridMap.toImage(best[0] + 0.5, best[1] + 0.5);
    badge(ctx, String(r.threats), x, y, fs, ringColor(r.move));
  }
  ctx.restore();
  drawArrival(ctx, lw);
}

// A route as a polyline through the cell centres, with a dark backing so it reads
// on any map colour.
export function drawRouteLine(
  ctx: CanvasRenderingContext2D,
  cells: [number, number][],
  color: string,
  width: number,
  lw: number,
) {
  if (!S.gridMap || cells.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    cells.forEach(([i, j], k) => {
      const [x, y] = S.gridMap!.toImage(i + 0.5, j + 0.5);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
  };
  trace();
  ctx.lineWidth = width + Math.max(3, lw * 1.4);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
  trace();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

// The chosen arrival cell, boldly highlighted (bright outline + fill + a marker).
export function drawArrival(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap || !S.moveTarget) return;
  const [ti, tj] = S.moveTarget;
  const quad: Array<[number, number]> = [[ti, tj], [ti + 1, tj], [ti + 1, tj + 1], [ti, tj + 1]];
  ctx.save();
  ctx.lineJoin = 'round';
  gridPath(ctx, quad);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(5, lw * 2.6);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  gridPath(ctx, quad);
  ctx.stroke();
  ctx.lineWidth = Math.max(3, lw * 1.6);
  ctx.strokeStyle = '#ffffff';
  gridPath(ctx, quad);
  ctx.stroke();
  const [cx, cy] = S.gridMap.toImage(ti + 0.5, tj + 0.5);
  const r = Math.max(5, lw * 1.8);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#facc15';
  ctx.fill();
  ctx.lineWidth = Math.max(2, lw * 0.6);
  ctx.strokeStyle = '#1a1206';
  ctx.stroke();
  ctx.restore();
}

// During movement, bar the squares the piece cannot pass through (the opposite
// side's pieces) with a red X, over a dark outline so it reads on any colour.
export function drawBlockedX(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap || S.activeOverlay?.kind !== 'move') return;
  const { impassable } = tokenObstaclesFor(moveGroup());
  const line = (a: [number, number], b: [number, number]) => {
    const p = S.gridMap!.toImage(a[0], a[1]);
    const q = S.gridMap!.toImage(b[0], b[1]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'round';
  for (const k of impassable) {
    const [i, j] = k.split(',').map(Number);
    const a: [number, number] = [i + 0.18, j + 0.18];
    const b: [number, number] = [i + 0.82, j + 0.82];
    const c: [number, number] = [i + 0.18, j + 0.82];
    const d: [number, number] = [i + 0.82, j + 0.18];
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(4, lw * 1.9);
    line(a, b);
    line(c, d);
    ctx.strokeStyle = '#ff2020';
    ctx.lineWidth = Math.max(2.5, lw * 1.1);
    line(a, b);
    line(c, d);
  }
  ctx.restore();
}

export function drawFlanking(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap) return;
  for (const e of flankedEnemies()) {
    const { bi, bj, w } = tokenBlock(e);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.setLineDash([lw * 3, lw * 2]);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = Math.max(3, lw * 1.5);
    gridPath(ctx, [[bi, bj], [bi + w, bj], [bi + w, bj + w], [bi, bj + w]]);
    ctx.stroke();
    ctx.restore();
    const [x, y] = S.gridMap.toImage(bi + w / 2, bj);
    const fs = Math.max(12, lw * 4.5);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, fs * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1206';
    ctx.fillText('⚔', x, y + fs * 0.05);
    ctx.restore();
  }
}

export function drawTokens(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap) return;
  for (const t of S.tokens) {
    const { bi, bj, w } = tokenBlock(t);
    const c0 = S.gridMap.toImage(bi, bj);
    const c1 = S.gridMap.toImage(bi + w, bj);
    const c2 = S.gridMap.toImage(bi + w, bj + w);
    const c3 = S.gridMap.toImage(bi, bj + w);
    const cx = (c0[0] + c1[0] + c2[0] + c3[0]) / 4;
    const cy = (c0[1] + c1[1] + c2[1] + c3[1]) / 4;
    const side = Math.min(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), Math.hypot(c3[0] - c0[0], c3[1] - c0[1]));
    // Radius = half the piece's size, so the disc touches its area's borders.
    const strokeW = Math.max(2, lw * 0.8);
    const r = Math.max(1, side / 2 - strokeW / 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = t.kind === 'ally' ? '#22c55e' : '#ef4444';
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = t.kind === 'ally' ? '#064e2a' : '#7f1d1d';
    ctx.stroke();
    ctx.restore();
  }
}

// Rotation handle drawn on the shape's TIP (line end / cone front). Drawn in
// GRID space so it follows the map's perspective. Only this handle rotates the
// shape — tapping elsewhere never turns it. Faint ticks mark the allowed
// orientations (the tip snaps to these) so you can rotate roughly and let it snap.
export function drawAngleRing(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.gridMap || !ringActive()) return;
  const o = ringOriginGrid();
  const h = ringHandleGrid();
  if (!o || !h) return;
  // The ticks sit on the HANDLE's arc, not the tip's: when a long area pushes its tip
  // off screen the handle is pulled back (see ringHandleGrid), and the orientation marks
  // must follow it to stay readable.
  const R = Math.max(0.5, Math.hypot(h[0] - o[0], h[1] - o[1]));
  const toImg = (a: number, b: number) => S.gridMap!.toImage(a, b);
  ctx.save();
  // Ticks at the allowed orientations, on the handle's arc.
  ctx.strokeStyle = 'rgba(147,197,253,0.75)';
  ctx.lineWidth = Math.max(1.5, lw * 0.5);
  for (const ang of currentFixedAngles()) {
    const d = gridDir(ang);
    const [x1, y1] = toImg(o[0] + d[0] * R * 0.92, o[1] + d[1] * R * 0.92);
    const [x2, y2] = toImg(o[0] + d[0] * R * 1.08, o[1] + d[1] * R * 1.08);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // Dashed spoke from the origin out to the handle at the current angle.
  const [ox, oy] = toImg(o[0], o[1]);
  const [hx, hy] = toImg(h[0], h[1]);
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(hx, hy);
  ctx.lineWidth = Math.max(2, lw * 0.6);
  ctx.strokeStyle = 'rgba(59,130,246,0.85)';
  ctx.setLineDash([lw * 2, lw * 1.5]);
  ctx.stroke();
  ctx.setLineDash([]);
  // The grab handle — the ONLY place a drag rotates from.
  ctx.beginPath();
  ctx.arc(hx, hy, Math.max(10, lw * 2.6), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(59,130,246,0.95)';
  ctx.fill();
  ctx.lineWidth = Math.max(2, lw * 0.6);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  // A small rotate glyph on the handle.
  const gs = Math.max(9, lw * 2.2);
  ctx.font = `700 ${gs}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('↻', hx, hy + gs * 0.05);
  ctx.restore();
}

// --- Tactical drawing --------------------------------------------------
export function gridPath(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>) {
  if (!S.gridMap || pts.length === 0) return;
  ctx.beginPath();
  const [x0, y0] = S.gridMap.toImage(pts[0][0], pts[0][1]);
  ctx.moveTo(x0, y0);
  for (let k = 1; k < pts.length; k++) {
    const [x, y] = S.gridMap.toImage(pts[k][0], pts[k][1]);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Highlight the selection. Burst/cone show only the intersection dot (drawn with
// the overlay); emanation / movement cover the whole creature block; otherwise
// just the tapped cell.
export function drawSelection(ctx: CanvasRenderingContext2D, lw: number) {
  if (!S.selectedCell) return;
  if (S.activeOverlay?.kind === 'area' && (S.activeOverlay.type === 'esplosione' || S.activeOverlay.type === 'cono')) {
    return; // the intersection dot is enough
  }
  let bi: number;
  let bj: number;
  let w: number;
  const piece = selectedPiece();
  if (piece && !S.activeOverlay) {
    // A selected piece → highlight its WHOLE area.
    ({ bi, bj, w } = tokenBlock(piece));
  } else {
    const [si, sj] = S.selectedCell;
    w = 1;
    if (S.activeOverlay?.kind === 'move') w = S.activeOverlay.creatureCells;
    else if (S.activeOverlay?.kind === 'area' && S.activeOverlay.type === 'emanazione')
      w = S.activeOverlay.creatureCells;
    [bi, bj] = creatureBlock(si, sj, Math.max(1, w));
  }
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = lw * 1.4;
  for (let i = bi; i < bi + w; i++) {
    for (let j = bj; j < bj + w; j++) {
      gridPath(ctx, [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Colour whole cells (Pathfinder 2e). Areas → blue; movement → per-move colour.
export function drawOverlay(ctx: CanvasRenderingContext2D, ov: Overlay, lw: number) {
  if (!S.gridMap) return;
  const { na, nb } = S.gridDims;
  let cells: Array<{ i: number; j: number; color: string }>;
  if (ov.kind === 'area') {
    cells = areaCells(ov, na, nb).map(([i, j]) => ({ i, j, color: '#3b82f6' }));
  } else {
    cells = moveCells(ov, na, nb, tokenObstaclesFor(ov.group ?? 'ally')).map(({ i, j, move }) => ({ i, j, color: ringColor(move) }));
  }
  // Movement bands are kept faint so the path preview (drawn opaque on top) and
  // the pieces stay readable; areas are a touch stronger.
  fillCells(ctx, cells, lw, ov.kind === 'move' ? { fillAlpha: 0.16, strokeAlpha: 0.4 } : undefined);
  // Burst and cone both radiate from the chosen intersection — mark it with a dot.
  if (ov.kind === 'area' && (ov.type === 'esplosione' || ov.type === 'cono')) {
    const [x, y] = S.gridMap.toImage(ov.corner[0], ov.corner[1]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(5, lw * 1.8), 0, Math.PI * 2);
    ctx.fillStyle = '#3b82f6';
    ctx.fill();
    ctx.lineWidth = Math.max(2, lw * 0.5);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }
}

export function fillCells(
  ctx: CanvasRenderingContext2D,
  cells: Array<{ i: number; j: number; color: string }>,
  lw: number,
  opts?: { fillAlpha?: number; strokeAlpha?: number },
) {
  const fillAlpha = opts?.fillAlpha ?? 0.4;
  const strokeAlpha = opts?.strokeAlpha ?? 0.85;
  ctx.save();
  ctx.lineJoin = 'round';
  for (const { i, j, color } of cells) {
    gridPath(ctx, [
      [i, j],
      [i + 1, j],
      [i + 1, j + 1],
      [i, j + 1],
    ]);
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = Math.max(1, lw * 0.4);
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFamily(
  ctx: CanvasRenderingContext2D,
  lines: Line2[],
  cross: Line2[],
  W: number,
  H: number,
  color: string,
  lw: number,
) {
  // Clip each line to the segment between the first and last line of the OTHER
  // family — that is the grid's own border, so nothing protrudes beyond the
  // outer rows/columns. Fall back to the image rect if geometry degenerates.
  const b0 = cross.length >= 2 ? cross[0] : null;
  const b1 = cross.length >= 2 ? cross[cross.length - 1] : null;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = lw;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash([]);
  for (const l of lines) {
    // Directly detected lines are solid/opaque; lines rebuilt by the lattice
    // model (occluded ones) are drawn a bit fainter so they're distinguishable
    // but still shown as part of the complete grid.
    ctx.globalAlpha = l.filled ? 0.5 : 1;
    let seg: [[number, number], [number, number]] | null = null;
    if (b0 && b1) {
      const p = intersect(l, b0);
      const q = intersect(l, b1);
      if (p && q) seg = [[p.x, p.y], [q.x, q.y]];
    }
    if (!seg) seg = clipLineToRect(l, W, H);
    if (!seg) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0][0], seg[0][1]);
    ctx.lineTo(seg[1][0], seg[1][1]);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawLine(ctx: CanvasRenderingContext2D, l: Line2, W: number, H: number) {
  const seg = clipLineToRect(l, W, H);
  if (!seg) return;
  ctx.beginPath();
  ctx.moveTo(seg[0][0], seg[0][1]);
  ctx.lineTo(seg[1][0], seg[1][1]);
  ctx.stroke();
}
