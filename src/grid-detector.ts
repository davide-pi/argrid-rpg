// Core computer-vision pipeline: find the two families of lines that make up a
// grid of squares in a photo, then fill in missing/occluded lines.
//
// Everything is AUTOMATIC — Canny thresholds come from Otsu, the Hough
// accumulator threshold is proportional to the image size and self-tunes via a
// retry loop, so there are no knobs to expose to the user.
//
// Pipeline
//   grayscale -> CLAHE (local contrast) -> blur -> auto-Canny (Otsu)
//   -> adaptive Hough lines (retry until a sane number of lines)
//   -> cluster lines into two ~perpendicular families by angle (handles any
//      rotation automatically)
//   -> snap each line to its family's mean orientation, dedupe
//   -> estimate the cell pitch and interpolate missing interior lines
//
// Everything is returned as plain data in ORIGINAL image coordinates so the UI
// can draw the overlay with the Canvas 2D API (no OpenCV needed for drawing).

export interface DetectorParams {
  /** Downscale so the longest side is at most this many px (speed/robustness). */
  maxDim: number;
  /** Lines whose offsets differ by less than this fraction of maxDim merge. */
  mergeFrac: number;
  /** Interpolate missing interior lines from the estimated cell pitch. */
  fillGrid: boolean;
  /** Suppress edges outside the in-focus plane before detection (blunt; off by
   * default — the lattice reconstruction rejects non-grid lines more safely). */
  focusGating: boolean;
  /** Rebuild the regular lattice and drop lines that don't fit it. */
  reconstruct: boolean;
  /** Fallback for noisy/low-contrast photos (a grid drawn on a textured surface):
   * if the plain Canny pipeline finds no grid, retry with a morphological line
   * extractor that suppresses isotropic texture and keeps long thin lines. */
  lineMorph: boolean;
  /** Extrapolate the fitted lattice PAST the detected lines, continuing the same
   * pitch/orientation, bounded by the image frame:
   *   'off'    — only detected + interior-filled lines
   *   'border' — a few cells beyond the detected extent, to recover an outer
   *              border the detector missed (e.g. a colour-only map edge)
   *   'frame'  — tile the whole frame with the inferred grid (virtual grid) */
  extend: 'off' | 'border' | 'frame';
  /** Also detect CHROMATIC edges (grid vs background differ in hue but not
   * luminance, so grayscale Canny misses them): OR the Lab a/b edge map into the
   * luminance Canny before Hough. A near-neutral channel contributes nothing. */
  colorEdges: boolean;
  /** Use an FFT periodicity prior to fix the family-orientation split when the angle
   * histogram locks onto a wrong orientation (e.g. a 45° diagonal off a tiled floor).
   * Only overrides when the prior confidently disagrees; a matching prior is a no-op. */
  fftPrior: boolean;
  /** Oriented edge re-extraction (weak-fit recovery): when the first fit is weak, keep
   * only edge pixels whose gradient matches the fit's own perspective-consistent grid
   * normal (vanishing-point-aware, so it follows the fan) and re-fit. Adopted only if
   * strictly stronger — pure containment. See orientEdgesVP / ORIENT_SKIP_STRENGTH. */
  orientGate: boolean;
  /** Texture cleaning: before Hough, drop the SHORT connected components of the edge
   * map (a high-frequency sand/dirt texture leaves many tiny fragments; grid lines are
   * long). Orientation-agnostic length filter — see dropShortComponents. */
  edgeClean: boolean;
}

export const DEFAULT_PARAMS: DetectorParams = {
  maxDim: 1600,
  mergeFrac: 0.012,
  fillGrid: true,
  focusGating: false,
  reconstruct: true,
  lineMorph: true,
  extend: 'frame',
  colorEdges: true,
  fftPrior: true,
  orientGate: true,
  edgeClean: true,
};

/** A line as normal form: nx*x + ny*y = d, with (nx,ny) a unit vector. */
export interface Line2 {
  nx: number;
  ny: number;
  d: number;
  filled?: boolean; // true if interpolated rather than detected
  extended?: boolean; // true if extrapolated BEYOND the detected extent (see extend)
}

/** One node of the pipeline graph (debug only). `image` is a downscaled RGBA snapshot
 * of that stage's Mat (absent for the final overlay node, or for a stage that never
 * ran). `inputs` are the ids of the stages that STRUCTURALLY feed this one — the full
 * fixed topology, so every stage (even a skipped one) is drawn with its in/out arrows.
 * `executed` = the stage actually ran (false → drawn deactivated, not clickable).
 * `used` = the stage is on the path that actually produced the final grid. So a node
 * can be: used (highlighted), executed-but-not-used (normal), or not executed. */
export interface DebugStep {
  id: string;
  label: string;
  image?: ImageData;
  inputs: string[];
  executed: boolean;
  used: boolean;
}

/** Per-candidate detection quality, for the debug confidence panel. Each independent
 * fit (the main luminance path, the morphological fallback) reports its own numbers;
 * `chosen` marks the one that became the final result. */
export interface PipelineStat {
  id: string; // 'main' | 'morph'
  label: string;
  strength: number; // detected (non-filled) lines in the weaker family
  confidence: number; // 0..1 heuristic
  cells: [number, number]; // a × b cells
  degenerate: boolean;
  chosen: boolean; // became the final result
}

export interface GridResult {
  width: number;
  height: number;
  familyA: Line2[];
  familyB: Line2[];
  rawLines: Line2[];
  edges?: ImageData; // debug edge map (working resolution); DOM-free
  debugSteps?: DebugStep[]; // per-stage previews (only when wantEdges/debug)
  debugPipelines?: PipelineStat[]; // per-candidate confidence (only when wantEdges/debug)
  debugAgreement?: number | null; // 0..1 main↔morph agreement, or null (debug only)
  debugTimings?: Record<string, number>; // ms per phase + counts, for the debug log (debug only)
  debugRawLum?: Line2[]; // raw Hough lines of the luminance fit (debug only)
  debugRawMorph?: Line2[]; // raw Hough lines of the morphology fit (debug only)
  // Line attrition through the fit stages, per family [A,B] (debug/diagnostic only): how many
  // lines survive raw→angle-split→duplicate-merge→VP-concurrency→regular-lattice. Pinpoints
  // WHERE an obvious grid's lines are being discarded.
  debugFit?: { split: [number, number]; merged: [number, number]; vp: [number, number]; lattice: [number, number] };
  info: {
    rawCount: number;
    aCount: number;
    bCount: number;
    angleADeg: number;
    angleBDeg: number;
    spacingA: number; // px in original coords
    spacingB: number;
    usedHough: number; // Hough threshold the retry loop settled on
    cannyHigh: number; // Canny high threshold picked from Otsu
    edgePixels: number; // number of edge pixels (diagnostics)
    detectedA: number; // real DETECTED (non-filled) lines per family …
    detectedB: number;
    confidence: number; // …feeding a 0..1 heuristic detection-quality score
    // Estimated grid SIZE = how many cells of each family span the image at the detected
    // pitch (rotation-robust: image extent along the family normal / pitch). A plausible
    // tactical grid is a handful to a couple dozen cells; far outside that is a false fit.
    cellsA: number;
    cellsB: number;
    // Per-family lattice REGULARITY = fraction of the family's (merged, VP-concurrent) raw
    // lines that land on the fitted lattice — high for a real grid, low for a texture stumble
    // whose lines don't sit on a regular pitch. Surfaced (not just folded into `confidence`)
    // so the UI reliability gate can reject a low-regularity fit per family. 0 when the family
    // took a degenerate / early-out fit path.
    inlierA: number;
    inlierB: number;
    // true when the fit collapsed to an implausible SUB-PITCH (micro-cells) — a
    // degenerate/garbage grid. This (not a confidence threshold) is what the UI gates
    // on to decide whether to draw the auto grid or offer the manual fallback.
    degenerate: boolean;
    // Detected lattice EXTENT per family (kmax−kmin+1, rectified plane) — the size of the grid
    // ACTUALLY SEEN. Used by the fusion size tie-break instead of the frame-relative cell count
    // (cellsA/B), which over-counts by the image margin.
    spanA: number;
    spanB: number;
  };
}

const DEG = 180 / Math.PI;

/** Smallest absolute angle between two orientations, mod 180°. */
function angDist180(aDeg: number, bDeg: number): number {
  let d = Math.abs(((aDeg - bDeg) % 180) + 180) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

export interface RawLine {
  rho: number;
  thetaDeg: number; // normal angle in [0,180)
}

/** Circular mean of normal angles (mod 180°) via the doubled-angle trick. */
function meanAngle180(anglesDeg: number[]): number {
  let s = 0;
  let c = 0;
  for (const a of anglesDeg) {
    const r = (2 * a) / DEG;
    s += Math.sin(r);
    c += Math.cos(r);
  }
  let m = Math.atan2(s, c) * DEG * 0.5;
  if (m < 0) m += 180;
  return m;
}

/** Number of DETECTED (non-filled/non-extended) lines in a family. */
const detectedCount = (fam: Line2[]): number => fam.reduce((n, l) => n + (l.filled ? 0 : 1), 0);

/** Smaller family's detected-line count — the binding constraint on whether a
 * real grid was found (both families must be present). */
const gridStrength = (r: GridResult): number =>
  Math.min(detectedCount(r.familyA), detectedCount(r.familyB));

/** Compact description of a fit, for cross-method agreement (image-space; adequate for
 * the LIGHT perspective we target). Families are ordered [A,B]. */
interface GridDescriptor {
  ang: [number, number]; // family normal angles (deg)
  pitch: [number, number]; // family median pitch (px)
  strength: number; // min detected lines across the two families
}

const describeGrid = (r: GridResult): GridDescriptor | null => {
  if (r.info.degenerate) return null;
  const strength = Math.min(r.info.detectedA, r.info.detectedB);
  if (strength < 2 || r.info.spacingA <= 0 || r.info.spacingB <= 0) return null;
  return { ang: [r.info.angleADeg, r.info.angleBDeg], pitch: [r.info.spacingA, r.info.spacingB], strength };
};

/** Largest integer m (1..MAX) whose multiple of the finer pitch matches the coarser pitch,
 * scored 0..1 by how close the ratio is to that integer. A ratio near an integer means one
 * fit is a SUB-SAMPLING (every m-th line) of the other — they still describe the SAME grid,
 * just at a coarser pitch. Non-integer ratios (a genuinely different grid) score ~0. */
function harmonicPitchScore(pa: number, pb: number): number {
  if (pa <= 0 || pb <= 0) return 0;
  const ratio = Math.max(pa, pb) / Math.min(pa, pb); // ≥ 1
  const m = Math.max(1, Math.round(ratio));
  if (m > 4) return 0; // beyond a 4× sub-sampling we no longer trust the correspondence
  const err = Math.abs(ratio - m) / m; // relative distance to the nearest harmonic
  return clamp01(1 - err / 0.15); // within 15% of an integer multiple
}

/**
 * Do two fits describe the SAME grid? Returns 0..1 (1 = identical orientation and a clean
 * harmonic pitch relationship on BOTH families), or null when a fit isn't comparable
 * (degenerate / too weak). Orientation is matched by pairing each family to its nearest;
 * pitch agreement is HARMONIC-aware, so a coarse sub-sampling (a method that missed the
 * faint intermediate lines) still counts as agreeing with the fine grid — which is exactly
 * how an independent second opinion resolves a wrong pitch. Two independent methods agreeing
 * is strong evidence even when each alone found only a few lines. Pure — unit-tested. */
function gridsAgree(a: GridResult | null, b: GridResult | null): number | null {
  const da = a && describeGrid(a);
  const db = b && describeGrid(b);
  if (!da || !db) return null;
  // Pair family A of `a` with whichever family of `b` is closer in angle.
  const swap = angDist180(da.ang[0], db.ang[1]) < angDist180(da.ang[0], db.ang[0]);
  const bIdx = swap ? [1, 0] : [0, 1];
  let prod = 1;
  for (let k = 0; k < 2; k++) {
    const angScore = clamp01(1 - angDist180(da.ang[k], db.ang[bIdx[k]]) / 12); // within 12°
    const pitchScore = harmonicPitchScore(da.pitch[k], db.pitch[bIdx[k]]);
    prod *= angScore * pitchScore;
  }
  return clamp01(Math.sqrt(prod)); // geometric mean of the two families' agreement
}

/** How much an independent second opinion lifts a corroborated fit's confidence. A fit that
 * a second method agrees with is pushed toward certainty; a lone fit keeps its raw quality. */
const CONSENSUS_BOOST = 0.8;

/** Fused-confidence band within which two candidates count as "tied" — the winner is then
 * decided by grid shape, not the noisy confidence delta. Also bounds the noise override
 * (it may only swap in morphology when its confidence is within this band of the leader). */
const CONF_TIE = 0.06;

export interface FusionResult {
  index: number; // winning candidate (index into the input array)
  confidence: number; // fused confidence of the winner: internal quality lifted by consensus
  agreement: number | null; // best agreement the winner has, as the FINER representative
  confidences: number[]; // fused confidence of EACH candidate (for tie-break overrides / panel)
}

/**
 * Fuse several independent candidate grids (luminance / chroma / morphology) into one
 * decision — the heart of "put the approaches together to work out which is the grid".
 * Each candidate carries its own calibrated internal confidence. Where two candidates
 * AGREE (same orientation, harmonic pitch), that's strong corroboration: the FINER of the
 * pair is the representative (it recovered lines the other missed) and its confidence is
 * lifted toward 1; the coarser sub-sampling is NOT lifted, so the complete grid wins over a
 * skip-sampled one. A lone candidate keeps its internal confidence. The winner is the
 * candidate with the highest fused confidence (ties broken by more detected lines). Pure. */
export function fuseGrids(cands: GridResult[]): FusionResult {
  if (cands.length === 0) return { index: 0, confidence: 0, agreement: null, confidences: [] };
  const strengthOf = (r: GridResult): number =>
    r.info.degenerate ? 0 : Math.min(r.info.detectedA, r.info.detectedB);
  const confidences: number[] = [];
  const agreements: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    const internal = cands[i].info.confidence;
    const si = strengthOf(cands[i]);
    // Only agreement where THIS candidate is the finer (≥-strength) representative lifts it,
    // so a coarse sub-sampling can't ride the fine grid's corroboration to the top.
    let agree = 0;
    for (let j = 0; j < cands.length; j++) {
      if (j === i) continue;
      if (si < strengthOf(cands[j])) continue; // the other is finer → it's the representative
      const g = gridsAgree(cands[i], cands[j]);
      if (g != null && g > agree) agree = g;
    }
    confidences.push(clamp01(internal + (1 - internal) * agree * CONSENSUS_BOOST));
    agreements.push(agree);
  }
  // Shape sanity in [0,1]: is this candidate a plausibly-SIZED grid? Measured on the DETECTED
  // extent (`span` = lattice positions actually seen), NOT `cellsAcross` (which counts cells the
  // pitch would tile across the whole FRAME and is inflated by the margin / doubled by a
  // sub-pitch). Independent of raw line count, so it breaks ties when several candidates share a
  // near-zero confidence — a plausible 13×8 must beat garbage like 1×9 / 43×3 / 50×1.
  const shapeOf = (r: GridResult): number =>
    r.info.degenerate ? 0 : cellCountPlausibility(r.info.spanA) * cellCountPlausibility(r.info.spanB);
  // Winner ranking: clearly-higher fused confidence wins; within a small confidence band
  // (both weak / tied) prefer the more grid-SHAPED candidate, then the one with more lines.
  let best = 0;
  for (let i = 1; i < cands.length; i++) {
    const dc = confidences[i] - confidences[best];
    let better: boolean;
    if (Math.abs(dc) > CONF_TIE) better = dc > 0;
    else {
      const ds = shapeOf(cands[i]) - shapeOf(cands[best]);
      better = Math.abs(ds) > 1e-6 ? ds > 0 : strengthOf(cands[i]) > strengthOf(cands[best]);
    }
    if (better) best = i;
  }
  return {
    index: best,
    confidence: confidences[best],
    agreement: agreements[best] > 0 ? agreements[best] : null,
    confidences,
  };
}

