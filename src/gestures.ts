// Map pointer gestures: tap/long-press/drag on pieces, area origin & arrival dragging, ring rotate.
import { S, type Token, type ImgPt } from './tactical-state';
import { view } from './dom';
import { creatureBlock } from './overlays';
import { activePointers, capturePointer } from './pointer-capture';
import { tokenAt, tokenCovers, tokenBlock } from './board';
import {
  ringHit, rotateFromPointer, targetHit, setMoveTargetAt, startMovementFromCell,
  selectPieceAt, placeOrRemoveAt, placeAreaAt, pointerCell, updateFabIcon,
  syncMoveOverlayTo, anchorSelectionTo,
} from './placement';
import { refreshHud } from './hud';
import { manualPointerDown, manualPointerMove, manualPointerUp } from './manual-grid';
import { requestDraw } from './draw-loop';

// --- Tactical tools (select a cell → add area / see movement) ----------
// One overlay is "active" at a time and stays editable: its position (tap
// another cell), size and angle can be changed live while its form is open.
export function deselectCell() {
  S.selectedCell = null;
  S.activeOverlay = null;
  S.moveTarget = null;
  refreshHud();
  updateFabIcon();
  requestDraw(); // clear any overlay/threat visuals IMMEDIATELY (e.g. leaving movement)
}

/** Map a client point to IMAGE pixels (accounts for the zoom transform via the
 * canvas's rendered rect). */
export function pointerToImage(clientX: number, clientY: number): ImgPt | null {
  const rect = view.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * view.width,
    y: ((clientY - rect.top) / rect.height) * view.height,
  };
}

/** Map a client point to grid coordinates. */
export function pointerToGrid(clientX: number, clientY: number): [number, number] | null {
  if (!S.gridMap) return null;
  const p = pointerToImage(clientX, clientY);
  return p ? S.gridMap.toGrid(p.x, p.y) : null;
}

// Reposition the active selection/overlay to the tapped point. Used only while
// DRAGGING an area's origin handle, so it must NOT expand the HUD (moving an area
// must never reopen the menu).
export function selectCellAt(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return;
  const [a, b] = g;
  const i = Math.floor(a);
  const j = Math.floor(b);
  if (i < 0 || j < 0 || i >= S.gridDims.na - 1 || j >= S.gridDims.nb - 1) return; // off-grid

  S.selectedCell = [i, j];
  S.selectedNode = [Math.round(a), Math.round(b)]; // nearest intersection
  // If an overlay is active, moving the selection MOVES it (cell + intersection).
  if (S.activeOverlay) {
    S.activeOverlay.cell = [i, j];
    if (S.activeOverlay.kind === 'area') S.activeOverlay.corner = [S.selectedNode[0], S.selectedNode[1]];
  }
  requestDraw();
}

/** The cells that count as the selection's "origin handle": dragging from one of
 * them moves the selection (drag-to-reposition), a tap on one deselects it. */
export function originCellSet(): Set<string> {
  const s = new Set<string>();
  if (!S.selectedCell) return s;
  const [ci, cj] = S.selectedCell;
  if (S.activeOverlay?.kind === 'area' && (S.activeOverlay.type === 'esplosione' || S.activeOverlay.type === 'cono')) {
    const [ni, nj] = S.selectedNode; // the four cells that touch the chosen intersection
    for (const [di, dj] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) s.add(`${ni + di},${nj + dj}`);
  } else {
    let w = 1;
    if (S.activeOverlay?.kind === 'move') w = Math.max(1, S.activeOverlay.creatureCells);
    else if (S.activeOverlay?.kind === 'area' && S.activeOverlay.type === 'emanazione')
      w = Math.max(1, S.activeOverlay.creatureCells);
    const [bi, bj] = creatureBlock(ci, cj, w);
    for (let i = bi; i < bi + w; i++) for (let j = bj; j < bj + w; j++) s.add(`${i},${j}`);
    s.add(`${ci},${cj}`);
  }
  return s;
}

