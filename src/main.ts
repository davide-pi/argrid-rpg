import './style.css';
import { Camera } from './camera';
import {
  detectGridSteps,
  DEFAULT_PARAMS,
  DRAW_THRESHOLD,
  isGridReliable,
  type DetectorParams,
} from './grid-detector';
import { attachZoomPan } from './zoom';
import { makeGridMap, CREATURE_SIZES } from './overlays';
import { S } from './tactical-state';
import {
  video,
  view,
  stage,
  statusEl,
  hint,
  loader,
  loaderMsg,
  loaderFill,
  processing,
  processingMsg,
  processingFill,
  processingPct,
  btnCapture,
  btnRetake,
  topActions,
  editChooser,
  btnEditGrid,
  debugBar,
  fabWrap,
  hud,
  areaCreature,
  versionBadge,
  pieceSize,
  pieceMove,
} from './dom';
import {
  setPlaceMode,
  updateFabEnabled,
  highlightAreaType,
  refreshMoveUI,
  DEFAULT_PIECE_SPEED,
  initPlacement,
} from './placement';
import { deselectCell, initGestures } from './gestures';
import { draw } from './draw-loop';
import { updateInfo, initHud } from './hud';
import { rebuildDebugBar, initDebug } from './debug-panel';
import { showManualBar, initManualGrid } from './manual-grid';
import { clearFocusPoint, initTapToFocus } from './tap-to-focus';
import { installDevHook } from './dev-hook';

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

// --- Setup -------------------------------------------------------------
versionBadge.textContent = `v${__APP_VERSION__}`;

export const camera = new Camera(video);
// While rotating the angle ring OR dragging the selection/arrival, OR while editing a manual
// grid, suppress pan so the gesture only turns/moves that thing (zoom stays where it is).
const zoom = attachZoomPan(view, {
  suppress: () => S.ringRotating || S.dragKind !== null || S.manualDrag !== null || S.manualActive,
});