/** A coarse progress tick emitted between the heavy detection stages, so the UI
 * can show a (jumpy) percentage and keep the loading die spinning. */
export interface DetectProgress {
  frac: number; // 0..1
  label: string;
}

/** Downscale a full-resolution `src` Mat so its longest side is `maxDim`, into the
 * caller-managed `work` Mat (INTER_AREA), returning the scale factor. */
function scaleToWork(cv: any, src: any, work: any, W0: number, H0: number, maxDim: number): number {
  const scale = Math.min(1, maxDim / Math.max(W0, H0));
  if (scale < 1) {
    cv.resize(src, work, new cv.Size(Math.round(W0 * scale), Math.round(H0 * scale)), 0, 0, cv.INTER_AREA);
  } else {
    src.copyTo(work);
  }
  return scale;
}

/** Downscaled RGBA snapshot of an intermediate Mat, for the debug step viewer.
 * Handles 1-channel (gray / binary) and 3/4-channel inputs; DOM-free (works in a
 * worker). `maxW` caps the width so a dozen previews stay cheap in memory. */
function matToPreview(cv: any, mat: any, maxW = 720): ImageData {
  const s = Math.min(1, maxW / mat.cols);
  const w = Math.max(1, Math.round(mat.cols * s));
  const h = Math.max(1, Math.round(mat.rows * s));
  const small = new cv.Mat();
  try {
    cv.resize(mat, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const ch = small.channels();
    const src = small.data as Uint8Array;
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (ch === 1) {
        const v = src[i];
        buf[i * 4] = v;
        buf[i * 4 + 1] = v;
        buf[i * 4 + 2] = v;
      } else {
        buf[i * 4] = src[i * ch];
        buf[i * 4 + 1] = src[i * ch + 1];
        buf[i * 4 + 2] = src[i * ch + 2];
      }
      buf[i * 4 + 3] = 255;
    }
    return new ImageData(buf, w, h);
  } finally {
    small.delete();
  }
}

export function detectGrid(
  cv: any,
  srcCanvas: HTMLCanvasElement,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): GridResult {
  const W0 = srcCanvas.width;
  const H0 = srcCanvas.height;
  const src = cv.imread(srcCanvas);
  const work = new cv.Mat();
  try {
    const scale = scaleToWork(cv, src, work, W0, H0, params.maxDim);
    return detectGridFromMat(cv, work, W0, H0, scale, params, wantEdges);
  } finally {
    src.delete();
    work.delete();
  }
}

/**
 * Staged detection from a canvas: same pipeline as `detectGrid`, but a GENERATOR
 * that `yield`s a {frac,label} tick before each heavy stage and `return`s the
 * `GridResult`. The caller (the app) drives it with a frame yield between steps so
 * the progress bar paints and the loading die keeps spinning during the (still
 * synchronous) OpenCV work, which otherwise blocks the main thread.
 */
export function* detectGridSteps(
  cv: any,
  srcCanvas: HTMLCanvasElement,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): Generator<DetectProgress, GridResult, void> {
  const W0 = srcCanvas.width;
  const H0 = srcCanvas.height;
  const src = cv.imread(srcCanvas);
  const work = new cv.Mat();
  try {
    const scale = scaleToWork(cv, src, work, W0, H0, params.maxDim);
    return yield* detectGridFromMatSteps(cv, work, W0, H0, scale, params, wantEdges);
  } finally {
    src.delete();
    work.delete();
  }
}

/**
 * Grid detection on an already-loaded working Mat (RGBA or gray). Split out so it
 * can be called without a <canvas>/DOM element (e.g. a Mat built from an ImageBitmap
 * in a Worker, or a synthetic test Mat) — note OpenCV.js itself cannot run in Node
 * (its Emscripten runtime wedges), so verification still goes through a headless
 * browser. The caller owns `work` and must delete it.
 */
export function detectGridFromMat(
  cv: any,
  work: any,
  W0: number,
  H0: number,
  scale: number,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): GridResult {
  // Drive the staged generator straight to completion (synchronous callers:
  // tests and the DEV hook).
  const g = detectGridFromMatSteps(cv, work, W0, H0, scale, params, wantEdges);
  let s = g.next();
  while (!s.done) s = g.next();
  return s.value;
}

/**
 * The pipeline body as a GENERATOR: identical work to `detectGridFromMat`, but it
 * `yield`s a {frac,label} tick before each heavy stage so a driver can paint a
 * progress bar / keep the die spinning between stages. `detectGridFromMat` and
 * `detectGridSteps` are the two entry points; the caller owns `work`.
 */
