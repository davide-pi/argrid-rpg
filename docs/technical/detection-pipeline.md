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
- `detectGridFromImageData(cv, imageData, …)` — sync, DOM-free, for a Worker.
- `detectGridFromMat(cv, work, W0, H0, scale, …)` — sync wrapper that drives
  `detectGridFromMatSteps` to completion (tests, the DEV hook).

## Stages

| # | Stage | Where | Notes |
| --- | --- | --- | --- |
| 1 | Downscale to `maxDim` | `detectGrid` / `…FromMat` | `INTER_AREA`; `scale` is carried so lines map back to original coords (`grid-detector.ts:109`). |
| 2 | Grayscale → **CLAHE** (local contrast) | `grid-detector.ts:190` | `cv.CLAHE(2.0, 8×8)` so faint / unevenly-lit grids still yield edges. |
| 3 | Gaussian blur 3×3 | `grid-detector.ts:195` | |
| 4 | **Auto-Canny** from Otsu | `grid-detector.ts:199` | `high = round(otsu)`, `low = round(0.5·otsu)`, then `cv.Canny`. |
| 5 | **Chromatic edges** (optional) | `chromaEdges` | On (`colorEdges`) and when the source is RGBA: auto-Canny the Lab **a/b** channels and OR into the luminance edges, so a grid that differs from its background only in **hue** (no luminance edge) is still found. A near-neutral channel (std < `CHROMA_MIN_STD` = 3) is skipped. |
| 6 | Focus gating (optional) | `gateEdgesByFocus` | **Off by default**; suppresses blurry, out-of-plane edges by local `|Laplacian|` vs the median. |
| 7 | **Adaptive Hough** | `houghToGrid` | `cv.HoughLines`, 0.5° resolution; threshold starts at `max(30, minDim·0.3)` and self-tunes over ≤8 tries (too few → relax, >600 → tighten). |
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
   Refined by least squares (`vanishingPoint` `:650`); parallel → VP at infinity.
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
| `angleTolDeg` | `24` | Family-axis tolerance (kept for callers; the split itself uses nearest-axis, no hard cut). |
| `mergeFrac` | `0.012` | Offset merge distance as a fraction of `maxDim` (`:491`). |
| `fillGrid` | `true` | Emit occluded rows/cols as `filled` lines (`:798`). UI forces this on (`main.ts:233`). |
| `focusGating` | `false` | Suppress out-of-focus edges before Hough. Off — it erased faint/hand-drawn grids. |
| `reconstruct` | `true` | Rebuild the regular lattice and drop off-lattice lines; if off, only detected offsets are used. |
| `lineMorph` | `true` | Noisy/low-contrast fallback (grid on dirt/cork): if the plain Canny path detects `< 3` lines per family, retry on a morphological line mask (`enhanceGridLines`) and keep it if it detects more. Strength is counted from **detected** lines only, so fill/extension can't mask a weak detection. |
| `extend` | `'frame'` | Extrapolate the fitted lattice past the detected lines (step 7): `'off'` none, `'border'` a couple of cells to recover a missed outer edge, `'frame'` tile the whole frame (virtual grid). |
| `colorEdges` | `true` | Also detect **chromatic** edges (Lab a/b) and OR them into the luminance Canny, so a grid distinguished from its background by hue (not brightness) is found (`chromaEdges`, stage 5). |

## `GridResult.info` (diagnostics, `grid-detector.ts:52`)

`rawCount`, `aCount`, `bCount`, `angleADeg/BDeg`, `spacingA/B` (px, original coords),
`usedHough` (settled threshold), `cannyHigh` (from Otsu), `edgePixels`. Surfaced in the
status line when `debug` is on (`main.ts:382`). Note `aCount`/`bCount` are the **total**
family sizes (detected + filled + extended); the `lineMorph` fallback gates on
detected-only counts instead, so extension never suppresses it.

## Debug output (edges + raw Hough lines)

`detectGrid(…, wantEdges=true)` fills `result.edges` (Canny mask as `ImageData`).
`draw()` blits it at 0.45 alpha and strokes every `rawLines` entry in translucent red
(`main.ts:412`). Debug is a module boolean toggled by **triple-tapping the logo**
(`main.ts:1660`), which re-runs detection so the diagnostics appear/disappear.

## Verifying the pipeline

OpenCV.js hangs in Node ESM (Emscripten wedges the thread) — verify in a **headless
browser (Playwright) on `127.0.0.1`** via `window.__argrid` (render a synthetic grid,
inspect `r.info` / families). Pure geometry (`buildGrid` fed synthetic `RawLine[]`) is
unit-tested in `test/grid.test.ts`, but that path bypasses Hough's θ-wrap. See
[architecture.md](architecture.md) for the DEV hook and [decisions.md](decisions.md).
