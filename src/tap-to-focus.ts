// Tap-to-focus on the live camera preview. A tap (a) drops a focus reticle there,
// (b) best-effort tells the camera to focus that point, (c) stores it (normalized
// [0,1] in the video frame) so the NEXT capture weights that area. No tap ⇒ focus
// stays off. The reticle is a Lucide `focus` glyph.
import { S } from './tactical-state';
import { video, stage } from './dom';
import { camera } from './main';

let focusReticle: HTMLDivElement;
let focusReticleTimer: number | null = null;

/** Map a tap on the live preview to the video frame (normalized [0,1]) + a stage-relative
 * reticle position. The preview is object-fit:contain, so the video is letterboxed inside
 * its element box — we map through the CONTAINED content rect (dropping the bars, clamping
 * a tap that lands on one) to intrinsic videoWidth/videoHeight coords. Null if no frame yet. */
function mapPreviewTap(
  clientX: number,
  clientY: number,
): { nx: number; ny: number; sx: number; sy: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  // object-fit:contain — scale to fit, centre, letterbox the remainder.
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const offX = (rect.width - dw) / 2;
  const offY = (rect.height - dh) / 2;
  // Tap inside the content rect; clamp a tap that fell on a letterbox bar to the content.
  const lx = Math.max(0, Math.min(dw, clientX - rect.left - offX));
  const ly = Math.max(0, Math.min(dh, clientY - rect.top - offY));
  const nx = dw ? lx / dw : 0;
  const ny = dh ? ly / dh : 0;
  const stageRect = stage.getBoundingClientRect();
  const sx = rect.left + offX + lx - stageRect.left;
  const sy = rect.top + offY + ly - stageRect.top;
  return { nx, ny, sx, sy };
}

/** Flash the focus reticle at a stage-relative position (~700ms pop + fade). */
function showFocusReticle(sx: number, sy: number) {
  focusReticle.style.left = sx + 'px';
  focusReticle.style.top = sy + 'px';
  focusReticle.hidden = false;
  focusReticle.classList.remove('show');
  void focusReticle.offsetWidth; // reflow so the animation restarts on rapid taps
  focusReticle.classList.add('show');
  if (focusReticleTimer !== null) clearTimeout(focusReticleTimer);
  focusReticleTimer = window.setTimeout(() => {
    focusReticle.classList.remove('show');
    focusReticle.hidden = true;
    focusReticleTimer = null;
  }, 700);
}

/** Drop the active focus point + hide the reticle (each new camera session starts clean). */
export function clearFocusPoint() {
  S.focusPoint = null;
  if (focusReticleTimer !== null) {
    clearTimeout(focusReticleTimer);
    focusReticleTimer = null;
  }
  focusReticle.classList.remove('show');
  focusReticle.hidden = true;
}

/** Create the reticle element (appended to the stage) and wire the live-preview tap. */
export function initTapToFocus() {
  focusReticle = document.createElement('div');
  focusReticle.className = 'focus-reticle';
  focusReticle.hidden = true;
  focusReticle.setAttribute('aria-hidden', 'true');
  focusReticle.innerHTML =
    '<svg viewBox="0 0 24 24" width="76" height="76" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>';
  stage.appendChild(focusReticle);

  video.addEventListener('pointerdown', (e) => {
    // Live camera only: not on the result canvas, and only once a frame is running.
    if (S.showingResult || video.hidden || !camera.isRunning) return;
    const m = mapPreviewTap(e.clientX, e.clientY);
    if (!m) return;
    S.focusPoint = { x: m.nx, y: m.ny };
    camera.focusAt(m.nx, m.ny).catch(() => {}); // best-effort; never block the UI
    showFocusReticle(m.sx, m.sy);
  });
}
