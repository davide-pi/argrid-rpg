// Placement (FAB) + per-piece editor + area controls + on-map angle ring + movement start.
import { S, type Token } from './tactical-state';
import {
  view, fabWrap, fab, fabAlly, fabEnemy, fabArea, areaTypeBox, areaSizeInput, areaSizeMinus,
  areaSizePlus, areaSizeUnit, areaPresets, areaUnit, areaCreature, areaCreatureFld,
  pieceSize, pieceMove, pieceMoveMinus, pieceMovePlus, pieceMoveUnit, pieceRemove,
} from './dom';
import {
  AREA_PRESETS, MAX_SIZE_SHOWN, unitToCells, fixedAngles, snapToAngles, gridDir,
  angleOfGridDir, type Unit, type AreaType, type MoveOverlay,
} from './overlays';
import { tokenCovers, tokenAt, tokenBlock, blockToCell } from './board';
import { deselectCell, pointerToGrid } from './gestures';
import { showHud, updateInfo, removeActiveArea } from './hud';
import { requestDraw } from './draw-loop';
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

/** Is this grid point currently ON SCREEN? Goes through the canvas's rendered rect, so
 * it accounts for the zoom/pan transform, and keeps `margin` px of slack for the handle
 * to be touchable rather than half off the edge. */
function gridPointOnScreen(g: [number, number], margin: number): boolean {
  if (!S.gridMap) return false;
  const rect = view.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const [x, y] = S.gridMap.toImage(g[0], g[1]);
  const cx = rect.left + (x / view.width) * rect.width;
  const cy = rect.top + (y / view.height) * rect.height;
  return (
    cx >= margin && cy >= margin &&
    cx <= window.innerWidth - margin && cy <= window.innerHeight - margin
  );
}

/** Slack (px) kept between the rotation handle and the screen edge. */
const HANDLE_MARGIN_PX = 28;

// Grid position of the rotation handle at the current effective angle (null if
// there is nothing to rotate). Normally the shape's tip — but a long area (or a
// zoomed-in map) puts that tip off screen, where it can't be grabbed, so the handle
// is pulled BACK along the direction to the farthest point still on screen. Only the
// handle moves; the area itself keeps its full length.
export function ringHandleGrid(): [number, number] | null {
  const o = ringOriginGrid();
  if (!o) return null;
  const d = gridDir(effectiveAngle());
  const R = ringReachCells();
  const at = (t: number): [number, number] => [o[0] + d[0] * R * t, o[1] + d[1] * R * t];
  const tip = at(1);
  if (gridPointOnScreen(tip, HANDLE_MARGIN_PX)) return tip;
  for (let t = 0.9; t >= 0.15; t -= 0.05) {
    const p = at(t);
    if (gridPointOnScreen(p, HANDLE_MARGIN_PX)) return p;
  }
  return tip; // the whole ray is off screen (the origin too) — nothing better to offer
}

/** Build a movement overlay for a token — movement always starts from a piece,
 * taking the piece's size and side. */
export function moveOverlayFromToken(t: Token): MoveOverlay {
  const { bi, bj, w } = tokenBlock(t);
  const speedCells = Math.max(0, t.speed || 0); // the piece's own movement (in cells)
  return { kind: 'move', cell: blockToCell(bi, bj, w), speedCells, moves: MOVE_ACTIONS, creatureCells: w, group: t.kind };
}

/** Re-anchor the ACTIVE movement on its piece after the piece changed (size/speed),
 * so editing a moving piece updates what's drawn instead of dropping the movement.
 * The arrival cell is kept — tweaking the speed must not lose the planned route. */
export function syncMoveOverlayTo(t: Token) {
  if (S.activeOverlay?.kind !== 'move') return;
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  S.selectedCell = [cell[0], cell[1]];
  S.selectedNode = [cell[0], cell[1]];
  S.activeOverlay = moveOverlayFromToken(t);
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
  requestDraw();
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
    requestDraw();
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
  requestDraw();
}