export function originHit(clientX: number, clientY: number): boolean {
  if (!S.selectedCell || !S.activeOverlay) return false; // only an active overlay repositions by drag
  if (S.activeOverlay.kind === 'move') return false; // movement starts from a fixed piece — no drag
  const g = pointerToGrid(clientX, clientY);
  if (!g) return false;
  return originCellSet().has(`${Math.floor(g[0])},${Math.floor(g[1])}`);
}

/** The token under the pointer (any token, regardless of selection), for gestures.
 * Also used IN placement mode, where a piece can be dragged as well as removed. */
export function pieceUnderPointer(clientX: number, clientY: number): Token | null {
  const c = pointerCell(clientX, clientY);
  return c ? tokenAt(c[0], c[1]) : null;
}

/** The piece's own cell (its block's top-left): `t.i/t.j` are the RAW values, which
 * tokenBlock clamps at the board edge — so always address a piece through its block. */
function pieceCell(t: Token): [number, number] {
  const { bi, bj } = tokenBlock(t);
  return [bi, bj];
}

/** Drag a piece so its block follows the pointer (won't stack on another piece). */
export function movePieceTo(t: Token, clientX: number, clientY: number) {
  const c = pointerCell(clientX, clientY);
  if (!c) return;
  if (S.tokens.some((o) => o !== t && tokenCovers(o, c[0], c[1]))) return;
  if (t.i === c[0] && t.j === c[1]) return; // same cell → nothing to repaint
  t.i = c[0];
  t.j = c[1];
  // Keep whatever we were doing with the piece: if its MOVEMENT was showing, keep
  // showing it (recomputed from the new spot); otherwise keep its editor anchored on it.
  // (User: "se sposto la pedina deve rimanere il movimento".) The HUD's CONTENT doesn't
  // change while dragging, so it is rebuilt once on release, not on every move.
  if (S.activeOverlay?.kind === 'move') syncMoveOverlayTo(t);
  else anchorSelectionTo(t);
  requestDraw();
}

export let tapStart: { x: number; y: number; t: number } | null = null;

export let tapCandidate = false;

export let dragMoved = false;

export let gesturePiece: Token | null = null;

export let longPressFired = false;

export let longPressTimer: ReturnType<typeof setTimeout> | null = null;

export const LONG_PRESS_MS = 450;

