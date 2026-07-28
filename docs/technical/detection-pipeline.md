# Detection pipeline (`src/grid-detector.ts`)

Everything here is **automatic** — Canny thresholds come from Otsu, the Hough
threshold self-tunes via a retry loop, families split by nearest orientation (no hard
angle cut-off), and the grid is reconstructed as a true 2-D lattice via vanishing
points + rectification. Output is plain data in **original image coordinates**, so the
UI draws with Canvas 2D and no OpenCV.

Entry points (all funnel into the generator `detectGridFromMatSteps`):

- `detectGrid(cv, srcCanvas, params, wantEdges)` — sync, from a canvas.
- `detectGridSteps(cv, srcCanvas, …)` — **generator**: `yield`s a `{frac,label}` `DetectProgress`
  tick before each heavy stage and `return`s the `GridResult`. The app drives it with a frame
  yield between steps (`runDetection` in `main.ts`) to paint the progress bar / keep the loading
  die spinning while the still-synchronous OpenCV stages briefly block the main thread.
- `detectGridFromMat(cv, work, W0, H0, scale, …)` — sync wrapper (on an already-scaled
  Mat) that drives `detectGridFromMatSteps` to completion (tests, the DEV hook).

## Stages

| # | Stage | Where | Notes |
| --- | --- | --- | --- |
| 1 | Downscale to `maxDim` | `detectGrid` / `…FromMat` | `INTER_AREA`; `scale` is carried so lines map back to original coords (`grid-detector.ts:109`). |
| 2 | Grayscale → **CLAHE** (local contrast) | `grid-detector.ts:190` | `cv.CLAHE(2.0, 8×8)` so faint / unevenly-lit grids still yield edges. |
| 3 | Gaussian blur 5×5 | `grid-detector.ts` | A touch more denoising than 3×3 before Otsu/Canny (CLAHE just before amplifies noise); the Otsu-derived Canny thresholds are computed on this blurred image. |
| 4 | **Auto-Canny** from Otsu | `grid-detector.ts:199` | `high = round(otsu)`, `low = round(0.5·otsu)`, then `cv.Canny`. |
| 5 | **Chromatic edges** (optional) | `chromaEdges` | On (`colorEdges`) and when the source is RGBA: auto-Canny the Lab **a/b** channels and OR into the luminance edges, so a grid that differs from its background only in **hue** (no luminance edge) is still found. A near-neutral channel (std < `CHROMA_MIN_STD` = 3) is skipped. |
| 6 | Focus gating (optional) | `gateEdgesByFocus` | **Off by default**; suppresses blurry, out-of-plane edges by local `|Laplacian|` vs the median. |
| 7 | **Adaptive Hough** | `houghToGrid` | `cv.HoughLines`, 0.5° resolution; threshold starts at `max(30, minDim·0.3)` and self-tunes over ≤8 tries (too few → relax, >600 → tighten). |
| — | **Oriented re-extraction** (optional, VP-aware) | `orientEdgesVP` | On (`orientGate`) and only when the first fit is WEAK (`gridStrength < ORIENT_SKIP_STRENGTH` = 6): keep only edge pixels whose gradient matches the LOCAL expected grid normal of either family (direction to that family's vanishing point ± `ORIENT_TOL_DEG` = 15° — so it follows the perspective fan), re-run Hough, and keep the re-fit **only if strictly stronger** (so it can only help; a good fit is left untouched). |
| — | **Noisy fallback** (optional) | `enhanceGridLines` | If the standard path detects `< 3` lines per family and `lineMorph` is on, retry Hough on a morphological line mask (directional openings that suppress isotropic texture) and keep it if it detects more. |
| 8 | Parse raw lines, **rho kept SIGNED** | `grid-detector.ts:244` | θ→`[0,180)`; rho stays signed so the 0/180° wrap doesn't collapse two parallel lines. See the wrap note below. |
| 9 | Build the 2-D lattice | `buildGrid` | The rest of this section (incl. the `extend` extrapolation, step 7 there). |
| 10 | Debug edges (optional) | `grid-detector.ts:261` | When `wantEdges`, packs the (combined) edge mask into an RGBA `ImageData` (DOM-free). |

## `buildGrid` — from lines to a lattice (`grid-detector.ts:424`)

Works in **image-centred** coordinates for numerical stability (`:458`), then maps back.

1. **Split into two families by nearest orientation** — a 2°-bin angle histogram
   finds the dominant axis `axisA`; `axisB = axisA + 90°`; each line joins the nearer
   axis with **no discard** (`grid-detector.ts:472`), so perspective spread never
   drops a real line.
2. **Merge Hough duplicates** — `mergeDuplicateLines` (`grid-detector.ts:617`) collapses
   the several Hough hits on one physical line into one, keeping a `support` count;
   offsets/angles averaged sign-safely across the 0/180° wrap.
3. **Vanishing point per family (RANSAC)** — `ransacVP` (`grid-detector.ts:556`) picks
   the VP where the most lines concur (≤1.5° residual, `vpResidualDeg` `:531`); lines
   that don't converge like the grid (text, drawings, stray marks) are rejected.
   Refined by least squares (`vanishingPoint` `:650`); parallel → VP at infinity. A
   finite VP **inside** the frame is normally spurious (`VP_FRAME_MARGIN`) and dropped
   back to "parallel" — EXCEPT when the evidence is strong (wide inlier fan
   `VP_STRONG_FAN_DEG` + many concurrent lines `VP_STRONG_MIN_INLIERS`): that is a
   genuine shallow-angle floor/table VP, so it's trusted. Without this override a
   low-angle floor collapses to a fronto-parallel 2×2 (the vanishing point rejected →
   no rectification). A fronto-parallel grid fans ~0° and never triggers the override.
4. **Rectify with the horizon** — `buildRectify` (`grid-detector.ts:590`) sends the
   horizon `VP_A × VP_B` to infinity; in the rectified plane each family is parallel
   and **evenly spaced**.
5. **Fit + rebuild the lattice per family** — `fitFamilyGrid` (`grid-detector.ts:684`):
   robust cell pitch (`robustCell` `:668`), dedupe cell-splitting duplicates, pick the
   anchor phase whose lattice captures the most lines (`:739`), snap each line to a
   **global integer index** `round((off − a) / b)` (not a running sum, so one
   off-lattice line can't shift the rest), iterative LSQ refit with inlier reject
   (`:761`), then rebuild every row/column from `kmin…kmax`.
6. **Rebuild occluded rows/cols** — missing indices between `kmin…kmax` are emitted as
   `filled: true` lines when `fillGrid` and the span ≤ 200. Detected lines are
   `filled: false`.
7. **Extrapolate past the detected extent** (`extend`) — continue the same lattice
   `a + b·k` OUTWARD from `kmin`/`kmax`, mapped back through the homography. Each
   candidate is kept only while it still crosses the image frame (`crossesImage`) and
   until successive lines crowd to within `EXTEND_MIN_GAP_PX` px at the image centre
   (they pile up toward a vanishing point). `'border'` adds ≤ `EXTEND_BORDER_CELLS` (2)
   cells per side (recovers an outer edge the detector missed); `'frame'` tiles the whole
   frame (a virtual grid, cap `EXTEND_FRAME_CELLS` = 120). Extended lines are flagged
   `extended: true` **and** `filled: true`, so they draw faint (0.5α). `'off'` skips this.
8. **Map back into the image** — `fromCentered` (propagates `filled`/`extended`) +
   `backToImage`; the result carries `familyA`, `familyB`, `rawLines`, and `info`.

### The 0/180° rho-wrap (do not average raw rho)

A near-axis line (θ≈0°) is reported by Hough alternately as `(+rho, θ≈0.5°)` and
`(−rho, θ≈179.5°)` — the same line, opposite rho sign. **Averaging raw rho collapses
it to ~0.** The fix: project onto the cluster normal, `d = mean(rho·cos(θ − θ̄))`, which
is sign-consistent (`mergeDuplicateLines` `:617`; rho kept signed at `:244`). Symptom:
the debug/raw overlay looks right but one *final* family is garbage. Unit tests with
exact synthetic θ do **not** catch it — only real Hough output does.

## `DetectorParams` knobs (`grid-detector.ts:19`, defaults `:35`)

| Knob | Default | Effect |
| --- | --- | --- |
| `maxDim` | `1600` | Longest side after downscale (speed/robustness). |
| `mergeFrac` | `0.012` | Offset merge distance as a fraction of `maxDim`. |
| `fillGrid` | `true` | Emit occluded rows/cols as `filled` lines (`:798`). UI forces this on (`main.ts:233`). |
| `focusGating` | `false` | Suppress out-of-focus edges before Hough. Off — it erased faint/hand-drawn grids. |
| `reconstruct` | `true` | Rebuild the regular lattice and drop off-lattice lines; if off, only detected offsets are used. |
| `lineMorph` | `true` | Noisy/low-contrast fallback (grid on dirt/cork): if the plain Canny path detects `< 3` lines per family, retry on a morphological line mask (`enhanceGridLines`) and keep it if it detects more. Strength is counted from **detected** lines only, so fill/extension can't mask a weak detection. |
| `extend` | `'frame'` | Extrapolate the fitted lattice past the detected lines (step 7): `'off'` none, `'border'` a couple of cells to recover a missed outer edge, `'frame'` tile the whole frame (virtual grid). |
| `colorEdges` | `true` | Also detect **chromatic** edges (Lab a/b) and OR them into the luminance Canny, so a grid distinguished from its background by hue (not brightness) is found (`chromaEdges`, stage 5). |
| `fftPrior` | `true` | FFT periodicity prior: fix the family-orientation split when the angle histogram locks onto a wrong orientation (`fftOrientations`). Overrides only when it confidently disagrees. |
| `orientGate` | `true` | VP-aware oriented re-extraction on a weak first fit (`orientEdgesVP`); contained (kept only if strictly stronger), so it can only help. |

## `GridResult.info` (diagnostics, `grid-detector.ts:52`)

`rawCount`, `aCount`, `bCount`, `angleADeg/BDeg`, `spacingA/B` (px, original coords),
`usedHough` (settled threshold), `cannyHigh` (from Otsu), `edgePixels`, plus
`detectedA`/`detectedB` (real DETECTED lines per family) and `confidence` (0..1).
Surfaced in the status line when `debug` is on. Note `aCount`/`bCount` are the **total**
family sizes (detected + filled + extended); the `lineMorph` fallback and `confidence`
gate on the **detected-only** counts instead, so fill/extension never inflate them.
`confidence` = `clamp((min(detectedA, detectedB) − 2) / 4, 0, 1)` (diagnostic only). The
UI no longer gates on `confidence` or shows a toast: `applyDetectedGrid()` (in `main.ts`)
sets `gridReliable = detectedA ≥ 2 && detectedB ≥ 2 && cellsA,cellsB ≥ MIN_GRID_CELLS (5)
&& !degenerate && aspect ≤ MAX_CELL_ASPECT` and draws the grid it found, or the photo
alone when unreliable. The `MIN_GRID_CELLS` floor (drawn cells per side) rejects the
tiny 2×2 a bad perspective fit collapses to. Contextual guidance ("Nessuna griglia
rilevata — usa il tasto griglia / fotocamera", etc.) is carried by the single info
**(i)** button (bottom-left), not a transient toast.

## Debug output (edges, raw Hough lines, step viewer)

`detectGrid(…, wantEdges=true)` fills `result.edges` (Canny mask as `ImageData`).
`draw()` blits it at 0.45 alpha and strokes every `rawLines` entry in translucent red.
Debug is a module boolean toggled by **triple-tapping the logo**, which re-runs
detection so the diagnostics appear/disappear.

When `wantEdges`, the generator also captures a downscaled RGBA snapshot of each stage
into `result.debugSteps` (`DebugStep[]`: Grigio → CLAHE → Sfocatura → Canny → +cromatica
→ orientati → morfologico — the last two only appear when those optional stages run) via
`matToPreview`. `main.ts` renders a top **step-chip bar** (`#debugBar`,
`rebuildDebugBar`) — the default chip is the live line overlay, the others blit that
stage's image onto the view canvas (`drawDebugStep`), so you can inspect where the
pipeline diverges from the photo.

## Verifying the pipeline

OpenCV.js hangs in Node ESM (Emscripten wedges the thread) — verify in a **headless
browser (Playwright) on `127.0.0.1`** via `window.__argrid` (render a synthetic grid,
inspect `r.info` / families). Pure geometry (`buildGrid` fed synthetic `RawLine[]`) is
unit-tested in `test/grid.test.ts`, but that path bypasses Hough's θ-wrap. See
[architecture.md](architecture.md) for the DEV hook and [decisions.md](decisions.md).
