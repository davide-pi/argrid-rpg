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
  /** How far (deg) a line may sit from a family axis to still belong to it. */
  angleTolDeg: number;
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
}

export const DEFAULT_PARAMS: DetectorParams = {
  maxDim: 1600,
  angleTolDeg: 24,
  mergeFrac: 0.012,
  fillGrid: true,
  focusGating: false,
  reconstruct: true,
  lineMorph: true,
  extend: 'frame',
  colorEdges: true,
};

/** A line as normal form: nx*x + ny*y = d, with (nx,ny) a unit vector. */
export interface Line2 {
  nx: number;
  ny: number;
  d: number;
  filled?: boolean; // true if interpolated rather than detected
  extended?: boolean; // true if extrapolated BEYOND the detected extent (see extend)
}

export interface GridResult {
  width: number;
  height: number;
  familyA: Line2[];
  familyB: Line2[];
  rawLines: Line2[];
  edges?: ImageData; // debug edge map (working resolution); DOM-free
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

export function detectGrid(
  cv: any,
  srcCanvas: HTMLCanvasElement,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): GridResult {
  const W0 = srcCanvas.width;
  const H0 = srcCanvas.height;
  const scale = Math.min(1, params.maxDim / Math.max(W0, H0));

  const src = cv.imread(srcCanvas);
  const work = new cv.Mat();
  if (scale < 1) {
    cv.resize(
      src,
      work,
      new cv.Size(Math.round(W0 * scale), Math.round(H0 * scale)),
      0,
      0,
      cv.INTER_AREA,
    );
  } else {
    src.copyTo(work);
  }

  const result = detectGridFromMat(cv, work, W0, H0, scale, params, wantEdges);
  src.delete();
  work.delete();
  return result;
}

/**
 * Grid detection from an ImageData (no canvas/DOM needed) — used by the Web
 * Worker, where OpenCV runs off the main thread.
 */
export function detectGridFromImageData(
  cv: any,
  imageData: ImageData,
  params: DetectorParams = DEFAULT_PARAMS,
  wantEdges = false,
): GridResult {
  const W0 = imageData.width;
  const H0 = imageData.height;
  const scale = Math.min(1, params.maxDim / Math.max(W0, H0));

  const src = cv.matFromImageData(imageData);
  const work = new cv.Mat();
  if (scale < 1) {
    cv.resize(
      src,
      work,
      new cv.Size(Math.round(W0 * scale), Math.round(H0 * scale)),
      0,
      0,
      cv.INTER_AREA,
    );
  } else {
    src.copyTo(work);
  }

  const result = detectGridFromMat(cv, work, W0, H0, scale, params, wantEdges);
  src.delete();
  work.delete();
  return result;
}

/**
 * Grid detection on an already-loaded working Mat (RGBA or gray). Split out so
 * it can run headless (Node) without a canvas/DOM. The caller owns `work` and
 * must delete it.
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
  const gray = new cv.Mat();
  if (work.channels && work.channels() === 1) {
    work.copyTo(gray);
  } else {
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
  }

  // --- Standard edge path: CLAHE local contrast -> blur -> auto-Canny (Otsu) ---
  const eq = new cv.Mat();
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  clahe.apply(gray, eq);
  clahe.delete();

  const blurred = new cv.Mat();
  cv.GaussianBlur(eq, blurred, new cv.Size(3, 3), 0);

  // Auto-Canny: derive thresholds from Otsu's global threshold.
  const otsuTmp = new cv.Mat();
  const otsu = cv.threshold(blurred, otsuTmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  otsuTmp.delete();
  const cannyHigh = Math.max(1, Math.round(otsu));
  const cannyLow = Math.max(1, Math.round(0.5 * otsu));

  const cannyEdges = new cv.Mat();
  cv.Canny(blurred, cannyEdges, cannyLow, cannyHigh);

  // Chromatic edges: a grid that differs from its background in HUE but not in
  // brightness (e.g. a coloured map on a similarly-light surface) leaves no
  // luminance edge, so grayscale Canny misses it. Add the colour-only edges from
  // the Lab a/b channels. Only when the source has colour (RGBA) and the channel
  // actually carries chroma (near-neutral channels contribute nothing).
  if (params.colorEdges && work.channels && work.channels() === 4) {
    const chroma = chromaEdges(cv, work);
    cv.bitwise_or(cannyEdges, chroma, cannyEdges);
    chroma.delete();
  }

  // Focus gating (off by default): the grid sits in the focal plane, so it is
  // sharper than an out-of-focus background; suppress edges whose local sharpness
  // is well below the median among edges. Self-disabling when the frame is
  // uniformly sharp. See DetectorParams.
  if (params.focusGating) gateEdgesByFocus(cv, gray, cannyEdges);
  eq.delete();
  blurred.delete();

  // Hough + grid fit on the Canny edges.
  let edges = cannyEdges;
  let { result } = houghToGrid(cv, edges, work, scale, W0, H0, params);

  // --- Fallback for noisy / low-contrast photos -------------------------
  // When Canny drowns in background texture (a grid drawn on dirt/cork), it finds
  // no grid. Retry with the morphological line extractor and keep it if it does
  // better. Costs an extra pass only when the plain pipeline already failed.
  // Count only DETECTED lines (not interior-filled or extrapolated ones), so a
  // weak detection can't be masked by fill/extension and skip the fallback.
  const detected = (fam: Line2[]) => fam.reduce((n, l) => n + (l.filled ? 0 : 1), 0);
  const strength = (r: GridResult) => Math.min(detected(r.familyA), detected(r.familyB));
  if (params.lineMorph && strength(result) < 3) {
    const morphEdges = enhanceGridLines(cv, gray);
    const alt = houghToGrid(cv, morphEdges, work, scale, W0, H0, params);
    if (strength(alt.result) > strength(result)) {
      result = alt.result;
      cannyEdges.delete();
      edges = morphEdges;
    } else {
      morphEdges.delete();
    }
  }

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

  gray.delete();
  edges.delete();

  return result;
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
): { result: GridResult; usedHough: number } {
  const minDim = Math.min(work.cols, work.rows);
  const linesMat = new cv.Mat();
  let usedHough = Math.max(30, Math.round(minDim * 0.3));
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
  const raw: RawLine[] = [];
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
  linesMat.delete();
  const result = buildGrid(raw, scale, W0, H0, params);
  result.info.usedHough = usedHough;
  return { result, usedHough };
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
 * sums the fragments that share a (rho, theta), and the lattice fit rebuilds gaps. */
function enhanceGridLines(cv: any, gray: any): any {
  const MW = 1000; // work around ~1000px on the longer side
  const down = Math.min(1, MW / Math.max(gray.cols, gray.rows));
  let g = gray;
  let tempG: any = null;
  if (down < 1) {
    tempG = new cv.Mat();
    cv.resize(gray, tempG, new cv.Size(Math.round(gray.cols * down), Math.round(gray.rows * down)), 0, 0, cv.INTER_AREA);
    g = tempG;
  }
  const minDim = Math.min(g.cols, g.rows);
  const L = Math.max(9, Math.round(minDim / 23)); // line-probe length
  const L2 = Math.max(12, Math.round(minDim / 14)); // min line run to keep
  const LC = Math.max(24, Math.round(minDim / 7)); // bridge collinear fragments
  const K = 2.0; // threshold = mean + K·σ of the line response

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
  cv.morphologyEx(inv, oH, cv.MORPH_OPEN, hSE);
  cv.morphologyEx(inv, oV, cv.MORPH_OPEN, vSE);
  cv.morphologyEx(inv, oS, cv.MORPH_OPEN, sq);
  const rH = new cv.Mat();
  const rV = new cv.Mat();
  cv.subtract(oH, oS, rH);
  cv.subtract(oV, oS, rV);

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
    const t = me.data64F[0] + K * st.data64F[0];
    me.delete();
    st.delete();
    const b = new cv.Mat();
    cv.threshold(r, b, t, 255, cv.THRESH_BINARY);
    cv.morphologyEx(b, b, cv.MORPH_OPEN, seOpen);
    cv.morphologyEx(b, b, cv.MORPH_CLOSE, seClose);
    return b;
  };
  const bH = binDir(rH, hSE2, hSEc);
  const bV = binDir(rV, vSE2, vSEc);
  let mask = new cv.Mat();
  cv.max(bH, bV, mask);
  const d3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(mask, mask, d3);