export const clearLongPress = () => {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

export function initGestures() {
view.addEventListener('pointerdown', (e) => {
  if (S.manualActive) {
    manualPointerDown(e);
    return;
  }
  activePointers.add(e.pointerId);
  if (activePointers.size !== 1) {
    tapCandidate = false; // multi-touch → pinch, not a tap/drag
    S.ringRotating = false;
    S.dragKind = null;
    clearLongPress();
    return;
  }
  tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
  gesturePiece = null;
  longPressFired = false;
  const piece = pieceUnderPointer(e.clientX, e.clientY);
  const placingPieces = S.placeMode === 'ally' || S.placeMode === 'enemy';
  if (placingPieces && piece) {
    // A piece under the finger WHILE PLACING: a tap still removes it (unchanged), but a
    // drag now carries it to another cell instead of doing nothing. No long-press here —
    // in placement mode the tap keeps its single meaning (add / remove).
    gesturePiece = piece;
    S.dragKind = 'piece';
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
  } else if (S.placeMode !== 'none') {
    tapCandidate = true; // placement mode: every tap adds/removes
  } else if (ringHit(e.clientX, e.clientY)) {
    S.ringRotating = true;
    tapCandidate = false;
    capturePointer(e.pointerId);
    rotateFromPointer(e.clientX, e.clientY);
  } else if (piece) {
    // Tap → movement, long-press → edit, drag → reposition.
    gesturePiece = piece;
    S.dragKind = 'piece';
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (gesturePiece && !dragMoved) {
        longPressFired = true;
        S.dragKind = null; // no drag after the edit menu opens
        selectPieceAt(...pieceCell(gesturePiece)); // open the edit menu
        requestDraw();
      }
    }, LONG_PRESS_MS);
  } else if (originHit(e.clientX, e.clientY)) {
    S.dragKind = 'origin'; // drag → reposition the area; tap → deselect
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
  } else if (targetHit(e.clientX, e.clientY)) {
    S.dragKind = 'target'; // drag → move the arrival cell; tap → clear it
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
  } else {
    tapCandidate = true;
  }
});
view.addEventListener('pointermove', (e) => {
  if (S.manualActive) {
    manualPointerMove(e);
    return;
  }
  if (S.ringRotating) {
    e.preventDefault();
    S.dragPoint = pointerToImage(e.clientX, e.clientY); // magnify under the finger
    rotateFromPointer(e.clientX, e.clientY);
  } else if (S.dragKind && tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) {
    e.preventDefault();
    clearLongPress(); // moving → it's a drag, not a long-press
    dragMoved = true;
    S.dragPoint = pointerToImage(e.clientX, e.clientY);
    if (S.dragKind === 'piece' && gesturePiece) movePieceTo(gesturePiece, e.clientX, e.clientY);
    else if (S.dragKind === 'origin') selectCellAt(e.clientX, e.clientY);
    else if (S.dragKind === 'target') setMoveTargetAt(e.clientX, e.clientY);
  }
});
view.addEventListener('pointerup', (e) => {
  if (S.manualActive) {
    manualPointerUp(e);
    return;
  }
  activePointers.delete(e.pointerId);
  clearLongPress();
  S.dragPoint = null; // finger up → the loupe goes away
  if (S.ringRotating) {
    S.ringRotating = false;
  } else if (S.dragKind === 'piece') {
    const piece = gesturePiece;
    S.dragKind = null;
    gesturePiece = null;
    // A drag already repositioned the piece — releasing must never also delete it; a
    // long-press already opened its editor. Only a quick TAP acts here, and what it does
    // depends on the mode: while placing it removes the piece, otherwise it starts its
    // movement.
    if (!dragMoved && piece) {
      const [pi, pj] = pieceCell(piece);
      if (S.placeMode === 'ally' || S.placeMode === 'enemy') placeOrRemoveAt(pi, pj);
      else startMovementFromCell(pi, pj);
    } else if (dragMoved) {
      refreshHud(); // the drag skipped the HUD to stay smooth — sync it once, now
    }
  } else if (S.dragKind) {
    const kind = S.dragKind;
    S.dragKind = null;
    if (!dragMoved) {
      // A tap (no drag) on the area origin does NOTHING — an area is removed only
      // with the ✕, never by clicking it. A tap on the movement arrival clears it.
      if (kind === 'target') {
        S.moveTarget = null;
        requestDraw();
      }
    }
  } else if (longPressFired) {
    // edit menu already opened on the long-press; nothing to do on release
  } else if (tapCandidate && tapStart) {
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    const dt = Date.now() - tapStart.t;
    if (moved <= 8 && dt <= 500) {
      const c = pointerCell(e.clientX, e.clientY);
      if (S.placeMode === 'ally' || S.placeMode === 'enemy') {
        if (c) placeOrRemoveAt(c[0], c[1]);
      } else if (S.placeMode === 'area') {
        placeAreaAt(e.clientX, e.clientY);
      } else if (S.activeOverlay?.kind === 'move') {
        setMoveTargetAt(e.clientX, e.clientY); // empty cell in movement → arrival
      } else if (S.activeOverlay?.kind === 'area') {
        // an area stays until removed with the ✕ — a stray tap does nothing
      } else {
        deselectCell(); // tap empty ground → clear a piece selection
      }
    }
  }
  tapStart = null;
  tapCandidate = false;
  gesturePiece = null;
  longPressFired = false;
  requestDraw(); // always repaint on release — if nothing else, to drop the loupe
});
view.addEventListener('pointercancel', (e) => {
  if (S.manualActive) {
    manualPointerUp(e);
    return;
  }
  activePointers.delete(e.pointerId);
  clearLongPress();
  S.ringRotating = false;
  S.dragKind = null;
  S.dragPoint = null;
  tapStart = null;
  tapCandidate = false;
  gesturePiece = null;
  longPressFired = false;
  requestDraw();
});
}
