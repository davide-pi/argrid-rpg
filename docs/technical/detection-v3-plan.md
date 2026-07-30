# Grid detection v3 — periodicity-first rework (single source of truth)

> Supersedes [`detection-v2-plan.md`](detection-v2-plan.md) (historical research record). This is the
> committed roadmap. All code references are to `src/grid-detector.ts` and `src/main.ts` at time of
> writing (2026-07-29). Research citations are in [Sources](#sources); parameter picks are folded into
> the phases below and collected in the [Parameter cheat-sheet](#parameter-cheat-sheet).

## Diagnosis (one paragraph)

The v1 pipeline is a **bottom-up chain** — `Canny → Hough → family-split → per-family VP-RANSAC →
single-pitch lattice fit → frame-extend` — where every stage is independently foolable and errors
compound. Extraction actually *works* (the morph mask shows the cross-hatch); the collapse is at the
**lattice fit**: `fitFamilyGrid` (`grid-detector.ts:2109`) measures pitch with `robustCell`
(`:2046`, median of sorted consecutive offset gaps — the *least* robust estimator), so a few
merged/foreshortened/occluded lines smear the rectified offsets into a near-continuum and lock a
spurious sub-pitch, collapsing the family to ~2 lines. That feeds a **brittle-product confidence**
(`gridConfidence:1972` geometric-means `familyQuality:1946`, so one weak family → exactly 0) sitting
next to a **permissive draw-gate** (`main.ts:589` accepts any lattice with `detectedA/B ≥ 2`).
Net: partial real grids read 0 and are not drawn, while full fake lattices (floor tiles at test_5's
wrong orientation) score 1.0 and are drawn. The cure is to stop treating individual lines as atomic
evidence and instead fit **one global 2-D periodic model** `p = origin + i·b₁ + j·b₂` (+ optional
homography `H`) whose pitch is a **periodicity measurement over the whole image** (projection +
autocorrelation), from which confidence and ROI fall out and emitted lines are *synthesized* (stray
non-grid lines become structurally impossible).

## KEEP / RIP-OUT / REBUILD

| Verdict | Component (location) | Rationale |
|---|---|---|
| **KEEP** | `scaleToWork` (`:323`) | work-resolution downscale is fine; standardize on ~1200px longest side, `INTER_AREA`. |
| **KEEP** | `fftOrientations` (`:1518`) | FFT peak-pair orientation is proven reliable (beats the 45° trap). Fix the `CROSS=3` guard bug (discards an axis-aligned grid's own fundamental — Agent1). |
| **KEEP** | `ransacVP` / `vanishingPoint` / `buildRectify` (`:1848` / `:2028` / `:1902`) | VP = 2 params from many lines; robust *when gated*. Reuse — but accept a finite VP only when inliers are numerous, span the image, VP is off-frame, and agree with the FFT orientation; else identity (fronto-parallel). |
| **KEEP** | emit path `backToImage` / centered-coords helpers (in `fitFamilyGrid`) | line synthesis from a model is exactly what v3 wants; drive it from the validated model instead of the fitted line set. |
| **KEEP (concept)** | rectified-plane fitting, degeneracy/size gates, signed-ρ dedupe (`:988`) | sound ideas; reused inside the new engine. |
| **RIP OUT** | `robustCell` (`:2046`) + `coarsenPitch` (`:2063`) + sorted-offset differencing in `fitFamilyGrid` (`:2123`–`:2165`) | the smear/sub-pitch source. Replaced by projection + autocorrelation fundamental. |
| **RIP OUT** | `gridConfidence` geometric-mean-of-`familyQuality` (`:1972`, `:1946`) | brittle product; replaced by periodicity-validity score. |
| **RIP OUT** | consensus fusion + noise-override + oriented re-extraction + chroma sweep (`fuseGrids:265`, `enhanceGridLines:1161`, noise branch) | 7 interacting branches feeding the same fragile fit; a distractor that two branches agree on gets *promoted*. Demolish in Phase 3 once the new core is trusted. |
| **RIP OUT** | frame-extension `EXTEND_FRAME_CELLS=120` tiling on `core.length ≥ 2` (`:2090`, `:2274`) | 2 spurious lines tile a whole fake frame. Only the *validated model* emits lines. |
| **REBUILD** | the whole `buildGrid` core (`:1646`) | around the periodicity engine (Phases 1–2). |

## End-state pipeline (with OpenCV.js primitives)

Design principle: the **primary object is the global periodic model**; edges/lines are only *votes* for
its parameters, never the output. Everything downstream reads gradient **energy**, never a binarized
Canny — so nothing depends on a hard threshold a faint line falls under.

| Stage | What | OpenCV.js primitives |
|---|---|---|
| **A. Prepare** | resize→gray; CLAHE (illumination); **TOP-HAT ∪ BLACK-HAT** (polarity-agnostic thin-line pop); Sobel→gradient magnitude `gm` | `resize`, `cvtColor`, `createCLAHE`, `morphologyEx`+`getStructuringElement`, `Sobel`, `magnitude` |
| **B. Orientation** | FFT magnitude peak-pair → θA,θB; cross-check with structure-tensor histogram | `dft`, `getOptimalDFTSize`, `copyMakeBorder`, `split`, `magnitude` (reuse `fftOrientations`) |
| **C. Perspective** | coarse `HoughLines` on `gm`, **gated** to ±12° of θA/θB; robust VP per family; build `H` (identity if fronto-parallel) | `HoughLines`, then reuse `ransacVP`/`buildRectify` |
| **D. Pitch+phase** | `warpPerspective(gm, H)` → axis-aligned; **project** (column/row sums); **1-D autocorrelation**; pick **fundamental** lag + phase → `b₁,b₂,origin` | `warpPerspective`, `reduce` (REDUCE_SUM, CV_32F); autocorr + peak-pick in **plain JS** |
| **E. Validity** | autocorr peak-to-pedestal, periods spanned, orthogonality + equal-pitch, centrality → multiplicative confidence | plain JS |
| **F. ROI / distractor** | predicted-lattice mask ∧ `gm` → **largest central connected component** = map; floor tiles = second periodicity (different pitch/off-center) → rejected | `connectedComponentsWithStats` |
| **G. (opt) refine** | few Gauss-Newton / local-RANSAC iters maximizing lattice-line energy, seeded from D | plain JS |
| **H. Emit** | walk k=kmin…kmax of the validated model through `H⁻¹` → image lines | reuse emit helpers |

### Speed budget (phone, 1200px longest side)

| Stage | Est. |
|---|---|
| resize + gray + CLAHE | ~15 ms |
| top-hat ∪ black-hat (9×9 ellipse) | ~15 ms |
| Sobel + magnitude | ~10 ms |
| FFT orientation (512²) | ~40 ms |
| gated Hough + VP | ~50 ms |
| warpPerspective | ~20 ms |
| 2× reduce + 2× autocorr (JS) | ~5 ms |
| validity + connectedComponents | ~15 ms |
| emit (+ optional refine ~20 ms) | ~2 ms |
| **Total** | **≈ 170–190 ms** (≈ 210 with refine) — well under the 3 s budget, and cheaper than today's multi-branch fusion. |

## Roadmap

### Phase 0 — Surgical fixes (stop the bleeding; throwaway once Phase 1–2 land)
Cheap, low-risk patches to the *existing* accept path so the corpus doesn't regress while the rebuild
lands. Explicitly disposable.
- **0a** `fitFamilyGrid` (`:2109`): fit each family **twice** — once with `H`, once with `IDENTITY3` —
  keep the higher `metrics.count` (Agent2 Fix A; neutralizes a marginal/wrong VP without touching the
  amplifier).
- **0b** Gate frame-extension on evidence: require `detectedIdx.size ≥ MIN_GRID_CELLS` (not `≥ 2`)
  before tiling `EXTEND_FRAME_CELLS` (`:2274`).
- **0c** Raise accept floor: `main.ts:590` require `detectedA/B ≥ 3` **and** a minimum per-family fill,
  so a 2-line spurious pitch can't clear the gate.
- **0d** De-zero confidence: replace the `gridConfidence` geometric mean (`:1972`) with a floored/
  additive combine so **one weak family ≠ 0** — but only paired with 0b/0c so garbage still can't pass.
- **0e** Fix `fftOrientations` `CROSS=3` guard (`:1576`,`:1589`) so an axis-aligned grid's fundamental
  peak isn't discarded.

### Phase 1 — Periodicity pitch engine (THE fix: Stages A–D)
Replace `robustCell`/`coarsenPitch`/sorted-offset fit with the projection+autocorrelation model.
- **A. Prepare.** `resize` longest side→1200 `INTER_AREA`. Gray. **CLAHE** `clipLimit=2.0`, tiles
  `8×8` (decouples illumination from line-popping so the morph SE can stay small). **Polarity-agnostic
  thin-line map** = `max(TOP-HAT, BLACK-HAT)` with a `MORPH_ELLIPSE` SE **9×9** at 1200px
  (SE **larger than line width** ~1–4px, **smaller than the finest cell** ~15px — the classic sizing
  rule; ellipse to avoid orientation bias). Black-hat pops **dark-on-light** (parchment mats), top-hat
  pops **light-on-dark**; taking the max handles either without knowing polarity. **Do NOT bilateral-
  filter** — it erases faint lines. Gradient once: `Sobel` ksize=3 → `magnitude` = `gm`. Everything
  downstream reads `gm`.
- **B. Orientation.** Reuse `fftOrientations` (Hann-windowed, square-padded FFT magnitude, orthogonal
  equal-pitch peak-pair). Cross-check with a **structure-tensor** dominant-orientation histogram
  (blur `[gx², gx·gy, gy²]`, coherence-weighted, two modes ~90° apart). Agree → the pair; disagree →
  trust FFT (periodicity-weighted). Output θA, θB. No individual lines yet.
- **C. Perspective (VP only).** Coarse `HoughLines` on thresholded `gm`, **angle-gated to ±12°** of
  θA/θB (drops clutter up front). Robust VP per family (`ransacVP`). **Accept a finite VP only when**
  inliers are numerous, span the image, VP is off-frame, and it's consistent with the FFT orientation;
  else VP→∞, `H = IDENTITY3` (no forced rectification — a wrong rectify is what smears the comb).
- **D. Pitch + phase (periodicity engine).** `warpPerspective(gm, H, dsize)` → both families
  axis-aligned, constant-pitch by construction (rectify-first, so **no per-strip pitch-drift** to
  handle in the common case). **Project**: `cv.reduce(gm, Px, 0, REDUCE_SUM, CV_32F)` (column sums →
  vertical-line profile) and `cv.reduce(gm, Py, 1, REDUCE_SUM, CV_32F)` (row sums → horizontal-line
  profile) — **`dtype = CV_32F` is mandatory**, a `uint8` accumulator overflows summing ~1200 px.
  **Detrend** each profile (subtract a moving-average baseline, window ≈ 2× max plausible cell ~120px,
  to kill the illumination low-frequency trend) and apply a **Hann taper** over the profile length
  (reduces edge leakage). **Autocorrelation** of each profile, computed **directly in plain JS**
  (length ~1200 → ~1.4M mults, sub-ms — simpler and avoids the opencv.js `idft`/`mulSpectrums` gap,
  see [Primitives](#opencvjs-primitives-reference)), normalized so `r(0)=1`, evaluated only over
  plausible lags `L ∈ [1200/maxCells, 1200/minCells]`.
  **Fundamental-lag selection (the "not-a-harmonic, not-a-sub-multiple" fix):** don't take the tallest
  peak. For each candidate lag `L` (local maxima of `r`, prominence ≥ 0.25·max-prominence, `r(L) ≥ 0.3`),
  compute a **harmonic-comb score** `S(L) = mean_{k=1..K} r(round(k·L))` with `K = min(5, ⌊maxLag/L⌋)`,
  requiring **≥ 3 harmonics present** above the pedestal. Among all `L` with `S(L) ≥ 0.8·max S`, choose
  the **largest** `L` (coarsest fundamental) — this simultaneously rejects harmonics (their combs miss
  teeth) and picks the coarse tactical grid over fine graph ruling (**fixes test_5**). **Phase/origin**:
  cross-correlate the profile against a unit Dirac comb of period `L` over offsets `s ∈ [0,L)`; argmax
  = lattice phase. Now `b₁, b₂` (= the two `L`s) + origin = full model.

### Phase 2 — Validity + emergent ROI (Stages E–F)
Confidence and localization *fall out* of the model — no upfront segmentation (tried twice, failed).
- **E. Validity = confidence.** Per family: **peak-to-pedestal** `r(L)/median(r over lag band)` (texture
  → flat → ~0; 30 faint lines integrate coherently → tall peak even at 5% contrast → high — this is
  *why* "confidence 0 on an obvious grid" becomes structurally impossible); **periods spanned**
  (`kmax−kmin+1` coverage); **orthogonality + equal-pitch** in the rectified plane (PF2e is square →
  `|Lx−Ly|/mean < 0.15`; also the 45°-trap killer — the off-axis family has far lower *projected*
  energy); **centrality** (supported region contains image center). Combine **multiplicatively** into
  one `[0,1]` confidence that the UI trusts — replaces `gridConfidence`.
- **F. ROI / distractor resolution.** From the validated model, draw predicted lattice lines, dilate by
  ±line-width, `AND` with `gm > thr` → binary → `connectedComponentsWithStats` → keep the component
  maximizing `area × centrality` = the map region. A competing floor-tile grid is a **second
  periodicity** (different pitch, peripheral/annular support) → score both, keep the one that is
  central + single coherent blob + squarer under its own rectification.

### Phase 3 — Perspective robustness + demolition (Stages C-refine, G; cleanup)
- **Per-strip pitch-drift check** (only if VP was marginal): split each axis into 3 strips,
  autocorrelate each; a monotonic pitch drift confirms residual perspective → refine VP; flat →
  fronto-parallel confirmed.
- **G. Optional grid-model RANSAC / Gauss-Newton refine** of `(origin, b₁, b₂, H)`, few iters
  maximizing lattice-line energy — bounded and cheap because it starts from a good seed (polish, not
  search).
- **Non-planar (folded mat, photo_9/10):** no single homography exists; target the **flat majority**
  region (largest coherent-pitch blob) and accept partial coverage rather than forcing one `H`.
- **Demolish** the dead v1 superstructure (chroma sweep, oriented re-extraction, consensus fusion +
  noise-override) once Phases 1–2 are the trusted path.

**Validation loop (mandatory, unchanged from v2):** detection correctness is the **user's** call.
After each meaningful change regenerate the labelling gallery (photo + overlay per image) and have the
user re-label; metrics guide, the user's eye decides. Never self-judge; never regress the currently-
correct set.

## OpenCV.js primitives reference

Verified against the OpenCV 4.x `platforms/js/opencv_js.config.py` whitelist and the 4.x JS docs.
opencv.js has **no default arguments** (pass every arg), and **every `Mat` you allocate must be
`.delete()`d** (no GC) — budget for `try/finally` cleanup.

### Availability (whitelist-checked)
- **Present:** `reduce`, `dft`, `getOptimalDFTSize`, `magnitude`, `split`, `merge`, `copyMakeBorder`,
  `log`, `normalize`, `Sobel`, `Scharr`, `morphologyEx`, `getStructuringElement`, `connectedComponents`,
  `connectedComponentsWithStats`, `warpPerspective`, `getPerspectiveTransform`, `HoughLines`, `createCLAHE`.
- **ABSENT — must hand-roll (corrects the v2 note):** **`idft` is NOT whitelisted**, and **`mulSpectrums`
  is NOT whitelisted**. For an inverse transform use the **`DFT_INVERSE` flag on `dft`** (see below).
  For a 1-D profile, skip DFT entirely — compute autocorrelation directly in JS.

### `getStructuringElement` + `morphologyEx` (top-hat / black-hat)
```js
// SE larger than line width, smaller than the finest cell.
const se = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));  // no anchor default -> omit ok? pass Point if needed
const top = new cv.Mat(), blk = new cv.Mat(), thin = new cv.Mat();
cv.morphologyEx(gray, top, cv.MORPH_TOPHAT,   se);   // light-on-dark lines
cv.morphologyEx(gray, blk, cv.MORPH_BLACKHAT, se);   // dark-on-light lines
cv.max(top, blk, thin);                              // polarity-agnostic thin-structure map
// signature: morphologyEx(src, dst, op, kernel, anchor=(-1,-1), iterations=1, borderType, borderValue)
se.delete(); top.delete(); blk.delete();
```

### `reduce` (projection profiles)
```js
// dim=0 -> reduce to ONE ROW = column sums = vertical-line profile Px(x)
// dim=1 -> reduce to ONE COL = row sums    = horizontal-line profile Py(y)
const Px = new cv.Mat();
cv.reduce(gm, Px, 0, cv.REDUCE_SUM, cv.CV_32F);  // CV_32F REQUIRED — uint8 overflows on ~1200-px sums
// read: Px is 1×W CV_32F -> Px.floatAt(0, x)
```
(`cv.REDUCE_SUM` in 4.x; if a build only exposes the legacy name it is `cv.CV_REDUCE_SUM`.)

### 1-D autocorrelation — recommended: plain JS (no DFT)
```js
// p: Float32Array of the detrended, Hann-tapered profile (length N ~1200)
function autocorr(p, minLag, maxLag) {
  let e0 = 0; for (let i = 0; i < p.length; i++) e0 += p[i] * p[i];
  const r = new Float32Array(maxLag + 1);
  for (let k = minLag; k <= maxLag; k++) {
    let s = 0; for (let i = 0; i + k < p.length; i++) s += p[i] * p[i + k];
    r[k] = s / e0;                    // normalized so r(0)=1
  }
  return r;                            // O(N·lagRange) ~ sub-ms
}
```
If you ever need it via FFT (2-D), Wiener-Khinchin = `IFFT(|FFT|²)`; since `idft` is absent, invert with
the flag: `cv.dft(power, out, cv.DFT_INVERSE | cv.DFT_REAL_OUTPUT | cv.DFT_SCALE)`.

### `dft` (2-D orientation) — reuse `fftOrientations`
`cv.dft(src, dst, flags=0, nonzeroRows=0)`. Pad to `cv.getOptimalDFTSize(...)` with `copyMakeBorder`,
supply a 2-channel (real, zeros) `Mat` or use `cv.DFT_COMPLEX_OUTPUT`, then `cv.split` + `cv.magnitude`
for the spectrum. Already implemented and working in v1.

### `warpPerspective`
```js
cv.warpPerspective(gm, rect, H, new cv.Size(W, Hh),
  cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
// H is 3×3 CV_64FC1. WARP_INVERSE_MAP can be OR'd into flags if H maps dst->src.
```

### `connectedComponentsWithStats` (ROI blob)
```js
const labels = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
const n = cv.connectedComponentsWithStats(binary /*8U 1-ch*/, labels, stats, cent, 8, cv.CV_32S);
for (let i = 1; i < n; i++) {                        // 0 = background
  const area = stats.intAt(i, cv.CC_STAT_AREA);      // LEFT=0 TOP=1 WIDTH=2 HEIGHT=3 AREA=4
  const cx = cent.doubleAt(i, 0), cy = cent.doubleAt(i, 1);
}
// stats: CV_32S, n×5 ; cent: CV_64F, n×2. Access via intAt / doubleAt.
```

## Deformed-lattice / checkerboard libraries — verdict: OVERKILL, don't pull in
- **`findChessboardCornersSB` / libcbdetect (Geiger):** built for **checkerboards**, whose corners are
  **saddle points** (Hessian eigenvalues of opposite sign). Battle-mat grids are drawn **"+"-junctions
  on a flat fill, not black/white saddles** — the saddle/X-corner detector has no signal there, and
  these APIs also demand a known `rows×cols` and full visibility. Wrong tool.
- **Deformed-lattice detection (Park, Collins & Liu — Mean-Shift Belief Propagation over a degree-4
  MRF):** the right *conceptual* frame (recover `(t₁,t₂)` basis + texel, propagate a wallpaper-group
  lattice) and genuinely handles the folded-mat case, but it's a heavy iterative tracker — far more than
  a <3 s browser budget wants, and not in opencv.js. Borrow the **idea** (global `(t₁,t₂)` lattice with
  a consistency score) via the cheap projection+autocorrelation route, not the machinery. Keep as a
  reference only if Phase-3 non-planar handling proves insufficient.

## Parameter cheat-sheet

| Where | Parameter | Pick |
|---|---|---|
| A resize | longest side / interp | 1200 px / `INTER_AREA` |
| A CLAHE | clipLimit / tiles | 2.0 / 8×8 |
| A morph | op / shape / size | `max(TOPHAT, BLACKHAT)` / `MORPH_ELLIPSE` / **9×9** |
| A gradient | operator | `Sobel` ksize 3 → `magnitude` (L2) |
| C Hough gate | angle window | ±12° of θA/θB |
| C VP accept | finite-VP guard | numerous inliers **and** off-frame **and** FFT-consistent, else identity |
| D reduce | rtype / dtype | `REDUCE_SUM` / **`CV_32F`** |
| D detrend | baseline window / taper | moving-avg ~120 px / Hann over profile |
| D autocorr | lag band | `[1200/maxCells, 1200/minCells]`, normalized `r(0)=1` |
| D peak | candidate gate | prominence ≥ 0.25·max, `r(L) ≥ 0.3` |
| D fundamental | comb score / tie-break | `S(L)=mean_{k≤5} r(kL)`, ≥3 harmonics; among `S≥0.8·maxS` pick **largest L** |
| E validity | peak-to-pedestal / squareness | `r(L)/median` high; `|Lx−Ly|/mean < 0.15`; ×centrality, multiplicative |
| F ROI | selection | `connectedComponentsWithStats`, max `area×centrality`, central blob |

## Sources

Projection-profile + autocorrelation, fundamental-vs-harmonic peak selection:
- [Pitch Detection Methods (autocorrelation subharmonic/harmonic ambiguity; weighting & peak filtering)](https://sound.eti.pg.gda.pl/student/eim/synteza/leszczyna/index_ang.htm)
- [CCRMA — Pitch Detection Methods Review](https://ccrma.stanford.edu/~pdelac/154/m154paper.htm)
- [scipy.signal.find_peaks — prominence/distance semantics](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html)
- [scipy.signal.peak_prominences (prominence = height above lowest contour; robust to baseline drift)](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.peak_prominences.html)
- [Detrended windowed autocorrelation — detrend before ACF to remove DC/linear trend](https://journals.sagepub.com/doi/10.1080/17470210802131896)

Top-hat / black-hat for faint thin-line extraction:
- [Top-hat transform (white top-hat isolates features smaller than the SE; SE > line width)](https://en.wikipedia.org/wiki/Top-hat_transform)
- [OpenCV — More Morphology Transformations (top-hat/black-hat definitions)](https://docs.opencv.org/3.4.20/d3/dbe/tutorial_opening_closing_hats.html)
- [PyImageSearch — OpenCV Morphological Operations](https://pyimagesearch.com/2021/04/28/opencv-morphological-operations/)

FFT vs autocorrelation for periodicity (orientation vs pitch split):
- [FFT peaks give orientation AND period of a regular texture](https://calebrob.com/static/fft_playground.html)
- [Wiener–Khinchin: IFFT(power spectrum) = autocorrelation (OpenCV Fourier tutorial)](https://docs.opencv.org/3.4/de/dbc/tutorial_py_fourier_transform.html)

Emergent lattice localization / deformed lattice / checkerboard:
- [Park, Collins & Liu — Deformed Lattice Discovery via Mean-Shift Belief Propagation (ECCV 2008)](https://www.ri.cmu.edu/pub_files/2008/10/eccv08ParkCollinsLiu.pdf)
- [Deformed Lattice Detection project page (PSU vision)](http://vision.cse.psu.edu/research/deformedLattice/Deformed_Lattice_Detection.html)
- [X-Corner detection via saddle points — why checkerboard detectors need saddles, not "+"-junctions](https://www.researchgate.net/publication/298196790_X-Corner_Detection_for_Camera_Calibration_Using_Saddle_Points)

OpenCV.js API (signatures & whitelist):
- [opencv.js build whitelist `platforms/js/opencv_js.config.py` (idft & mulSpectrums absent; reduce, dft, connectedComponentsWithStats present)](https://raw.githubusercontent.com/opencv/opencv/4.x/platforms/js/opencv_js.config.py)
- [OpenCV.js Morphological Operations tutorial (morphologyEx / getStructuringElement JS signatures)](https://docs.opencv.org/4.x/d4/d76/tutorial_js_morphological_ops.html)
- [OpenCV.js Geometric Transformations tutorial (warpPerspective / getPerspectiveTransform JS signatures)](https://docs.opencv.org/4.x/dd/d52/tutorial_js_geometric_transformations.html)
- [OpenCV core — Operations on Arrays (reduce dim/rtype/dtype; REDUCE_SUM may promote bit-depth)](https://docs.opencv.org/4.13.0/d2/de8/group__core__array.html)
