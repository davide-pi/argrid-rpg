// Dev-only test hook so a headless browser can drive detection on a synthetic canvas.
// Installed from boot()'s cv-ready callback (only when import.meta.env.DEV) and stripped
// from the production build.
import { S } from './tactical-state';
import { view } from './dom';
import { detectGrid, DEFAULT_PARAMS } from './grid-detector';
import { processImage, runDetection } from './main';
import { ringHandleGrid, effectiveAngle } from './placement';

export function installDevHook(mod: any) {
  (window as any).__argrid = {
    detectGrid,
    cv: mod,
    DEFAULT_PARAMS,
    render: (c: HTMLCanvasElement) => processImage(c),
    view,
    // Client-space position of a grid point (i,j), for driving the tactical
    // UI (taps, ring drags) from a test harness.
    cellClient: (i: number, j: number) => {
      if (!S.gridMap) return null;
      const [x, y] = S.gridMap.toImage(i, j);
      const r = view.getBoundingClientRect();
      return { x: r.left + (x / view.width) * r.width, y: r.top + (y / view.height) * r.height };
    },
    // Rotation handle (grid coords) + current effective angle, for driving
    // the ring from a test harness.
    ringHandle: () => ringHandleGrid(),
    effectiveAngle: () => effectiveAngle(),
    // Current detection state, for test assertions.
    state: () => ({ gridReliable: S.gridReliable, gridDims: { ...S.gridDims }, showingResult: S.showingResult }),
    // Tap-to-focus point (normalized [0,1]) the next capture will weight: read it, or
    // set one and re-detect the last capture (mirrors what a tap on the preview does).
    focus: () => (S.focusPoint ? { ...S.focusPoint } : null),
    setFocus: (p: { x: number; y: number } | null) => {
      S.focusPoint = p ? { x: p.x, y: p.y } : null;
      if (S.lastCapture) runDetection();
      return S.focusPoint ? { ...S.focusPoint } : null;
    },
  };
}
