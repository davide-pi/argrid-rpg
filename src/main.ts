import './style.css';
import { Camera } from './camera';
import {
  detectGrid,
  detectGridSteps,
  buildGrid,
  clipLineToRect,
  intersect,
  DEFAULT_PARAMS,
  type DetectorParams,
  type GridResult,
  type Line2,
  type RawLine,
} from './grid-detector';
import { attachZoomPan } from './zoom';
import {
  makeGridMap,
  solveHomography,
  applyH,
  areaCells,
  moveCells,
  movePareto,
  ringColor,
  fixedAngles,
  snapToAngles,
  gridDir,
  angleOfGridDir,
  threatCells,
  FIXED_SIZES,
  CREATURE_SIZES,
  creatureBlock,
  type GridMap,
  type Overlay,
  type MoveOverlay,
  type AreaType,
  type Unit,
} from './overlays';

// OpenCV is loaded by the classic bootstrap script (public/opencv-boot.js),
// which exposes these globals. See that file for why it must be classic.
type CvProgress =
  | { phase: 'download'; loaded: number; total: number | null }
  | { phase: 'init' }
  | { phase: 'ready' };
declare global {
  interface Window {
    cv: any;
    __cvOnProgress: (fn: (p: CvProgress) => void) => void;
    __cvOnReady: (fn: (cv: any) => void, onErr?: (e: Error) => void) => void;
  }
}

// --- DOM ---------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const view = $<HTMLCanvasElement>('view');
const stage = $<HTMLElement>('stage');
const statusEl = $<HTMLSpanElement>('status');
const hint = $<HTMLDivElement>('hint');

const loader = $<HTMLDivElement>('loader');
const loaderMsg = $<HTMLParagraphElement>('loaderMsg');
const loaderFill = $<HTMLDivElement>('loaderFill');

// Processing overlay (shown while a captured photo is being analysed).
const processing = $<HTMLDivElement>('processing');
const processingMsg = $<HTMLParagraphElement>('processingMsg');
const processingFill = $<HTMLDivElement>('processingFill');
const processingPct = $<HTMLSpanElement>('processingPct');

const btnCapture = $<HTMLButtonElement>('btnCapture');
const btnRetake = $<HTMLButtonElement>('btnRetake');
// The retake (camera) button lives in the top bar and shows only in result mode.
const topActions = $<HTMLDivElement>('topActions');

// Manual-grid chooser (shown only when the user taps the top-bar edit button).
const editChooser = $<HTMLDivElement>('editChooser');
const chooseAdapt = $<HTMLButtonElement>('chooseAdapt');
const chooseDraw = $<HTMLButtonElement>('chooseDraw');
const chooseCancel = $<HTMLButtonElement>('chooseCancel');

// Result-mode "edit the grid by hand" button (top bar); always available so any
// grid — even a well-detected one — can be adjusted.
const btnEditGrid = $<HTMLButtonElement>('btnEditGrid');
// Manual-grid editor bar.
const manualBar = $<HTMLDivElement>('manualBar');
const colsMinus = $<HTMLButtonElement>('colsMinus');
const colsPlus = $<HTMLButtonElement>('colsPlus');
const colsInput = $<HTMLInputElement>('colsInput');
const rowsMinus = $<HTMLButtonElement>('rowsMinus');
const rowsPlus = $<HTMLButtonElement>('rowsPlus');
const rowsInput = $<HTMLInputElement>('rowsInput');
const manualDone = $<HTMLButtonElement>('manualDone');
const manualCancel = $<HTMLButtonElement>('manualCancel');
const manualCollapse = $<HTMLButtonElement>('manualCollapse');

// Debug has no on-screen switch — it's a hidden state toggled by triple-tapping
// the logo. When on, detection draws its edge/line diagnostics and a verbose status,
// and the debug step viewer lets you inspect each pipeline stage.
let debug = false;
const debugBar = $<HTMLDivElement>('debugBar');
// Selected debug stage: an index into lastResult.debugSteps, or === its length for the
// final live line overlay (the default). Reset to the overlay on each detection.
let debugStepIdx = 0;
// Floating "add" speed-dial.
const fabWrap = $<HTMLDivElement>('fabWrap');
const fab = $<HTMLButtonElement>('fab');
const fabAlly = $<HTMLButtonElement>('fabAlly');
const fabEnemy = $<HTMLButtonElement>('fabEnemy');
const fabArea = $<HTMLButtonElement>('fabArea');

// Heads-up panel (overlaid on the top of the map) — the single contextual control
// surface for a selected piece, an active area, or a movement. Replaces the old
// bottom sheet.
const hud = $<HTMLDivElement>('hud');
const hudBadge = $<HTMLSpanElement>('hudBadge');
const hudTitle = $<HTMLSpanElement>('hudTitle');
const hudArea = $<HTMLDivElement>('hudArea');
const hudPiece = $<HTMLDivElement>('hudPiece');
const hudMove = $<HTMLDivElement>('hudMove');
const hudCollapse = $<HTMLButtonElement>('hudCollapse');
const hudClose = $<HTMLButtonElement>('hudClose');
// Single contextual-help affordance (bottom-left, above the version badge).
const infoWrap = $<HTMLDivElement>('infoWrap');
const infoBtn = $<HTMLButtonElement>('infoBtn');
const infoPop = $<HTMLDivElement>('infoPop');
// Area controls (live inside the HUD now).
const areaTypeBox = $<HTMLDivElement>('areaType');
const areaSizeSel = $<HTMLSelectElement>('areaSizeSel');
const areaUnit = $<HTMLSelectElement>('areaUnit');
const areaCreature = $<HTMLSelectElement>('areaCreature');
const brand = $<HTMLElement>('brand');
// Build version (injected by Vite — GitVersion in CI), shown small on the map.
const versionBadge = $<HTMLSpanElement>('versionBadge');
versionBadge.textContent = `v${__APP_VERSION__}`;
// Per-piece editor (Taglia / Movimento), shown when a token is selected.
const pieceSize = $<HTMLSelectElement>('pieceSize');
const pieceMove = $<HTMLSelectElement>('pieceMove');
const pieceRemove = $<HTMLButtonElement>('pieceRemove');

// --- State -------------------------------------------------------------
const camera = new Camera(video);
// While rotating the angle ring OR dragging the selection/arrival, suppress pan
// so the gesture only turns/moves that thing.
let ringRotating = false;
let dragKind: 'origin' | 'target' | 'piece' | null = null;
// Manual-grid editing: which handle is being dragged (0..3 corner, 4 = translate,
// 5 = tracing a line, 6 = pinch-resize). `manualActive` is true throughout manual
// editing so the whole gesture surface (incl. image pinch-zoom) is handed to the
// grid editor instead of the zoom controller.
let manualDrag: number | null = null;
let manualActive = false;
const zoom = attachZoomPan(view, {
  suppress: () => ringRotating || dragKind !== null || manualDrag !== null || manualActive,
});
let cv: any = null;
let lastCapture: HTMLCanvasElement | null = null;
let lastResult: GridResult | null = null;
let showingResult = false; // true while a captured photo + overlay is shown
// Whether a grid is currently drawn (and tactics can build on it). True when the
// detector actually found one (both families detected, not a broken/degenerate fit),
// or the user placed a manual one. When false we simply show the photo alone — there
// is NO automatic fallback panel; the user edits or retakes from the top-bar buttons.
let gridReliable = false;

// Tactical state.
let gridMap: GridMap | null = null; // grid<->image mapping for the current grid
let gridDims = { na: 0, nb: 0 };
let selectedCell: [number, number] | null = null; // floor of the tapped grid point
let selectedNode: [number, number] = [0, 0]; // nearest intersection (burst/cone origin)
let activeOverlay: Overlay | null = null; // one editable overlay at a time
let currentAreaType: AreaType = 'esplosione';
let areaAngleDeg = 0; // line/cone orientation, set by the on-map angle ring

// Board tokens: allies (green) / enemies (red), each an X×X block at (i,j).
// Each piece carries its own movement speed (in cells / q). Threat reach is shown
// only during movement (the opposite side) — there is no global toggle.
interface Token {
  kind: 'ally' | 'enemy';
  i: number;
  j: number;
  w: number;
  speed: number; // movement in cells (q)
}
const DEFAULT_PIECE_SPEED = 6; // 6q = 30 ft
const MOVE_ACTIONS = 5; // movement always shows up to 5 movements (no selector)
let tokens: Token[] = [];
// Placement mode (driven by the FAB): while set, tapping the map adds pieces of
// that kind, or (for 'area') drops an area at the tapped cell.
let placeMode: 'none' | 'ally' | 'enemy' | 'area' = 'none';
let moveTarget: [number, number] | null = null; // "arrival" cell for the path preview

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

// --- Contextual help (single (i) button, bottom-left) ------------------
// One affordance carries all the "what can I do now" guidance that used to be
// scattered across HUD hints and transient toasts. It's shown only when there's
// something to say for the current state; tapping (i) toggles the popover. It
// auto-opens on the moments that need immediate guidance (entering placement /
// manual editing, or a photo with no grid); otherwise it stays where the user left it.
let infoOpen = false;

/** The guidance for the current app state (null → nothing to show, button hidden). */
function currentInfo(): string | null {
  if (!showingResult) return null; // camera mode — the central on-screen hint suffices
  if (manualActive) {
    return manualDrawPending
      ? 'Traccia una linea lungo ogni colonna e ogni riga (almeno 2 per direzione): da queste genero la griglia.\nTrascina gli estremi per correggere una linea · tocca la × per eliminarla.'
      : 'Trascina gli angoli per adattare la griglia · trascina il centro per spostarla.\nAvvicina o allontana due dita per ridimensionarla.';
  }
  if (placeMode === 'area') return 'Tocca una cella per posizionare l’area.';
  if (placeMode === 'ally') return 'Tocca le celle per aggiungere o togliere alleati.';
  if (placeMode === 'enemy') return 'Tocca le celle per aggiungere o togliere nemici.';
  const ctx = hudContext();
  if (ctx === 'move')
    return 'Tocca una cella per vedere i percorsi · tocca un’altra pedina per spostarti su di essa.';
  if (ctx === 'piece') return 'Tocca la pedina per il movimento · trascinala per spostarla.';
  if (ctx === 'area') {
    const base = 'Trascina l’area per spostarla · tocca ✕ per rimuoverla.';
    return currentAreaType === 'linea' || currentAreaType === 'cono'
      ? 'Ruota l’area trascinando la punta sulla mappa.\n' + base
      : base;
  }
  if (!gridReliable)
    return 'Nessuna griglia rilevata.\nDisegnala a mano con il tasto griglia (in alto a destra), o rifai la foto con il tasto fotocamera.';
  // Idle over a good grid: the always-available "what can I do". Refer to the top-bar
  // buttons by what their icons ARE (grid / camera), not by a mismatched glyph.
  return 'Tocca ＋ per aggiungere pedine o aree.\nUsa il tasto griglia (in alto a destra) per modificare la griglia, o il tasto fotocamera per rifare la foto.';
}