export function* detectGridFromMatSteps(
  cv: any,
  work: any,
  W0: number,
  H0: number,
  scale: number,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): Generator<DetectProgress, GridResult, void> {
  // OpenCV Mats are freed in `finally` so a throw mid-pipeline (a cv.* call) can't
  // leak the WASM heap. Each is nulled right after an explicit early delete; `edges`
  // is just an alias for whichever of cannyEdges/morphEdges is live, so only those
  // two need tracking. (gateEdgesByFocus / chromaEdges / enhanceGridLines own their
  // own temporaries.)
  let gray: any = null;
  let clahe: any = null;
  let eq: any = null;
  let blurred: any = null;
  let cannyEdges: any = null;
  let morphEdges: any = null;
  // Debug-only pipeline-graph previews (populated when wantEdges). Each stage's Mat is
  // snapped while still live (they're freed before we return); the graph is assembled
  // at the end from these previews + the applied/discarded flags below.
  const previews: Record<string, ImageData> = {};
  const snap = (id: string, mat: any) => {
    if (wantEdges) previews[id] = matToPreview(cv, mat);
  };
  // Debug-only timing: accumulate the ms spent in each heavy (synchronous) phase so the
  // debug log can show where the pipeline spends its time. `timed` wraps a synchronous
  // call only — never a span that contains a `yield`, or the frame wait would be counted.
  const timings: Record<string, number> = {};
  const timed = <T>(key: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    timings[key] = (timings[key] ?? 0) + (performance.now() - t0);
    return r;
  };
  let chromaExecuted = false; // the chromatic branch ran (colour source, RGBA)
  let chromaContributed = false; // …and it actually added edges (non-empty)
  let cleanApplied = false;
  let orientedRan = false; // the oriented re-extraction computed a mask
  let orientedAdopted = false; // …and it was stronger, so its re-fit won
  let morphRan = false; // the morphological pass ran
  let morphChosen = false; // …and it beat the luminance fit
  try {
    yield { frac: 0.05, label: "Preparazione dell'immagine…" };
    gray = new cv.Mat();
    timed('gray', () => {
      if (work.channels && work.channels() === 1) {
        work.copyTo(gray);
      } else {
        cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
      }
    });
    snap('foto', work); // the original colour image — the single root of the graph
    snap('gray', gray);

    // --- Standard edge path: CLAHE local contrast -> blur -> auto-Canny (Otsu) ---
    eq = new cv.Mat();
    clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    timed('clahe', () => clahe.apply(gray, eq));
    clahe.delete();
    clahe = null;
    snap('clahe', eq);

    blurred = new cv.Mat();
    // 5×5: light denoising before Otsu/Canny. A larger kernel (7×7) was tried but it
    // blurred faint / thin grid lines below Canny's threshold and killed recall on real
    // photos, so keep it modest.
    timed('blur', () => cv.GaussianBlur(eq, blurred, new cv.Size(5, 5), 0));
    snap('blur', blurred);

    // Auto-Canny: derive thresholds from Otsu's global threshold.
    const otsuTmp = new cv.Mat();
    const otsu = cv.threshold(blurred, otsuTmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    otsuTmp.delete();
    const cannyHigh = Math.max(1, Math.round(otsu));
    const cannyLow = Math.max(1, Math.round(0.5 * otsu));

    yield { frac: 0.2, label: 'Rilevamento dei bordi…' };
    cannyEdges = new cv.Mat();
    timed('canny', () => cv.Canny(blurred, cannyEdges, cannyLow, cannyHigh));
    // If the LUMINANCE Canny is flooded (a textured surface), it's mostly noise — re-run
    // with higher thresholds so only the strong edges (the grid) survive. We remember the
    // flood so the downstream noise defences (cleanup, morph preference) still engage even
    // though the map is now sparse. The morphology covers any faint grid this drops.
    const lumFlooded = cv.countNonZero(cannyEdges) / (cannyEdges.rows * cannyEdges.cols) > NOISE_EDGE_FRAC;
    if (lumFlooded) {
      timed('canny', () => {
        cv.Canny(
          blurred,
          cannyEdges,
          Math.max(1, Math.round(cannyLow * NOISE_CANNY_BOOST)),
          Math.max(1, Math.round(cannyHigh * NOISE_CANNY_BOOST)),
        );
      });
    }
    snap('canny', cannyEdges);

    // Chromatic edges: a grid that differs from its background in HUE but not in
    // brightness (e.g. a coloured map on a similarly-light surface) leaves no
    // luminance edge, so grayscale Canny misses it. Add the colour-only edges from
    // the Lab a/b channels. Only when the source has colour (RGBA) and the channel
    // actually carries chroma (near-neutral channels contribute nothing).
    if (params.colorEdges && work.channels && work.channels() === 4) {
      yield { frac: 0.35, label: 'Analisi cromatica…' };
      const chroma = timed('chroma', () => chromaEdges(cv, work));
      snap('chroma', chroma); // the colour-only edges (what chroma actually found)
      chromaExecuted = true;
      chromaContributed = cv.countNonZero(chroma) > 0; // empty on a tonal (non-hue) grid
      // Fold the colour-only edges straight INTO the luminance edge map: a grid that differs from
      // its background in HUE, not brightness (brown-on-earth), leaves no luminance edge, so the
      // MAIN Hough gains those lines. There is NO separate chroma candidate — it never won and was
      // always degenerate; the colour now lives inside the luminance flow (per the user's design).
      timed('edges', () => cv.bitwise_or(cannyEdges, chroma, cannyEdges));
      chroma.delete();
    }

    // Focus gating (off by default): the grid sits in the focal plane, so it is
    // sharper than an out-of-focus background; suppress edges whose local sharpness
    // is well below the median among edges. Self-disabling when the frame is
    // uniformly sharp. See DetectorParams.
    if (params.focusGating) gateEdgesByFocus(cv, gray, cannyEdges);
    snap('edges', cannyEdges); // merged edge map (Canny [+ chroma]) before cleaning

    // How texture-saturated is the edge map? A clean grid leaves thin, sparse edges; a
    // dirt/cork/fabric texture floods it. This gates BOTH the cleanup below and (later)
    // whether we distrust a disagreeing luminance fit in favour of the morphology.
    const edgeDensity = cv.countNonZero(cannyEdges) / (cannyEdges.rows * cannyEdges.cols);
    const noisy = lumFlooded || edgeDensity > NOISE_EDGE_FRAC; // stay noisy even after the boost thinned it

    // Texture cleaning: drop the short components (sand/dirt speckle) so Hough sees the
    // long grid lines instead of a web of tiny fragments. ONLY on a noisy frame — on a
    // clean/faint grid the "short components" are the grid's own broken lines, so cleaning
    // there would erase them (that regressed recall when it ran unconditionally).
    if (params.edgeClean && noisy) {
      timed('clean', () => dropShortComponents(cv, cannyEdges, shortLen(cannyEdges)));
      snap('clean', cannyEdges);
      cleanApplied = true;
    }
    eq.delete();
    eq = null;
    blurred.delete();
    blurred = null;

    // Global FFT periodicity prior (orientation only) — used to fix the family split
    // when Hough's angle histogram locks onto a wrong orientation. Best-effort.
    let orient: { a: number; b: number } | null = null;
    if (params.fftPrior) {
      try {
        orient = timed('fft', () => fftOrientations(cv, gray));
      } catch (err) {
        console.warn('fft orientation prior skipped:', err);
      }
    }

    // Hough + grid fit on the Canny edges.
    yield { frac: 0.55, label: 'Ricerca delle linee della griglia…' };
    let result = timed('houghMain', () => houghToGrid(cv, cannyEdges, work, scale, W0, H0, params, orient));

    // VP-aware oriented re-extraction: on a WEAK first fit, gate the edges by the fit's
    // own perspective-consistent orientation (drops clutter — furniture, text, diagonals
    // — that doesn't run with either family) and re-fit. Kept only if strictly stronger,
    // so it can only help. The gate follows the vanishing-point fan (not a fixed angle),
    // so it doesn't erase a steeply-converging family.
    if (params.orientGate && gridStrength(result) < ORIENT_SKIP_STRENGTH) {
      try {
        const gated = timed('oriented', () =>
          orientEdgesVP(cv, gray, cannyEdges, scale, result.familyA, result.familyB, ORIENT_TOL_DEG),
        );
        if (gated) {
          snap('oriented', gated.mask);
          orientedRan = true;
          if (gated.keptFrac >= ORIENT_MIN_KEEP) {
            const alt = timed('oriented', () => houghToGrid(cv, gated.mask, work, scale, W0, H0, params, orient));
            if (gridStrength(alt) > gridStrength(result)) {
              result = alt;
              orientedAdopted = true;
              cannyEdges.delete();
              cannyEdges = gated.mask; // adopted mask becomes the live edge mask
            } else {
              gated.mask.delete();
            }
          } else {
            gated.mask.delete();
          }
        }
      } catch (err) {
        console.warn('oriented re-extraction skipped:', err);
      }
    }

    const mainFit = result; // luminance path result (incl. oriented recovery), for the panel

    // --- Chromatic candidate ------------------------------------------------
    // (The chroma candidate was removed: the colour-only edges are folded into the luminance edge
    // map above, so the MAIN fit already sees them — a separate chroma Hough added no value.)
    let morphFit: GridResult | null = null;
    let agreement: number | null = null; // winner's consensus agreement, set by fuseGrids below

    // --- Morphological pass -------------------------------------------------
    // A second, INDEPENDENT line extractor (morphology instead of Canny) — strong where
    // Canny drowns in background texture (a grid on dirt/cork). Runs ALWAYS (not only on
    // failure) so it's a genuine second opinion.
    if (params.lineMorph) {
      yield { frac: 0.75, label: 'Analisi morfologica…' };
      // The morphology is AXIS-ALIGNED, so a tilted grid must be straightened first. We
      // don't trust a single prior angle (a wrong one leaves the lines crooked): instead
      // we SWEEP deskew angles, and for each one rotate → morphology → fit, keeping the
      // angle whose fit has the most "virtual" lattice lines (gridStrength — grid lines
      // hypothesised from the segments, not raw segments). The winning mask is already
      // rotated back to the original frame inside enhanceGridLines. A square grid's 90°
      // symmetry means every tilt lives in [-45,45]. Start from a best guess (0 if the
      // prior says near-axis, else the prior's tilt) and only sweep when it's weak.
      const off = residualTilt(orient ? orient.a : result.info.angleADeg); // [-45,45]
      const primary = Math.abs(off) > 12 ? -off : 0;
      let bestDeskew = primary;
      let morphAngles = 1;
      morphEdges = timed('morphEnhance', () => enhanceGridLines(cv, gray, snap, primary, timed));
      morphRan = true;
      let alt = timed('morphHough', () => houghToGrid(cv, morphEdges, work, scale, W0, H0, params, orient));
      if (gridStrength(alt) < MORPH_STRONG) {
        for (const a of deskewSweepAngles(off, orient != null)) {
          if (Math.abs(a - primary) < MORPH_SWEEP_STEP / 2) continue; // ~already tried
          morphAngles++;
          const m = timed('morphEnhance', () => enhanceGridLines(cv, gray, undefined, a, undefined));
          const f = timed('morphHough', () => houghToGrid(cv, m, work, scale, W0, H0, params, orient));
          if (gridStrength(f) > gridStrength(alt)) {
            morphEdges.delete();
            morphEdges = m;
            alt = f;
            bestDeskew = a;
            if (gridStrength(f) >= MORPH_STRONG) break; // clearly a grid — stop searching
          } else {
            m.delete();
          }
        }
        // Re-run the winning angle WITH snap so the graph shows its (deskewed) stages.
        if (bestDeskew !== primary) {
          morphEdges.delete();
          morphEdges = timed('morphEnhance', () => enhanceGridLines(cv, gray, snap, bestDeskew, timed));
        }
      }
      timings.morphAngles = morphAngles;
      snap('morph', morphEdges);
      morphFit = alt;
    }

    // --- Consensus fusion ---------------------------------------------------
    // Put the independent candidates together and let them vote (see fuseGrids): where two
    // agree they corroborate each other → the finer, complete grid wins with high confidence;
    // a lone candidate keeps its own calibrated quality. This is the meaning of the reported
    // confidence — a probability the winner really is a grid, not a raw line count.
    const candidates: { id: string; label: string; r: GridResult }[] = [
      { id: 'main', label: 'Luminanza', r: mainFit },
    ];
    if (morphFit) candidates.push({ id: 'morph', label: 'Morfologica', r: morphFit });
    const fused = fuseGrids(candidates.map((c) => c.r));
    let winnerIdx = fused.index;
    // Noise safety net: on a texture-flooded frame a luminance fit that DISAGREES with a solid
    // morphology fit is probably texture — prefer the (texture-robust) morphology. This is a
    // TIE-BREAK, not a bypass: it may only swap in morphology when its fused confidence is within
    // CONF_TIE of the leader's, so the invariant "winner = argmax of the same score" holds and the
    // draw gate can't be handed a candidate below threshold while a stronger one existed.
    const morphCandIdx = candidates.findIndex((c) => c.id === 'morph');
    if (
      noisy &&
      candidates[winnerIdx].id === 'main' &&
      morphCandIdx >= 0 &&
      morphFit &&
      !morphFit.info.degenerate &&
      Math.min(morphFit.info.detectedA, morphFit.info.detectedB) >= NOISE_MORPH_MIN &&
      (gridsAgree(mainFit, morphFit) ?? 0) < NOISE_AGREE_MAX &&
      fused.confidences[morphCandIdx] >= fused.confidences[winnerIdx] - CONF_TIE
    ) {
      winnerIdx = morphCandIdx;
    }
    // Agreement reported for the ACTUAL winner (the noise override is a tie-break, not a
    // consensus, so it carries no agreement of its own).
    agreement = winnerIdx === fused.index ? fused.agreement : null;
    result = candidates[winnerIdx].r;
    morphChosen = candidates[winnerIdx].id === 'morph';
    // The winner's fused confidence becomes the reported confidence (stamped after the debug
    // panel captures each candidate's RAW internal confidence, below).
    const fusedConfidence = fused.confidences[winnerIdx] ?? result.info.confidence;

    // Free the mask that lost (keep only the winner's, for the edge preview / edgePixels).
    if (morphEdges) {
      if (morphChosen) {
        cannyEdges?.delete();
        cannyEdges = null; // morphEdges is now the live mask
      } else {
        morphEdges.delete();
        morphEdges = null;
      }
    }

    const edges = morphEdges ?? cannyEdges; // whichever mask survived

    yield { frac: 0.9, label: 'Ricostruzione della griglia…' };
    result.info.cannyHigh = cannyHigh;
    result.info.edgePixels = cv.countNonZero(edges);

    if (wantEdges) {
      // Build an RGBA ImageData from the single-channel edge mask (DOM-free, so it
      // also works inside a Web Worker).
      const ew = edges.cols;
      const eh = edges.rows;
      const buf = new Uint8ClampedArray(ew * eh * 4);
      const em = edges.data as Uint8Array;
      for (let i = 0; i < ew * eh; i++) {
        const v = em[i];
        buf[i * 4] = v;
        buf[i * 4 + 1] = v;
        buf[i * 4 + 2] = v;
        buf[i * 4 + 3] = 255;
      }
      result.edges = new ImageData(buf, ew, eh);
    }

    if (wantEdges) {
      // FIXED structural topology — every stage is drawn (even skipped ones) with its
      // in/out arrows.
      // The Hough node of the pipeline that actually won (so the graph highlights the real path).
      const winnerHough = result === morphFit ? 'houghMorph' : 'houghLum';
      const topo: Record<string, string[]> = {
        foto: [],
        gray: ['foto'],
        clahe: ['gray'],
        blur: ['clahe'],
        canny: ['blur'],
        // Chromatic branch: colour-only edges are folded INTO the luminance 'edges' (no separate
        // candidate) — a hue-only grid (brown-on-earth) reaches the MAIN Hough this way.
        chroma: ['foto'],
        edges: ['canny', 'chroma'],
        clean: ['edges'],
        oriented: ['clean'],
        // Morphological pass, exploded: it runs from GRAY (its own denoise/invert
        // is folded into the ridge nodes), forks into a horizontal and a vertical line
        // extractor, then the two rejoin into the final mask.
        mridgeh: ['gray'],
        mridgev: ['gray'],
        mbinh: ['mridgeh'],
        mbinv: ['mridgev'],
        morph: ['mbinh', 'mbinv'],
        // Each pipeline runs its OWN Hough → raw detected lines; the final grid is the fit the
        // consensus fusion selected.
        houghLum: ['oriented'],
        houghMorph: ['morph'],
        overlay: ['houghLum', 'houghMorph'],
      };
      const label: Record<string, string> = {
        foto: 'Foto', gray: 'Grigio', clahe: 'Contrasto', blur: 'Sfocatura', canny: 'Canny',
        chroma: 'Bordi colore', edges: 'Bordi uniti', clean: 'Pulizia texture',
        oriented: 'Orientati', mridgeh: 'Cresta H', mridgev: 'Cresta V', mbinh: 'Linee H',
        mbinv: 'Linee V', morph: 'Morfologica', houghLum: 'Hough L', houghMorph: 'Hough M',
        overlay: 'Griglia',
      };
      const executed: Record<string, boolean> = {
        foto: true, gray: true, clahe: true, blur: true, canny: true,
        chroma: chromaExecuted, edges: true, clean: cleanApplied,
        oriented: orientedRan, mridgeh: morphRan, mridgev: morphRan, mbinh: morphRan, mbinv: morphRan,
        morph: morphRan, houghLum: true, houghMorph: morphRan, overlay: true,
      };
      // The ACTUAL data path to the final grid (walk back through the input each stage
      // really used — bypassing skipped stages / non-contributing branches).
      const realInput: Record<string, string[]> = {
        overlay: [winnerHough],
        houghLum: [orientedAdopted ? 'oriented' : cleanApplied ? 'clean' : 'edges'],
        houghMorph: ['morph'],
        oriented: [cleanApplied ? 'clean' : 'edges'],
        clean: ['edges'],
        edges: chromaContributed ? ['canny', 'chroma'] : ['canny'],
        canny: ['blur'],
        blur: ['clahe'],
        clahe: ['gray'],
        gray: ['foto'],
        chroma: ['foto'],
        morph: ['mbinh', 'mbinv'],
        mbinh: ['mridgeh'],
        mbinv: ['mridgev'],
        mridgeh: ['gray'],
        mridgev: ['gray'],
        foto: [],
      };
      const used = new Set<string>();
      const stack = ['overlay'];
      while (stack.length) {
        const id = stack.pop()!;
        if (used.has(id) || !executed[id]) continue;
        used.add(id);
        for (const inp of realInput[id] ?? []) stack.push(inp);
      }
      result.debugSteps = Object.keys(topo).map((id) => ({
        id,
        label: label[id],
        image: previews[id],
        inputs: topo[id],
        executed: executed[id],
        used: used.has(id),
      }));

      // Per-candidate confidence: each candidate's FUSED confidence (its own calibrated
      // quality lifted by any consensus), so the panel shows the same probability the final
      // decision used. The chosen one's chip equals the "Finale" chip.
      result.debugPipelines = candidates.map((c, i) => ({
        id: c.id,
        label: c.label,
        strength: gridStrength(c.r),
        // The chosen candidate shows the FINAL fused confidence so its chip equals the "Finale" chip;
        // the others show their own fused value.
        confidence: i === winnerIdx ? fusedConfidence : (fused.confidences[i] ?? c.r.info.confidence),
        cells: [Math.max(0, c.r.info.aCount - 1), Math.max(0, c.r.info.bCount - 1)],
        degenerate: c.r.info.degenerate,
        chosen: i === winnerIdx,
      }));
      result.debugAgreement = agreement;
      result.debugTimings = timings;
      result.debugRawLum = mainFit.rawLines;
      if (morphFit) result.debugRawMorph = morphFit.rawLines;
    }

    // Stamp the FUSED confidence (after the panel above captured each candidate's value).
    result.info.confidence = fusedConfidence;

    return result;
  } finally {
    if (clahe) clahe.delete();
    if (gray) gray.delete();
    if (eq) eq.delete();
    if (blurred) blurred.delete();
    if (cannyEdges) cannyEdges.delete();
    if (morphEdges) morphEdges.delete();
  }
}

/** Adaptive Hough on an edge mask + grid fit. The accumulator threshold is a
 * fraction of the shorter side and self-tunes: too few lines -> relax; far too
 * many -> tighten. Shared by the Canny path and the morphological fallback. */
function houghToGrid(
  cv: any,
  edges: any,
  work: any,
  scale: number,
  W0: number,
  H0: number,
  params: DetectorParams,
  orientPrior: { a: number; b: number } | null = null,
): GridResult {
  const minDim = Math.min(work.cols, work.rows);
  const linesMat = new cv.Mat();
  let usedHough = Math.max(30, Math.round(minDim * 0.3));
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      cv.HoughLines(edges, linesMat, 1, Math.PI / 360, usedHough); // 0.5° angular resolution
      const n = linesMat.rows;
      if (n < 8 && usedHough > 25) {
        usedHough = Math.max(20, Math.round(usedHough * 0.6));
        continue;
      }
      if (n > 600) {
        usedHough = Math.round(usedHough * 1.5);
        continue;
      }
      break;
    }
    let raw: RawLine[] = [];
    for (let i = 0; i < linesMat.rows; i++) {
      const rho = linesMat.data32F[i * 2];
      const theta = linesMat.data32F[i * 2 + 1];
      // OpenCV's convention: theta in [0,pi) and rho SIGNED. Keep rho signed — the
      // offset projection (rho*cos(theta-mean)) is already sign-correct, and forcing
      // rho positive would collapse two distinct parallel lines onto one.
      let thetaDeg = theta * DEG;
      thetaDeg = ((thetaDeg % 180) + 180) % 180;
      raw.push({ rho, thetaDeg });
    }
    // Collapse near-duplicate detections of the SAME physical line: Hough fires several
    // adjacent (ρ,θ) cells for one thick/anti-aliased line, so the raw output is cluttered
    // with "collapsible" lines that inflate the count and confuse the fit. HoughLines returns
    // lines vote-descending, so a greedy non-maximum suppression keeps the strongest of each
    // cluster and drops the rest. The window is a few working-px / ~2°, far below a grid's
    // cell pitch, so distinct grid lines are never merged. See dedupeHoughLines.
    raw = dedupeHoughLines(raw, Math.max(2, minDim * 0.008), HOUGH_DEDUP_DEG);
    // Orientation gate: we're looking for a GRID, so keep only lines whose angle is near
    // one of the two dominant orientations (from the FFT prior) — dropping diagonals, text
    // and off-grid clutter. The tolerance is generous so the perspective fan (each family
    // spreads as it converges to its vanishing point) survives. Safety: if the gate would
    // discard most of the lines the prior probably doesn't match this mask, so skip it.
    if (orientPrior) {
      const gated = raw.filter(
        (l) =>
          angDist180(l.thetaDeg, orientPrior.a) <= HOUGH_ORIENT_TOL ||
          angDist180(l.thetaDeg, orientPrior.b) <= HOUGH_ORIENT_TOL,
      );
      if (gated.length >= 4 && gated.length >= raw.length * 0.3) raw = gated;
    }
    let result = buildGrid(raw, scale, W0, H0, params, orientPrior);
    // Degenerate fit = a phantom SUB-PITCH: thick / wavy lines (a physical mat, a
    // morphological mask) produce many close Hough responses that the default merge
    // distance doesn't collapse, so the lattice locks onto half/third the real pitch.
    // Re-fit the SAME raw lines with a progressively LARGER merge distance and take the
    // first non-degenerate result. Only triggers on a degenerate fit, so fine grids
    // (never degenerate) keep the tight default merge — no risk of merging real lines.
    if (result.info.degenerate) {
      for (let m = 2; m <= 4; m++) {
        const alt = buildGrid(raw, scale, W0, H0, { ...params, mergeFrac: params.mergeFrac * m }, orientPrior);
        if (!alt.info.degenerate) {
          result = alt;
          break;
        }
      }
    }
    result.info.usedHough = usedHough;
    return result;
  } finally {
    linesMat.delete();
  }
}

