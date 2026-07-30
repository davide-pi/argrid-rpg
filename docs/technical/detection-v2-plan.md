# Grid detection v2 — improvement plan (research-backed)

> **SUPERSEDED by [`detection-v3-plan.md`](detection-v3-plan.md)** (2026-07-29). Kept as the historical
> research record; v3 is the single source of truth going forward (it sharpens this: periodicity-emergent
> ROI instead of ROI-segmentation-first, and autocorrelation-fundamental pitch instead of FFT-pitch).

> Working plan to raise auto-detection accuracy. Synthesised from two web-research passes
> (2026-07-28) plus a **user-labelled 16-photo benchmark**. The current v1 pipeline
> (Canny → Hough → family split → VP RANSAC → lattice fit → extend) is correct on only
> **3/16** hard real photos. This is an accuracy problem in the pipeline, not the show/hide gate.

## Ground truth (user-labelled, `test-images/` corpus, 2026-07-28)

The user judged the auto grid on each photo (the authority — never self-judge, see the memory
note `validate-detection-changes-visually`):

- **Correct (3):** `test_2`, `test_3`, `test_15`
- **Wrong (11):** `test_1, 5, 6, 7, 9, 10, 11, 12, 13, 14, 16`
- **Correctly rejected / fallback-ok (2):** `test_4, 8`

Key facts the benchmark exposed:
- Confidence (= detected-line count) tracks correctness *almost* perfectly: correct grids scored
  **≥ 0.75**, wrong ones **≤ 0.25** — **except `test_5`** (conf 1.0 but a full lattice at the
  wrong orientation). No available metric separates `test_5` from a good grid → we need a
  **geometric/periodicity validity score**, not just line counts.
- Failure modes: faint/low-contrast missed; noise makes Hough latch onto texture; strong
  perspective → degenerate / wrong-orientation (45°) fits; **distractors** (a tiled floor behind
  the mat) hijack detection; fine graph paper detected at the wrong scale/orientation.

## Validation loop (mandatory)
Detection correctness is the **user's** call. After each meaningful change, regenerate the labelling
gallery (photo + drawn overlay per image, data-URI, published as an Artifact) and have the user
re-label. Metrics (spacing CV, inlier ratio, FFT peak sharpness) guide; the user's eye decides.

## The core reframe (both research passes agreed)
v1 is a *bottom-up* chain (line → VP → lattice) where every stage is independently fooled by faint
contrast, noise, and floor tiles. v2 should be **prior-first, evidence-second, distractor-rejection
explicit**, as three gates in series:

1. **WHERE** — isolate the map region, mask out the rest (kills the floor distractor at the source).
2. **WHICH** — get a global periodicity prior (orientation + pitch), then keep only local lines
   consistent with it.
3. **IS IT REAL** — score the fitted lattice; reject wrong fits (45° trap, micro sub-pitch); emit
   or reject.

## OpenCV.js availability (checked against the 4.x `opencv_js.config.py` whitelist)
- **Available:** `dft`/`idft`, `getOptimalDFTSize`, `HoughLines(P)`, `Canny`, `Sobel`, `Scharr`,
  `filter2D`, `getGaborKernel`, `morphologyEx` (TOPHAT/BLACKHAT), `getStructuringElement`,
  `createCLAHE`, `grabCut`, `findContours`, `approxPolyDP`, `minAreaRect`, `kmeans`,
  `goodFeaturesToTrack`, `connectedComponents`, `warpPerspective`, `getPerspectiveTransform`.
- **NOT in the standard build (hand-roll in JS if needed):** `saliency` (spectral-residual is ~15
  lines on `dft`), `ximgproc` (no Fast Line Detector / structured edges / guidedFilter), Frangi
  vesselness (build from Sobel Hessian), **`cornerSubPix`** (refine yourself). `LineSegmentDetector`
  may or may not be whitelisted — **verify at runtime**, don't assume.

## Techniques (prioritised)

### Gate 1 — Map ROI isolation (biggest distractor win)
Naive Otsu+minAreaRect / Canny-contour FAILED (mat isn't the highest-contrast object). Use
appearance/central-region cues instead, as a fallback chain, always intersected with "connected
component containing the image centre":
1. **Colour/HSV k-means** (downscale ~128px, `kmeans` k=3–5) → largest central component → close.
2. **Spectral-residual saliency** (reimplement on `dft`) to seed the map blob.
3. **GrabCut** (`grabCut`, available) seeded from a central ~40–60% rectangle as probable-FG, border
   ring as probable-BG.
4. **Scored quadrilateral** (candidate quads from `findContours`+`approxPolyDP`, scored by
   boundary contrast + side straightness + area + centrality) — not "largest contour".
Then detect lines **inside the mask only**.

### Gate 2 — Global periodicity prior (FFT / autocorrelation)
- `dft` of the (masked, Hann-windowed) gray/edge image → the two symmetric **peak-pairs** give the
  two families' **orientation + pitch**; a competing floor grid shows a **second** peak-pair (detect
  & separate). Autocorrelation (`IFFT(|FFT|²)`) gives the two lattice basis vectors directly.
- **1-D projection-profile / "comb" fit** per family (after a rough deskew): sum edge magnitude
  along the family direction → autocorrelation peak spacing = exact pitch, phase = offset. Cheap,
  robust; rejects sub-pitch (require the fundamental, min cell size) and splits a second periodicity.
- Use the prior to **gate Hough** (keep only lines within ±~5° of the FFT orientations, spacing
  consistent with FFT pitch) and to **seed** VP-RANSAC and the lattice fit.

