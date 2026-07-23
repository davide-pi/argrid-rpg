# ARGrid — Grid Detector (PWA)

Mobile-first PWA that detects a grid of squares in a photo (graph paper, tiled
floor, ceiling panels, a plexiglass grid…) and highlights it in AR style,
completing rows/columns that are occluded or out of frame.

## How it works

1. Open the app — it opens the camera.
2. Frame a grid of squares (from above; slight tilt / rotation is OK) and shoot.
3. The app finds the rows and columns and overlays them:
   - **cyan** = one family of lines, **magenta** = the perpendicular family

Only **detected** lines are drawn. Interpolated / occluded lines are *not*
guessed and shown, because they are not reliable enough to trust.

4. Tap a cell to select it, then add a tactical overlay following the
   **Pathfinder 2e** area templates. The affected **cells are coloured** (blue
   for areas). One overlay is active at a time and stays editable live — move it
   (tap another cell), change size and creature size, and (for lines/cones)
   **rotate it with a translucent ring** drawn on the map, whose faint ticks mark
   the book orientations and snap the angle to the nearest. Sizes and orientations
   are always the **book-fixed** ones (the exact templates from the diagram).
   - **Emanazione** — measured from the creature with the PF2e alternating-diagonal
     rule (R=1 → 3×3; R=2 → a 5×5 with its four corners cut, since they are 3 away),
     with a **creature size** (Media 1×1 … Mastodontica 4×4).
   - **Esplosione** — from a grid **corner/intersection** (tap picks the nearest);
     diagonals cost extra, so 1 → 2×2, 2 → a cross, etc.
   - **Cono** — a 90° sector of a burst from a grid **corner** next to the cell:
     a right-triangle staircase when diagonal, widening 2,4,6,8… when orthogonal.
   - **Linea** — 1-cell-wide from the cell. Snaps to the **four book
     slopes** (in every direction): 0°, a shallow 1:3 (~18.4°), a steep 1:2
     (~26.6°) and the 45° diagonal — the same for every length (a shorter line is
     the same staircase, truncated).
   - **Movimento** — speed + number of moves colour every reachable cell by which
     move reaches it (green/yellow/orange, cycling), measured from the creature.
   Sizes are in cells (q), metres (m) or feet (ft) — **1 cell = 1.5 m = 5 ft**.
   Distances use PF2e diagonals (alternating 1/2 → 1, 3, 4, 6, 7, 9 …). The result
   canvas is **zoomable** (wheel/pinch) and pannable. (The book template image is
   kept locally in `assets/pf2e-areas.png`, git-ignored.)

Detection is **fully automatic** — there are no thresholds to tune. The only
control is one toggle:

- **Debug** — overlay what the algorithm sees: the Canny edge map plus the raw
  Hough lines (red) before the grid model. Useful to tell *why* a photo fails
  (no edges → contrast/lighting; edges but no red lines → grid too small/weak).

### Pipeline (`src/grid-detector.ts`)

grayscale → **CLAHE** (local contrast) → blur → **auto-Canny** (thresholds from
Otsu) → **adaptive Hough** (accumulator threshold proportional to image size,
self-tuning via retry) → **2-D grid-model fit** (see below) → rebuild the
complete grid.

The detector fits a **true 2-D lattice**, not a bag of independent lines:

1. **Split** the Hough lines into two families by nearest orientation — no hard
   angle cut-off, so a family that spreads under perspective never loses lines.
2. **Merge** the several Hough hits per real line into one (with a support
   count), sign-safely across the 0/180° wrap (OpenCV reports a near-axis line
   as either `(+rho, θ≈0°)` or `(−rho, θ≈180°)`).
3. **Vanishing point per family by RANSAC** — keep only the lines that actually
   *concur* like a grid; text, drawings and stray marks that don't converge are
   rejected.
4. **Rectify** with the horizon (the line through both vanishing points): in the
   rectified plane the two families are parallel and evenly spaced.
5. **Fit a regular lattice** there (robust cell, global integer indexing so one
   off-lattice line can't shift the rest, least-squares refit + outlier
   rejection) and **rebuild every row/column** — occluded ones included — then
   map the complete grid back into the image.

Verified end-to-end against rendered grids: a **strong-perspective 11×11** grid
is recovered in full (all converging lines), and a grid with dozens of noise
scribbles/drawings is recovered cleanly with the noise rejected.

Interpolated (rebuilt) lines are drawn slightly fainter than directly detected
ones. Detected lines keep their exact position; the model only fills genuinely
missing rows/columns between detected ones.

## Develop

```bash
npm install
npm run dev
```

The camera requires a secure context (`https://` or `localhost`). To test on a
phone, expose the dev server with ngrok — `*.ngrok-free.dev` and
`*.ngrok-free.app` are already in Vite's `allowedHosts`:

```bash
ngrok http 5173
```

## Build

```bash
npm run build && npm run preview
```

## Notes / next steps

- OpenCV.js (~11 MB, wasm embedded) is **vendored** at `public/opencv.js` and
  served from our own origin. The service worker precaches it, so it downloads
  **once** and is then served from cache (offline too). The CDN
  (`docs.opencv.org/4.x`) is only a fallback if the local file fails to load.
- The service worker runs only in the **built** app. To test the download-once
  caching on a device, use the production build rather than the dev server:
  `npm run build && npm run preview` (then `ngrok http 4173`).