/** Max angle (deg) a raw Hough line may deviate from a dominant grid orientation (FFT
 * prior) to be kept. Generous so the perspective fan — each family spreads as it
 * converges to its vanishing point — isn't clipped; still drops off-grid diagonals/text. */
const HOUGH_ORIENT_TOL = 28;
/** Angular window (deg) within which two Hough lines are treated as the SAME line for the
 * duplicate-suppression pass. Small: distinct grid lines differ in OFFSET, not angle. */
const HOUGH_DEDUP_DEG = 3;

/**
 * Non-maximum suppression of duplicate Hough lines. Hough fires a little cluster of adjacent
 * (ρ,θ) cells for a single thick / anti-aliased line; those are "collapsible" duplicates that
 * inflate the line count and can pull the lattice pitch toward the sub-line spacing. `raw`
 * arrives vote-descending (OpenCV's order), so a greedy sweep keeps the strongest line of
 * each cluster and drops any later line within (`dRho`, `dThetaDeg`) of one already kept.
 *
 * Offsets are compared with SIGN-AWARE alignment: θ∈[0,180) already fixes the normal to the
 * upper half-plane, but a line seen at θ≈0 and its twin at θ≈180 have opposite normals, so
 * their ρ flips sign. `cos(Δθ)<0` detects that and negates the candidate's ρ before comparing
 * — never averaging raw ρ across the 0/180° wrap (that wrap bug shifts lines badly). Pure. */
export function dedupeHoughLines(raw: RawLine[], dRho: number, dThetaDeg: number): RawLine[] {
  const kept: RawLine[] = [];
  for (const c of raw) {
    let dup = false;
    for (const k of kept) {
      if (angDist180(k.thetaDeg, c.thetaDeg) > dThetaDeg) continue;
      const rc = Math.cos((c.thetaDeg - k.thetaDeg) / DEG) < 0 ? -c.rho : c.rho; // align opposite normals
      if (Math.abs(k.rho - rc) <= dRho) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}
/** Angular half-width (deg) an edge pixel's gradient may deviate from the LOCAL
 * expected grid normal and still be kept. Vanishing-point-aware, so it can stay tight. */
const ORIENT_TOL_DEG = 15;
/** If the gate would keep less than this fraction of the edge pixels, the families
 * probably don't describe the real grid — skip it. */
const ORIENT_MIN_KEEP = 0.15;
/** Only run the oriented re-extraction as a RECOVERY: skip it once the first fit already
 * has this many detected lines per family (it's a clear grid, nothing to rescue). */
const ORIENT_SKIP_STRENGTH = 6;

/**
 * Vanishing-point-aware oriented edge re-extraction. Using the FIRST fit's two families
 * (their vanishing points, or mean orientation when parallel), keep only edge pixels
 * whose gradient (= line-normal) matches the **locally** expected grid normal of either
 * family within `tolDeg`. Because the expected normal is computed from the pixel's
 * direction to each vanishing point, it FOLLOWS the perspective fan — a fixed global
 * angle would erase the strongly-converging family. Returns a NEW mask (caller owns it)
 * + kept fraction, or null if the fit has no usable family orientation. Does not mutate
 * `edges`. Coordinates: family lines are in original image space, `edges` is at working
 * resolution, so vanishing points are scaled by `scale`.
 */
function orientEdgesVP(
  cv: any,
  gray: any,
  edges: any,
  scale: number,
  familyA: Line2[],
  familyB: Line2[],
  tolDeg: number,
): { mask: any; keptFrac: number } | null {
  const meanNorm = (fam: Line2[]): number | null =>
    fam.length ? meanAngle180(fam.map((l) => angleOfDeg(l.nx, l.ny))) : null;
  const mnA = meanNorm(familyA);
  const mnB = meanNorm(familyB);
  if (mnA == null && mnB == null) return null;
  const vpA = familyA.length >= 2 ? vanishingPoint(familyA) : null; // original coords
  const vpB = familyB.length >= 2 ? vanishingPoint(familyB) : null;
  const axw = vpA ? vpA.x * scale : 0;
  const ayw = vpA ? vpA.y * scale : 0;
  const bxw = vpB ? vpB.x * scale : 0;
  const byw = vpB ? vpB.y * scale : 0;

  const gx = new cv.Mat();
  const gy = new cv.Mat();
  try {
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
    const out = edges.clone();
    const em = out.data as Uint8Array;
    const gxD = gx.data32F as Float32Array;
    const gyD = gy.data32F as Float32Array;
    const W = out.cols;
    const fold = (deg: number): number => (((deg % 180) + 180) % 180);
    let kept = 0;
    let total = 0;
    for (let i = 0; i < em.length; i++) {
      if (!em[i]) continue;
      total++;
      const px = i % W;
      const py = (i / W) | 0;
      const gnorm = fold(Math.atan2(gyD[i], gxD[i]) * DEG); // gradient = line normal
      // Expected normal of family A at this pixel: line points to VP_A (finite) or has
      // the constant parallel orientation; its normal is that direction + 90°.
      let ok = false;
      if (mnA != null) {
        const nA = vpA ? fold(Math.atan2(ayw - py, axw - px) * DEG + 90) : mnA;
        ok = angDist180(gnorm, nA) <= tolDeg;
      }
      if (!ok && mnB != null) {
        const nB = vpB ? fold(Math.atan2(byw - py, bxw - px) * DEG + 90) : mnB;
        ok = angDist180(gnorm, nB) <= tolDeg;
      }
      if (ok) kept++;
      else em[i] = 0;
    }
    return { mask: out, keptFrac: total ? kept / total : 0 };
  } finally {
    gx.delete();
    gy.delete();
  }
}

/** Detected lines per family at which the morphological fit counts as a clear grid, so
 * the deskew angle sweep can stop early. */
const MORPH_STRONG = 6;
/** Deskew sweep step (deg) over a square grid's [-45,45] tilt range. Small enough that
 * some candidate lands within the axis-aligned openings' few-degrees tolerance; larger
 * = fewer (but coarser) morphology passes. */
const MORPH_SWEEP_STEP = 7.5;
/** Fraction of edge pixels above which the frame is treated as texture-DOMINATED (noise):
 * the short-component cleanup is applied, and a disagreeing main fit is distrusted. Kept
 * high enough that a clean grid (thin, sparse edges) stays below it. */
const NOISE_EDGE_FRAC = 0.08;
/** When the raw luminance Canny is flooded (density above the frac), re-run it with the
 * thresholds scaled by this, keeping only the strong edges — a textured surface's weak
 * edges drop out while the sharper grid lines survive. */
const NOISE_CANNY_BOOST = 1.6;
/** On a noisy frame, distrust the luminance fit and prefer the (noise-robust) morphology
 * when the two DISAGREE below this and the morph fit is at least this solid. */
const NOISE_AGREE_MAX = 0.4;
const NOISE_MORPH_MIN = 4;
/** Signed tilt (deg, [-45,45]) of an angle from the nearest image axis. Normal vs line
 * angle folds away (they differ by 90°), so the caller's convention doesn't matter. */
const residualTilt = (deg: number): number => {
  if (!Number.isFinite(deg)) return 0;
  let r = ((deg % 90) + 90) % 90; // [0,90)
  if (r > 45) r -= 90; // [-45,45]
  return r;
};

/** Deskew angles to try when the first morphology guess is weak, ordered most-likely
 * first (for early-out). With a reliable orientation prior we probe only a NARROW window
 * around it — BOTH signs cover the ± ambiguity of the tilt, ±step a small prior error —
 * which is far fewer passes than the full [-45,45] sweep used when there's no prior. */
function deskewSweepAngles(off: number, hasPrior: boolean): number[] {
  const step = MORPH_SWEEP_STEP;
  const out: number[] = [];
  const add = (a: number) => {
    if (a >= -45 && a <= 45 && !out.some((x) => Math.abs(x - a) < step / 2)) out.push(a);
  };
  if (hasPrior) {
    for (const base of [-off, off]) for (const d of [base, base - step, base + step]) add(d);
    add(0);
  } else {
    for (let a = -45; a <= 45; a += step) add(a);
  }
  return out;
}

/** Morphological line extractor for noisy / low-contrast photos (e.g. a grid drawn
 * on a dirt or cork texture) where Canny drowns in speckle. Isotropic texture is
 * suppressed and long thin dark lines are kept, giving a clean edge mask for Hough.
 * Returns a binary mask at `gray`'s resolution (the caller deletes it).
 *
 * How it works: downscale (fine speckle averages out, lines survive) -> invert
 * (dark lines become bright ridges) -> for the horizontal and vertical directions,
 * a directional opening MINUS an isotropic opening = a line-only response in which
 * the background and speckle cancel -> threshold at mean + K·σ -> re-open ALONG the
 * line to drop residual blobs -> combine -> dilate. Broken lines are fine: Hough
 * sums the fragments that share a (rho, theta), and the lattice fit rebuilds gaps.
 *
 * NOTE (orientation bias): the directional openings use AXIS-ALIGNED structuring
 * elements (L×1, 1×L), so this responds to near-horizontal / near-vertical lines.
 * A grid strongly rotated leaves little response — so `deskewDeg` (when the grid's
 * tilt is known, e.g. from the FFT prior) rotates the image to straighten the grid
 * BEFORE the morphology and rotates the resulting mask back, extending the fallback
 * to oblique-but-flat shots. (Strong perspective, where lines converge, still can't be
 * straightened by a single angle.) `snap` (optional) exposes the intermediate H/V
 * stages to the debug graph. */
function rotateMat(cv: any, src: any, deg: number, interp: number, border: number): any {
  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const M = cv.getRotationMatrix2D(center, deg, 1);
  const dst = new cv.Mat();
  cv.warpAffine(src, dst, M, new cv.Size(src.cols, src.rows), interp, border, new cv.Scalar());
  M.delete();
  return dst;
}
function enhanceGridLines(
  cv: any,
  gray: any,
  snap?: (id: string, mat: any) => void,
  deskewDeg = 0,
  time?: <X>(key: string, fn: () => X) => X,
): any {
  // Optional per-sub-node timing (debug): wraps the ridge / line-binarisation phases so the
  // graph's morph nodes (Cresta/Linee H·V) each get a measured time. Identity when absent.
  const T = time ?? (<X>(_k: string, fn: () => X): X => fn());
  // Straighten a tilted grid first (BORDER_REPLICATE, so the rotated-in corners don't
  // become a hard frame edge that looks like a grid line). `src` is the caller's gray
  // when there's no deskew, or a NEW rotated Mat we own and free at the end.
  const src = deskewDeg ? rotateMat(cv, gray, deskewDeg, cv.INTER_LINEAR, cv.BORDER_REPLICATE) : gray;
  const MW = 1000; // work around ~1000px on the longer side (the SE sizes / threshold are
  // tuned for this scale — changing it needs retuning)
  const down = Math.min(1, MW / Math.max(src.cols, src.rows));
  let g = src;
  let tempG: any = null;
  if (down < 1) {
    tempG = new cv.Mat();
    cv.resize(src, tempG, new cv.Size(Math.round(src.cols * down), Math.round(src.rows * down)), 0, 0, cv.INTER_AREA);
    g = tempG;
  }
  const minDim = Math.min(g.cols, g.rows);
  const L = Math.max(9, Math.round(minDim / 23)); // line-probe length
  // min line run to keep: a bit shorter than a full grid line so a perspective-broken
  // line survives as pieces (Hough re-aggregates the collinear ones), but not SO short
  // that isolated texture blobs pass — that flooded the ridge with noise.
  const L2 = Math.max(10, Math.round(minDim / 20));
  const LC = Math.max(24, Math.round(minDim / 7)); // bridge collinear fragments

  const blur = new cv.Mat();
  cv.GaussianBlur(g, blur, new cv.Size(3, 3), 0);
  const inv = new cv.Mat();
  cv.bitwise_not(blur, inv);

  const hSE = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(L, 1));
  const vSE = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, L));
  const sq = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(L, L));
  const oH = new cv.Mat();
  const oV = new cv.Mat();
  const oS = new cv.Mat();
  const rH = new cv.Mat();
  const rV = new cv.Mat();
  // H ridge = horizontal directional opening minus the isotropic opening (the shared square
  // opening oS is computed here, once, and reused by the V ridge). V ridge = vertical minus oS.
  T('mridgeh', () => {
    cv.morphologyEx(inv, oH, cv.MORPH_OPEN, hSE);
    cv.morphologyEx(inv, oS, cv.MORPH_OPEN, sq);
    cv.subtract(oH, oS, rH);
  });
  T('mridgev', () => {
    cv.morphologyEx(inv, oV, cv.MORPH_OPEN, vSE);
    cv.subtract(oV, oS, rV);
  });
  snap?.('mridgeh', rH);
  snap?.('mridgev', rV);

  const hSE2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(L2, 1));
  const vSE2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, L2));
  const hSEc = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(LC, 1));
  const vSEc = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, LC));
  // Threshold the line response, open ALONG the line to drop residual blobs, then
  // close ALONG the line to bridge the gaps the speckle left — turning broken faint
  // lines into continuous ones so Hough forms a strong single peak per grid line.
  const binDir = (r: any, seOpen: any, seClose: any): any => {
    const me = new cv.Mat();
    const st = new cv.Mat();
    cv.meanStdDev(r, me, st);
    const gSig = st.data64F[0];
    me.delete();
    st.delete();
    const b = new cv.Mat();
    // Local adaptive threshold on the ridge: compare each pixel to its LOCAL mean (over an LC window)
    // rather than to a single global level. On a textured surface the GLOBAL σ is inflated by texture
    // so a global mean+K·σ would drown a faint grid; the local mean tracks the background, so the faint
    // ridge still stands out. `convertTo(dst,-1,1,β)` adds the σ margin per-element (avoids the
    // Scalar-as-Mat binding this OpenCV.js build rejects) and keeps r's 8-bit depth.
    const lm = new cv.Mat();
    cv.boxFilter(r, lm, -1, new cv.Size(LC, LC)); // local mean (ridge is 8-bit → ddepth -1)
    // Keep a pixel when its ridge response exceeds the LOCAL mean by ~1σ. A flat gridless region
    // has r≈local mean, so nothing passes there.
    const thr = new cv.Mat();
    lm.convertTo(thr, -1, 1, gSig); // thr = local mean + 1σ (same type as r → compare is valid)
    cv.compare(r, thr, b, cv.CMP_GT); // b = 255 where r > thr, else 0
    thr.delete();
    lm.delete();
    // Open ALONG the line to drop residual blobs, then close ALONG the line to bridge the gaps the
    // speckle left — turning broken faint lines into continuous ones so Hough forms one strong peak.
    cv.morphologyEx(b, b, cv.MORPH_OPEN, seOpen);
    cv.morphologyEx(b, b, cv.MORPH_CLOSE, seClose);
    return b;
  };
  const bH = T('mbinh', () => binDir(rH, hSE2, hSEc));
  const bV = T('mbinv', () => binDir(rV, vSE2, vSEc));
  snap?.('mbinh', bH);
  snap?.('mbinv', bV);
  let mask = new cv.Mat();
  cv.max(bH, bV, mask);
  // Drop the isolated small blobs the ridge left behind (residual texture noise) before
  // dilating — a grid line survives as a long component, a speck doesn't.
  dropShortComponents(cv, mask, shortLen(mask));
  const d3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(mask, mask, d3);

  // Back up to the caller's (work) resolution so Hough shares the same scale.
  if (down < 1) {
    const up = new cv.Mat();
    cv.resize(mask, up, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_NEAREST);
    mask.delete();
    mask = up;
  }

  [blur, inv, hSE, vSE, sq, oH, oV, oS, rH, rV, hSE2, vSE2, hSEc, vSEc, bH, bV, d3].forEach((x) => x.delete());
  if (tempG) tempG.delete();
  // Rotate the mask back into the original (un-deskewed) frame so its lines line up
  // with the real photo for Hough + the lattice fit. INTER_NEAREST keeps it binary.
  if (deskewDeg) {
    const back = rotateMat(cv, mask, -deskewDeg, cv.INTER_NEAREST, cv.BORDER_CONSTANT);
    mask.delete();
    mask = back;
    src.delete(); // the rotated-in gray we allocated (never the caller's gray)
  }
  return mask;
}