### Preprocessing (faint lines + noise; do NOT use bilateral — it erases faint lines)
- **Top-hat / black-hat** morphology (`MORPH_TOPHAT`/`BLACKHAT`) to flatten illumination and isolate
  thin lines (SE larger than line width, smaller than cell) — biggest cheap win; apply CLAHE after.
- **Frangi/Sato ridge (vesselness)** from the Sobel Hessian (multi-scale) — the purpose-built
  "amplify thin ridge lines, ignore blobs/noise" filter.
- **Oriented Gabor** bank tuned to the FFT orientation+frequency, once known.

### Line evidence
- Prefer **LSD** if the build exposes `createLineSegmentDetector` (graceful on noise, sub-pixel,
  a-contrario) — verify at runtime; else keep Hough but **gate it by the FFT prior**.
- **Oriented morphological opening** per family (long SE rotated to the FFT angles) → clean line
  masks, nearly noise-immune; fit lines to connected components.

### Gate 3 — Lattice-consistency score (reject wrong fits: 45° trap, micro-pitch)
Fit an explicit periodic lattice `p = origin + i·b₁ + j·b₂` (with a homography for perspective;
seed b₁,b₂ from FFT), then score and threshold:
- **Inlier ratio** — fraction of detected lines/crossings ON the lattice (low for a 45° fit).
- **Occupancy/coverage** — fraction of predicted lattice lines actually supported (low for a micro
  sub-pitch: half its teeth are empty).
- **Cell-size uniformity** — after rectification, `CV = std/mean` of spacing (reject > ~0.1–0.15).
- **Projected line-energy** per candidate orientation (direct 45°-trap test: axis-aligned families
  have far more projected support than a diagonal).
- **Cross-ratio** of 4 consecutive lines (perspective-invariant uniformity check; also inpaints
  missing faint lines).
- Require **cell size in a plausible px range** + coherent contiguous coverage.
Combine (e.g. `inlierRatio × occupancy × (1−CV) × projectedEnergy`); if nothing passes → "no grid".

### VP / perspective
Accept a **finite VP only when** inliers are numerous, span the image, VP is off-frame, AND the
result is consistent with the FFT orientations; else use the **parallel (VP-at-∞)** model. Enforce
post-rectification **orthogonality + equal pitch** (kills the wrong-orientation fit). Fit pitch in
**rectified** space, not the perspective image.

### Distractor tie-break (if two periodic structures survive)
Rank by the lattice score **gated by priors**, NOT by raw line strength: **centrality** (map is
central), **single coherent region** (map fills one blob; floor is peripheral/annular),
**foreground/appearance** (map is the salient, more uniform, nearer plane), **less-extreme
perspective**.

## Suggested phasing (each phase measured against the labelled gallery)
- **P1 — Map ROI mask** (colour/GrabCut/saliency) → detect inside it. Expected: kills floor
  distractors (test_6/10-type); may recover faint mats.
- **P2 — FFT periodicity prior + Hough gating + comb pitch fit.** Expected: right orientation/scale
  (test_5/16-type), sub-pitch rejection.
- **P3 — Lattice-consistency score** as the "is it real" gate (also drives a trustworthy `confidence`
  the UI can use). Expected: reject the 45°/micro wrong-but-confident fits.
- **P4 — Ridge/top-hat preprocessing + oriented morphological line masks** for faint/noisy recall.
- **P5 — VP gating + rectified pitch + distractor tie-break** for perspective.

Implement incrementally, keep only what improves the benchmark (re-labelled by the user), never
regress the 3 currently-correct.

## Prototype results (FFT prior, 2026-07-28, in-harness — not yet in the pipeline)
A browser-harness prototype of the FFT prior (gradient-magnitude input, Hann window, aspect-
preserving square pad, spectral high-pass = subtract a heavily-blurred spectrum, then joint
selection of two ~orthogonal equal-pitch peak families):
- **Orientation is reliable.** `test_2` matched the correct grid almost exactly (22.6°/112° pitch
  ~33); `test_3`/`test_15` got a correct family orientation; crucially **`test_6` DISAGREED with the
  wrong 45° fit** and found the true near-H/V tile orientation → the FFT prior would fix the 45°
  distractor trap.
- **Pitch needs a "fundamental, not harmonic" fix.** It sometimes locks onto a high harmonic
  (`test_3`: pitch 8 vs the real 69). Fix: per direction, pick the **lowest-frequency strong peak**
  (largest period) / take the GCD of the harmonic radii, not the strongest peak.
- **`test_5` stays ambiguous** — FFT agrees with its (wrong) fine-grid detection; it's wrong for a
  subtler reason (likely detecting the fine graph ruling vs the intended coarser grid), so the FFT
  prior alone won't fix it; the lattice-consistency score / a coarser-grid preference is needed.
Next: fundamental-pitch selection → use the prior to **angle-gate Hough + seed the lattice pitch** →
re-fit → re-label a gallery. The pieces (`dft`, `Sobel`, `copyMakeBorder`, `multiply`, quadrant-swap
fftshift, JS peak-finding) all work in opencv.js.

## Sources
Two research syntheses are in this session's history; key references: deformed-lattice detection
(Park & Liu), Geiger corner prototypes / libcbdetect, findChessboardCornersSB (checkerboard only —
mats are "+"-junctions not saddles), FFT/autocorrelation periodicity, top-hat & Frangi for faint
structures, J/T-linkage VP clustering, orthogonality-constrained VP, spectral-residual saliency,
document/quad detection by contours-and-contrasts, `(t1,t2)` lattice RANSAC + consistency scoring.
