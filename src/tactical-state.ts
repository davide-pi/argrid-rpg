// Shared mutable state, in ONE object so every module reads/writes the same live
// values. ES modules forbid reassigning an imported `let` from another file, so any
// module-level variable that is read or written from more than one module lives here
// as a property on `S`. Variables used by a single module stay module-private there.

import type { GridResult } from './grid-detector';
import type { GridMap, Overlay, AreaType } from './overlays';

// Board tokens: allies (green) / enemies (red), each an X×X block at (i,j).
// Each piece carries its own movement speed (in cells / q). Threat reach is shown
// only during movement (the opposite side) — there is no global toggle.
export interface Token {
  kind: 'ally' | 'enemy';
  i: number;
  j: number;
  w: number;
  speed: number; // movement in cells (q)
}

// A point in image-pixel coordinates (manual-grid quad corners / traced lines).
export type ImgPt = { x: number; y: number };

export const S = {
  cv: null as any,
  lastCapture: null as HTMLCanvasElement | null,
  lastResult: null as GridResult | null,
  showingResult: false, // true while a captured photo + overlay is shown

  // Whether a grid is currently drawn (and tactics can build on it).
  gridReliable: false,
  // When the detector DID synthesize a grid but the reliability gate rejected it, a
  // human-readable "scartata: …" reason (debug only). Null otherwise.
  gridRejectReason: null as string | null,

  // Tactical state.
  gridMap: null as GridMap | null, // grid<->image mapping for the current grid
  gridDims: { na: 0, nb: 0 },
  selectedCell: null as [number, number] | null, // floor of the tapped grid point
  selectedNode: [0, 0] as [number, number], // nearest intersection (burst/cone origin)
  activeOverlay: null as Overlay | null, // one editable overlay at a time
  currentAreaType: 'esplosione' as AreaType,
  areaAngleDeg: 0, // line/cone orientation, set by the on-map angle ring

  tokens: [] as Token[],
  // Placement mode (driven by the FAB).
  placeMode: 'none' as 'none' | 'ally' | 'enemy' | 'area',
  moveTarget: null as [number, number] | null, // "arrival" cell for the path preview

  // Tap-to-focus point (normalized [0,1] in the video frame), and the value the most
  // recent detection ran with (for the debug focus indicator).
  focusPoint: null as { x: number; y: number } | null,
  lastFocusPoint: null as { x: number; y: number } | null,

  // Debug is a hidden state toggled by triple-tapping the logo.
  debug: false,
  debugStepId: 'overlay', // selected debug pipeline node id ('overlay' = the live overlay)
  debugCollapsed: false,
  debugLogOpen: false, // the timing log panel (scroll-text button) is showing
  debugLogTab: 'tempi' as 'tempi' | 'conf', // which log tab: timings vs confidence breakdown

  hudCollapsed: false,
  infoOpen: false,

  // While rotating the angle ring OR dragging the selection/arrival, suppress pan.
  ringRotating: false,
  dragKind: null as 'origin' | 'target' | 'piece' | null,
  // Where the finger is (IMAGE pixels) during a tactical drag/rotate, so draw() can put
  // the magnifier loupe there — the finger hides exactly the cell being aimed at. Null
  // when nothing is being dragged.
  dragPoint: null as ImgPt | null,

  // Drawing caches (created once, reused).
  edgeCanvas: null as HTMLCanvasElement | null,
  debugStepCanvas: null as HTMLCanvasElement | null,

  // Manual-grid editing: `manualActive` is true throughout manual editing so the whole
  // gesture surface is handed to the grid editor; `manualDrag` is which handle is being
  // dragged; `manualQuad` is the editable quad ([TL, TR, BR, BL] in image coordinates).
  manualActive: false,
  manualDrag: null as number | null,
  manualQuad: null as ImgPt[] | null,
  // "Draw by hand" mode: the user TRACES reference lines and the grid is generated from them.
  manualDrawPending: false,
};