/** Below this std (0..255) a Lab chroma channel is treated as neutral (no colour
 * information) and skipped, so a near-grayscale photo adds no chromatic edges.
 * Conservative on purpose: a LOWER gate lets a textured surface's micro hue-variation
 * (cork/sand speckle) leak in as noise, which then pollutes the merged edge map the
 * main Hough sees. If chroma ever becomes its own independent "second opinion" fit
 * (not OR'd into the luminance edges) this can be relaxed safely. */
const CHROMA_MIN_STD = 3;

/**
 * Colour-only edge mask from the Lab chroma channels (a, b) of an RGBA image.
 * Luminance (L) is already handled by the grayscale Canny path; here we pick up
 * edges where only the hue changes. Each chroma channel is auto-Canny'd (Otsu,
 * mirroring the luminance path) and the two are OR'd. A near-neutral channel
 * (std < CHROMA_MIN_STD) is skipped. Returns an 8U mask at `work`'s resolution
 * (the caller ORs it into the luminance edges and deletes it).
 */
function chromaEdges(cv: any, work: any): any {
  const out = cv.Mat.zeros(work.rows, work.cols, cv.CV_8U);
  // Free the longer-lived temporaries in finally so a cv.* throw can't leak them.
  let rgb: any = null;
  let lab: any = null;
  let chans: any = null;
  try {
    rgb = new cv.Mat();
    cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);
    lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    rgb.delete();
    rgb = null;
    chans = new cv.MatVector();
    cv.split(lab, chans);
    lab.delete();
    lab = null;
    for (const idx of [1, 2]) {
      // a (1) and b (2) are the chroma channels; L (0) is luminance, already used.
      const ch = chans.get(idx);
      try {
        const me = new cv.Mat();
        const st = new cv.Mat();
        cv.meanStdDev(ch, me, st);
        const sigma = st.data64F[0];
        me.delete();
        st.delete();
        if (sigma >= CHROMA_MIN_STD) {
          const blur = new cv.Mat();
          cv.GaussianBlur(ch, blur, new cv.Size(3, 3), 0);
          const otsuTmp = new cv.Mat();
          const otsu = cv.threshold(blur, otsuTmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
          otsuTmp.delete();
          const e = new cv.Mat();
          // Mirror the luminance path's hysteresis (0.5/1.0·otsu): a lower threshold
          // catches subtler hue steps but drags in texture noise, which pollutes the
          // merged edges the main Hough sees — not worth it while chroma is OR'd in.
          cv.Canny(blur, e, Math.max(1, Math.round(0.5 * otsu)), Math.max(1, Math.round(otsu)));
          cv.max(out, e, out);
          blur.delete();
          e.delete();
        }
      } finally {
        ch.delete();
      }
    }
    return out;
  } finally {
    if (rgb) rgb.delete();
    if (lab) lab.delete();
    if (chans) chans.delete();
  }
}

/**
 * Suppress edge pixels that lie in out-of-focus regions. `gray` is the working
 * grayscale image, `edges` the Canny mask (modified in place). We build a local
 * sharpness map = mean |Laplacian| over a window, then keep only edges whose
 * local sharpness is at least a fraction of the MEDIAN sharpness among all edge
 * pixels. The median is robust, so a few very sharp/blurry outliers don't skew
 * it, and when everything is equally sharp the threshold is far below the bulk
 * and nothing is dropped.
 */
function gateEdgesByFocus(cv: any, gray: any, edges: any): void {
  const minDim = Math.min(gray.cols, gray.rows);
  if (minDim < 40) return;

  // Local sharpness: mean of |Laplacian| over a window (~4% of the short side).
  let win = Math.round(minDim * 0.04);
  win = Math.max(9, win | 1); // odd, >= 9
  const lap = new cv.Mat();
  const absLap = new cv.Mat();
  const sharp = new cv.Mat();
  try {
    // Explicit args: OpenCV.js (embind) is strict about argument counts.
    cv.Laplacian(gray, lap, cv.CV_16S, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(lap, absLap, 1, 0); // |Laplacian| as 8U
    cv.boxFilter(
      absLap,
      sharp,
      cv.CV_32F,
      new cv.Size(win, win),
      new cv.Point(-1, -1),
      true,
      cv.BORDER_DEFAULT,
    ); // local mean of |Laplacian|

    // Collect the local sharpness at edge pixels (subsampled for speed).
    const em = edges.data as Uint8Array;
    const sm = sharp.data32F as Float32Array;
    const n = em.length;
    const step = Math.max(1, Math.floor(n / 200000)); // cap the sample size
    const vals: number[] = [];
    let edgeCount = 0;
    for (let i = 0; i < n; i += step) {
      if (em[i]) {
        edgeCount++;
        vals.push(sm[i]);
      }
    }
    if (edgeCount < 500) return; // too few edges to judge focus reliably
    const med = median(vals);
    if (med <= 0) return;

    // Keep edges with local sharpness >= 0.35 * median. Only clearly-blurry
    // edges (well below the typical grid sharpness) are removed.
    const thr = 0.35 * med;
    const mask = new cv.Mat();
    try {
      cv.threshold(sharp, mask, thr, 255, cv.THRESH_BINARY);
      mask.convertTo(mask, cv.CV_8U);
      // If gating would wipe out almost everything, it's likely mis-firing on a
      // faint grid — bail out and keep the original edges.
      cv.bitwise_and(edges, mask, mask);
      if (cv.countNonZero(mask) < 0.15 * cv.countNonZero(edges)) return;
      mask.copyTo(edges);
    } finally {
      mask.delete();
    }
  } finally {
    lap.delete();
    absLap.delete();
    sharp.delete();
  }
}

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

interface Pt {
  x: number;
  y: number;
}

// --- Small homogeneous-geometry helpers (points/lines/homographies) ------
type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number];
const IDENTITY3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mulM3V = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const transpose3 = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function inv3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const Hh = -(a * f - c * d);
  const I = a * e - b * d;
  const s = 1 / det;
  return [A * s, D * s, G * s, B * s, E * s, Hh * s, C * s, F * s, I * s];
}

/** A line nx·x+ny·y=d as homogeneous coefficients (line·point=0). */
const lineToHom = (l: Line2): V3 => [l.nx, l.ny, -l.d];
const homToLine = (h: V3): Line2 => {
  const n = Math.hypot(h[0], h[1]) || 1;
  return { nx: h[0] / n, ny: h[1] / n, d: -h[2] / n };
};
const angleOfDeg = (nx: number, ny: number): number => {
  let a = (Math.atan2(ny, nx) * DEG) % 180;
  if (a < 0) a += 180;
  return a;
};

/**
 * Detect the grid as a TRUE 2-D lattice rather than a bag of independent lines.
 *
 *  1. Split the raw lines into two families by nearest orientation (no hard
 *     angle cut-off, so perspective spread never discards real lines).
 *  2. For each family, find its vanishing point by RANSAC and keep only the
 *     lines that actually CONCUR there — this is the grid pattern; text,
 *     drawings and stray marks that don't converge like the grid are rejected.
 *  3. Rectify with the horizon (the line through both vanishing points): in the
 *     rectified plane the two families are parallel and EVENLY spaced.
 *  4. Fit a regular lattice per family there, rebuild every row/column (filling
 *     occluded ones), then map the complete grid back into the image.
 */
/** 2-D Hann window as a CV_32F Mat (cached by size). */
let hannCache: { n: number; mat: any } | null = null;
function hannWindow(cv: any, N: number): any {
  if (hannCache && hannCache.n === N) return hannCache.mat;
  if (hannCache) hannCache.mat.delete();
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  const data = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data[y * N + x] = w[y] * w[x];
  const mat = cv.matFromArray(N, N, cv.CV_32F, data);
  hannCache = { n: N, mat };
  return mat;
}

/** In-place quadrant swap (fftshift) of an N×N Mat. */
function fftshift(cv: any, m: any, N: number): void {
  const c = N / 2;
  const q0 = m.roi(new cv.Rect(0, 0, c, c));
  const q1 = m.roi(new cv.Rect(c, 0, c, c));
  const q2 = m.roi(new cv.Rect(0, c, c, c));
  const q3 = m.roi(new cv.Rect(c, c, c, c));
  const t = new cv.Mat();
  q0.copyTo(t); q3.copyTo(q0); t.copyTo(q3);
  q1.copyTo(t); q2.copyTo(q1); t.copyTo(q2);
  t.delete(); q0.delete(); q1.delete(); q2.delete(); q3.delete();
}

/**
 * Global periodicity prior via FFT: the two dominant ORIENTATIONS of the grid (as
 * line-NORMAL angles in [0,180), same space as a RawLine's thetaDeg). A regular grid
 * is periodic, so its spectrum has sharp peaks whose direction is the grid's frequency
 * direction (= line normal). Robust to noise/faint contrast/distractors where Hough
 * latches onto local texture. Returns the two ~orthogonal family angles (a = strongest
 * peak, b = strongest peak 60–120° away at a similar radius) or null if there's no
 * clear second family. `gray` is the working grayscale Mat. (Pitch is NOT returned —
 * FFT can lock onto a harmonic; here we only use the reliable orientation.)
 */
function fftOrientations(cv: any, gray: any): { a: number; b: number } | null {
  const N = 512;
  const W = gray.cols;
  const H = gray.rows;
  const maxD = Math.max(W, H);
  const sc = N / maxD;
  const nw = Math.max(1, Math.round(W * sc));
  const nh = Math.max(1, Math.round(H * sc));
  let rs: any = null, gx: any = null, gy: any = null, gm: any = null, pad: any = null;
  let complex: any = null, planes: any = null, mag: any = null, bg: any = null;
  try {
    rs = new cv.Mat();
    cv.resize(gray, rs, new cv.Size(nw, nh), 0, 0, cv.INTER_AREA);
    gx = new cv.Mat();
    gy = new cv.Mat();
    cv.Sobel(rs, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(rs, gy, cv.CV_32F, 0, 1, 3);
    gm = new cv.Mat();
    cv.magnitude(gx, gy, gm);
    const top = Math.floor((N - nh) / 2);
    const left = Math.floor((N - nw) / 2);
    pad = new cv.Mat();
    cv.copyMakeBorder(gm, pad, top, N - nh - top, left, N - nw - left, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.multiply(pad, hannWindow(cv, N), pad);
    const zeros = cv.Mat.zeros(N, N, cv.CV_32F);
    planes = new cv.MatVector();
    planes.push_back(pad);
    planes.push_back(zeros);
    complex = new cv.Mat();
    cv.merge(planes, complex);
    zeros.delete();
    cv.dft(complex, complex);
    const sp = new cv.MatVector();
    cv.split(complex, sp);
    mag = new cv.Mat();
    cv.magnitude(sp.get(0), sp.get(1), mag);
    sp.delete();
    const one = cv.Mat.ones(N, N, cv.CV_32F);
    cv.add(mag, one, mag);
    one.delete();
    cv.log(mag, mag);
    fftshift(cv, mag, N);
    bg = new cv.Mat();
    cv.GaussianBlur(mag, bg, new cv.Size(0, 0), 9);
    cv.subtract(mag, bg, mag); // spectral high-pass (kill the low-freq background)

    const d = mag.data32F as Float32Array;
    const cx = N / 2;
    const cy = N / 2;
    const R0 = 12;
    const Rmax = N / 2 - 4;
    // Fix 4: earlier code ALSO skipped a ±3px band around the two frequency axes to suppress the
    // DC / finite-image "cross" streak — but the fundamental peaks of an UNROTATED (axis-aligned)
    // grid lie EXACTLY on those axes (a grid of vertical lines peaks on the horizontal freq axis,
    // horizontal lines on the vertical axis), so that blanket band discarded a legitimate grid's
    // OWN peaks and the prior went blind to axis-aligned grids. The near-DC cross is already
    // handled without a band: the R0 disk below drops the DC neighbourhood, the Hann window kills
    // the finite-image edge streak, and the spectral high-pass above removes the low-freq
    // background — so no axis exclusion is applied here.
    // RESIDUAL RISK (needs a negative-corpus browser check, not verifiable in Node): with the band
    // gone, strong axis-aligned CLUTTER (a table/door/window edge) can leave on-axis energy that
    // biases this orientation prior toward 0°/90° on a non-grid or diagonally-tiled photo. No new
    // heuristic guard is added here (it would need the same validation and could itself regress);
    // the bias is mitigated DOWNSTREAM — the reliability gate rejects a non-grid regardless of the
    // prior (needs ≥ MIN_GRID_CELLS detected lattice lines per family AND inlier ≥ 0.5), and the
    // prior only overrides the Hough split when it disagrees by > 15°.
    let mx = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r < R0 || r > Rmax) continue;
        const v = d[y * N + x];
        if (v > mx) mx = v;
      }
    }
    if (mx <= 0) return null;
    const thr = mx * 0.5;
    const cand: { v: number; r: number; ang: number }[] = [];
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r < R0 || r > Rmax) continue;
        const v = d[y * N + x];
        if (v < thr) continue;
        cand.push({ v, r, ang: (((Math.atan2(dy, dx) * DEG) % 180) + 180) % 180 });
      }
    }
    if (!cand.length) return null;
    cand.sort((p, q) => q.v - p.v);
    const p1 = cand[0];
    let p2b: { v: number; r: number; ang: number } | null = null;
    for (const c of cand) {
      const ad = angDist180(c.ang, p1.ang);
      if (ad >= 60 && ad <= 120 && Math.abs(c.r - p1.r) / p1.r < 0.4) {
        p2b = c;
        break;
      }
    }
    if (!p2b) return null; // no clear orthogonal second family → not a confident grid prior
    return { a: p1.ang, b: p2b.ang };
  } finally {
    for (const m of [rs, gx, gy, gm, pad, complex, mag, bg]) if (m) m.delete();
    if (planes) planes.delete();
  }
}

