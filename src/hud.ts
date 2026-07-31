// Heads-up panel (the single contextual control surface over the map) + the (i) help popover.
import { S } from './tactical-state';
import {
  hud, hudBadge, hudTitle, hudArea, hudPiece, hudMove, hudCollapse, hudClose,
  pieceRemove, pieceSize, pieceMove, infoWrap, infoBtn, infoPop,
} from './dom';
import { selectedPiece, highlightAreaType, moveGroup, updateFabIcon } from './placement';
import { deselectCell } from './gestures';
import { draw } from './draw-loop';

// The exact top-bar button icons (Lucide), inlined so the (i) guidance points at the
// real controls with their real glyphs — kept in sync with index.html (#btnEditGrid /
// #btnRetake). Rendered as HTML (see updateInfo), so info strings are treated as HTML;
// all guidance text is static, so there's no injection surface.
export const ICON_GRID =
  '<span class="info-ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></span>';

export const ICON_CAM =
  '<span class="info-ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg></span>';

/** The guidance for the current app state (null → nothing to show, button hidden). May
 * contain inline HTML (the real UI icons); updateInfo renders it as HTML. */
export function currentInfo(): string | null {
  if (!S.showingResult) return null; // camera mode — the central on-screen hint suffices
  if (S.manualActive) {
    return S.manualDrawPending
      ? 'Traccia una linea lungo ogni colonna e ogni riga (almeno 2 per direzione): da queste genero la griglia.\nTrascina gli estremi per correggere una linea · tocca la × per eliminarla.'
      : 'Trascina gli angoli per adattare la griglia · trascina il centro per spostarla.\nAvvicina o allontana due dita per ridimensionarla.';
  }
  if (S.placeMode === 'area') return 'Tocca una cella per posizionare l’area.';
  if (S.placeMode === 'ally') return 'Tocca le celle per aggiungere o togliere alleati.';
  if (S.placeMode === 'enemy') return 'Tocca le celle per aggiungere o togliere nemici.';
  const ctx = hudContext();
  if (ctx === 'move')
    return 'Tocca una cella per vedere i percorsi · tocca un’altra pedina per spostarti su di essa.';
  if (ctx === 'piece') return 'Tocca la pedina per il movimento · trascinala per spostarla.';
  if (ctx === 'area') {
    const base = 'Trascina l’area per spostarla · tocca ✕ per rimuoverla.';
    return S.currentAreaType === 'linea' || S.currentAreaType === 'cono'
      ? 'Ruota l’area trascinando la punta sulla mappa.\n' + base
      : base;
  }
  if (!S.gridReliable)
    return `Nessuna griglia rilevata.\nDisegnala a mano con ${ICON_GRID} o rifai la foto con ${ICON_CAM}.`;
  // Idle over a good grid: the always-available "what can I do". Point at the real
  // top-bar buttons with their real icons (grid / camera).
  return `Tocca ＋ per aggiungere pedine o aree.\nUsa ${ICON_GRID} per modificare la griglia, o ${ICON_CAM} per rifare la foto.`;
}

/** Sync the (i) button + popover with the current state. */
export function updateInfo() {
  const text = currentInfo();
  if (!text) {
    S.infoOpen = false;
    infoWrap.hidden = true;
    infoPop.hidden = true;
    infoWrap.classList.remove('open');
    return;
  }
  infoWrap.hidden = false;
  infoPop.innerHTML = text; // static guidance, may embed the real UI icons (see ICON_*)
  infoPop.hidden = !S.infoOpen;
  infoWrap.classList.toggle('open', S.infoOpen);
}

export function hudContext(): 'area' | 'piece' | 'move' | null {
  if (S.activeOverlay?.kind === 'move') return 'move';
  if (S.activeOverlay?.kind === 'area') return 'area';
  if (selectedPiece()) return 'piece';
  return null;
}

// Rebuild the HUD from the current state, PRESERVING the collapsed flag.
export function refreshHud() {
  const ctx = hudContext();
  if (!ctx) {
    hud.hidden = true;
    updateInfo();
    return;
  }
  hud.hidden = false;
  hud.classList.toggle('collapsed', S.hudCollapsed);
  // Movement has no body controls (its guidance lives behind the (i) button), so
  // drop the empty body and its collapse chevron.
  hud.classList.toggle('bodyless', ctx === 'move');
  hudCollapse.hidden = ctx === 'move';
  hudArea.hidden = ctx !== 'area';
  hudPiece.hidden = ctx !== 'piece';
  hudMove.hidden = ctx !== 'move';
  pieceRemove.hidden = ctx !== 'piece'; // the trash lives in the head, only for a piece
  hudBadge.className = 'hud-badge';
  if (ctx === 'area') {
    hudTitle.textContent = 'Area';
    hudBadge.classList.add('area');
    highlightAreaType(); // sync the chips + size / creature selects
  } else if (ctx === 'piece') {
    const t = selectedPiece()!;
    hudTitle.textContent = t.kind === 'ally' ? 'Alleato' : 'Nemico';
    hudBadge.classList.add(t.kind);
    pieceSize.value = String(t.w);
    pieceMove.value = String(t.speed);
  } else {
    hudTitle.textContent = 'Movimento';
    hudBadge.classList.add(moveGroup());
  }
  updateInfo();
}

// Expand + rebuild — only for explicit entry points (add area / open editor / start
// movement / manual expand).
export function showHud() {
  S.hudCollapsed = false;
  refreshHud();
}

// Remove the currently active area (the FAB ✕ and the HUD close both do this — the
// "Pulisci" button is gone; clearing an area is done by its ✕).
export function removeActiveArea() {
  if (S.activeOverlay?.kind !== 'area') return;
  S.activeOverlay = null;
  S.selectedCell = null;
  S.moveTarget = null;
  refreshHud();
  updateFabIcon();
  draw();
}

export function initHud() {
// HUD: collapse/expand its body; the ✕ dismisses the current context — removes an
// area, or deselects a piece / exits a movement.
hudCollapse.addEventListener('click', () => {
  S.hudCollapsed = !S.hudCollapsed;
  refreshHud();
});
// The single (i) button toggles the contextual-help popover.
infoBtn.addEventListener('click', () => {
  S.infoOpen = !S.infoOpen;
  updateInfo();
});
hudClose.addEventListener('click', () => {
  if (S.activeOverlay?.kind === 'area') removeActiveArea();
  else {
    deselectCell();
    draw();
  }
});
}
