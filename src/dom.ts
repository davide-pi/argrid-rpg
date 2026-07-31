// Central DOM element lookups. Pure querySelector-by-id bindings (no logic), so
// they evaluate once when this module is first imported — which happens at the top
// of main.ts, after the deferred module script sees the parsed HTML. Every other
// module imports the elements it needs from here.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const video = $<HTMLVideoElement>('video');
export const view = $<HTMLCanvasElement>('view');
export const stage = $<HTMLElement>('stage');
export const statusEl = $<HTMLSpanElement>('status');
export const hint = $<HTMLDivElement>('hint');

export const loader = $<HTMLDivElement>('loader');
export const loaderMsg = $<HTMLParagraphElement>('loaderMsg');
export const loaderFill = $<HTMLDivElement>('loaderFill');

// Processing overlay (shown while a captured photo is being analysed).
export const processing = $<HTMLDivElement>('processing');
export const processingMsg = $<HTMLParagraphElement>('processingMsg');
export const processingFill = $<HTMLDivElement>('processingFill');
export const processingPct = $<HTMLSpanElement>('processingPct');

export const btnCapture = $<HTMLButtonElement>('btnCapture');
export const btnRetake = $<HTMLButtonElement>('btnRetake');
// Debug-only: load a saved photo from the gallery instead of the camera.
export const btnLoadImage = $<HTMLButtonElement>('btnLoadImage');
export const fileInput = $<HTMLInputElement>('fileInput');
// The retake (camera) button lives in the top bar and shows only in result mode.
export const topActions = $<HTMLDivElement>('topActions');

// Manual-grid chooser (shown only when the user taps the top-bar edit button).
export const editChooser = $<HTMLDivElement>('editChooser');
export const chooseAdapt = $<HTMLButtonElement>('chooseAdapt');
export const chooseDraw = $<HTMLButtonElement>('chooseDraw');
export const chooseCancel = $<HTMLButtonElement>('chooseCancel');

// Result-mode "edit the grid by hand" button (top bar); always available so any
// grid — even a well-detected one — can be adjusted.
export const btnEditGrid = $<HTMLButtonElement>('btnEditGrid');
// Manual-grid editor bar.
export const manualBar = $<HTMLDivElement>('manualBar');
export const colsMinus = $<HTMLButtonElement>('colsMinus');
export const colsPlus = $<HTMLButtonElement>('colsPlus');
export const colsInput = $<HTMLInputElement>('colsInput');
export const rowsMinus = $<HTMLButtonElement>('rowsMinus');
export const rowsPlus = $<HTMLButtonElement>('rowsPlus');
export const rowsInput = $<HTMLInputElement>('rowsInput');
export const manualDone = $<HTMLButtonElement>('manualDone');
export const manualCancel = $<HTMLButtonElement>('manualCancel');
export const manualCollapse = $<HTMLButtonElement>('manualCollapse');

export const debugBar = $<HTMLDivElement>('debugBar');
// Floating "add" speed-dial.
export const fabWrap = $<HTMLDivElement>('fabWrap');
export const fab = $<HTMLButtonElement>('fab');
export const fabAlly = $<HTMLButtonElement>('fabAlly');
export const fabEnemy = $<HTMLButtonElement>('fabEnemy');
export const fabArea = $<HTMLButtonElement>('fabArea');

// Heads-up panel (overlaid on the top of the map) — the single contextual control
// surface for a selected piece, an active area, or a movement.
export const hud = $<HTMLDivElement>('hud');
export const hudBadge = $<HTMLSpanElement>('hudBadge');
export const hudTitle = $<HTMLSpanElement>('hudTitle');
export const hudArea = $<HTMLDivElement>('hudArea');
export const hudPiece = $<HTMLDivElement>('hudPiece');
export const hudMove = $<HTMLDivElement>('hudMove');
export const hudCollapse = $<HTMLButtonElement>('hudCollapse');
export const hudClose = $<HTMLButtonElement>('hudClose');
// Single contextual-help affordance (bottom-left, above the version badge).
export const infoWrap = $<HTMLDivElement>('infoWrap');
export const infoBtn = $<HTMLButtonElement>('infoBtn');
export const infoPop = $<HTMLDivElement>('infoPop');
// Area controls (live inside the HUD now).
export const areaTypeBox = $<HTMLDivElement>('areaType');
export const areaSizeSel = $<HTMLSelectElement>('areaSizeSel');
export const areaUnit = $<HTMLSelectElement>('areaUnit');
export const areaCreature = $<HTMLSelectElement>('areaCreature');
export const brand = $<HTMLElement>('brand');
// Build version (injected by Vite — GitVersion in CI), shown small on the map.
export const versionBadge = $<HTMLSpanElement>('versionBadge');
// Debug indicator chip (next to the version); shown only while debug mode is on.
export const dbgBadge = $<HTMLSpanElement>('dbgBadge');
// Debug-only focus indicator (next to the DBG chip).
export const focusBadge = $<HTMLSpanElement>('focusBadge');
// Per-piece editor (Taglia / Movimento), shown when a token is selected.
export const pieceSize = $<HTMLSelectElement>('pieceSize');
export const pieceMove = $<HTMLSelectElement>('pieceMove');
export const pieceRemove = $<HTMLButtonElement>('pieceRemove');
