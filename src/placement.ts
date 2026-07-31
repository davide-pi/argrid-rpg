// Placement (FAB) + per-piece editor + area controls + on-map angle ring + movement start.
import { S, type Token } from './tactical-state';
import { fabWrap, fab, fabAlly, fabEnemy, fabArea, areaTypeBox, areaSizeSel, areaUnit, areaCreature, pieceSize, pieceMove, pieceRemove } from './dom';
import { FIXED_SIZES, fixedAngles, snapToAngles, gridDir, angleOfGridDir, type Unit, type AreaType, type MoveOverlay } from './overlays';
import { tokenCovers, tokenAt, tokenBlock, blockToCell } from './board';
import { deselectCell, pointerToGrid } from './gestures';
import { showHud, updateInfo, removeActiveArea } from './hud';
import { draw } from './draw-loop';
import { setStatus } from './main';

export const DEFAULT_PIECE_SPEED = 6;

export const MOVE_ACTIONS = 5;

/** The moving piece's side for the active movement (defaults to ally). */
export function moveGroup(): 'ally' | 'enemy' {
  return S.activeOverlay?.kind === 'move' ? S.activeOverlay.group ?? 'ally' : 'ally';
}

// Which sides' threat to draw. Threat reach is shown ONLY during movement, and it
// shows BOTH groups' reach (not just the opposite side) so you can read the whole
// board's threat while planning a move.
export function threatSidesToShow(): Array<'ally' | 'enemy'> {
  if (S.activeOverlay?.kind === 'move') return ['ally', 'enemy'];
  return [];
}

// --- Angle ring (rotate line/cone on the map instead of a slider) ------
export function ringActive(): boolean {
  return (
    !!S.gridMap &&
    !!S.selectedCell &&
    S.activeOverlay?.kind === 'area' &&
    (S.currentAreaType === 'linea' || S.currentAreaType === 'cono')
  );
}

export function ringOriginGrid(): [number, number] | null {
  if (!S.selectedCell) return null;
  // Cones rotate around the chosen INTERSECTION (a fixed corner) — the ring
  // centres there and stays put while turning. Lines rotate around the selected
  // cell's centre. Either way the centre is fixed during a drag.
  if (S.currentAreaType === 'cono') {
    const c = S.activeOverlay?.kind === 'area' ? S.activeOverlay.corner : S.selectedNode;
    return [c[0], c[1]];
  }
  return [S.selectedCell[0] + 0.5, S.selectedCell[1] + 0.5];
}

// Distance (in cells) from the origin to the rotation handle: the shape's tip —
// the far end of a line, the front of a cone.
export function ringReachCells(): number {
  return Math.max(1, currentSizeCells());
}

// Grid position of the rotation handle at the current effective angle (null if
// there is nothing to rotate).
export function ringHandleGrid(): [number, number] | null {
  const o = ringOriginGrid();
  if (!o) return null;
  const d = gridDir(effectiveAngle());
  const R = ringReachCells();
  return [o[0] + d[0] * R, o[1] + d[1] * R];
}

/** Build a movement overlay for a token — movement always starts from a piece,
 * taking the piece's size and side. */
export function moveOverlayFromToken(t: Token): MoveOverlay {
  const { bi, bj, w } = tokenBlock(t);
  const speedCells = Math.max(0, t.speed || 0); // the piece's own movement (in cells)
  return { kind: 'move', cell: blockToCell(bi, bj, w), speedCells, moves: MOVE_ACTIONS, creatureCells: w, group: t.kind };
}

/** Start (or switch) movement from the token on cell (i,j). Returns false if the
 * cell has no piece. */
export function startMovementFromCell(i: number, j: number): boolean {
  const t = tokenAt(i, j);
  if (!t) return false;
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  S.selectedCell = [cell[0], cell[1]];
  S.selectedNode = [cell[0], cell[1]];
  S.moveTarget = null;
  S.activeOverlay = moveOverlayFromToken(t);
  showHud(); // starting a movement is an explicit action → expand the HUD
  updateFabIcon();
  draw();
  return true;
}

// --- Placement (via the FAB) + per-piece editor -----------------------
/** Enter/leave a placement mode (from the FAB). While active, tapping the map adds
 * pieces of that kind or (for 'area') drops an area; the FAB shows the active type
 * and turns into an ✕ to exit. Passing the current mode again toggles it off. */
export function setPlaceMode(m: 'ally' | 'enemy' | 'area' | 'none') {
  S.placeMode = S.placeMode === m ? 'none' : m;
  fabWrap.classList.remove('open'); // a choice closes the speed-dial
  if (S.placeMode !== 'none') {
    deselectCell();
  } else {
    setStatus('');
  }
  updateFabIcon();
  updateInfo();
}

/** The FAB shows ✕ (and its type colour) while a placement mode is active OR while
 * an area is on the map — so the same ✕ that adds an area also REMOVES it — and a
 * plain ＋ otherwise. */