export function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function currentParams(): DetectorParams {
  // Reconstruct the full 2-D lattice and rebuild every row/column (occluded ones
  // included) — with the vanishing-point + rectification model these are
  // reliable, so the complete grid is shown. `focusPoint` (set by a tap on the live
  // preview, null otherwise) makes the detector weight that area; null ⇒ today's behaviour.
  return { ...DEFAULT_PARAMS, fillGrid: true, focusPoint: S.focusPoint };
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
      S.cv = mod;
      // Dev-only test hook so a headless browser can drive detection on a
      // synthetic canvas (stripped from the production build).
      if (import.meta.env.DEV) installDevHook(mod);
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
    clearFocusPoint(); // every new camera session / retake starts with focus OFF
    video.hidden = false;
    view.hidden = true;
    hint.hidden = false;
    btnCapture.hidden = false; // the floating Scatta button — camera mode only
    btnCapture.disabled = !S.cv;
    topActions.hidden = true; // the retake button is result-mode only
    hud.hidden = true; // no contextual controls on the live camera
    if (S.placeMode !== 'none') setPlaceMode('none');
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

export function processImage(canvas: HTMLCanvasElement) {
  S.lastCapture = canvas;
  detectGen++; // a new photo supersedes any in-flight analysis
  view.hidden = false;
  hint.hidden = true;
  zoom.reset(); // start each new capture unzoomed
  deselectCell(); // a new photo → drop the previous overlay and selection
  S.tokens = []; // …and the previous board tokens
  // A new photo → drop any manual grid / fallback state from the previous one.
  S.manualActive = false;
  S.manualQuad = null;
  showManualBar(false);
  editChooser.hidden = true;
  if (S.placeMode !== 'none') setPlaceMode('none'); // turn off any active placement
  fabWrap.hidden = false; // the "add" FAB is available once there's a grid
  // Enter result mode BEFORE detection so the chrome/(i) updates run by runDetection
  // (updateResultChrome / updateInfo) see the correct mode — otherwise the FIRST photo
  // leaves the (i) hidden and the FAB ungated. Push a history entry so the device/
  // browser "back" returns to the camera (via popstate) instead of leaving the app.
  if (!S.showingResult) {
    S.showingResult = true;
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
// Detection generation: bumped on every new capture / retake so an in-flight analysis
// (staged over many frames) can tell it has been SUPERSEDED and discard its result
// instead of committing a stale grid over a newer photo. `detectPending` remembers that
// a fresh photo arrived while a run was busy, so it's analysed once the run finishes.
let detectGen = 0;
let detectPending = false;

// The reliability decision lives in `isGridReliable` (grid-detector.ts): confidence ≥ DRAW_THRESHOLD
// + the hard `degenerate` / ≥2-lines guards. Cell-count, inlier, aspect are all folded into the
// confidence there — see applyDetectedGrid.

export async function runDetection() {
  // One detection at a time — the pipeline is heavy and holds OpenCV Mats.
  if (!S.cv || !S.lastCapture) return;
  if (detecting) {
    // A run is in flight; it will pick up the latest capture when it finishes, so this
    // photo isn't silently dropped (retake + quick re-shoot during analysis).
    detectPending = true;
    return;
  }
  detecting = true;
  const myGen = detectGen; // the photo this run belongs to
  showProcessing("Analisi dell'immagine…", 0);
  await nextFrame(); // paint the overlay before the first blocking stage
  try {
    // Drive the staged detector: paint each step, yield a frame (die spins /
    // bar advances), then run the next synchronous stage. Always drained to
    // completion so the generator's own `finally` frees its OpenCV Mats.
    const params = currentParams();
    S.lastFocusPoint = params.focusPoint; // remember what this run used (debug focus indicator)
    // Compute the debug data (stage previews, timings, confidence breakdown) ONLY in debug mode —
    // `wantEdges` is gated on `debug`, so a normal capture stays lean (no preview snapshots/extra
    // allocations). Entering debug recomputes on demand (see the triple-tap handler).
    const gen = detectGridSteps(S.cv, S.lastCapture, params, S.debug);
    let step = gen.next();
    while (!step.done) {
      setProcessing(step.value.label, step.value.frac);
      await nextFrame();
      step = gen.next();
    }
    // Superseded by a newer capture / retake while we were analysing (the staged run
    // spans many frames)? Discard this result — committing it would draw an old grid
    // over a newer photo.
    if (myGen !== detectGen) return;
    setProcessing('Quasi pronto…', 1);
    S.lastResult = step.value;

    // Draw whatever grid the detector actually FOUND — or nothing if it didn't. The
    // user decides if it's good (they can edit it or retake); we no longer auto-hide
    // low-confidence grids behind a panel.
    applyDetectedGrid();
    S.debugStepId = 'overlay'; // default to the final overlay on each new detection
    if (S.selectedCell) {
      const [i, j] = S.selectedCell;
      if (!S.gridMap || i >= S.gridDims.na - 1 || j >= S.gridDims.nb - 1) deselectCell();
    }
    draw();
    reportStatus();
    // No grid found → the photo shows alone; updateResultChrome surfaces the (i)
    // guidance ("tocca ✎ / ↺") so the user isn't left wondering.
    updateResultChrome();
  } catch (err) {
    console.error(err);
    // Only surface the error for the CURRENT photo — a superseded run that throws
    // must not overwrite the header with a stale "Errore analisi" for a discarded photo.
    if (myGen === detectGen) setStatus('Errore analisi: ' + (err as Error).message);
  } finally {
    detecting = false;
    hideProcessing();
    // A fresh photo arrived while we were busy → analyse the latest capture now.
    if (detectPending) {
      detectPending = false;
      runDetection();
    }
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

// Derive gridReliable + the grid↔image map from the current detector output (lastResult).
// ONE decision now: `isGridReliable` — the calibrated confidence must clear DRAW_THRESHOLD, plus
// two HARD guards the score can't override (a confirmed sub-pitch `degenerate`, and a single-line
// "axis"). Regularity, size and squareness are already folded into `confidence` (see
// gridConfidence), so the old scattered gate (inlier / detected-line floors / aspect) is gone —
// the chip, the winner choice and "drawn?" now share the same score. Used after detection AND to
// RESTORE the auto grid when the user cancels a manual edit (cancel must not lose the grid).
export function applyDetectedGrid() {
  S.gridReliable = false;
  if (S.lastResult) {
    const i = S.lastResult.info;
    S.gridReliable = isGridReliable(i, DRAW_THRESHOLD);
    // Diagnostic: when the detector DID synthesize a grid (both families non-trivial) but the gate
    // rejected it, spell out why so the user can SEE why an obviously-detected grid wasn't drawn
    // (debug-gated; see reportStatus / the debug info panel).
    S.gridRejectReason = null;
    const hasLines = S.lastResult.familyA.length >= 2 && S.lastResult.familyB.length >= 2;
    if (!S.gridReliable && hasLines) {
      const reasons: string[] = [];
      if (i.degenerate) reasons.push('degenerate (sub-pitch)');
      if (i.detectedA < 2 || i.detectedB < 2)
        reasons.push(`detected ${i.detectedA}×${i.detectedB}: un asse ha meno di 2 linee`);
      if (!i.degenerate && i.detectedA >= 2 && i.detectedB >= 2 && i.confidence < DRAW_THRESHOLD)
        reasons.push(`confidenza ${i.confidence.toFixed(2)} < ${DRAW_THRESHOLD} (soglia di disegno)`);
      S.gridRejectReason = reasons.length ? 'scartata: ' + reasons.join('; ') : null;
    }
  } else {
    S.gridRejectReason = null;
  }
  S.gridMap = null;
  if (S.gridReliable && S.lastResult) {
    S.gridMap = makeGridMap(S.lastResult.familyA, S.lastResult.familyB);
    S.gridDims = { na: S.lastResult.familyA.length, nb: S.lastResult.familyB.length };
  }
}

// Result-mode chrome: there is NO automatic fallback panel. The FAB (place tokens) is always
// PRESENT once a result is shown, but DISABLED until a grid exists; the edit button + retake are
// always available so the user can create/replace the grid or reshoot at will.
export function updateResultChrome() {
  editChooser.hidden = true; // only opened explicitly by the edit button
  if (S.showingResult && !S.manualActive) {
    fabWrap.hidden = false; // present in result mode…
    updateFabEnabled(); // …but greyed-out/inert until there's a grid
    if (!S.gridReliable) {
      hud.hidden = true;
    }
  }
  updateEditGridButton();
  updateInfo();
  rebuildDebugBar();
}

/** Show the top-bar "edit grid" button whenever a result is on screen and we're not
 * already editing (so any grid can be adjusted by hand at any time). */
function updateEditGridButton() {
  btnEditGrid.hidden = !(S.showingResult && !S.manualActive);
}

function reportStatus() {
  if (!S.lastResult) return;
  const i = S.lastResult.info;
  const total = i.aCount + i.bCount;
  if (i.rawCount === 0) {
    setStatus('Nessuna linea rilevata — riprova con più contrasto/luce');
    return;
  }
  if (total === 0) {
    setStatus(`${i.rawCount} linee grezze ma nessuna griglia — inquadra più da vicino`);
    return;
  }
  // The reliability gate's rejection reason is NOT shown in the header anymore — it lives only in
  // the debug pipeline panel (the `.debug-reason` banner). On success the top-right shows the
  // action buttons; either way the header carries no grid status line (the debug step viewer +
  // on-canvas labels carry the diagnostics instead), so clear any stale value.
  setStatus('');
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

// --- Retake ------------------------------------------------------------
function retake() {
  S.showingResult = false;
  S.lastResult = null;
  S.lastCapture = null;
  detectGen++; // supersede any in-flight analysis; don't commit its grid after we leave
  detectPending = false; // nothing to re-analyse once we're back on the camera
  deselectCell();
  zoom.reset();
  view.hidden = true;
  // Clear any manual-grid / fallback UI from the previous result.
  S.manualActive = false;
  S.manualQuad = null;
  S.gridReliable = false;
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
// Each module attaches its own listeners via an init function, called here in the same
// order the inline wiring ran before (no listener fires during setup, so ordering only
// mirrors the original for faithfulness).
initTapToFocus();
initGestures();
initPlacement();
initHud();
initDebug();
initManualGrid();
btnCapture.addEventListener('click', capture);
// Fallback for a denied/failed camera: on the camera screen (no result yet),
// tapping the stage (re)starts it. There is no dedicated Camera button.
stage.addEventListener('click', () => {
  if (!S.showingResult && !camera.isRunning) startCamera().catch(() => {});
});
// "Rifai" goes back through history so the state stays consistent with the
// device back button (which also returns to the camera via popstate).
btnRetake.addEventListener('click', () => {
  if (S.showingResult) history.back();
  else retake();
});
window.addEventListener('popstate', () => {
  if (S.showingResult) retake();
});

boot();