  // Back up to the caller's (work) resolution so Hough shares the same scale.
  if (down < 1) {
    const up = new cv.Mat();
    cv.resize(mask, up, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_NEAREST);
    mask.delete();
    mask = up;
  }

  [blur, inv, hSE, vSE, sq, oH, oV, oS, rH, rV, hSE2, vSE2, hSEc, vSEc, bH, bV, d3].forEach((x) => x.delete());
  if (tempG) tempG.delete();
  return mask;
}

/** Below this std (0..255) a Lab chroma channel is treated as neutral (no colour
 * information) and skipped, so a near-grayscale photo adds no chromatic edges. */
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
  const rgb = new cv.Mat();
  cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  rgb.delete();
  const chans = new cv.MatVector();
  cv.split(lab, chans);
  lab.delete();
  for (const idx of [1, 2]) {
    // a (1) and b (2) are the chroma channels; L (0) is luminance, already used.
    const ch = chans.get(idx);
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
      cv.Canny(blur, e, Math.max(1, Math.round(0.5 * otsu)), Math.max(1, Math.round(otsu)));
      cv.max(out, e, out);
      blur.delete();
      e.delete();
    }
    ch.delete();
  }
  chans.delete();
  return out;
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
export function buildGrid(
  raw: RawLine[],
  scale: number,
  W0: number,
  H0: number,
  params: DetectorParams,
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
  const axisA = peak * 2 + 1;
  const axisB = (axisA + 90) % 180;

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
  const vA = ransacVP(mA.map((m) => m.line));
  const vB = ransacVP(mB.map((m) => m.line));
  const inA = vA.inliers.map((k) => mA[k]);
  const inB = vB.inliers.map((k) => mB[k]);

  // --- Rectify with the horizon, then fit + rebuild the lattice ---------
  // Extension works in the centred coordinate frame used for fitting; a line
  // is worth extrapolating only while it still crosses the actual image frame.
  const crossesImage = (l: Line2): boolean => !!clipLineToRect(fromCentered(l), W0, H0);
  const H = buildRectify(vA.vp, vB.vp);
  const A = fitFamilyGrid(inA, H, params, crossesImage);
  const B = fitFamilyGrid(inB, H, params, crossesImage);

  const familyA = A.lines.map(fromCentered);
  const familyB = B.lines.map(fromCentered);

  return {
    width: W0,
    height: H0,
    familyA,
    familyB,
    rawLines,
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
    },
  };
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
function ransacVP(lines: Line2[]): { vp: V3; inliers: number[] } {
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

  // Refine the VP from all inliers (least squares); parallel -> VP at infinity.
  const refined = vanishingPoint(best.map((k) => lines[k]));
  let vp: V3;
  if (refined) {
    vp = [refined.x, refined.y, 1];
  } else {
    const ang = meanAngle180(best.map((k) => angleOfDeg(lines[k].nx, lines[k].ny)));
    const dir = (ang + 90) / DEG; // line direction
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
    const sameAngle = angDist180(items[i].th, groupTheta()) <= 6;
    if (near && sameAngle) group.push(items[i]);
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
  const gm = median(gaps);
  if (gm <= 0) return 0;
  const single = gaps.filter((g) => g >= 0.5 * gm && g <= 1.5 * gm);
  return single.length ? median(single) : gm;
};

/** Conservative extension: how many cells past the detected extent 'border' may
 * add (recovers an undetected outer border; bounded by the image frame). */
const EXTEND_BORDER_CELLS = 2;
/** Aggressive extension safety cap for 'frame' (the frame/crowding guards stop
 * it far sooner in practice). */
const EXTEND_FRAME_CELLS = 120;
/** Stop extrapolating when successive lines crowd to within this many px at the
 * image centre — i.e. they are piling up toward a vanishing point. */
const EXTEND_MIN_GAP_PX = 3;

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
): FamilyGrid {
  const HinvT = transpose3(inv3(H) ?? IDENTITY3);
  const HT = transpose3(H);
  const backToImage = (offset: number, nx: number, ny: number, filled: boolean): Line2 =>
    ({ ...homToLine(mulM3V(HT, [nx, ny, -offset])), filled });
  const finalize = (lines: Line2[]): FamilyGrid => {
    if (lines.length === 0) return { lines, angleDeg: 0, spacing: 0 };
    const mid = lines[Math.floor(lines.length / 2)];
    const ds = lines.map((l) => l.d).sort((a, b) => a - b);
    const g: number[] = [];
    for (let i = 1; i < ds.length; i++) g.push(ds[i] - ds[i - 1]);
    return { lines, angleDeg: angleOfDeg(mid.nx, mid.ny), spacing: median(g) };
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
  cell = robustCell(pts.map((p) => p.off)) || cell;

  const offs = pts.map((p) => p.off);
  if (offs.length < 2 || !params.reconstruct) {
    return finalize(offs.map((o) => backToImage(o, meanNx, meanNy, false)));
  }

  // Anchor phase = the offset whose lattice captures the most other lines.
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
  const keep = offs.map((o) => Math.abs(o - (a + cell * Math.round((o - a) / cell))) / cell <= 0.4);
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
      const ok = Math.abs(offs[i] - (na + nb * k)) / nb <= 0.4;
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
  const canFill = params.fillGrid && kmax - kmin <= 200;
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
  const cap =
    params.extend === 'frame'
      ? EXTEND_FRAME_CELLS
      : params.extend === 'border'
        ? EXTEND_BORDER_CELLS
        : 0;
  const lo: Line2[] = [];
  const hi: Line2[] = [];
  if (cap > 0 && core.length >= 2) {
    const extendFrom = (startK: number, step: number, out: Line2[]): void => {
      // (nx,ny) is constant across offsets for this family, so |Δd| at the image
      // centre is exactly the perpendicular gap — a clean crowding test.
      let prev = backToImage(a + b * startK, meanNx, meanNy, false);
      for (let n = 1; n <= cap; n++) {
        const line = backToImage(a + b * (startK + step * n), meanNx, meanNy, true);
        line.extended = true;
        if (!crossesImage(line)) break;
        if (Math.abs(line.d - prev.d) < EXTEND_MIN_GAP_PX) break;
        out.push(line);
        prev = line;
      }
    };
    extendFrom(kmax, +1, hi);
    extendFrom(kmin, -1, lo);
    lo.reverse(); // back to ascending-k order
  }
  return finalize([...lo, ...core, ...hi]);
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