/** Point the selection at a piece WITHOUT touching the HUD. Used while DRAGGING, where
 * the panel's content doesn't change and rebuilding it on every pointermove costs. */
export function anchorSelectionTo(t: Token) {
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  S.selectedCell = [cell[0], cell[1]];
  S.selectedNode = [cell[0], cell[1]];
}

/** Select the token covering (i,j) and open its editor. */
export function selectPieceAt(i: number, j: number) {
  const t = tokenAt(i, j);
  if (!t) return;
  anchorSelectionTo(t);
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

// Sizes are FREE and always land on a whole cell; the unit only relabels them.
export function cellsToUnit(cells: number, unit: Unit): number {
  if (unit === 'm') return cells * 1.5;
  if (unit === 'ft') return cells * 5;
  return cells;
}

export function sizeLabel(cells: number, unit: Unit): string {
  return `${cellsToUnit(cells, unit)} ${unit}`;
}

/** The measure unit chosen in the header. */
const unit = (): Unit => areaUnit.value as Unit;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The largest whole-cell size whose LABEL still fits the 3-digit field in `u`:
 * 999 q, 666 cells in metres (999 m), 199 in feet (995 ft). */
function maxCellsIn(u: Unit): number {
  return Math.max(1, Math.floor(MAX_SIZE_SHOWN / cellsToUnit(1, u)));
}

/** A size in cells: a whole cell inside [1, maxCellsIn(unit)], whatever was typed. */
const clampCells = (cells: number): number =>
  Math.max(1, Math.min(maxCellsIn(unit()), Math.round(cells || 0)));

/**
 * A size field set BY HAND — the area template's length, a piece's movement. The value
 * lives in CELLS on the input's dataset; the text is only its VIEW in the chosen unit, so
 * switching unit relabels without changing the size. Typing, − and + all land on whole
 * cells (the field's `step` is one cell expressed in that unit: 1 q / 1.5 m / 5 ft).
 * `onEdit` fires only for the USER's edits, never for a programmatic `set`.
 */
function makeCellStepper(
  input: HTMLInputElement,
  minus: HTMLButtonElement,
  plus: HTMLButtonElement,
  unitEl: HTMLElement,
  fallback: () => number,
  onEdit: () => void,
) {
  const get = (): number => {
    const raw = input.dataset.cells;
    return clampCells(raw === undefined ? fallback() : +raw);
  };
  const set = (cells: number) => {
    const c = clampCells(cells);
    input.dataset.cells = String(c);
    input.value = String(round2(cellsToUnit(c, unit())));
    minus.disabled = c <= 1; // nothing below one cell…
    plus.disabled = c >= maxCellsIn(unit()); // …nor past what the field can show
  };
  const relabel = () => {
    const u = unit();
    const cell = cellsToUnit(1, u);
    input.step = String(cell);
    input.min = String(cell);
    input.max = String(cellsToUnit(maxCellsIn(u), u));
    unitEl.textContent = u;
    set(get()); // re-show the same size in the (possibly new) unit
  };
  const edit = (cells: number) => {
    set(cells);
    onEdit();
  };
  const attach = () => {
    input.addEventListener('input', () => {
      // Don't rewrite the field mid-typing (the caret would jump) — the value snaps to
      // whole cells here and the TEXT is normalized on commit (change/blur).
      input.dataset.cells = String(clampCells(unitToCells(+input.value, unit())));
      onEdit();
    });
    input.addEventListener('change', () => edit(get()));
    minus.addEventListener('click', () => edit(get() - 1));
    plus.addEventListener('click', () => edit(get() + 1));
  };
  return { get, set, relabel, attach };
}

// The area template's size, with the preset chips below it.
const areaSize = makeCellStepper(
  areaSizeInput, areaSizeMinus, areaSizePlus, areaSizeUnit,
  () => AREA_PRESETS[S.currentAreaType][0],
  () => {
    markActivePreset();
    if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
  },
);

// The selected piece's movement, edited live like everything else in the HUD.
const pieceSpeed = makeCellStepper(
  pieceMove, pieceMoveMinus, pieceMovePlus, pieceMoveUnit,
  () => DEFAULT_PIECE_SPEED,
  () => {
    const t = selectedPiece();
    if (!t) return;
    t.speed = pieceSpeed.get();
    syncMoveOverlayTo(t); // a movement on screen redraws with the new speed
    requestDraw();
  },
);

/** The area size in CELLS. */
export function currentSizeCells(): number {
  return areaSize.get();
}

/** Show a size (cells) in the area stepper. Leaves the overlay alone — callers rebuild
 * it when the change is the user's. */
export function setSizeCells(cells: number) {
  areaSize.set(cells);
  markActivePreset();
}

/** Show a piece's movement (cells) in its stepper. */
export function showPieceSpeed(cells: number) {
  pieceSpeed.set(cells);
}

/** Light up the preset chip matching the current size (none when it was hand-typed). */
function markActivePreset() {
  const c = currentSizeCells();
  for (const el of areaPresets.querySelectorAll<HTMLElement>('.chip'))
    el.classList.toggle('on', +el.dataset.cells! === c);
}

/** Relabel the size stepper and rebuild the preset chips for the current type + unit. */
export function refreshSizeUI() {
  const u = unit();
  areaSize.relabel();
  areaPresets.innerHTML = AREA_PRESETS[S.currentAreaType]
    .map((c) => `<button type="button" class="chip" data-cells="${c}">${sizeLabel(c, u)}</button>`)
    .join('');
  markActivePreset();
}

/** Relabel the piece-movement stepper for the chosen unit ("6 q" → "9 m" → "30 ft"),
 * keeping the same number of cells. */
export function refreshMoveUI() {
  pieceSpeed.relabel();
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
  // Creature size only for emanations — hide the whole field (label included); it sits on
  // its own line so the preset chips keep the width beside the stepper.
  areaCreatureFld.hidden = S.currentAreaType !== 'emanazione';
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
  requestDraw();
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
  else requestDraw();
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
  requestDraw();
}

export function initPlacement() {
// Area type + size are edited live from the HUD (the map is dynamic — no confirm).
areaTypeBox.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  const t = chip?.dataset.t as AreaType | undefined;
  if (!t || t === S.currentAreaType) return; // re-tapping the same type must not reset the size
  S.currentAreaType = t;
  // Keep a size the new type also offers; otherwise start from that type's default (a
  // 1 q cone or line would be a poor default).
  const opts = AREA_PRESETS[t];
  if (!opts.includes(currentSizeCells())) setSizeCells(opts[0]);
  highlightAreaType();
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
// Live edits (the map is dynamic — no confirm needed). The unit relabels the area size
// (stepper + presets) and the piece movement ("6 q" → "9 m" …) without changing the
// underlying number of cells.
areaUnit.addEventListener('input', () => {
  refreshSizeUI();
  refreshMoveUI();
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
// Both hand-set fields (area size, piece movement): type it, or step it a cell at a time.
areaSize.attach();
pieceSpeed.attach();
// …plus the one-tap presets for the area size.
areaPresets.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!chip) return;
  setSizeCells(+chip.dataset.cells!);
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
areaCreature.addEventListener('input', () => {
  if (S.activeOverlay?.kind === 'area') updateAreaOverlay();
});
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
  // Resizing while its movement is shown keeps the movement (recomputed for the new
  // block); otherwise re-anchor the selection to the resized block.
  if (S.activeOverlay?.kind === 'move') syncMoveOverlayTo(t);
  else selectPieceAt(nb.bi, nb.bj);
  requestDraw();
});
// (the Movement stepper is wired above, with the area size — see pieceSpeed)
pieceRemove.addEventListener('click', () => {
  const t = selectedPiece();
  if (!t) return;
  const idx = S.tokens.indexOf(t);
  if (idx >= 0) S.tokens.splice(idx, 1);
  deselectCell();
  requestDraw();
});
}