- **`public/opencv-boot.js` (classic script) loads OpenCV — do not "modernize"
  it into the ES-module app code.** OpenCV's Emscripten runtime only finishes
  initializing when injected/driven from a **classic** script, and the ready
  signal must be a **synchronous callback** (`window.__cvOnReady`), not a
  promise `.then` (Emscripten starves the microtask queue right after init).
  The injected blob URL must **not** be revoked (Emscripten keeps referencing
  it). These constraints were pinned down with a headless-browser harness; the
  comments in `opencv-boot.js` explain each one. `src/main.ts` just consumes
  `window.__cvOnReady` / `window.__cvOnProgress`.
- **2-D grid model** (see the pipeline section) is the core: vanishing-point
  RANSAC + horizon rectification + a per-family lattice fit, which rejects
  non-grid lines (text, drawings, stray edges) by *grid consistency* and rebuilds
  the complete lattice — recovering the far, converging lines that plain
  per-line detection misses under perspective. `params.reconstruct` toggles it;
  `params.fillGrid` toggles rebuilding occluded rows/columns (both on).
- **Known limitation:** a foreign object whose lines are parallel to **and** land
  exactly on the grid's spacing can still alias onto the lattice. Robust
  rejection there would use full 2-D cross-consistency (both families agreeing on
  every intersection); differently-angled, differently-spaced or non-converging
  objects are already rejected.
- **Focus gating (`gateEdgesByFocus`, OFF by default):** available via
  `focusGating`, it drops edges in out-of-focus regions. It is a blunt tool that
  can erase faint or hand-drawn grid lines, so it is disabled by default — the
  2-D grid model is the preferred way to reject non-grid lines. Left in place for
  photos with a strongly out-of-focus background.
- **Object detection — removed for now.** Piece/dice detection (a pixel-level
  foreground mask → morphological opening → connected components, each snapped to
  its X×X footprint) was taken out to focus on grid detection and the tactical
  layer. The full implementation is in git history (`src/object-detector.ts` +
  `test/object-detector.test.ts`) if it needs to come back.
- **Grid rendering** clips each line to the grid's own border — the segment
  between the first and last line of the *other* family — so lines never
  protrude past the outer rows/columns.
- **Zoom/pan (`src/zoom.ts`):** after analysis the result canvas is zoomable
  (mouse wheel / pinch) and pannable (drag), reset on each new capture.
- **Tactical overlays (`src/overlays.ts`):** overlays colour whole CELLS with the
  **Pathfinder 2e** area templates (matched against `assets/pf2e-areas.png`):
  - `blockDist` / `pf2eDist` — grid distance with alternating diagonals (1, 3, 4,
    6, 7, 9 …), measured from a creature's w×w block.
  - **Emanation** = `blockDist` (alternating-diagonal, NOT Chebyshev) from the
    creature's block: R=1 → 3×3, R=2 → a 5×5 with its four corners cut (they are 3
    away by the diagonal rule), R=2 on a Large creature → 6×6 minus corners. The
    block is centred on the selected cell's **top-right corner** (`creatureBlock`:
    odd sizes centre on the cell, even sizes on the corner).
  - **Burst** = from a **selected intersection** (the tap picks the nearest node,
    marked with a dot); `burstDist` puts the four touching cells at 1 and the
    diagonal ones at 3 → 1 → 2×2, 2 → a cross.
  - **Cone** = a 90° sector of the burst from a grid **corner** adjacent to the
    selected cell, its direction snapped to one of the 8 grid orientations
    (`coneDir`). The corner is derived from the cell + direction (`coneOrigin`),
    never the freely-nearest node, so the cone always starts adjacent to the
    creature and doesn't jitter with where in the cell you tapped. Orthogonal cones
    widen 2,4,6,8… (matching the 30-ft template; a short one is 2,4,2); diagonal
    cones are one burst quadrant → a right-triangle staircase. (Starting from a
    corner is a small simplification over the book, which draws short orthogonal
    cones cell-centred as 1,3,3 — but it keeps the origin, dot and ring on one
    clean intersection.)
  - **Line** = from the **selected cell** along the angle; its length is counted
    in PF2e feet (`lineCells`) — each cell is 1, but a diagonal step alternates
    1/2, so a straight 6q line is 6 cells and a 45° 6q line is only 4. Its fixed
    orientations (`lineAngles`) are the **four slopes the book draws**, reflected
    into every octant (so the ring snaps coarsely, not to a fine fan), the same
    for every length: 0°, a shallow 1:3 (~18.4°, the [3,3]/[3,3,3,2] staircase), a
    steep 1:2 (~26.6°, [2,2,1]/[2,2,2,2,2]) and 45°. Verified by rendering each
    staircase against the book crops.
  - **Movement** bands every reachable cell by `ceil(cost / speed)`, from the
    creature's block.
  - **Angle ring:** lines and cones are rotated by a translucent ring drawn on
    the map (`drawAngleRing`), centred on the area's origin and drawn in grid
    space so it follows the perspective. Dragging its band rotates (pan is
    suppressed via `attachZoomPan`'s `suppress` option); faint ticks
    (`fixedAngles`) mark the book orientations and the handle snaps to them
    (`snapToAngles`). Emanation/burst have no orientation, so no ring.
  Origins are derived from the tapped cell; a tap maps back through the inverse
  **grid↔image homography** (`makeGridMap`). Sizes are always the book presets
  (`FIXED_SIZES`) and orientations the book ones (there is no free mode). Movement
  speed is a 1–25 preset, moves 1–5. One overlay is active and editable live (no
  confirm). Covered by `test/overlays.test.ts`.
- **Dev test hook:** in the dev build only, `window.__argrid = { detectGrid, cv,
  DEFAULT_PARAMS, render, view }` is exposed so a headless browser can run
  detection on a synthetic canvas (the CV pipeline can't be driven from Node —
  OpenCV's Emscripten runtime hangs there). Stripped from the production build.