/** Sync the (i) button + popover with the current state. */
function updateInfo() {
  const text = currentInfo();
  if (!text) {
    infoOpen = false;
    infoWrap.hidden = true;
    infoPop.hidden = true;
    infoWrap.classList.remove('open');
    return;
  }
  infoWrap.hidden = false;
  infoPop.textContent = text;
  infoPop.hidden = !infoOpen;
  infoWrap.classList.toggle('open', infoOpen);
}

// --- Heads-up panel (contextual controls over the map) -----------------
// The HUD is the single control surface, overlaid on the TOP of the map. It shows
// whatever is active (a selected piece / an area / a movement). It can be COLLAPSED
// to just its header, and it does NOT auto-expand when you reposition a piece or an
// area — only an explicit action (add area, open a piece editor, start a movement)
// or a manual tap expands it (user: "se riduco il menù non deve riaprirsi se sposto
// l'area; deve aprirsi solo quando aggiungo un'area o se lo apro io a mano").
let hudCollapsed = false;

function hudContext(): 'area' | 'piece' | 'move' | null {
  if (activeOverlay?.kind === 'move') return 'move';
  if (activeOverlay?.kind === 'area') return 'area';
  if (selectedPiece()) return 'piece';
  return null;
}

// Rebuild the HUD from the current state, PRESERVING the collapsed flag.
function refreshHud() {
  const ctx = hudContext();
  if (!ctx) {
    hud.hidden = true;
    updateInfo();
    return;
  }
  hud.hidden = false;
  hud.classList.toggle('collapsed', hudCollapsed);
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
function showHud() {
  hudCollapsed = false;
  refreshHud();
}

// Remove the currently active area (the FAB ✕ and the HUD close both do this — the
// "Pulisci" button is gone; clearing an area is done by its ✕).
function removeActiveArea() {
  if (activeOverlay?.kind !== 'area') return;
  activeOverlay = null;
  selectedCell = null;
  moveTarget = null;
  refreshHud();
  updateFabIcon();
  draw();
}

function currentParams(): DetectorParams {
  // Reconstruct the full 2-D lattice and rebuild every row/column (occluded ones
  // included) — with the vanishing-point + rectification model these are
  // reliable, so the complete grid is shown.
  return { ...DEFAULT_PARAMS, fillGrid: true };
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

// --- Boot --------------------------------------------------------------
// Stay behind the loading screen until OpenCV is fully ready, so once the app
// is usable it never blocks the user mid-action.
function boot() {
  window.__cvOnProgress((p) => {
    if (p.phase === 'download') {
      if (p.total) {
        const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
        loaderFill.classList.remove('indeterminate');
        loaderFill.style.width = pct + '%';
        loaderMsg.textContent = `Scarico il motore… ${mb(p.loaded)} / ${mb(p.total)} MB (${pct}%)`;
      } else {
        loaderFill.classList.add('indeterminate');
        loaderMsg.textContent = `Scarico il motore… ${mb(p.loaded)} MB`;
      }
    } else if (p.phase === 'init') {
      loaderFill.classList.add('indeterminate');
      loaderMsg.textContent = 'Compilazione motore di visione…';
    }
  });

  window.__cvOnReady(
    (mod) => {
      cv = mod;
      // Dev-only test hook so a headless browser can drive detection on a
      // synthetic canvas (stripped from the production build).
      if (import.meta.env.DEV) {
        (window as any).__argrid = {
          detectGrid,
          cv: mod,
          DEFAULT_PARAMS,
          render: (c: HTMLCanvasElement) => processImage(c),
          view,
          // Client-space position of a grid point (i,j), for driving the tactical
          // UI (taps, ring drags) from a test harness.
          cellClient: (i: number, j: number) => {
            if (!gridMap) return null;
            const [x, y] = gridMap.toImage(i, j);
            const r = view.getBoundingClientRect();
            return { x: r.left + (x / view.width) * r.width, y: r.top + (y / view.height) * r.height };
          },
          // Rotation handle (grid coords) + current effective angle, for driving
          // the ring from a test harness.
          ringHandle: () => ringHandleGrid(),
          effectiveAngle: () => effectiveAngle(),
          // Current detection state, for test assertions.
          state: () => ({ gridReliable, gridDims: { ...gridDims }, showingResult }),
        };
      }
      btnCapture.disabled = false;
      loader.classList.add('done');
      setStatus('Pronto');
      startCamera().catch(() => setStatus('Consenti la fotocamera e tocca lo schermo per avviarla'));
    },
    (err) => {
      console.error(err);
      loader.classList.add('error');
      loaderMsg.textContent = 'Errore nel caricamento di OpenCV: ' + err.message;
    },
  );
}

// --- Camera / capture --------------------------------------------------
async function startCamera() {
  try {
    await camera.start();
    video.hidden = false;
    view.hidden = true;
    hint.hidden = false;
    btnCapture.hidden = false; // the floating Scatta button — camera mode only
    btnCapture.disabled = !cv;
    topActions.hidden = true; // the retake button is result-mode only
    hud.hidden = true; // no contextual controls on the live camera
    if (placeMode !== 'none') setPlaceMode('none');
    fabWrap.hidden = true; // nothing to add on the live camera
    setStatus(''); // no header status on the live camera (the on-map hint suffices)
    updateInfo(); // hide the (i) button — nothing to guide on the camera
  } catch (err) {
    console.error(err);
    setStatus('Fotocamera non disponibile — tocca lo schermo per riprovare');
    throw err;
  }
}

function capture() {
  if (!camera.isRunning) {
    setStatus('Avvia la fotocamera');
    return;
  }
  const frame = camera.grabFrame();
  camera.stop();
  video.hidden = true;
  processImage(frame);
}

function processImage(canvas: HTMLCanvasElement) {
  lastCapture = canvas;
  view.hidden = false;
  hint.hidden = true;
  zoom.reset(); // start each new capture unzoomed
  deselectCell(); // a new photo → drop the previous overlay and selection
  tokens = []; // …and the previous board tokens
  // A new photo → drop any manual grid / fallback state from the previous one.
  manualActive = false;
  manualQuad = null;
  showManualBar(false);
  editChooser.hidden = true;
  if (placeMode !== 'none') setPlaceMode('none'); // turn off any active placement
  fabWrap.hidden = false; // the "add" FAB is available once there's a grid
  // Enter result mode BEFORE detection so the chrome/(i) updates run by runDetection
  // (updateResultChrome / updateInfo) see the correct mode — otherwise the FIRST photo
  // leaves the (i) hidden and the FAB ungated. Push a history entry so the device/
  // browser "back" returns to the camera (via popstate) instead of leaving the app.
  if (!showingResult) {
    showingResult = true;
    history.pushState({ argrid: 'result' }, '');
  }
  runDetection();
  btnCapture.hidden = true; // no Scatta once we already have a grid
  topActions.hidden = false; // show the camera (retake) button at the top
}

// Yield to the browser so it paints the overlay (bar + message) and keeps the
// die's compositor animation running before we block on the next heavy stage.
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

let detecting = false;

// Max ratio between the two families' cell pitches before a fit is treated as "not a
// grid" (one family collapsed → micro one way / macro the other).
const MAX_CELL_ASPECT = 6;
// A real tactical grid is at least this many cells per side. A smaller fit (e.g. the
// 2×2 a strong-perspective floor collapses to when the vanishing point is rejected and
// no rectification happens) is treated as unreliable → we don't draw a confidently
// wrong grid; the (i) guidance steers the user to ✎ / ↺ instead.
const MIN_GRID_CELLS = 5;

async function runDetection() {
  // One detection at a time — the pipeline is heavy and holds OpenCV Mats.
  if (!cv || !lastCapture || detecting) return;
  detecting = true;
  showProcessing("Analisi dell'immagine…", 0);
  await nextFrame(); // paint the overlay before the first blocking stage
  try {
    const t0 = performance.now();
    // Drive the staged detector: paint each step, yield a frame (die spins /
    // bar advances), then run the next synchronous stage.
    const gen = detectGridSteps(cv, lastCapture, currentParams(), debug);
    let step = gen.next();
    while (!step.done) {
      setProcessing(step.value.label, step.value.frac);
      await nextFrame();
      step = gen.next();
    }
    setProcessing('Quasi pronto…', 1);
    lastResult = step.value;

    // Draw whatever grid the detector actually FOUND — or nothing if it didn't. The
    // user decides if it's good (they can edit it or retake); we no longer auto-hide
    // low-confidence grids behind a panel.
    applyDetectedGrid();
    debugStepIdx = lastResult?.debugSteps?.length ?? 0; // default to the final overlay
    if (selectedCell) {
      const [i, j] = selectedCell;
      if (!gridMap || i >= gridDims.na - 1 || j >= gridDims.nb - 1) deselectCell();
    }
    const dt = Math.round(performance.now() - t0);
    draw();
    reportStatus(dt);
    // No grid found → the photo shows alone; updateResultChrome surfaces the (i)
    // guidance ("tocca ✎ / ↺") so the user isn't left wondering.
    updateResultChrome();
  } catch (err) {
    console.error(err);
    setStatus('Errore analisi: ' + (err as Error).message);
  } finally {
    detecting = false;
    hideProcessing();
  }
}

function showProcessing(label: string, frac: number) {
  processing.hidden = false;
  setProcessing(label, frac);
}
function setProcessing(label: string, frac: number) {
  processingMsg.textContent = label;
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  processingFill.style.width = pct + '%';
  processingPct.textContent = pct + '%';
}
function hideProcessing() {
  processing.hidden = true;
}

// Derive gridReliable + the grid↔image map from the current detector output
// (lastResult). "Found a grid" = both families really detected (≥ 2 lines each), the
// drawn grid spans at least MIN_GRID_CELLS per side, and it isn't a broken fit
// (degenerate sub-pitch, or one family collapsed → extreme cell-aspect). Used after
// detection AND to RESTORE the auto grid when the user cancels a manual edit (cancel
// must not lose the detected grid).
function applyDetectedGrid() {
  gridReliable = false;
  if (lastResult) {
    const i = lastResult.info;
    const aspect =
      i.spacingA > 0 && i.spacingB > 0
        ? Math.max(i.spacingA / i.spacingB, i.spacingB / i.spacingA)
        : Infinity;
    // Cells drawn per side (lines − 1) — a strong-perspective collapse yields a tiny
    // 2×2, which this floors out.
    const naCells = lastResult.familyA.length - 1;
    const nbCells = lastResult.familyB.length - 1;
    gridReliable =
      i.detectedA >= 2 &&
      i.detectedB >= 2 &&
      naCells >= MIN_GRID_CELLS &&
      nbCells >= MIN_GRID_CELLS &&
      !i.degenerate &&
      aspect <= MAX_CELL_ASPECT;
  }
  gridMap = null;
  if (gridReliable && lastResult) {
    gridMap = makeGridMap(lastResult.familyA, lastResult.familyB);
    gridDims = { na: lastResult.familyA.length, nb: lastResult.familyB.length };
  }
}

// Result-mode chrome: there is NO automatic fallback panel. The FAB (place tokens)
// only makes sense when a grid was found; the edit button + retake are always
// available so the user can create/replace the grid or reshoot at will.
function updateResultChrome() {
  editChooser.hidden = true; // only opened explicitly by the edit button
  if (showingResult && !manualActive) {
    fabWrap.hidden = !gridReliable;
    if (!gridReliable) {
      hud.hidden = true;
      infoOpen = true; // auto-reveal "no grid — use ✎ or ↺"
    }
  }
  updateEditGridButton();
  updateInfo();
  rebuildDebugBar();
}

// --- Manual grid editor -----------------------------------------------
// When auto-detection is unreliable the user can place a grid by hand: a quad
// (4 draggable corners) over the photo, tiled into `manualNa × manualNb` cells.
// The quad → unit-square homography gives projective (perspective-correct) cell
// nodes, from which we build the same familyA/familyB Line2[] the detector would,
// so drawing + all tactical tools work unchanged.
type ImgPt = { x: number; y: number };
let manualQuad: ImgPt[] | null = null; // [TL, TR, BR, BL] in image coordinates
let manualNa = 10; // cells along the top/bottom edge (columns)
let manualNb = 10; // cells along the left/right edge (rows)
let manualDragLast: ImgPt | null = null;
let manualCollapsed = false; // the editor bar can collapse to free the corners under it
// "Draw by hand" mode: the user TRACES reference lines along columns and rows, and
// the grid is generated from them (buildGrid: family split + fit + extend to frame).
let manualDrawPending = false;
let manualStrokes: [ImgPt, ImgPt][] = []; // traced reference lines (image coords)
let strokeStart: ImgPt | null = null; // in-progress stroke endpoints
let strokeEnd: ImgPt | null = null;
const DRAW_SENTINEL = 5; // manualDrag value while tracing a line
const PINCH_SENTINEL = 6; // manualDrag value while pinch-resizing the grid
const ENDPOINT_SENTINEL = 7; // manualDrag value while dragging a traced-line endpoint
let drawEndpointDrag: { s: number; e: 0 | 1 } | null = null; // which stroke endpoint
// Live pointer positions (image coords) during manual editing, for pinch.
const manualPointerPos = new Map<number, ImgPt>();
let pinchState: { startDist: number; startQuad: ImgPt[]; center: ImgPt } | null = null;

/** Client → image-pixel coordinates (accounts for CSS sizing + the zoom transform,
 * since the canvas backing store is in image pixels). */
function pointerToImage(clientX: number, clientY: number): ImgPt | null {
  const rect = view.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * view.width,
    y: ((clientY - rect.top) / rect.height) * view.height,
  };
}

/** Line2 (normal form) through two image points. */
function lineThrough(p1: ImgPt, p2: ImgPt): Line2 {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return { nx, ny, d: nx * p1.x + ny * p1.y };
}

/** Build the two line families from the current quad + cell counts. */
function manualToFamilies(): { A: Line2[]; B: Line2[] } | null {
  if (!manualQuad) return null;
  const [TL, TR, BR, BL] = manualQuad;
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
function applyManual() {
  const fam = manualToFamilies();
  if (!fam || !lastResult) return;
  lastResult.familyA = fam.A;
  lastResult.familyB = fam.B;
  gridMap = makeGridMap(fam.A, fam.B);
  gridDims = { na: fam.A.length, nb: fam.B.length };
  gridReliable = true;
  draw();
}

/**
 * Commit the manual grid, EXTENDING the lattice past the drawn quad to fill the
 * whole frame (like the detector's extend:'frame'): continue the same projective
 * lattice outward from each edge while the line still crosses the image, capped and
 * with a crowding guard. Cells beyond the drawn quad are flagged extended (drawn
 * faint). Returns false if there's no valid quad to commit.
 */
function commitManualGrid(): boolean {
  if (!manualQuad || !lastResult) return false;
  const [TL, TR, BR, BL] = manualQuad;
  const H = solveHomography(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[TL.x, TL.y], [TR.x, TR.y], [BR.x, BR.y], [BL.x, BL.y]],
  );
  if (!H) return false;
  const W = lastResult.width;
  const Ht = lastResult.height;
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
  lastResult.familyA = A;
  lastResult.familyB = B;
  gridMap = makeGridMap(A, B);
  gridDims = { na: A.length, nb: B.length };
  gridReliable = true;
  return true;
}

/** Radius (image px) within which a tap grabs a corner handle. */
function manualHandleRadius(): number {
  const W = lastResult?.width ?? view.width;
  const H = lastResult?.height ?? view.height;
  return Math.max(W, H) * 0.045;
}

function pointInQuad(p: ImgPt, q: ImgPt[]): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i];
    const b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

