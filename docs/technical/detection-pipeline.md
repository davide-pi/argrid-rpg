# Detection pipeline (`src/grid-detector.ts`)

Everything here is **automatic** — Canny thresholds come from Otsu, the Hough
threshold self-tunes via a retry loop, families split by nearest orientation (no hard
angle cut-off), and the grid is reconstructed as a true 2-D lattice via vanishing
points + rectification. Output is plain data in **original image coordinates**, so the
UI draws with Canvas 2D and no OpenCV.

Entry points (all funnel into `detectGridFromMat`):

- `detectGrid(cv, srcCanvas, params, wantEdges)` — from a canvas (`grid-detector.ts:101`).
- `detectGridFromImageData(cv, imageData, …)` — DOM-free, for a Worker (`grid-detector.ts:136`).
- `detectGridFromMat(cv, work, W0, H0, scale, …)` — shared core (`grid-detector.ts:172`).

## Stages

| # | Stage | Where | Notes |
| --- | --- | --- | --- |
| 1 | Downscale to `maxDim` | `detectGrid` / `…FromMat` | `INTER_AREA`; `scale` is carried so lines map back to original coords (`grid-detector.ts:109`). |
| 2 | Grayscale → **CLAHE** (local contrast) | `grid-detector.ts:190` | `cv.CLAHE(2.0, 8×8)` so faint / unevenly-lit grids still yield edges. |
| 3 | Gaussian blur 3×3 | `grid-detector.ts:195` | |
| 4 | **Auto-Canny** from Otsu | `grid-detector.ts:199` | `high = round(otsu)`, `low = round(0.5·otsu)` (`:207`), then `cv.Canny` (`:211`). |
| 5 | Focus gating (optional) | `gateEdgesByFocus` `grid-detector.ts:296` | **Off by default**; suppresses blurry, out-of-plane edges by local `|Laplacian|` vs the median. Called at `:221`. |
| 6 | **Adaptive Hough** | `grid-detector.ts:229` | `cv.HoughLines`, 0.5° resolution (`:230`); threshold starts at `max(30, minDim·0.3)` and self-tunes over ≤8 tries (too few → relax, >600 → tighten). |
| 7 | Parse raw lines, **rho kept SIGNED** | `grid-detector.ts:244` | θ→`[0,180)`; rho stays signed so the 0/180° wrap doesn't collapse two parallel lines. See the wrap note below. |
| 8 | Build the 2-D lattice | `buildGrid` `grid-detector.ts:424` | The rest of this section. |
| 9 | Debug edges (optional) | `grid-detector.ts:261` | When `wantEdges`, packs the Canny mask into an RGBA `ImageData` (DOM-free). |

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
6. **Rebuild occluded rows/cols** — missing indices are emitted as `filled: true` lines
   when `fillGrid` and the span ≤ 200 (`grid-detector.ts:798`). Detected lines are
   `filled: false`.
7. **Map back into the image** — `fromCentered` (`:465`) + `backToImage` (`:687`); the
   result carries `familyA`, `familyB`, `rawLines`, and `info`.

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
| `reconstruct` | `true` | Rebuild the regular lattice and drop off-lattice lines; if off, only detected offsets are used (`:735`). |

## `GridResult.info` (diagnostics, `grid-detector.ts:52`)

`rawCount`, `aCount`, `bCount`, `angleADeg/BDeg`, `spacingA/B` (px, original coords),
`usedHough` (settled threshold), `cannyHigh` (from Otsu), `edgePixels`. Surfaced in the
status line when `debug` is on (`main.ts:382`).

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