/** Min line length (px, working res) below which a connected component is treated as a
 * short fragment (texture/speckle), not part of a grid line. */
const shortLen = (mask: any): number => Math.max(12, Math.round(Math.min(mask.rows, mask.cols) / 45));

/**
 * Zero the connected components of a binary `mask` whose longer bounding-box side is
 * below `minLen` (in-place). A grid is long rows/columns, so this removes the many
 * short fragments a high-frequency texture (sand/dirt) leaves in the edge map, without
 * touching the long grid lines (a broken line is still several long-enough pieces).
 */
function dropShortComponents(cv: any, mask: any, minLen: number): void {
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  try {
    const nLab = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
    // stats: nLab × 5 (LEFT, TOP, WIDTH, HEIGHT, AREA), CV_32S.
    const sd = stats.data32S as Int32Array;
    const keep = new Uint8Array(nLab);
    for (let l = 1; l < nLab; l++) {
      if (Math.max(sd[l * 5 + cv.CC_STAT_WIDTH], sd[l * 5 + cv.CC_STAT_HEIGHT]) >= minLen) keep[l] = 1;
    }
    const lab = labels.data32S as Int32Array;
    const md = mask.data as Uint8Array;
    for (let i = 0; i < md.length; i++) if (md[i] && !keep[lab[i]]) md[i] = 0;
  } finally {
    labels.delete();
    stats.delete();
    centroids.delete();
  }
}

export function buildGrid(
  raw: RawLine[],
  scale: number,
  W0: number,
  H0: number,
  params: DetectorParams,
  orientPrior: { a: number; b: number } | null = null,
): GridResult {
  const rawLines: Line2[] = raw.map((l) => toLine2(l.rho, l.thetaDeg, scale));

  const empty: GridResult = {
    width: W0,
    height: H0,
    familyA: [],
    familyB: [],
    rawLines,
    info: {
      rawCount: raw.length,
      aCount: 0,
      bCount: 0,
      angleADeg: 0,
      angleBDeg: 0,
      spacingA: 0,
      spacingB: 0,
      usedHough: 0,
      cannyHigh: 0,
      edgePixels: 0,
      detectedA: 0,
      detectedB: 0,
      confidence: 0,
      cellsA: 0,
      cellsB: 0,
      inlierA: 0,
      inlierB: 0,
      degenerate: true, // no grid at all → treat as degenerate (offer the fallback)
      spanA: 0,
      spanB: 0,
    },
  };

  if (raw.length < 4) return empty;

  // Work in image-centred coordinates for numerical stability (keeps the
  // horizon away from the origin). Centring is a translation, so it changes
  // only each line's offset `d`, not its orientation.
  const cx = W0 / 2;
  const cy = H0 / 2;
  const toCentered = (l: Line2): Line2 => ({
    nx: l.nx,
    ny: l.ny,
    d: l.d - l.nx * cx - l.ny * cy,
  });
  const fromCentered = (l: Line2): Line2 => ({
    nx: l.nx,
    ny: l.ny,
    d: l.d + l.nx * cx + l.ny * cy,
    filled: l.filled,
    extended: l.extended,
  });

  // --- Split into two families by nearest orientation (no discard) ------
  const bins = new Array(90).fill(0); // 0..180 in 2° steps
  for (const l of raw) bins[Math.min(89, Math.floor(l.thetaDeg / 2))]++;
  let peak = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
  let axisA = peak * 2 + 1;
  let axisB = (axisA + 90) % 180;
  // FFT orientation prior: if the histogram peak matches NEITHER prior family, it
  // locked onto a wrong orientation (e.g. a 45° diagonal off a tiled floor) — trust
  // the periodicity prior instead. A matching prior leaves the split unchanged.
  if (orientPrior) {
    const off = Math.min(angDist180(axisA, orientPrior.a), angDist180(axisA, orientPrior.b));
    if (off > 15) {
      axisA = orientPrior.a;
      axisB = orientPrior.b;
    }
  }

  const famA: Line2[] = [];
  const famB: Line2[] = [];
  for (let i = 0; i < raw.length; i++) {
    const dA = angDist180(raw[i].thetaDeg, axisA);
    const dB = angDist180(raw[i].thetaDeg, axisB);
    (dA <= dB ? famA : famB).push(toCentered(rawLines[i]));
  }

  // Merge the several Hough hits that fall on each real line into one (keeping
  // a support count), so the lattice cell isn't mistaken for the sub-pixel
  // spacing between duplicate detections of the same line.
  const mergeDist = (params.mergeFrac * params.maxDim) / (scale || 1);
  const mA = mergeDuplicateLines(famA, mergeDist);
  const mB = mergeDuplicateLines(famB, mergeDist);

  // --- Vanishing point per family (RANSAC) — keeps only concurrent lines --
  // Lines are in centred coords, so the frame half-extents are W0/2, H0/2.
  const vA = ransacVP(mA.map((m) => m.line), W0 / 2, H0 / 2);
  const vB = ransacVP(mB.map((m) => m.line), W0 / 2, H0 / 2);
  const inA = vA.inliers.map((k) => mA[k]);
  const inB = vB.inliers.map((k) => mB[k]);

  // --- Rectify with the horizon, then fit + rebuild the lattice ---------
  // Extension works in the centred coordinate frame used for fitting; a line
  // is worth extrapolating only while it still crosses the actual image frame.
  const crossesImage = (l: Line2): boolean => !!clipLineToRect(fromCentered(l), W0, H0);
  const minCell = Math.min(W0, H0) / MAX_CELLS_ACROSS;

  // Grid SIZE = cells of each family across the image at the detected pitch. The image's
  // extent along a family's normal is |cos·W| + |sin·H| (so it's rotation-robust), divided
  // by the pitch. Feeds both the size-plausibility term of the confidence and the UI gate.
  const cellsAcross = (angleDeg: number, spacing: number): number => {
    if (!(spacing > 0)) return 0;
    const a = angleDeg / DEG;
    return (Math.abs(Math.cos(a)) * W0 + Math.abs(Math.sin(a)) * H0) / spacing;
  };

  // Fit BOTH families with ONE rectification and score the resulting pair. `degenerate`,
  // `cellsAcross`, the sub-pitch guard and each line's backToImage all read the families in
  // image space but assume they came from a SINGLE coherent plane — so the rectification is
  // chosen per-PAIR, never mixed between families (a mixed H would be geometrically incoherent).
  const fitPair = (Hm: M3) => {
    const A = fitFamilyGrid(inA, Hm, params, crossesImage, minCell);
    const B = fitFamilyGrid(inB, Hm, params, crossesImage, minCell);
    // A degenerate (sub-pitch) fit has an implausibly small cell — reconstruction
    // was already skipped for it; also drop its confidence to ~0 so the UI warns.
    const degenerate =
      (A.spacing > 0 && A.spacing < minCell) || (B.spacing > 0 && B.spacing < minCell);
    const cellsA = cellsAcross(A.angleDeg, A.spacing);
    const cellsB = cellsAcross(B.angleDeg, B.spacing);
    // Cell squareness (ratio of the two families' pitches) feeds the confidence's soft
    // squareness term; cellsA/cellsB stay for `info` and the fusion size tie-break.
    const pitchA = A.spacing;
    const pitchB = B.spacing;
    const aspect =
      pitchA > 0 && pitchB > 0 ? Math.max(pitchA / pitchB, pitchB / pitchA) : Infinity;
    const confidence = gridConfidence(A.metrics, B.metrics, degenerate, aspect);
    return { A, B, degenerate, cellsA, cellsB, confidence, minCount: Math.min(A.metrics.count, B.metrics.count) };
  };

  // Fix 1 (Symptom A — an obvious grid reads confidence 0): a marginally-wrong vanishing point
  // makes buildRectify's H smear the rectified offsets, collapsing a family to ~2 lines and
  // zeroing the geometric-mean confidence. Re-fit the WHOLE pair with the IDENTITY rectification
  // too and keep the better-scoring pair. Chosen per-PAIR (not per-family) so both families
  // always share one plane — see fitPair. A correctly-rectified perspective grid TYPICALLY keeps
  // its H-fit (identity smears it → lower confidence); this improves the collapsed-family case
  // but is a heuristic, not a formal guarantee — a mildly-off VP could still let a plausible-but-
  // wrong identity lattice edge ahead, so it wants validation on the label gallery. buildRectify
  // returns the IDENTITY3 const itself when there's no perspective, so the second fit is
  // redundant then and skipped.
  const H = buildRectify(vA.vp, vB.vp);
  // Fit H, and if it's a real rectification also fit identity and keep the better pair,
  // rescuing a family a marginally-wrong VP smeared to ~2 lines.
  let chosen = fitPair(H);
  if (H !== IDENTITY3) {
    const withIdentity = fitPair(IDENTITY3);
    if (betterPair(withIdentity, chosen)) chosen = withIdentity;
  }
  const { A, B, degenerate, cellsA, cellsB, confidence } = chosen;

  const familyA = A.lines.map(fromCentered);
  const familyB = B.lines.map(fromCentered);

  const result: GridResult = {
    width: W0,
    height: H0,
    familyA,
    familyB,
    rawLines,
    debugFit: {
      split: [famA.length, famB.length],
      merged: [mA.length, mB.length],
      vp: [inA.length, inB.length],
      lattice: [A.metrics.count, B.metrics.count],
    },
    info: {
      rawCount: raw.length,
      aCount: familyA.length,
      bCount: familyB.length,
      angleADeg: A.angleDeg,
      angleBDeg: B.angleDeg,
      spacingA: A.spacing,
      spacingB: B.spacing,
      usedHough: 0,
      cannyHigh: 0,
      edgePixels: 0,
      detectedA: detectedCount(familyA),
      detectedB: detectedCount(familyB),
      // Calibrated grid confidence: both axes must look like a grid (geometric mean of the
      // two families' calibrated qualities) AND be a plausible size, 0 if degenerate. NOT a
      // raw line count. This is the per-candidate INTERNAL confidence; consensus lifts it.
      confidence,
      cellsA,
      cellsB,
      inlierA: A.metrics.inlier,
      inlierB: B.metrics.inlier,
      degenerate,
      spanA: A.metrics.span,
      spanB: B.metrics.span,
    },
  };

  return result;
}

/** Angular residual (deg) of a line vs "passes through the vanishing point". */
function vpResidualDeg(l: Line2, vp: V3): number {
  const tx = -l.ny;
  const ty = l.nx; // line direction
  let dx: number;
  let dy: number;
  if (Math.abs(vp[2]) < 1e-9) {
    dx = vp[0];
    dy = vp[1]; // point at infinity: its direction
  } else {
    const px = vp[0] / vp[2];
    const py = vp[1] / vp[2];
    dx = px - l.nx * l.d; // foot of the line minus VP
    dy = py - l.ny * l.d;
  }
  const dn = Math.hypot(dx, dy);
  if (dn < 1e-9) return 0;
  const cosv = Math.min(1, Math.abs((tx * dx + ty * dy) / dn));
  return Math.acos(cosv) * DEG;
}

/**
 * Robustly find a family's vanishing point and the lines that concur at it.
 * Grid lines converge to a common point (finite under perspective, at infinity
 * when parallel); noise lines don't, so this rejects them.
 */
/** Min angular fan (deg) among inliers before a FINITE vanishing point is trusted
 * — near-parallel lines intersect at a wildly unstable far point. */
const VP_MIN_FAN_DEG = 4;
/** A real grid family's vanishing point USUALLY lies OUTSIDE the frame; a finite VP
 * within this multiple of the half-frame is normally spurious (Hough-noise
 * intersection). But a floor/table shot at a shallow angle has a GENUINE in-frame
 * vanishing point — see VP_STRONG_* below, which overrides this rejection. */
const VP_FRAME_MARGIN = 1.3;
/** Strong-evidence override: an in-frame finite VP is trusted anyway when many
 * inliers concur (VP_STRONG_MIN_INLIERS) over a wide angular fan (VP_STRONG_FAN_DEG).
 * A fronto-parallel grid fans ~0° so it never qualifies (stays "parallel"); only a
 * real perspective pencil of lines does — this is what rescues shallow floor shots
 * from collapsing to a fronto-parallel 2×2. */
const VP_STRONG_FAN_DEG = 8;
const VP_STRONG_MIN_INLIERS = 6;

function ransacVP(
  lines: Line2[],
  halfW = Infinity,
  halfH = Infinity,
): { vp: V3; inliers: number[] } {
  const N = lines.length;
  if (N < 3) return { vp: [0, 0, 1], inliers: lines.map((_, i) => i) };

  const angTol = 1.5; // degrees
  const total = (N * (N - 1)) / 2;
  const stride = total <= 4000 ? 1 : Math.max(1, Math.floor((N - 1) / (8000 / N)));

  let best: number[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j += stride) {
      const vp = cross3(lineToHom(lines[i]), lineToHom(lines[j]));
      if (Math.hypot(vp[0], vp[1], vp[2]) < 1e-9) continue;
      const inl: number[] = [];
      for (let k = 0; k < N; k++) if (vpResidualDeg(lines[k], vp) <= angTol) inl.push(k);
      if (inl.length > best.length) best = inl;
    }
  }
  if (best.length < 3) return { vp: [0, 0, 1], inliers: lines.map((_, i) => i) };

  // Refine the VP, but only TRUST a finite VP when the inliers actually fan (else
  // the far intersection is noise) AND it lands outside the image frame (a real
  // family's VP must be off-frame). Otherwise treat the family as parallel — the
  // stable "VP at infinity from the mean direction", which avoids feeding a
  // garbage horizon into buildRectify and compressing the lattice to a sub-pitch.
  const meanA = meanAngle180(best.map((k) => angleOfDeg(lines[k].nx, lines[k].ny)));
  const fan = Math.max(...best.map((k) => angDist180(angleOfDeg(lines[k].nx, lines[k].ny), meanA)));
  let refined = fan >= VP_MIN_FAN_DEG ? vanishingPoint(best.map((k) => lines[k])) : null;
  // A wide fan of many concurrent lines is a GENUINE vanishing point even inside the
  // frame (shallow floor/table shot) — trust it. Otherwise an in-frame VP is spurious.
  const strongVP = fan >= VP_STRONG_FAN_DEG && best.length >= VP_STRONG_MIN_INLIERS;
  if (
    refined &&
    !strongVP &&
    Math.abs(refined.x) < halfW * VP_FRAME_MARGIN &&
    Math.abs(refined.y) < halfH * VP_FRAME_MARGIN
  ) {
    refined = null; // finite VP inside the frame → spurious
  }
  let vp: V3;
  if (refined) {
    vp = [refined.x, refined.y, 1];
  } else {
    const dir = (meanA + 90) / DEG; // line direction
    vp = [Math.cos(dir), Math.sin(dir), 0];
  }
  return { vp, inliers: best };
}