function showManualBar(show: boolean) {
  manualBar.hidden = !show;
  manualBar.classList.toggle('collapsed', manualCollapsed);
}
function updateManualBar() {
  colsInput.value = String(manualNa);
  rowsInput.value = String(manualNb);
}

/** Seed the editable quad + counts from the CURRENT grid (its outer lines), so the
 * user edits the existing grid rather than a fresh default. Returns false if there's
 * no usable grid to seed from. */
function seedQuadFromCurrentGrid(): boolean {
  if (!lastResult) return false;
  const A = lastResult.familyA;
  const B = lastResult.familyB;
  if (A.length < 2 || B.length < 2) return false;
  const c00 = intersect(A[0], B[0]);
  const c10 = intersect(A[A.length - 1], B[0]);
  const c11 = intersect(A[A.length - 1], B[B.length - 1]);
  const c01 = intersect(A[0], B[B.length - 1]);
  if (!c00 || !c10 || !c11 || !c01) return false;
  manualQuad = [
    { x: c00.x, y: c00.y },
    { x: c10.x, y: c10.y },
    { x: c11.x, y: c11.y },
    { x: c01.x, y: c01.y },
  ];
  manualNa = Math.max(1, A.length - 1);
  manualNb = Math.max(1, B.length - 1);
  return true;
}