export function updateFabIcon() {
  const areaActive = S.activeOverlay?.kind === 'area';
  fab.classList.toggle('mode-ally', S.placeMode === 'ally');
  fab.classList.toggle('mode-enemy', S.placeMode === 'enemy');
  fab.classList.toggle('mode-area', S.placeMode === 'area' || areaActive);
  fab.textContent = S.placeMode !== 'none' || areaActive ? '✕' : '＋';
}

/** The ＋ FAB is PRESENT whenever a result is shown, but ENABLED only when a grid exists — there's
 * nothing to place without one. A disabled <button> ignores clicks natively (so the speed-dial can't
 * open); we also collapse the dial in case it was open. Called wherever the FAB becomes visible. */
export function updateFabEnabled() {
  fab.disabled = !S.gridReliable; // native :disabled greys it and blocks clicks (see .fab:disabled)
  if (!S.gridReliable) fabWrap.classList.remove('open'); // collapse the speed-dial if it was open
}

/** Drop an area at the tapped point (from FAB 'area' mode), then leave placement so
 * the area can be edited/repositioned like before. */
export function placeAreaAt(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return;
  const i = Math.floor(g[0]);
  const j = Math.floor(g[1]);
  if (i < 0 || j < 0 || i >= S.gridDims.na - 1 || j >= S.gridDims.nb - 1) return;
  S.selectedCell = [i, j];
  S.selectedNode = [Math.round(g[0]), Math.round(g[1])];
  setPlaceMode('none'); // leave placement; now edit the area
  highlightAreaType(); // ensure the size select is populated for this type FIRST
  updateAreaOverlay(); // …so the area is built with a real size (not just the dot)
  showHud(); // a NEW area → expand the HUD (explicit action)
  updateFabIcon(); // FAB is now the ✕ that removes this area
}

/** In placement mode: tap an empty cell → add a piece (defaults: Taglia size,
 * speed 6) and select it for editing; tap a piece → remove it. Each new piece
 * starts from the defaults (the previous one's edits don't carry over). */
export function placeOrRemoveAt(i: number, j: number) {
  const idx = S.tokens.findIndex((t) => tokenCovers(t, i, j));
  if (idx >= 0) {
    S.tokens.splice(idx, 1);
    deselectCell();
    draw();
    return;
  }
  const t: Token = {
    kind: S.placeMode === 'enemy' ? 'enemy' : 'ally',
    i,
    j,
    w: 1, // new pieces start "Media o inferiore" (1 cell); resize in the HUD editor
    speed: DEFAULT_PIECE_SPEED,
  };
  S.tokens.push(t);
  selectPieceAt(i, j); // select the just-added piece so it can be tweaked
  draw();
}

/** Select the token covering (i,j) and open its editor. */
export function selectPieceAt(i: number, j: number) {
  const t = tokenAt(i, j);
  if (!t) return;
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  S.selectedCell = [cell[0], cell[1]];
  S.selectedNode = [cell[0], cell[1]];
  S.activeOverlay = null;
  S.moveTarget = null;
  showHud(); // opening a piece editor is explicit → expand the HUD
  updateFabIcon();
}

/** The piece under the current selection, or null. */
export function selectedPiece(): Token | null {
  return S.selectedCell ? tokenAt(S.selectedCell[0], S.selectedCell[1]) : null;
}

export function creatureVal(sel: HTMLSelectElement): number {
  return Math.max(1, +sel.value || 1);
}

// Sizes come from the PF2e preset list (labelled in the chosen unit).
export function cellsToUnit(cells: number, unit: Unit): number {
  if (unit === 'm') return cells * 1.5;
  if (unit === 'ft') return cells * 5;
  return cells;
}

export function sizeLabel(cells: number, unit: Unit): string {
  return `${cellsToUnit(cells, unit)} ${unit}`;
}

export function refreshSizeUI() {
  const opts = FIXED_SIZES[S.currentAreaType];
  const prev = +areaSizeSel.value;
  areaSizeSel.innerHTML = opts
    .map((s) => `<option value="${s}">${sizeLabel(s, areaUnit.value as Unit)}</option>`)
    .join('');
  if (opts.includes(prev)) areaSizeSel.value = String(prev);
}

// The piece Movement select (1..12 cells) is LABELLED in the chosen unit — "6 q",
// "9 m", "30 ft" — like the area size, so the number carries its measure.
export function refreshMoveUI() {
  const prev = pieceMove.value || String(DEFAULT_PIECE_SPEED);
  pieceMove.innerHTML = Array.from({ length: 12 }, (_, k) => {
    const cells = k + 1;
    return `<option value="${cells}">${sizeLabel(cells, areaUnit.value as Unit)}</option>`;
  }).join('');
  pieceMove.value = prev;
}

export function currentSizeCells(): number {
  return +areaSizeSel.value || 0;
}

/** The fixed orientations for the current area/size (empty if it has none). */
export function currentFixedAngles(): number[] {
  return fixedAngles(S.currentAreaType, currentSizeCells());
}

/** Angle snapped to the PF2e orientations (the 8 grid directions for a cone, the
 * book slopes for a line). */
export function effectiveAngle(): number {
  return snapToAngles(S.areaAngleDeg, currentFixedAngles());
}