/** Rectifying homography that sends the horizon (VP_A × VP_B) to infinity. */
function buildRectify(vpA: V3, vpB: V3): M3 {
  const horizon = cross3(vpA, vpB);
  const hn = Math.hypot(horizon[0], horizon[1]);
  if (hn < 1e-9) return IDENTITY3; // both VPs at infinity -> no perspective
  const l0 = horizon[0] / hn;
  const l1 = horizon[1] / hn;
  const l2 = horizon[2] / hn;
  if (!isFinite(l2) || Math.abs(l2) < 1e-6) return IDENTITY3; // horizon through centre
  return [1, 0, 0, 0, 1, 0, l0, l1, l2];
}

interface FamilyGrid {
  lines: Line2[];
  angleDeg: number;
  spacing: number;
  metrics: FamilyMetrics; // rectified-plane evidence; `familyQuality(metrics)` is the score
}

/** Raw per-family evidence, measured in the RECTIFIED plane (perspective removed, so a
 * real grid is evenly spaced). These feed the calibrated `familyQuality`. */
export interface FamilyMetrics {
  count: number; // DETECTED (non-filled) distinct lines that sit on the fitted lattice
  span: number; // lattice positions across the detected extent (kmax−kmin+1), gaps included
  fill: number; // count / span — how COMPLETE the lattice is (occlusion lowers it)
  inlier: number; // fraction of the family's raw lines that land on the lattice (regularity)
}

const EMPTY_METRICS: FamilyMetrics = { count: 0, span: 0, fill: 0, inlier: 0 };

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * "How much does this ONE family look like a grid axis", in [0,1] — from interpretable
 * rectified-plane evidence, NOT a raw line count. Two factors, each with a plain meaning:
 *   • evidence — enough regularly-spaced lines. A single line is no axis (0); the score
 *                ramps up with more detected lattice lines and SATURATES to 1 by ~7 lines
 *                (a clean, many-line axis is unambiguous). Smooth, so an occlusion that
 *                drops one line doesn't cliff the score.
 *   • quality  — how good those lines are: inlier (regularity — the fraction of the family's
 *                lines that actually sit on the lattice; the strongest single signal, texture
 *                throws lines off-lattice) weighted above fill (completeness across the
 *                detected extent; occlusion lowers it, so it's weighted gently).
 * The two MULTIPLY: an axis needs both real evidence AND regular lines. A clean complete
 * many-line axis reaches 1; a 1-line "family" is 0. Pure — unit-tested directly. */
export function familyQuality(m: FamilyMetrics): number {
  const evidence = clamp01((m.count - 1) / 6); // 1→0, 2→0.17, 4→0.5, 7+→1
  const quality = 0.6 * m.inlier + 0.4 * m.fill; // regularity dominant, completeness gentle
  return clamp01(evidence * quality);
}

/** Smallest / largest grid a real tactical map plausibly is, in CELLS per side. A 2×2 is a
 * strong-perspective collapse; a 60×60 is a fine texture / graph paper the fit locked onto —
 * neither is a usable battle grid. The confidence ramps to 0 outside these, and the UI gate
 * refuses to draw outside them. (Kept here so the detector and the UI share one definition.) */
export const MIN_GRID_CELLS = 5;
export const MAX_GRID_CELLS = 25;

/** Max ratio between the two families' cell pitches before the cell is "too rectangular" to be
 * a tactical square-grid cell. A perfect grid has aspect ≈ 1; a mis-estimated pitch on one axis
 * blows it up. Shared by the confidence's squareness term (soft decay) and the UI draw gate
 * (hard reject). Kept here so detector and UI share one definition. */
export const MAX_CELL_ASPECT = 6;

/** Size-plausibility of ONE axis in [0,1]: 1 inside [MIN,MAX] cells, ramping to 0 just below
 * MIN (a too-coarse 2–3 cell collapse) and above MAX (a too-fine texture lock). Pure. */
export function cellCountPlausibility(cells: number): number {
  if (cells <= 0) return 0;
  if (cells < MIN_GRID_CELLS) return clamp01((cells - (MIN_GRID_CELLS - 2)) / 2); // 3→0, 5→1
  if (cells > MAX_GRID_CELLS) return clamp01((MAX_GRID_CELLS * 1.4 - cells) / (MAX_GRID_CELLS * 0.4)); // 25→1, 35→0
  return 1;
}

/** Calibrated grid confidence in [0,1] BEFORE any cross-method consensus. Interpretable and
 * CLIFF-FREE — it degrades smoothly instead of snapping to 0, because the winner-selection and
 * the draw gate depend on it and an obvious grid must never read exactly 0:
 *   • pair       — a soft-AND of the two axes' qualities: the grid is MOSTLY as good as its
 *                  WEAKER axis (0.7·min), with partial credit for the stronger (0.3·max). A
 *                  lone strong axis is just parallel lines (low), but a strong axis + an
 *                  occluded/foreshortened one still reads as a partial grid — it is NOT zeroed,
 *                  matching the gate that can still rescue such a fit.
 *   • squareness — a tactical cell is ~square; an elongated cell (aspect ≫ 1) means a
 *                  mis-estimated pitch on one axis. Soft decay from 1 (square) to a floor by
 *                  MAX_CELL_ASPECT — a penalty, never a hard 0.
 *   • degenerate — a sub-pitch fit is broken geometry: a HEAVY penalty (×0.1), but not a hard
 *                  0, so a less-broken candidate still outranks a more-broken one during fusion.
 * NOTE: cell-count plausibility is deliberately NOT a factor here — it was zeroing real grids
 * and contradicts the draw gate (whose cell-count limit was removed). It survives only as a
 * fusion tie-break (see `fuseGrids`/`shapeOf`). Pure — unit-tested directly. */
/** Harmonic-aware aspect (audit BUG-2): a family whose pitch is an integer SUB-multiple of the
 * other's — a ×m harmonic sub-pitch fabricated by an over-merge (e.g. #9's spA=20 vs spB=65 ≈ ×3)
 * — must NOT be punished by `squareness` as a "rectangular cell". Try the small integer ratios and,
 * if one lands near a square cell, use it; a genuinely rectangular grid keeps its aspect. Pure. */
export function harmonicAspect(aspect: number): number {
  if (!(aspect > 1) || !isFinite(aspect)) return aspect;
  let best = aspect; // no correction
  for (const m of [2, 3, 4]) {
    const cand = aspect / m;
    if (Math.abs(cand - 1) < 0.35 && Math.abs(cand - 1) < Math.abs(best - 1)) best = cand;
  }
  return best;
}

export function gridConfidence(
  a: FamilyMetrics,
  b: FamilyMetrics,
  degenerate: boolean,
  aspect = 1,
): number {
  const qA = familyQuality(a);
  const qB = familyQuality(b);
  const pair = 0.7 * Math.min(qA, qB) + 0.3 * Math.max(qA, qB);
  const ar = harmonicAspect(aspect > 0 && isFinite(aspect) ? aspect : MAX_CELL_ASPECT);
  const squareness = 0.25 + 0.75 * clamp01(1 - (ar - 1) / (MAX_CELL_ASPECT - 1));
  const geom = degenerate ? 0.1 : squareness;
  return clamp01(pair * geom);
}

/** Draw/keep an auto-detected grid when its calibrated confidence clears this bar. SINGLE SOURCE
 * OF TRUTH for the reliability decision (the UI gate imports it). Calibrated on the labelled corpus
 * (Fase A): the genuinely-correct grids all score ≥ ~0.86, while the false positives / imprecise
 * fits (a self-consistent but wrong lattice, a texture sub-pitch) sit at 0.43–0.53 — so 0.65
 * separates them with ~zero recall cost on the real grids and kills the #13-style false positive.
 * Confidence still measures lattice self-consistency + size + squareness, NOT image support yet
 * (see Fase C), so keep the bar here rather than trusting a low score. */
export const DRAW_THRESHOLD = 0.65;

/** THE reliability decision — pure and unit-testable: is this fit good enough to DRAW as the auto
 * grid? One calibrated score above threshold, PLUS two HARD guards kept OUT of the score because
 * no score should override them: a confirmed sub-pitch (`degenerate`) and a single-line "axis"
 * are never a grid. Everything else (regularity, size, squareness) is already inside `confidence`.
 * Shared by the detector and the UI gate so the chip, the winner choice and "drawn?" agree. */
export function isGridReliable(info: GridResult['info'], threshold: number = DRAW_THRESHOLD): boolean {
  if (info.degenerate) return false;
  if (info.detectedA < 2 || info.detectedB < 2) return false;
  return info.confidence >= threshold;
}

/** The two comparable quality signals of a fitted family PAIR, for the H-vs-identity
 * rectification choice (Fix 1). `confidence` is the pair's calibrated gridConfidence;
 * `minCount` is the detected lattice-line count of the WEAKER family. */
export interface PairScore {
  confidence: number;
  minCount: number;
}

/** Choose between the two candidate rectifications (H vs identity) of a family pair (Fix 1):
 * the fit with the higher grid confidence wins; on a near-tie the fuller grid (more detected
 * lattice lines in the weaker family) wins. A correctly-rectified perspective grid TYPICALLY
 * keeps its H-fit (higher confidence), so swapping to identity mainly rescues the collapsed-
 * family case — a heuristic improvement, not a formal guarantee (a mildly-off VP could still let
 * a plausible-but-wrong identity lattice edge ahead). Returns true if `cand` beats `cur`.
 * Pure — unit-tested. */
export function betterPair(cand: PairScore, cur: PairScore): boolean {
  const dc = cand.confidence - cur.confidence;
  if (Math.abs(dc) > 1e-6) return dc > 0;
  return cand.minCount > cur.minCount;
}

interface LineSup {
  line: Line2;
  support: number; // how many Hough hits merged into this line
}

/**
 * Merge lines that are the same physical line detected several times by Hough
 * (near-identical offset AND angle) into one, tracking how many hits merged
 * (support). Offsets/angle are averaged sign-safely across the 0/180° wrap.
 */
function mergeDuplicateLines(lines: Line2[], mergeDist: number): LineSup[] {
  if (lines.length === 0) return [];
  const meanTheta = meanAngle180(lines.map((l) => angleOfDeg(l.nx, l.ny)));
  const mnx = Math.cos(meanTheta / DEG);
  const mny = Math.sin(meanTheta / DEG);
  const items = lines
    .map((l) => ({ l, off: l.d * (l.nx * mnx + l.ny * mny), th: angleOfDeg(l.nx, l.ny) }))
    .sort((a, b) => a.off - b.off);

  const out: LineSup[] = [];
  let group = [items[0]];
  const flush = () => {
    const th = meanAngle180(group.map((g) => g.th));
    const nx = Math.cos(th / DEG);
    const ny = Math.sin(th / DEG);
    const d = mean(group.map((g) => g.l.d * (g.l.nx * nx + g.l.ny * ny)));
    out.push({ line: { nx, ny, d, filled: false }, support: group.length });
  };
  const groupTheta = () => meanAngle180(group.map((g) => g.th));
  for (let i = 1; i < items.length; i++) {
    const near = items[i].off - items[i - 1].off <= mergeDist;
    // COMPLETE-linkage (not single-linkage): also cap the group's total WIDTH at mergeDist, so a
    // dense comb of near-duplicates can't chain into an arbitrarily wide blob that fabricates a
    // sub-pitch. A real duplicate cluster (one physical line) spans < mergeDist; distinct grid
    // lines (pitch ≫ mergeDist) still start their own group.
    const withinWidth = items[i].off - group[0].off <= mergeDist;
    const sameAngle = angDist180(items[i].th, groupTheta()) <= 6;
    if (near && withinWidth && sameAngle) group.push(items[i]);
    else {
      flush();
      group = [items[i]];
    }
  }
  flush();
  return out;
}

/** Least-squares vanishing point of a set of lines (null if ~parallel). */
function vanishingPoint(lines: Line2[]): Pt | null {
  if (lines.length < 2) return null;
  let Sxx = 0, Sxy = 0, Syy = 0, bx = 0, by = 0;
  for (const l of lines) {
    Sxx += l.nx * l.nx;
    Sxy += l.nx * l.ny;
    Syy += l.ny * l.ny;
    bx += l.nx * l.d;
    by += l.ny * l.d;
  }
  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-6) return null; // lines parallel -> VP at infinity
  const x = (bx * Syy - by * Sxy) / det;
  const y = (Sxx * by - Sxy * bx) / det;
  if (!isFinite(x) || !isFinite(y)) return null;
  return { x, y };
}

const robustCell = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  // Overlapping / duplicate lines (Hough NMS survivors, thick or lens-distorted lines that
  // merge only partially) produce near-ZERO offset gaps. A raw median of ALL gaps is dragged
  // below the true pitch by these — the [0.5·gm,1.5·gm] window then locks onto the small gaps
  // and returns a spurious SUB-PITCH → degenerate fit → "grid not identified". Drop the
  // duplicate gaps first, using a floor scaled from a HIGH PERCENTILE of the gaps (robust to a
  // majority of duplicates AND to a single huge outlier gap) rather than from the pitch itself
  // (circular). A real grid's gaps are integer multiples of the pitch, so nothing genuine sits
  // below ~0.15× the typical spacing — the floor can only remove duplicates.
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const hi = sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * 0.9))];
  const floor = 0.15 * hi;
  const kept = floor > 0 ? gaps.filter((g) => g >= floor) : gaps;
  const base = kept.length ? kept : gaps;
  const gm = median(base);
  if (gm <= 0) return 0;
  const single = base.filter((g) => g >= 0.5 * gm && g <= 1.5 * gm);
  return single.length ? median(single) : gm;
};

/**
 * Reject a sub-multiple (harmonic) pitch: prefer the COARSEST integer multiple of
 * the base cell that still lands (almost) every offset on the lattice. A true 1/m
 * harmonic keeps all inliers when coarsened by m (only phantom empty slots vanish);
 * a genuine fundamental loses its real intermediate lines off the coarse lattice, so
 * the fine pitch is kept. Backstops the perspective sub-pitch collapse. `offs` sorted.
 */