function manualDefaultQuad() {
  if (!lastResult) return;
  const W = lastResult.width;
  const H = lastResult.height;
  // A centred SQUARE 10×10 grid (square cells) — a clean, predictable starting point
  // the user then drags to fit. (Adapting to a photo's aspect gave odd default counts.)
  const side = Math.min(W, H) * 0.76;
  const x0 = (W - side) / 2;
  const y0 = (H - side) / 2;
  manualQuad = [
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
function applyManualBarMode() {
  manualBar.classList.toggle('draw-mode', manualDrawPending);
  manualCollapse.hidden = manualDrawPending;
}

function enterManualMode(mode: 'adapt' | 'draw' = 'adapt') {
  if (!lastCapture || !lastResult) return;
  manualActive = true;
  editChooser.hidden = true;
  fabWrap.hidden = true;
  hud.hidden = true;
  btnEditGrid.hidden = true;
  manualCollapsed = false;
  manualDrawPending = mode === 'draw';
  manualStrokes = [];
  strokeStart = null;
  strokeEnd = null;
  drawEndpointDrag = null;
  manualPointerPos.clear();
  pinchState = null;
  infoOpen = true; // reveal the editing instructions right away
  applyManualBarMode();
  showManualBar(true);
  rebuildDebugBar(); // hide the debug step bar while editing a manual grid
  if (manualDrawPending) {
    // No grid yet — wait for the user to trace lines. Show the photo alone.
    manualQuad = null;
    gridReliable = false;
    gridMap = null;
    updateManualBar();
    draw();
  } else {
    // Start from the current grid when it's usable, else a default quad — so a
    // well-detected grid is only tweaked, but a bad/absent one starts from scratch.
    if (!gridReliable || !seedQuadFromCurrentGrid()) manualDefaultQuad();
    updateManualBar(); // sync the counters AFTER na/nb are set (was showing stale values)
    applyManual();
  }
  updateInfo();
}

/** A traced stroke → a RawLine (rho, thetaDeg) in image coords for buildGrid. */
function strokeToRaw(p1: ImgPt, p2: ImgPt): RawLine {
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
function regenerateFromStrokes() {
  if (!lastResult) return;
  if (manualStrokes.length < 2) {
    gridReliable = false;
    gridMap = null;
    draw();
    return;
  }
  const raw = manualStrokes.map(([a, b]) => strokeToRaw(a, b));
  const res = buildGrid(raw, 1, lastResult.width, lastResult.height, {
    ...DEFAULT_PARAMS,
    extend: 'frame',
  });
  if (res.familyA.length >= 2 && res.familyB.length >= 2) {
    lastResult.familyA = res.familyA;
    lastResult.familyB = res.familyB;
    gridMap = makeGridMap(res.familyA, res.familyB);
    gridReliable = !!gridMap;
    gridDims = { na: res.familyA.length, nb: res.familyB.length };
  } else {
    gridReliable = false;
    gridMap = null;
  }
  draw();
}

/** Leave manual editing. keep=true commits the grid; false discards it (back to the
 * fallback panel). */
function exitManualMode(keep: boolean) {
  if (keep) {
    if (manualDrawPending) {
      // Draw mode: keep the grid generated from the traced lines (already extended).
      if (!gridReliable || !gridMap) keep = false;
    } else if (!manualQuad || !gridMap) {
      keep = false; // nothing to commit
    }
  }
  const wasDraw = manualDrawPending;
  manualActive = false;
  manualDrag = null;
  manualDragLast = null;
  manualDrawPending = false;
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
  } else {
    // Cancel → restore the auto-detected grid (don't throw it away just because the
    // user opened the editor and changed their mind).
    manualQuad = null;
    applyDetectedGrid();
    deselectCell();
  }
  draw();
  updateResultChrome();
}

/** Show the top-bar "edit grid" button whenever a result is on screen and we're not
 * already editing (so any grid can be adjusted by hand at any time). */
function updateEditGridButton() {
  btnEditGrid.hidden = !(showingResult && !manualActive);
}

// Pointer gestures while editing a manual grid (routed from the map handlers).
function manualPointerDown(e: PointerEvent) {
  const p = pointerToImage(e.clientX, e.clientY);
  if (!p) return;
  manualPointerPos.set(e.pointerId, p);
  activePointers.add(e.pointerId);

  // Two fingers on an adjustable quad → pinch-resize the grid about its centre.
  if (manualPointerPos.size === 2 && !manualDrawPending && manualQuad) {
    const [a, b] = [...manualPointerPos.values()];
    const cx = (manualQuad[0].x + manualQuad[1].x + manualQuad[2].x + manualQuad[3].x) / 4;
    const cy = (manualQuad[0].y + manualQuad[1].y + manualQuad[2].y + manualQuad[3].y) / 4;
    pinchState = {
      startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startQuad: manualQuad.map((c) => ({ ...c })),
      center: { x: cx, y: cy },
    };
    manualDrag = PINCH_SENTINEL;
    return;
  }
  if (manualPointerPos.size !== 1) {
    manualDrag = null; // a 3rd finger / can't-pinch state → cancel the current drag
    return;
  }

  if (manualDrawPending) {
    // Hit an existing stroke's delete badge or endpoint first; else start a new line.
    const hr = manualStrokeHandleRadius() * 0.6;
    for (let si = manualStrokes.length - 1; si >= 0; si--) {
      const [a, b] = manualStrokes[si];
      if (Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2) <= hr) {
        manualStrokes.splice(si, 1); // delete badge (midpoint)
        manualDrag = null;
        regenerateFromStrokes();
        return;
      }
      if (Math.hypot(p.x - a.x, p.y - a.y) <= hr) {
        drawEndpointDrag = { s: si, e: 0 };
        manualDrag = ENDPOINT_SENTINEL;
        capturePointer(e.pointerId);
        return;
      }
      if (Math.hypot(p.x - b.x, p.y - b.y) <= hr) {
        drawEndpointDrag = { s: si, e: 1 };
        manualDrag = ENDPOINT_SENTINEL;
        capturePointer(e.pointerId);
        return;
      }
    }
    strokeStart = p;
    strokeEnd = p;
    manualDrag = DRAW_SENTINEL;
    capturePointer(e.pointerId);
    return;
  }
  if (!manualQuad) return;
  const r = manualHandleRadius();
  let hit = -1;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(manualQuad[i].x - p.x, manualQuad[i].y - p.y) <= r) {
      hit = i;
      break;
    }
  }
  if (hit < 0 && pointInQuad(p, manualQuad)) hit = 4; // inside → translate the whole grid
  if (hit < 0) return;
  manualDrag = hit;
  manualDragLast = p;
  capturePointer(e.pointerId);
}
function manualPointerMove(e: PointerEvent) {
  const p = pointerToImage(e.clientX, e.clientY);
  if (!p) return;
  if (manualPointerPos.has(e.pointerId)) manualPointerPos.set(e.pointerId, p);

  if (manualDrag === PINCH_SENTINEL) {
    if (!pinchState) return;
    const pts = [...manualPointerPos.values()];
    if (pts.length < 2) return;
    e.preventDefault();
    const s = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) / pinchState.startDist;
    const ctr = pinchState.center;
    manualQuad = pinchState.startQuad.map((c) => ({
      x: ctr.x + (c.x - ctr.x) * s,
      y: ctr.y + (c.y - ctr.y) * s,
    }));
    applyManual();
    return;
  }
  if (manualDrag === ENDPOINT_SENTINEL) {
    if (!drawEndpointDrag) return;
    e.preventDefault();
    manualStrokes[drawEndpointDrag.s][drawEndpointDrag.e] = p;
    regenerateFromStrokes();
    return;
  }
  if (manualDrag === DRAW_SENTINEL) {
    e.preventDefault();
    strokeEnd = p;
    draw();
    return;
  }
  if (manualDrag === null || !manualQuad || !manualDragLast) return;
  e.preventDefault();
  if (manualDrag < 4) {
    manualQuad[manualDrag] = p;
  } else {
    const dx = p.x - manualDragLast.x;
    const dy = p.y - manualDragLast.y;
    for (const c of manualQuad) {
      c.x += dx;
      c.y += dy;
    }
  }
  manualDragLast = p;
  applyManual();
}
function manualPointerUp(e: PointerEvent) {
  manualPointerPos.delete(e.pointerId);
  activePointers.delete(e.pointerId);
  if (manualDrag === PINCH_SENTINEL) {
    if (manualPointerPos.size < 2) {
      pinchState = null;
      manualDrag = null;
    }
    return;
  }
  if (manualDrag === ENDPOINT_SENTINEL) {
    manualDrag = null;
    drawEndpointDrag = null;
    return;
  }
  if (manualDrag === DRAW_SENTINEL) {
    manualDrag = null;
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
  manualDrag = null;
  manualDragLast = null;
}

/** Radius (image px) for a traced-line endpoint / delete handle hit-test + draw. */
function manualStrokeHandleRadius(): number {
  const W = lastResult?.width ?? view.width;
  const H = lastResult?.height ?? view.height;
  return Math.max(W, H) * 0.028;
}

/** Draw the traced reference lines + their endpoint/delete handles + the in-progress
 * stroke (draw mode). */
function drawStrokes(ctx: CanvasRenderingContext2D) {
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
let loupeSrc: HTMLCanvasElement | null = null;

/** Capture the clean magnified source around `c` and return the loupe placement. */
function captureLoupe(c: ImgPt): { cx: number; cy: number; R: number } {
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
function drawLoupe(ctx: CanvasRenderingContext2D, p: { cx: number; cy: number; R: number }) {
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
function loupePoint(): ImgPt | null {
  if (manualDrawPending) {
    if (manualDrag === ENDPOINT_SENTINEL && drawEndpointDrag) {
      return manualStrokes[drawEndpointDrag.s][drawEndpointDrag.e];
    }
    return null;
  }
  if (manualDrag !== null && manualDrag >= 0 && manualDrag <= 3 && manualQuad) {
    return manualQuad[manualDrag];
  }
  return null;
}

/** Draw the 4 corner handles over the manual grid. */
function drawManualHandles(ctx: CanvasRenderingContext2D) {
  if (!manualQuad) return;
  const r = manualHandleRadius() * 0.5;
  ctx.save();
  for (const c of manualQuad) {
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

function reportStatus(dt: number) {
  if (!lastResult) return;
  const i = lastResult.info;
  const total = i.aCount + i.bCount;
  if (i.rawCount === 0) {
    setStatus('Nessuna linea rilevata — riprova con più contrasto/luce');
    return;
  }
  if (total === 0) {
    setStatus(`${i.rawCount} linee grezze ma nessuna griglia — inquadra più da vicino`);
    return;
  }
  const base = `Griglia ${i.detectedA}×${i.detectedB} · conf ${(i.confidence * 100).toFixed(0)}% · ${i.angleADeg.toFixed(0)}°/${i.angleBDeg.toFixed(0)}° · ${dt}ms`;
  // On success the top-right shows the action buttons instead of a status line;
  // only surface the (verbose) grid info while debugging.
  setStatus(debug ? `${base} · grezze ${i.rawCount} · Hough ${i.usedHough} · edge ${i.edgePixels}` : '');
}

// --- Drawing (photo + overlay on one canvas => perfect alignment) ------
let edgeCanvas: HTMLCanvasElement | null = null;
let debugStepCanvas: HTMLCanvasElement | null = null;

/** True when a pipeline-stage preview (not the final overlay) is selected. Never while
 * editing a manual grid (that view needs the photo + quad). */
function debugStepActive(): boolean {
  const steps = lastResult?.debugSteps;
  return debug && !manualActive && !!steps && debugStepIdx < steps.length;
}

/** Blit the selected pipeline-stage preview onto the view canvas (scaled up from the
 * downscaled snapshot), with the stage name labelled top-left. */
function drawDebugStep() {
  const r = lastResult!;
  const step = r.debugSteps![debugStepIdx];
  view.width = r.width;
  view.height = r.height;
  const ctx = view.getContext('2d')!;
  if (!debugStepCanvas) debugStepCanvas = document.createElement('canvas');
  debugStepCanvas.width = step.image.width;
  debugStepCanvas.height = step.image.height;
  debugStepCanvas.getContext('2d')!.putImageData(step.image, 0, 0);
  ctx.imageSmoothingEnabled = false; // show the pipeline pixels, not a blurred upscale
  ctx.drawImage(debugStepCanvas, 0, 0, r.width, r.height);
  ctx.imageSmoothingEnabled = true;
  const fs = Math.max(16, Math.round(r.width / 40));
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const label = `${debugStepIdx + 1}. ${step.label}`;
  const pad = fs * 0.5;
  ctx.fillStyle = 'rgba(10,14,19,0.72)';
  ctx.fillRect(pad, pad, ctx.measureText(label).width + pad * 2, fs + pad);
  ctx.fillStyle = '#eaf1fb';
  ctx.textBaseline = 'top';
  ctx.fillText(label, pad * 2, pad * 1.5);
}

/** Build the debug step chips from lastResult.debugSteps (+ a final "Overlay" chip).
 * Hidden unless debug is on, a result is shown, and we're not editing a manual grid. */
function rebuildDebugBar() {
  const steps = lastResult?.debugSteps ?? [];
  const show = debug && showingResult && !manualActive && steps.length > 0;
  debugBar.hidden = !show;
  if (!show) return;
  const overlayIdx = steps.length; // the final live line overlay
  if (debugStepIdx > overlayIdx) debugStepIdx = overlayIdx;
  debugBar.textContent = '';
  const mk = (idx: number, name: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'debug-chip' + (idx === debugStepIdx ? ' on' : '');
    b.innerHTML = `<span class="n">${String(idx + 1).padStart(2, '0')}</span>${name}`;
    b.addEventListener('click', () => {
      debugStepIdx = idx;
      for (const c of Array.from(debugBar.children)) c.classList.remove('on');
      b.classList.add('on');
      draw();
    });
    return b;
  };
  steps.forEach((s, i) => debugBar.appendChild(mk(i, s.label)));
  debugBar.appendChild(mk(overlayIdx, 'Overlay')); // the live line overlay (default)
}

function draw() {
  if (!lastResult || !lastCapture) return;
  const r = lastResult;
  // Debug: a pipeline-stage preview replaces the photo+overlay entirely.
  if (debugStepActive()) {
    drawDebugStep();
    return;
  }
  view.width = r.width;
  view.height = r.height;
  const ctx = view.getContext('2d')!;

  ctx.drawImage(lastCapture, 0, 0, r.width, r.height);

  if (debug) {
    if (r.edges) {
      if (!edgeCanvas) edgeCanvas = document.createElement('canvas');
      edgeCanvas.width = r.edges.width;
      edgeCanvas.height = r.edges.height;
      edgeCanvas.getContext('2d')!.putImageData(r.edges, 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(edgeCanvas, 0, 0, r.width, r.height);
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
  const showManualGrid = manualActive && !manualDrawPending && !!manualQuad;
  if (gridReliable || showManualGrid) {
    drawFamily(ctx, r.familyA, r.familyB, r.width, r.height, gridColor, lw);
    drawFamily(ctx, r.familyB, r.familyA, r.width, r.height, gridColor, lw);
  }

  if (manualActive) {
    // Capture the clean loupe source (photo+grid) BEFORE drawing handles/strokes, so
    // the magnifier can be drawn LAST — on top of every other handle.
    const lp = loupePoint();
    const place = lp ? captureLoupe(lp) : null;
    if (manualDrawPending) drawStrokes(ctx);
    else drawManualHandles(ctx);
    if (place) drawLoupe(ctx, place);
    return; // no tactical layer while editing the grid
  }

  // Tactical layer: overlay → path preview → threat/counters → flanking → tokens
  // → blocked squares → selection + ring.
  if (gridMap) {
    if (activeOverlay) drawOverlay(ctx, activeOverlay, lw);
    drawPaths(ctx, lw);
    drawThreat(ctx, lw);
    drawFlanking(ctx, lw);
    drawTokens(ctx, lw);
    drawBlockedX(ctx, lw);
    if (selectedCell) {
      drawSelection(ctx, lw);
      drawAngleRing(ctx, lw);
    }
  }
}

// --- Board tokens (allies / enemies) + threat ------------------------
function tokenBlock(t: Token): { bi: number; bj: number; w: number } {
  const w = Math.max(1, t.w);
  const bi = Math.max(0, Math.min(t.i, gridDims.na - 1 - w));
  const bj = Math.max(0, Math.min(t.j, gridDims.nb - 1 - w));
  return { bi, bj, w };
}
function tokenCovers(t: Token, i: number, j: number): boolean {
  const { bi, bj, w } = tokenBlock(t);
  return i >= bi && i < bi + w && j >= bj && j < bj + w;
}

/** Movement obstacles for a piece of `group`: you may pass through (but not stop
 * on) squares of your OWN side, and you cannot pass through the OPPOSITE side. */
function tokenObstaclesFor(group: 'ally' | 'enemy'): { impassable: Set<string>; occupied: Set<string> } {
  const impassable = new Set<string>();
  const occupied = new Set<string>();
  for (const t of tokens) {
    const { bi, bj, w } = tokenBlock(t);
    for (let i = bi; i < bi + w; i++)
      for (let j = bj; j < bj + w; j++) {
        const k = `${i},${j}`;
        if (t.kind === group) occupied.add(k); // same side: pass, don't stop
        else impassable.add(k); // opposite side: blocks the path
      }
  }
  return { impassable, occupied };
}
/** The moving piece's side for the active movement (defaults to ally). */
function moveGroup(): 'ally' | 'enemy' {
  return activeOverlay?.kind === 'move' ? activeOverlay.group ?? 'ally' : 'ally';
}

/** Per-cell threat counts by side (how many enemy / ally reaches cover a cell). */
function threatCountMaps(): { enemy: Map<string, number>; ally: Map<string, number> } {
  const enemy = new Map<string, number>();
  const ally = new Map<string, number>();
  const { na, nb } = gridDims;
  for (const t of tokens) {
    const { bi, bj, w } = tokenBlock(t);
    const m = t.kind === 'enemy' ? enemy : ally;
    for (const [i, j] of threatCells(bi, bj, w, na, nb)) {
      const k = `${i},${j}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return { enemy, ally };
}

// Which sides' threat to draw. Threat reach is shown ONLY during movement, and it
// shows BOTH groups' reach (not just the opposite side) so you can read the whole
// board's threat while planning a move.
function threatSidesToShow(): Array<'ally' | 'enemy'> {
  if (activeOverlay?.kind === 'move') return ['ally', 'enemy'];
  return [];
}

const ENEMY_COL = '#ff2d2d';
const ALLY_COL = '#22e06a';

// Reach of the shown tokens, bordered per cell. A cell threatened by only one
// side gets that side's solid border; a cell CONTESTED by both sides gets an
// alternating red/green dashed border. Drawn over the overlay so it stays visible
// during movement.
function drawThreat(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap) return;
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

function drawThreatCounts(ctx: CanvasRenderingContext2D, lw: number, sides: Array<'ally' | 'enemy'>) {
  if (!gridMap) return;
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
    const [x, y] = gridMap.toImage(i + 0.5, j + 0.5);
    if (showEn) badge(ctx, String(en), x - fs * 0.55, y - fs * 0.5, fs, '#ef4444');
    if (showAl) badge(ctx, String(al), x + fs * 0.55, y - fs * 0.5, fs, '#22c55e');
  }
  ctx.restore();
}
function badge(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fs: number, color: string) {
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
// Cap the preview (and its colouring) at 3 movements.
const MAX_PATH_MOVES = 5;

// One threat-area (set of cells) per creature of the group OPPOSITE the mover —
// so the path preview can count DISTINCT creatures met, not cells.
function oppThreatAreas(group: 'ally' | 'enemy'): Array<Set<string>> {
  const opp = group === 'ally' ? 'enemy' : 'ally';
  const { na, nb } = gridDims;
  const areas: Array<Set<string>> = [];
  for (const t of tokens) {
    if (t.kind !== opp) continue;
    const { bi, bj, w } = tokenBlock(t);
    const cells = threatCells(bi, bj, w, na, nb);
    if (cells.length) areas.push(new Set(cells.map(([i, j]) => `${i},${j}`)));
  }
  return areas;
}

// Select an arrival cell → show the (movements ↔ threats) Pareto set of routes to
// it: the FASTEST route first (drawn boldest — "il più visibile"), then each route
// that spends +1 movement to be threatened by FEWER creatures, down to 0 or the
// cap. Threats are counted PER DISTINCT CREATURE (including the start square). Each
// route is a line coloured by its movement band, with a badge = creatures met.
function drawPaths(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap || activeOverlay?.kind !== 'move' || !moveTarget) return;
  const ov = activeOverlay;
  const { na, nb } = gridDims;
  const group = moveGroup();
  const obs = tokenObstaclesFor(group);
  const cappedMv = { ...ov, moves: Math.min(ov.moves, MAX_PATH_MOVES) };

  const routes = movePareto(cappedMv, na, nb, moveTarget, MAX_PATH_MOVES, oppThreatAreas(group), obs);

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
    const [x, y] = gridMap.toImage(best[0] + 0.5, best[1] + 0.5);
    badge(ctx, String(r.threats), x, y, fs, ringColor(r.move));
  }
  ctx.restore();
  drawArrival(ctx, lw);
}

// A route as a polyline through the cell centres, with a dark backing so it reads
// on any map colour.
function drawRouteLine(
  ctx: CanvasRenderingContext2D,
  cells: [number, number][],
  color: string,
  width: number,
  lw: number,
) {
  if (!gridMap || cells.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    cells.forEach(([i, j], k) => {
      const [x, y] = gridMap!.toImage(i + 0.5, j + 0.5);
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
function drawArrival(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap || !moveTarget) return;
  const [ti, tj] = moveTarget;
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
  const [cx, cy] = gridMap.toImage(ti + 0.5, tj + 0.5);
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
function drawBlockedX(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap || activeOverlay?.kind !== 'move') return;
  const { impassable } = tokenObstaclesFor(moveGroup());
  const line = (a: [number, number], b: [number, number]) => {
    const p = gridMap!.toImage(a[0], a[1]);
    const q = gridMap!.toImage(b[0], b[1]);
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

// --- Flanking (Fase D) -----------------------------------------------
function tokenCenter(t: Token): [number, number] {
  const { bi, bj, w } = tokenBlock(t);
  return [bi + w / 2, bj + w / 2];
}
function threatensToken(att: Token, tgt: Token): boolean {
  const a = tokenBlock(att);
  const reach = new Set(
    threatCells(a.bi, a.bj, a.w, gridDims.na, gridDims.nb).map(([i, j]) => `${i},${j}`),
  );
  const b = tokenBlock(tgt);
  for (let i = b.bi; i < b.bi + b.w; i++)
    for (let j = b.bj; j < b.bj + b.w; j++) if (reach.has(`${i},${j}`)) return true;
  return false;
}
/** Does segment (ax,ay)-(bx,by) cross the rectangle [x0,x1]×[y0,y1]? (Liang-Barsky) */
function segCrossesRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay) && t0 <= t1;
}
/** Enemies flanked: two allies that both threaten it and whose centre-to-centre
 * line crosses opposite sides/corners of its space (PF2e flanking). */
function flankedEnemies(): Token[] {
  const allies = tokens.filter((t) => t.kind === 'ally');
  const out: Token[] = [];
  for (const e of tokens) {
    if (e.kind !== 'enemy') continue;
    const { bi, bj, w } = tokenBlock(e);
    const thr = allies.filter((a) => threatensToken(a, e));
    let flanked = false;
    for (let x = 0; x < thr.length && !flanked; x++)
      for (let y = x + 1; y < thr.length && !flanked; y++) {
        const [ax, ay] = tokenCenter(thr[x]);
        const [cx, cy] = tokenCenter(thr[y]);
        if (segCrossesRect(ax, ay, cx, cy, bi, bj, bi + w, bj + w)) flanked = true;
      }
    if (flanked) out.push(e);
  }
  return out;
}
function drawFlanking(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap) return;
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
    const [x, y] = gridMap.toImage(bi + w / 2, bj);
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

function drawTokens(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap) return;
  for (const t of tokens) {
    const { bi, bj, w } = tokenBlock(t);
    const c0 = gridMap.toImage(bi, bj);
    const c1 = gridMap.toImage(bi + w, bj);
    const c2 = gridMap.toImage(bi + w, bj + w);
    const c3 = gridMap.toImage(bi, bj + w);
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

// --- Angle ring (rotate line/cone on the map instead of a slider) ------
function ringActive(): boolean {
  return (
    !!gridMap &&
    !!selectedCell &&
    activeOverlay?.kind === 'area' &&
    (currentAreaType === 'linea' || currentAreaType === 'cono')
  );
}
function ringOriginGrid(): [number, number] | null {
  if (!selectedCell) return null;
  // Cones rotate around the chosen INTERSECTION (a fixed corner) — the ring
  // centres there and stays put while turning. Lines rotate around the selected
  // cell's centre. Either way the centre is fixed during a drag.
  if (currentAreaType === 'cono') {
    const c = activeOverlay?.kind === 'area' ? activeOverlay.corner : selectedNode;
    return [c[0], c[1]];
  }
  return [selectedCell[0] + 0.5, selectedCell[1] + 0.5];
}
// Distance (in cells) from the origin to the rotation handle: the shape's tip —
// the far end of a line, the front of a cone.
function ringReachCells(): number {
  return Math.max(1, currentSizeCells());
}
// Grid position of the rotation handle at the current effective angle (null if
// there is nothing to rotate).
function ringHandleGrid(): [number, number] | null {
  const o = ringOriginGrid();
  if (!o) return null;
  const d = gridDir(effectiveAngle());
  const R = ringReachCells();
  return [o[0] + d[0] * R, o[1] + d[1] * R];
}

// Rotation handle drawn on the shape's TIP (line end / cone front). Drawn in
// GRID space so it follows the map's perspective. Only this handle rotates the
// shape — tapping elsewhere never turns it. Faint ticks mark the allowed
// orientations (the tip snaps to these) so you can rotate roughly and let it snap.
function drawAngleRing(ctx: CanvasRenderingContext2D, lw: number) {
  if (!gridMap || !ringActive()) return;
  const o = ringOriginGrid();
  const h = ringHandleGrid();
  if (!o || !h) return;
  const R = ringReachCells();
  const toImg = (a: number, b: number) => gridMap!.toImage(a, b);
  ctx.save();
  // Ticks at the allowed orientations, on the tip's arc.
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
function gridPath(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>) {
  if (!gridMap || pts.length === 0) return;
  ctx.beginPath();
  const [x0, y0] = gridMap.toImage(pts[0][0], pts[0][1]);
  ctx.moveTo(x0, y0);
  for (let k = 1; k < pts.length; k++) {
    const [x, y] = gridMap.toImage(pts[k][0], pts[k][1]);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Highlight the selection. Burst/cone show only the intersection dot (drawn with
// the overlay); emanation / movement cover the whole creature block; otherwise
// just the tapped cell.
function drawSelection(ctx: CanvasRenderingContext2D, lw: number) {
  if (!selectedCell) return;
  if (activeOverlay?.kind === 'area' && (activeOverlay.type === 'esplosione' || activeOverlay.type === 'cono')) {
    return; // the intersection dot is enough
  }
  let bi: number;
  let bj: number;
  let w: number;
  const piece = selectedPiece();
  if (piece && !activeOverlay) {
    // A selected piece → highlight its WHOLE area.
    ({ bi, bj, w } = tokenBlock(piece));
  } else {
    const [si, sj] = selectedCell;
    w = 1;
    if (activeOverlay?.kind === 'move') w = activeOverlay.creatureCells;
    else if (activeOverlay?.kind === 'area' && activeOverlay.type === 'emanazione')
      w = activeOverlay.creatureCells;
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
function drawOverlay(ctx: CanvasRenderingContext2D, ov: Overlay, lw: number) {
  if (!gridMap) return;
  const { na, nb } = gridDims;
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
    const [x, y] = gridMap.toImage(ov.corner[0], ov.corner[1]);
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

function fillCells(
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

function drawFamily(
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

function drawLine(ctx: CanvasRenderingContext2D, l: Line2, W: number, H: number) {
  const seg = clipLineToRect(l, W, H);
  if (!seg) return;
  ctx.beginPath();
  ctx.moveTo(seg[0][0], seg[0][1]);
  ctx.lineTo(seg[1][0], seg[1][1]);
  ctx.stroke();
}

// --- Tactical tools (select a cell → add area / see movement) ----------
// One overlay is "active" at a time and stays editable: its position (tap
// another cell), size and angle can be changed live while its form is open.
function deselectCell() {
  selectedCell = null;
  activeOverlay = null;
  moveTarget = null;
  refreshHud();
  updateFabIcon();
  draw(); // clear any overlay/threat visuals IMMEDIATELY (e.g. leaving movement)
}

/** Map a client point to grid coordinates (accounts for the zoom transform via
 * the canvas's rendered rect). */
function pointerToGrid(clientX: number, clientY: number): [number, number] | null {
  if (!gridMap) return null;
  const rect = view.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const px = ((clientX - rect.left) / rect.width) * view.width;
  const py = ((clientY - rect.top) / rect.height) * view.height;
  return gridMap.toGrid(px, py);
}

// Reposition the active selection/overlay to the tapped point. Used only while
// DRAGGING an area's origin handle, so it must NOT expand the HUD (moving an area
// must never reopen the menu).
function selectCellAt(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return;
  const [a, b] = g;
  const i = Math.floor(a);
  const j = Math.floor(b);
  if (i < 0 || j < 0 || i >= gridDims.na - 1 || j >= gridDims.nb - 1) return; // off-grid

  selectedCell = [i, j];
  selectedNode = [Math.round(a), Math.round(b)]; // nearest intersection
  // If an overlay is active, moving the selection MOVES it (cell + intersection).
  if (activeOverlay) {
    activeOverlay.cell = [i, j];
    if (activeOverlay.kind === 'area') activeOverlay.corner = [selectedNode[0], selectedNode[1]];
  }
  draw();
}

/** The cells that count as the selection's "origin handle": dragging from one of
 * them moves the selection (drag-to-reposition), a tap on one deselects it. */
function originCellSet(): Set<string> {
  const s = new Set<string>();
  if (!selectedCell) return s;
  const [ci, cj] = selectedCell;
  if (activeOverlay?.kind === 'area' && (activeOverlay.type === 'esplosione' || activeOverlay.type === 'cono')) {
    const [ni, nj] = selectedNode; // the four cells that touch the chosen intersection
    for (const [di, dj] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) s.add(`${ni + di},${nj + dj}`);
  } else {
    let w = 1;
    if (activeOverlay?.kind === 'move') w = Math.max(1, activeOverlay.creatureCells);
    else if (activeOverlay?.kind === 'area' && activeOverlay.type === 'emanazione')
      w = Math.max(1, activeOverlay.creatureCells);
    const [bi, bj] = creatureBlock(ci, cj, w);
    for (let i = bi; i < bi + w; i++) for (let j = bj; j < bj + w; j++) s.add(`${i},${j}`);
    s.add(`${ci},${cj}`);
  }
  return s;
}
function originHit(clientX: number, clientY: number): boolean {
  if (!selectedCell || !activeOverlay) return false; // only an active overlay repositions by drag
  if (activeOverlay.kind === 'move') return false; // movement starts from a fixed piece — no drag
  const g = pointerToGrid(clientX, clientY);
  if (!g) return false;
  return originCellSet().has(`${Math.floor(g[0])},${Math.floor(g[1])}`);
}

/** The token under the pointer (any token, regardless of selection), for gestures. */
function pieceUnderPointer(clientX: number, clientY: number): Token | null {
  if (placeMode !== 'none') return null;
  const c = pointerCell(clientX, clientY);
  return c ? tokenAt(c[0], c[1]) : null;
}
/** Drag a piece so its block follows the pointer (won't stack on another piece). */
function movePieceTo(t: Token, clientX: number, clientY: number) {
  const c = pointerCell(clientX, clientY);
  if (!c) return;
  if (tokens.some((o) => o !== t && tokenCovers(o, c[0], c[1]))) return;
  t.i = c[0];
  t.j = c[1];
  // Keep whatever we were doing with the piece: if its MOVEMENT was showing, keep
  // showing it (from the new spot) — don't pop the edit menu open. Otherwise re-anchor
  // its editor. (User: "se sposto la pedina deve rimanere il movimento".)
  if (activeOverlay?.kind === 'move') startMovementFromCell(c[0], c[1]);
  else selectPieceAt(c[0], c[1]);
  draw();
}

/** The token whose block covers cell (i,j), or null. */
function tokenAt(i: number, j: number): Token | null {
  return tokens.find((t) => tokenCovers(t, i, j)) ?? null;
}
/** The "selected cell" value that makes creatureBlock() reproduce a given block
 * top-left (the inverse of creatureBlock), so a movement's source lines up
 * exactly with the token's occupied squares. */
function blockToCell(bi: number, bj: number, w: number): [number, number] {
  if (w % 2 === 1) return [bi + (w - 1) / 2, bj + (w - 1) / 2];
  return [bi + w / 2 - 1, bj + w / 2];
}
/** Build a movement overlay for a token — movement always starts from a piece,
 * taking the piece's size and side. */
function moveOverlayFromToken(t: Token): MoveOverlay {
  const { bi, bj, w } = tokenBlock(t);
  const speedCells = Math.max(0, t.speed || 0); // the piece's own movement (in cells)
  return { kind: 'move', cell: blockToCell(bi, bj, w), speedCells, moves: MOVE_ACTIONS, creatureCells: w, group: t.kind };
}
/** Start (or switch) movement from the token on cell (i,j). Returns false if the
 * cell has no piece. */
function startMovementFromCell(i: number, j: number): boolean {
  const t = tokenAt(i, j);
  if (!t) return false;
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  selectedCell = [cell[0], cell[1]];
  selectedNode = [cell[0], cell[1]];
  moveTarget = null;
  activeOverlay = moveOverlayFromToken(t);
  showHud(); // starting a movement is an explicit action → expand the HUD
  updateFabIcon();
  draw();
  return true;
}

// --- Placement (via the FAB) + per-piece editor -----------------------
/** Enter/leave a placement mode (from the FAB). While active, tapping the map adds
 * pieces of that kind or (for 'area') drops an area; the FAB shows the active type
 * and turns into an ✕ to exit. Passing the current mode again toggles it off. */
function setPlaceMode(m: 'ally' | 'enemy' | 'area' | 'none') {
  placeMode = placeMode === m ? 'none' : m;
  fabWrap.classList.remove('open'); // a choice closes the speed-dial
  if (placeMode !== 'none') {
    deselectCell();
    infoOpen = true; // auto-reveal what to tap for this placement mode
  } else {
    setStatus('');
  }
  updateFabIcon();
  updateInfo();
}
/** The FAB shows ✕ (and its type colour) while a placement mode is active OR while
 * an area is on the map — so the same ✕ that adds an area also REMOVES it — and a
 * plain ＋ otherwise. */
function updateFabIcon() {
  const areaActive = activeOverlay?.kind === 'area';
  fab.classList.toggle('mode-ally', placeMode === 'ally');
  fab.classList.toggle('mode-enemy', placeMode === 'enemy');
  fab.classList.toggle('mode-area', placeMode === 'area' || areaActive);
  fab.textContent = placeMode !== 'none' || areaActive ? '✕' : '＋';
}
/** Drop an area at the tapped point (from FAB 'area' mode), then leave placement so
 * the area can be edited/repositioned like before. */
function placeAreaAt(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return;
  const i = Math.floor(g[0]);
  const j = Math.floor(g[1]);
  if (i < 0 || j < 0 || i >= gridDims.na - 1 || j >= gridDims.nb - 1) return;
  selectedCell = [i, j];
  selectedNode = [Math.round(g[0]), Math.round(g[1])];
  setPlaceMode('none'); // leave placement; now edit the area
  highlightAreaType(); // ensure the size select is populated for this type FIRST
  updateAreaOverlay(); // …so the area is built with a real size (not just the dot)
  showHud(); // a NEW area → expand the HUD (explicit action)
  updateFabIcon(); // FAB is now the ✕ that removes this area
}
/** In placement mode: tap an empty cell → add a piece (defaults: Taglia size,
 * speed 6) and select it for editing; tap a piece → remove it. Each new piece
 * starts from the defaults (the previous one's edits don't carry over). */
function placeOrRemoveAt(i: number, j: number) {
  const idx = tokens.findIndex((t) => tokenCovers(t, i, j));
  if (idx >= 0) {
    tokens.splice(idx, 1);
    deselectCell();
    draw();
    return;
  }
  const t: Token = {
    kind: placeMode === 'enemy' ? 'enemy' : 'ally',
    i,
    j,
    w: 1, // new pieces start "Media o inferiore" (1 cell); resize in the HUD editor
    speed: DEFAULT_PIECE_SPEED,
  };
  tokens.push(t);
  selectPieceAt(i, j); // select the just-added piece so it can be tweaked
  draw();
}

/** Select the token covering (i,j) and open its editor. */
function selectPieceAt(i: number, j: number) {
  const t = tokenAt(i, j);
  if (!t) return;
  const { bi, bj, w } = tokenBlock(t);
  const cell = blockToCell(bi, bj, w);
  selectedCell = [cell[0], cell[1]];
  selectedNode = [cell[0], cell[1]];
  activeOverlay = null;
  moveTarget = null;
  showHud(); // opening a piece editor is explicit → expand the HUD
  updateFabIcon();
}

/** The piece under the current selection, or null. */
function selectedPiece(): Token | null {
  return selectedCell ? tokenAt(selectedCell[0], selectedCell[1]) : null;
}

function creatureVal(sel: HTMLSelectElement): number {
  return Math.max(1, +sel.value || 1);
}

// Sizes come from the PF2e preset list (labelled in the chosen unit).
function cellsToUnit(cells: number, unit: Unit): number {
  if (unit === 'm') return cells * 1.5;
  if (unit === 'ft') return cells * 5;
  return cells;
}
function sizeLabel(cells: number, unit: Unit): string {
  return `${cellsToUnit(cells, unit)} ${unit}`;
}
function refreshSizeUI() {
  const opts = FIXED_SIZES[currentAreaType];
  const prev = +areaSizeSel.value;
  areaSizeSel.innerHTML = opts
    .map((s) => `<option value="${s}">${sizeLabel(s, areaUnit.value as Unit)}</option>`)
    .join('');
  if (opts.includes(prev)) areaSizeSel.value = String(prev);
}
// The piece Movement select (1..12 cells) is LABELLED in the chosen unit — "6 q",
// "9 m", "30 ft" — like the area size, so the number carries its measure.
function refreshMoveUI() {
  const prev = pieceMove.value || String(DEFAULT_PIECE_SPEED);
  pieceMove.innerHTML = Array.from({ length: 12 }, (_, k) => {
    const cells = k + 1;
    return `<option value="${cells}">${sizeLabel(cells, areaUnit.value as Unit)}</option>`;
  }).join('');
  pieceMove.value = prev;
}
function currentSizeCells(): number {
  return +areaSizeSel.value || 0;
}

/** The fixed orientations for the current area/size (empty if it has none). */
function currentFixedAngles(): number[] {
  return fixedAngles(currentAreaType, currentSizeCells());
}
/** Angle snapped to the PF2e orientations (the 8 grid directions for a cone, the
 * book slopes for a line). */
function effectiveAngle(): number {
  return snapToAngles(areaAngleDeg, currentFixedAngles());
}

function highlightAreaType() {
  for (const el of areaTypeBox.querySelectorAll('.chip')) {
    el.classList.toggle('on', (el as HTMLElement).dataset.t === currentAreaType);
  }
  // Line/cone rotate via the on-map ring (tip handle) — the rotation hint lives
  // behind the (i) button and depends on the type, so refresh it.
  areaCreature.hidden = currentAreaType !== 'emanazione'; // creature size only for emanations
  refreshSizeUI();
  updateInfo();
}

// Rebuild the active overlay from the current form values and redraw.
function updateAreaOverlay() {
  if (!selectedCell) return;
  activeOverlay = {
    kind: 'area',
    type: currentAreaType,
    cell: [selectedCell[0], selectedCell[1]],
    corner: [selectedNode[0], selectedNode[1]],
    sizeCells: currentSizeCells(),
    angleDeg: effectiveAngle(),
    creatureCells: creatureVal(areaCreature),
  };
  updateFabIcon(); // an area is now active → FAB is the ✕
  draw();
}
// True only when a pointer lands on the rotation handle (the shape's tip), so a
// drag there rotates — while a tap on any other cell never turns the shape.
function ringHit(clientX: number, clientY: number): boolean {
  if (!ringActive()) return false;
  const g = pointerToGrid(clientX, clientY);
  const h = ringHandleGrid();
  if (!g || !h) return false;
  return Math.hypot(g[0] - h[0], g[1] - h[1]) <= 1.1; // grab tolerance in cells
}
function rotateFromPointer(clientX: number, clientY: number) {
  const g = pointerToGrid(clientX, clientY);
  const o = ringOriginGrid();
  if (!g || !o) return;
  areaAngleDeg = angleOfGridDir(g[0] - o[0], g[1] - o[1]);
  if (activeOverlay?.kind === 'area') updateAreaOverlay();
  else draw();
}

// The tapped grid cell (floored), or null off-grid.
function pointerCell(clientX: number, clientY: number): [number, number] | null {
  const g = pointerToGrid(clientX, clientY);
  if (!g) return null;
  const i = Math.floor(g[0]);
  const j = Math.floor(g[1]);
  if (i < 0 || j < 0 || i >= gridDims.na - 1 || j >= gridDims.nb - 1) return null;
  return [i, j];
}
function movingTarget(): boolean {
  return activeOverlay?.kind === 'move' && !!moveTarget;
}
function targetHit(clientX: number, clientY: number): boolean {
  if (!movingTarget()) return false;
  const c = pointerCell(clientX, clientY);
  return !!c && c[0] === moveTarget![0] && c[1] === moveTarget![1];
}
function setMoveTargetAt(clientX: number, clientY: number) {
  const c = pointerCell(clientX, clientY);
  if (!c) return;
  moveTarget = c;
  draw();
}

// Pointer gestures on the map. On a PIECE (placement off): a quick TAP shows its
// movement, a LONG-PRESS opens its edit menu, a DRAG repositions it. Elsewhere: a
// tap sets the movement arrival (in move mode) or drops a piece/area (placement),
// and the angle ring / area origin / arrival cell can be dragged. Two pointers →
// pinch/pan (the zoom controller).
const activePointers = new Set<number>();
let tapStart: { x: number; y: number; t: number } | null = null;
let tapCandidate = false;
let dragMoved = false;
let gesturePiece: Token | null = null; // the piece a tap/long-press/drag acts on
let longPressFired = false;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
const LONG_PRESS_MS = 450;
const clearLongPress = () => {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};
const capturePointer = (id: number) => {
  try {
    view.setPointerCapture(id);
  } catch {
    /* not all inputs support capture */
  }
};
view.addEventListener('pointerdown', (e) => {
  if (manualActive) {
    manualPointerDown(e);
    return;
  }
  activePointers.add(e.pointerId);
  if (activePointers.size !== 1) {
    tapCandidate = false; // multi-touch → pinch, not a tap/drag
    ringRotating = false;
    dragKind = null;
    clearLongPress();
    return;
  }
  tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
  gesturePiece = null;
  longPressFired = false;
  const piece = pieceUnderPointer(e.clientX, e.clientY);
  if (placeMode !== 'none') {
    tapCandidate = true; // placement mode: every tap adds/removes
  } else if (ringHit(e.clientX, e.clientY)) {
    ringRotating = true;
    tapCandidate = false;
    capturePointer(e.pointerId);
    rotateFromPointer(e.clientX, e.clientY);
  } else if (piece) {
    // Tap → movement, long-press → edit, drag → reposition.
    gesturePiece = piece;
    dragKind = 'piece';
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (gesturePiece && !dragMoved) {
        longPressFired = true;
        dragKind = null; // no drag after the edit menu opens
        selectPieceAt(gesturePiece.i, gesturePiece.j); // open the edit menu
        draw();
      }
    }, LONG_PRESS_MS);
  } else if (originHit(e.clientX, e.clientY)) {
    dragKind = 'origin'; // drag → reposition the area; tap → deselect
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
  } else if (targetHit(e.clientX, e.clientY)) {
    dragKind = 'target'; // drag → move the arrival cell; tap → clear it
    dragMoved = false;
    tapCandidate = false;
    capturePointer(e.pointerId);
  } else {
    tapCandidate = true;
  }
});
view.addEventListener('pointermove', (e) => {
  if (manualActive) {
    manualPointerMove(e);
    return;
  }
  if (ringRotating) {
    e.preventDefault();
    rotateFromPointer(e.clientX, e.clientY);
  } else if (dragKind && tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) {
    e.preventDefault();
    clearLongPress(); // moving → it's a drag, not a long-press
    dragMoved = true;
    if (dragKind === 'piece' && gesturePiece) movePieceTo(gesturePiece, e.clientX, e.clientY);
    else if (dragKind === 'origin') selectCellAt(e.clientX, e.clientY);
    else if (dragKind === 'target') setMoveTargetAt(e.clientX, e.clientY);
  }
});
view.addEventListener('pointerup', (e) => {
  if (manualActive) {
    manualPointerUp(e);
    return;
  }
  activePointers.delete(e.pointerId);
  clearLongPress();
  if (ringRotating) {
    ringRotating = false;
  } else if (dragKind === 'piece') {
    const piece = gesturePiece;
    dragKind = null;
    gesturePiece = null;
    if (!dragMoved && piece) startMovementFromCell(piece.i, piece.j); // quick tap → movement
    // (a drag already repositioned it; a long-press already opened its editor)
  } else if (dragKind) {
    const kind = dragKind;
    dragKind = null;
    if (!dragMoved) {
      // A tap (no drag) on the area origin does NOTHING — an area is removed only
      // with the ✕, never by clicking it. A tap on the movement arrival clears it.
      if (kind === 'target') {
        moveTarget = null;
        draw();
      }
    }
  } else if (longPressFired) {
    // edit menu already opened on the long-press; nothing to do on release
  } else if (tapCandidate && tapStart) {
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    const dt = Date.now() - tapStart.t;
    if (moved <= 8 && dt <= 500) {
      const c = pointerCell(e.clientX, e.clientY);
      if (placeMode === 'ally' || placeMode === 'enemy') {
        if (c) placeOrRemoveAt(c[0], c[1]);
      } else if (placeMode === 'area') {
        placeAreaAt(e.clientX, e.clientY);
      } else if (activeOverlay?.kind === 'move') {
        setMoveTargetAt(e.clientX, e.clientY); // empty cell in movement → arrival
      } else if (activeOverlay?.kind === 'area') {
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
});
view.addEventListener('pointercancel', (e) => {
  if (manualActive) {
    manualPointerUp(e);
    return;
  }
  activePointers.delete(e.pointerId);
  clearLongPress();
  ringRotating = false;
  dragKind = null;
  tapStart = null;
  tapCandidate = false;
  gesturePiece = null;
  longPressFired = false;
});

// Area type + size are edited live from the HUD (the map is dynamic — no confirm).
areaTypeBox.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  const t = chip?.dataset.t as AreaType | undefined;
  if (!t) return;
  currentAreaType = t;
  highlightAreaType();
  if (activeOverlay?.kind === 'area') updateAreaOverlay();
});
// Live edits (the map is dynamic — no confirm needed). The unit relabels BOTH the
// area size and the piece movement selects ("6 q" → "9 m" …).
areaUnit.addEventListener('input', () => {
  refreshSizeUI();
  refreshMoveUI();
  if (activeOverlay?.kind === 'area') updateAreaOverlay();
});
for (const el of [areaSizeSel, areaCreature]) {
  el.addEventListener('input', () => {
    if (activeOverlay?.kind === 'area') updateAreaOverlay();
  });
}
// Populate the fixed selects once.
{
  const sizeOpts = CREATURE_SIZES.map((c) => `<option value="${c.cells}">${c.label}</option>`).join('');
  areaCreature.innerHTML = sizeOpts;
  pieceSize.innerHTML = sizeOpts;
  // Piece movement in cells (1..12), labelled in the chosen unit; default 6.
  refreshMoveUI();
  pieceMove.value = String(DEFAULT_PIECE_SPEED);
  // Populate the area size select up-front so the FIRST area is built with a real
  // size (previously it was empty until the HUD refreshed → only the origin dot).
  highlightAreaType();
}
// FAB speed-dial: ＋ opens the menu; while a placement mode is active OR an area is on
// the map the FAB is an ✕ — it exits the mode, or REMOVES the active area (the same ✕
// that adds an area removes it, so you always have an ✕ to make the area disappear).
fab.addEventListener('click', () => {
  if (placeMode !== 'none') setPlaceMode('none');
  else if (activeOverlay?.kind === 'area') removeActiveArea();
  else fabWrap.classList.toggle('open');
});
fabAlly.addEventListener('click', () => setPlaceMode('ally'));
fabEnemy.addEventListener('click', () => setPlaceMode('enemy'));
fabArea.addEventListener('click', () => setPlaceMode('area'));

// HUD: collapse/expand its body; the ✕ dismisses the current context — removes an
// area, or deselects a piece / exits a movement.
hudCollapse.addEventListener('click', () => {
  hudCollapsed = !hudCollapsed;
  refreshHud();
});
// The single (i) button toggles the contextual-help popover.
infoBtn.addEventListener('click', () => {
  infoOpen = !infoOpen;
  updateInfo();
});
hudClose.addEventListener('click', () => {
  if (activeOverlay?.kind === 'area') removeActiveArea();
  else {
    deselectCell();
    draw();
  }
});

// Debug has no on-screen switch: triple-tap the logo (within 600ms) toggles it on/off
// and re-runs detection on the current capture so the diagnostics appear/disappear.
let brandTaps: number[] = [];
brand.addEventListener('click', () => {
  const now = Date.now();
  brandTaps = brandTaps.filter((t) => now - t < 600);
  brandTaps.push(now);
  if (brandTaps.length >= 3) {
    brandTaps = [];
    debug = !debug;
    setStatus(debug ? 'Debug attivo' : 'Debug disattivato');
    if (lastCapture) runDetection();
  }
});

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
  const idx = tokens.indexOf(t);
  if (idx >= 0) tokens.splice(idx, 1);
  deselectCell();
  draw();
});

// --- Retake ------------------------------------------------------------
function retake() {
  showingResult = false;
  lastResult = null;
  lastCapture = null;
  deselectCell();
  zoom.reset();
  view.hidden = true;
  // Clear any manual-grid / fallback UI from the previous result.
  manualActive = false;
  manualQuad = null;
  gridReliable = false;
  showManualBar(false);
  editChooser.hidden = true;
  fabWrap.hidden = true;
  btnEditGrid.hidden = true;
  topActions.hidden = true; // leaving result mode → hide Pulisci / Rifai
  debugBar.hidden = true; // no pipeline to inspect on the live camera
  startCamera().catch(() => {
    setStatus('Fotocamera non disponibile — tocca lo schermo per riprovare');
    hint.hidden = false;
  });
}

// --- Wiring ------------------------------------------------------------
btnCapture.addEventListener('click', capture);
// Fallback for a denied/failed camera: on the camera screen (no result yet),
// tapping the stage (re)starts it. There is no dedicated Camera button.
stage.addEventListener('click', () => {
  if (!showingResult && !camera.isRunning) startCamera().catch(() => {});
});
// "Rifai" goes back through history so the state stays consistent with the
// device back button (which also returns to the camera via popstate).
btnRetake.addEventListener('click', () => {
  if (showingResult) history.back();
  else retake();
});
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

// Manual-grid bar controls.
const MANUAL_MIN_CELLS = 1;
const MANUAL_MAX_CELLS = 60;
/** Clamp + apply a cell count, syncing the input fields. */
function setManualCount(which: 'cols' | 'rows', value: number) {
  const v = Math.max(MANUAL_MIN_CELLS, Math.min(MANUAL_MAX_CELLS, Math.round(value)));
  if (which === 'cols') manualNa = v;
  else manualNb = v;
  updateManualBar();
  applyManual();
}
function bumpManual(which: 'cols' | 'rows', delta: number) {
  setManualCount(which, (which === 'cols' ? manualNa : manualNb) + delta);
}
colsMinus.addEventListener('click', () => bumpManual('cols', -1));
colsPlus.addEventListener('click', () => bumpManual('cols', +1));
rowsMinus.addEventListener('click', () => bumpManual('rows', -1));
rowsPlus.addEventListener('click', () => bumpManual('rows', +1));
// Direct numeric entry: apply live while a valid number is typed, normalise (clamp +
// rewrite the field) on commit.
const liveCount = (which: 'cols' | 'rows', el: HTMLInputElement) => () => {
  const n = parseInt(el.value, 10);
  if (Number.isFinite(n) && n >= MANUAL_MIN_CELLS) {
    const v = Math.min(MANUAL_MAX_CELLS, n);
    if (which === 'cols') manualNa = v;
    else manualNb = v;
    applyManual();
  }
};
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
  if (!showingResult) return;
  editChooser.hidden = false;
});
window.addEventListener('popstate', () => {
  if (showingResult) retake();
});

boot();