export function highlightAreaType() {
  for (const el of areaTypeBox.querySelectorAll('.chip')) {
    el.classList.toggle('on', (el as HTMLElement).dataset.t === S.currentAreaType);
  }
  // Line/cone rotate via the on-map ring (tip handle) — the rotation hint lives
  // behind the (i) button and depends on the type, so refresh it.
  areaCreature.hidden = S.currentAreaType !== 'emanazione'; // creature size only for emanations
  refreshSizeUI();
  updateInfo();
}

// Rebuild the active overlay from the current form values and redraw.
export function updateAreaOverlay() {
  if (!S.selectedCell) return;
  S.activeOverlay = {
    kind: 'area',
    type: S.currentAreaType,
    cell: [S.selectedCell[0], S.selectedCell[1]],
    corner: [S.selectedNode[0], S.selectedNode[1]],
    sizeCells: currentSizeCells(),
    angleDeg: effectiveAngle(),
    creatureCells: creatureVal(areaCreature),
  };
  updateFabIcon(); // an area is now active → FAB is the ✕
  draw();
}

// True only when a pointer lands on the rotation handle (the shape's tip), so a
// drag there rotates — while a tap on any other cell never turns the shape.
export function ringHit(clientX: number, clientY: number): boolean {
  if (!ringActive()) return false;
  const g = pointerToGrid(clientX, clientY);
  const h = ringHandleGrid();
  if (!g || !h) return false;
  return Math.hypot(g[0] - h[0], g[1] - h[1]) <= 1.1; // grab tolerance in cells
}

export function rotateFromPointer(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  const o = ringOriginGrid();
  if (!g || !o) return;
  S.areaAngleDeg = angleOfGridDir(g[0] - o[0], g[1] - o[1]);
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
  else draw();
}

// The tapped grid cell (floored), or null off-grid.
export function pointerCell(clientX: number, clientY: number): [number, number] | null {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return null;
  const i = Math.floor(g[0]);
  const j = Math.floor(g[1]);
  if (i < 0 || j < 0 || i >= S.gridDims.na - 1 || j >= S.gridDims.nb - 1) return null;
  return [i, j];
}

export function movingTarget(): boolean {
  return S.activeOverlay?.kind === 'move' && !!S.moveTarget;
}

export function targetHit(clientX: number, clientY: number): boolean {
  if (!movingTarget()) return false;
  const c = pointerCell(clientX, clientY);
  return !!c && c[0] === S.moveTarget![0] && c[1] === S.moveTarget![1];
}

export function setMoveTargetAt(clientX: number, clientY: number) {
  const c = pointerCell(clientX, clientY);
  if (!c) return;
  S.moveTarget = c;
  draw();
}

export function initPlacement() {
// Area type + size are edited live from the HUD (the map is dynamic — no confirm).
areaTypeBox.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  const t = chip?.dataset.t as AreaType | undefined;
  if (!t) return;
  S.currentAreaType = t;
  highlightAreaType();
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
// Live edits (the map is dynamic — no confirm needed). The unit relabels BOTH the
// area size and the piece movement selects ("6 q" → "9 m" …).
areaUnit.addEventListener('input', () => {
  refreshSizeUI();
  refreshMoveUI();
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
for (const el of [areaSizeSel, areaCreature]) {
  el.addEventListener('input', () => {
    if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
  });
}
// FAB speed-dial: ＋ opens the menu; while a placement mode is active OR an area is on
// the map the FAB is an ✕ — it exits the mode, or REMOVES the active area (the same ✕
// that adds an area removes it, so you always have an ✕ to make the area disappear).
fab.addEventListener('click', () => {
  if (S.placeMode !== 'none') setPlaceMode('none');
  else if (S.activeOverlay?.kind === 'area') removeActiveArea();
  else fabWrap.classList.toggle('open');
});
fabAlly.addEventListener('click', () => setPlaceMode('ally'));
fabEnemy.addEventListener('click', () => setPlaceMode('enemy'));
fabArea.addEventListener('click', () => setPlaceMode('area'));
// Per-piece editor: edits the selected piece live.
pieceSize.addEventListener('input', () => {
  const t = selectedPiece();
  if (!t) return;
  const { bi, bj, w: oldW } = tokenBlock(t);
  const newW = Math.max(1, +pieceSize.value || 1);
  // Keep the piece's CENTRE as close as possible when the size changes, so the
  // character stays roughly in place (not anchored by a corner).
  t.w = newW;
  t.i = Math.round(bi + oldW / 2 - newW / 2);
  t.j = Math.round(bj + oldW / 2 - newW / 2);
  const nb = tokenBlock(t);
  selectPieceAt(nb.bi, nb.bj); // re-anchor selection to the resized block
  draw();
});
pieceMove.addEventListener('input', () => {
  const t = selectedPiece();
  if (!t) return;
  t.speed = Math.max(0, +pieceMove.value || 0);
  draw();
});
pieceRemove.addEventListener('click', () => {
  const t = selectedPiece();
  if (!t) return;
  const idx = S.tokens.indexOf(t);
  if (idx >= 0) S.tokens.splice(idx, 1);
  deselectCell();
  draw();
});
}