function coarsenPitch(offs: number[], cell: number): number {
  if (offs.length < 3 || cell <= 0) return cell;
  const span = offs[offs.length - 1] - offs[0];
  const tol = 0.2 * cell; // ABSOLUTE (base-cell) tolerance — must NOT grow with the
  // coarse pitch, or a large multiple's wide tolerance falsely "captures" off-lattice
  // offsets (e.g. occluded/dropped lines) and over-coarsens.
  const onLattice = (pitch: number): number => {
    let n = 0;
    for (const o of offs) {
      const k = Math.round((o - offs[0]) / pitch);
      if (Math.abs(o - offs[0] - k * pitch) <= tol) n++;
    }
    return n;
  };
  const base = onLattice(cell);
  let best = cell;
  for (let m = 2; m <= 8 && cell * m <= span; m++) {
    if (onLattice(cell * m) >= base - 1) best = cell * m;
  }
  return best;
}

/** Conservative extension: how many cells past the detected extent 'border' may
 * add (recovers an undetected outer border; bounded by the image frame). */
const EXTEND_BORDER_CELLS = 2;
/** Aggressive extension safety cap for 'frame' (the frame/crowding guards stop
 * it far sooner in practice). */
const EXTEND_FRAME_CELLS = 120;
/** Stop extrapolating when successive lines crowd to within this many px at the
 * image centre — i.e. they are piling up toward a vanishing point. */
const EXTEND_MIN_GAP_PX = 3;
/** Minimum DISTINCT detected lattice lines a family needs before 'frame' tiles the WHOLE frame.
 * Kept deliberately LOW (3 = a confirmed periodic axis, not a spurious pair): the user's rule is
 * "once a grid is IDENTIFIED it must extend to the whole screen, exactly like a manually-drawn
 * one." Garbage is filtered upstream by the DRAW gate (isGridReliable: confidence ≥ DRAW_THRESHOLD),
 * NOT here — a fit with too few/irregular lines never clears that gate, so tiling it is invisible.
 * So any grid that IS drawn also tiles the frame; only the degenerate sub-pitch is still refused. */
export const MIN_FRAME_EVIDENCE = 3;

/** A real tactical grid spans at most ~this many cells across the frame. A fitted
 * cell smaller than image/this is a degenerate lattice (a spurious sub-pitch the
 * VP/rectify fit locked onto under strong perspective) — reconstruction is then
 * skipped so it can't fill/extend into hundreds of bogus lines. */
const MAX_CELLS_ACROSS = 50;

/** How close (as a fraction of the cell) a line must sit to a lattice node to count as on-lattice
 * in the least-squares refit. See Fase A — tightened from 0.4 so parallel texture doesn't inflate
 * regularity, while staying loose enough for a real grid's slight perspective offset drift. */
const LATTICE_TOL = 0.3;

/**
 * Fit ONE family's regular lattice in the rectified plane (where its lines are
 * parallel and evenly spaced) and rebuild the complete set of lines, mapping
 * them back into the image. `inLines` are the family's concurrent lines (merged,
 * with support) in centred image coordinates; `H` is the rectifying homography.
 * `crossesImage` tests (in the same centred frame) whether a line still meets the
 * image, so extrapolation stops at the frame.
 */
function fitFamilyGrid(
  inLines: LineSup[],
  H: M3,
  params: DetectorParams,
  crossesImage: (l: Line2) => boolean,
  minCell: number,
): FamilyGrid {
  const HinvT = transpose3(inv3(H) ?? IDENTITY3);
  const HT = transpose3(H);
  const backToImage = (offset: number, nx: number, ny: number, filled: boolean): Line2 =>
    ({ ...homToLine(mulM3V(HT, [nx, ny, -offset])), filled });
  const finalize = (lines: Line2[], metrics: FamilyMetrics = EMPTY_METRICS): FamilyGrid => {
    if (lines.length === 0) return { lines, angleDeg: 0, spacing: 0, metrics };
    const mid = lines[Math.floor(lines.length / 2)];
    const ds = lines.map((l) => l.d).sort((a, b) => a - b);
    const g: number[] = [];
    for (let i = 1; i < ds.length; i++) g.push(ds[i] - ds[i - 1]);
    return { lines, angleDeg: angleOfDeg(mid.nx, mid.ny), spacing: median(g), metrics };
  };

  // Rectify each line: rectified line = H^{-T} · line.
  const rec = inLines.map((s) => ({
    r: homToLine(mulM3V(HinvT, lineToHom(s.line))),
    support: s.support,
  }));
  if (rec.length < 2) {
    return finalize(rec.map((x) => backToImage(x.r.d, x.r.nx, x.r.ny, false)));
  }

  const meanTheta = meanAngle180(rec.map((x) => angleOfDeg(x.r.nx, x.r.ny)));
  const meanNx = Math.cos(meanTheta / DEG);
  const meanNy = Math.sin(meanTheta / DEG);

  // Signed 1-D offset of each rectified line along the family mean normal.
  let pts = rec
    .map((x) => ({ off: x.r.d * (x.r.nx * meanNx + x.r.ny * meanNy), support: x.support }))
    .sort((a, b) => a.off - b.off);
  let cell = robustCell(pts.map((p) => p.off));
  if (cell <= 0) {
    return finalize(pts.map((p) => backToImage(p.off, meanNx, meanNy, false)));
  }

  cell = coarsenPitch(pts.map((p) => p.off), cell);

  // Drop cell-splitting duplicates: a line within half a cell of a neighbour —
  // keep the better-supported one (these are never distinct grid lines).
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (pts[i].off - prev.off < 0.5 * cell) {
      if (pts[i].support > prev.support) dedup[dedup.length - 1] = pts[i];
    } else {
      dedup.push(pts[i]);
    }
  }
  pts = dedup;
  const seed = robustCell(pts.map((p) => p.off)) || cell;
  cell = coarsenPitch(pts.map((p) => p.off), seed);

  const offs = pts.map((p) => p.off);
  if (offs.length < 2 || !params.reconstruct) {
    return finalize(offs.map((o) => backToImage(o, meanNx, meanNy, false)));
  }

  // Anchor phase: search for the offset whose lattice captures the most other lines.
  let a = offs[0];
  let bestC = -1;
  for (const a0 of offs) {
    let c = 0;
    for (const o of offs) {
      const k = Math.round((o - a0) / cell);
      if (Math.abs(o - a0 - k * cell) <= 0.4 * cell) c++;
    }
    if (c > bestC) {
      bestC = c;
      a = a0;
    }
  }

  // Snap each line to a GLOBAL integer index (round((off − a)/b)) — not a
  // running sum — so a single off-lattice line can't shift the indices of the
  // rest. Seed the inlier set from the clean anchor fit (a, cell) BEFORE the
  // least-squares refit, otherwise an off-lattice line biases the very first
  // fit and gets absorbed instead of rejected.
  let b = cell;
  // Lattice inlier tolerance (Fase A): a line counts as on-lattice within LATTICE_TOL·cell of a
  // node. Tightened 0.4→0.3 so a parallel TEXTURE line sitting ~0.35·cell off a node no longer
  // inflates `inlier`/regularity (a real grid's lines sit within ~0.1·cell of their nodes).
  const keep = offs.map((o) => Math.abs(o - (a + cell * Math.round((o - a) / cell))) / cell <= LATTICE_TOL);
  for (let iter = 0; iter < 6; iter++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < offs.length; i++) {
      if (!keep[i]) continue;
      const k = Math.round((offs[i] - a) / b);
      n++;
      sx += k;
      sy += offs[i];
      sxx += k * k;
      sxy += k * offs[i];
    }
    if (n < 2) break;
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) break;
    const nb = (n * sxy - sx * sy) / denom;
    const na = (sy - nb * sx) / n;
    if (!(nb > 0)) break;
    let changed = false;
    for (let i = 0; i < offs.length; i++) {
      const k = Math.round((offs[i] - na) / nb);
      const ok = Math.abs(offs[i] - (na + nb * k)) / nb <= LATTICE_TOL;
      if (ok !== keep[i]) changed = true;
      keep[i] = ok;
    }
    a = na;
    b = nb;
    if (!changed && iter > 0) break;
  }

  const detectedIdx = new Set<number>();
  for (let i = 0; i < offs.length; i++) if (keep[i]) detectedIdx.add(Math.round((offs[i] - a) / b));
  if (detectedIdx.size === 0) {
    return finalize(offs.map((o) => backToImage(o, meanNx, meanNy, false)));
  }

  const kmin = Math.min(...detectedIdx);
  const kmax = Math.max(...detectedIdx);

  // Raw per-family evidence in the RECTIFIED plane (perspective removed → a real grid IS
  // evenly spaced). `count`/`span`/`fill`/`inlier` are combined into a calibrated quality
  // by the pure `familyQuality` (see there for the weighting rationale).
  const span = kmax - kmin + 1;
  const keptCount = keep.reduce((n, k) => n + (k ? 1 : 0), 0);
  const metrics: FamilyMetrics = {
    count: detectedIdx.size,
    span,
    fill: span > 0 ? detectedIdx.size / span : 0,
    inlier: offs.length ? keptCount / offs.length : 0,
  };

  // Degeneracy guard: use the LARGEST (nearest) image-space cell across the detected extent, not
  // the median. Under perspective the FAR cells legitimately compress, so a median dips below
  // minCell on a genuine steep grid and falsely flags it degenerate. The fit is a real sub-pitch
  // only if even the biggest cell is implausibly small (< image/MAX_CELLS_ACROSS) — then DON'T
  // fill/extend it (that balloons into hundreds of bogus lines); keep only the detected lines.
  const imgCellAt = (k: number): number =>
    Math.abs(backToImage(a + b * (k + 1), meanNx, meanNy, false).d - backToImage(a + b * k, meanNx, meanNy, false).d);
  const step = Math.max(1, Math.floor((kmax - kmin) / 12));
  const cellSamples: number[] = [];
  for (let k = kmin; k < kmax; k += step) cellSamples.push(imgCellAt(k));
  const imgCell = cellSamples.length ? Math.max(...cellSamples) : imgCellAt(kmin);
  const degenerate = imgCell > 0 && imgCell < minCell;

  const canFill = !degenerate && params.fillGrid && kmax - kmin <= 200;
  const core: Line2[] = [];
  for (let k = kmin; k <= kmax; k++) {
    if (detectedIdx.has(k)) core.push(backToImage(a + b * k, meanNx, meanNy, false));
    else if (canFill) core.push(backToImage(a + b * k, meanNx, meanNy, true));
  }

  // --- Extrapolate the lattice past the detected extent -----------------
  // The fitted lattice is just the arithmetic progression a + b·k, so extra
  // rows/columns are its natural continuation. Extend outward from each end,
  // stopping when a line leaves the image frame or successive lines crowd toward
  // a vanishing point; 'border' adds only a few cells (to recover an undetected
  // outer edge), 'frame' tiles the whole frame. Extended lines are flagged and
  // drawn faint, since they lie beyond any detected evidence.
  // Once a grid is IDENTIFIED it must extend to the WHOLE screen, exactly like a manually-drawn
  // one — so 'frame' tiles whenever the family is a confirmed periodic axis (≥ MIN_FRAME_EVIDENCE
  // distinct detected lattice lines). The garbage filter is NOT here: it's the DRAW gate
  // (isGridReliable, confidence ≥ DRAW_THRESHOLD) — a fit too weak to be a grid never clears it, so
  // tiling it is never shown. Only the degenerate sub-pitch is still refused a full-frame tiling.
  const frameEvidenceOk = detectedIdx.size >= MIN_FRAME_EVIDENCE;
  const cap =
    params.extend === 'frame'
      ? frameEvidenceOk
        ? EXTEND_FRAME_CELLS
        : 0
      : params.extend === 'border'
        ? EXTEND_BORDER_CELLS
        : 0;
  const lo: Line2[] = [];
  const hi: Line2[] = [];
  // Stop extending once cells compress below a plausible size: raw crowding guard,
  // but also don't tile a heavily foreshortened region near a vanishing point with
  // dozens of sub-`minCell` lines (that is what over-densified perspective grids).
  const minExtendGap = Math.max(EXTEND_MIN_GAP_PX, 0.5 * minCell);
  if (!degenerate && cap > 0 && core.length >= 2) {
    const extendFrom = (startK: number, step: number, out: Line2[]): void => {
      // (nx,ny) is constant across offsets for this family, so |Δd| at the image
      // centre is exactly the perpendicular gap — a clean crowding test.
      let prev = backToImage(a + b * startK, meanNx, meanNy, false);
      for (let n = 1; n <= cap; n++) {
        const line = backToImage(a + b * (startK + step * n), meanNx, meanNy, true);
        line.extended = true;
        if (!crossesImage(line)) break;
        if (Math.abs(line.d - prev.d) < minExtendGap) break;
        out.push(line);
        prev = line;
      }
    };
    extendFrom(kmax, +1, hi);
    extendFrom(kmin, -1, lo);
    lo.reverse(); // back to ascending-k order
  }
  return finalize([...lo, ...core, ...hi], degenerate ? EMPTY_METRICS : metrics);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Convert a Hough (rho,theta) in working coords to a Line2 in original coords. */
function toLine2(rho: number, thetaDeg: number, scale: number): Line2 {
  const nx = Math.cos(thetaDeg / DEG);
  const ny = Math.sin(thetaDeg / DEG);
  return { nx, ny, d: rho / scale };
}

/**
 * Clip a line (nx*x+ny*y=d) to the rectangle [0,W]x[0,H]. Returns the two
 * boundary points, or null if it doesn't cross the rectangle.
 */
export function clipLineToRect(
  line: Line2,
  W: number,
  H: number,
): [[number, number], [number, number]] | null {
  const { nx, ny, d } = line;
  const pts: [number, number][] = [];
  const eps = 1e-6;
  const push = (x: number, y: number) => {
    if (x >= -eps && x <= W + eps && y >= -eps && y <= H + eps) pts.push([x, y]);
  };

  if (Math.abs(ny) > eps) {
    push(0, d / ny); // x = 0
    push(W, (d - nx * W) / ny); // x = W
  }
  if (Math.abs(nx) > eps) {
    push(d / nx, 0); // y = 0
    push((d - ny * H) / nx, H); // y = H
  }

  // Deduplicate coincident corner hits.
  const uniq: [number, number][] = [];
  for (const p of pts) {
    if (!uniq.some((q) => Math.abs(q[0] - p[0]) < 1 && Math.abs(q[1] - p[1]) < 1)) {
      uniq.push(p);
    }
  }
  if (uniq.length < 2) return null;
  return [uniq[0], uniq[1]];
}

/** Intersection point of two lines (null if parallel). */
export function intersect(a: Line2, b: Line2): { x: number; y: number } | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (a.d * b.ny - b.d * a.ny) / det,
    y: (a.nx * b.d - b.nx * a.d) / det,
  };
}
