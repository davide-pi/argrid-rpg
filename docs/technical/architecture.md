# Architecture

argrid-rpg is a single-page PWA with no framework. All modules share **one** mutable state
object (`S` in `tactical-state.ts`) and draw onto one `<canvas id="view">` where both the
captured photo and every overlay are painted (so alignment is exact). OpenCV is used **only**
inside `grid-detector.ts`; everything else is plain TypeScript. After a big consolidation
`main.ts` is thin — it boots, captures, runs detection, and calls each module's `initX()` — while
the rendering, gestures, HUD, placement and manual-grid editor each live in their own module.

## Module map

| Module | File | Responsibility |
| --- | --- | --- |
| App boot / wiring | `src/main.ts` | Boot, camera capture, `runDetection`, result chrome (`applyDetectedGrid`/`updateResultChrome`), the ordered `initX()` calls. No draw loop / HUD / gestures / placement here anymore. |
| Shared state | `src/tactical-state.ts` | The one mutable `S` object (grid, selection, tokens, overlay, debug, manual-grid flags) + the `Token` interface and `ImgPt` type. |
| DOM refs | `src/dom.ts` | Central `getElementById` bindings (`$` helper) every module imports. |
| Shared geometry | `src/geometry.ts` | Pure projective math (`intersect`, `invert3x3`) shared by the detector **and** overlays — a dependency-free leaf so neither couples to the other. |
| CV pipeline | `src/grid-detector.ts` | Photo → two line families → 2-D lattice reconstruction. Pure data out (image coords); no DOM in the core (`buildGrid`, `detectGridFromMatSteps`). Re-exports `intersect` from geometry. |
| Tactical engine | `src/overlays.ts` | Grid↔image homography + PF2e geometry: distances, area templates, reach/threat, movement search, Pareto routes. Pure functions, unit-tested. |
| Render | `src/draw-loop.ts` | The single `draw()` pass (photo + grid + tactical overlays on one canvas) and every `draw*`/`fillCells` helper; `ENEMY_COL`/`ALLY_COL`/`MAX_PATH_MOVES`. |
| Board logic | `src/board.ts` | Token / threat / flanking geometry over `S.tokens` (`tokenBlock`, `tokenObstaclesFor`, `threatCountMaps`, `oppThreatAreas`, `flankedEnemies`, `tokenAt`). No drawing/DOM. |
| HUD | `src/hud.ts` | The contextual heads-up panel (`refreshHud`/`hudContext`/`showHud`) + the `(i)` help popover. |
| Placement | `src/placement.ts` | FAB placement, per-piece editor, area form, movement start, the on-map angle ring (`setPlaceMode`, `updateFabIcon`, `ringHit`, `threatSidesToShow`). |
| Gestures | `src/gestures.ts` | Pointer tap / long-press / drag / rotate on the map (`initGestures`, `pointerToGrid`, `selectCellAt`); shares `activePointers` via `pointer-capture.ts`. |
| Manual grid | `src/manual-grid.ts` | By-hand grid editor: adapt a draggable quad / trace reference lines, + magnifier loupe (`enterManualMode`, `commitManualGrid`). |
| Debug panel | `src/debug-panel.ts` | Dev-only pipeline graph + confidence/timing logs, `drawDebugStep`, and the triple-tap debug toggle. |
| Tap-to-focus | `src/tap-to-focus.ts` | Live-preview tap → focus reticle + the focus point the next capture weights. |
| DEV hook | `src/dev-hook.ts` | `installDevHook` — the `window.__argrid` test surface (DEV only). |
| Camera | `src/camera.ts` | `getUserMedia` (rear camera) wrapper; `grabFrame()` → canvas at native resolution. |
| Zoom / pan | `src/zoom.ts` | CSS-transform pinch / wheel / drag zoom on the view; `suppress()` hook to freeze pan during a gesture. |
| OpenCV bootstrap | `public/opencv-boot.js` | Classic (non-module) script: fetches `opencv.js` with progress, exposes `window.__cvOnProgress` / `window.__cvOnReady`. |
| Markup / styles | `index.html`, `src/style.css` | App layout, loader, HUD, FAB; PWA shell. |
| Build / PWA | `vite.config.ts` | `__APP_VERSION__` define, `vite-plugin-pwa` (precache incl. ~11 MB `opencv.js`). |

## Runtime data flow

```mermaid
flowchart TD
  boot["boot() — main.ts:96"] -->|__cvOnReady| cvready["cv ready + installDevHook (DEV) — dev-hook.ts"]
  cvready --> cam["camera.start() — camera.ts"]
  cam -->|"Scatta"| capture["capture() → grabFrame() — main.ts:156"]
  capture --> process["processImage(canvas) — main.ts:167"]
  process --> detect["runDetection → detectGridSteps(...) — main.ts:212 / grid-detector.ts"]
  detect --> result["GridResult { familyA, familyB, rawLines, info, edges? }"]
  result --> gmap["applyDetectedGrid → makeGridMap(familyA, familyB) — main.ts:299 / overlays.ts:115"]
  gmap --> draw["draw() — draw-loop.ts:14"]

  subgraph redraw["draw() — cheap, NEVER re-runs OpenCV"]
    draw --> photo["drawImage(lastCapture)"]
    photo --> grid["drawFamily × 2 (single colour) — draw-loop.ts:56"]
    grid --> tac["overlay → paths → threat → flanking → tokens → selection + ring"]
  end

  gesture["pointer (gestures.ts) / HUD / FAB events"] -->|mutate S, call draw()| draw
```

Key point: detection runs **once per capture** (`runDetection`, `main.ts:212`). Every
interaction after that — selecting cells, moving pieces, rotating the angle ring, editing an
area — only mutates the shared state `S` and calls `draw()` (`draw-loop.ts:14`). `draw()`
repaints the photo plus the vector overlays; it does not touch OpenCV. This is what keeps the UI
responsive on a phone.

**Reliability gate + manual grid.** After detection, `applyDetectedGrid` sets
`gridReliable = isGridReliable(info)`: the calibrated `confidence` must clear
`DRAW_THRESHOLD` (0.65), plus two HARD guards the score can't override (`!degenerate`,
`detectedA,detectedB ≥ 2`) — cell-count, aspect and regularity are folded into the
`confidence` itself (see [decisions.md](decisions.md)). When it's false, the grid + tactical
layer are simply **not** drawn (the photo shows alone); there is **no** automatic panel. Guidance lives in the
single info **(i)** button (bottom-left), and a top-bar **edit-grid** button opens an
on-demand chooser (`#editChooser`: *grid to adapt* / *draw by hand*) on any result;
**cancel restores the detected grid**. Both manual modes synthesise the same
`familyA`/`familyB` `Line2[]` the detector emits — *adapt* tiles a draggable quad via
the quad→unit-square homography; *draw* traces reference lines fed to `buildGrid` —
and on commit the lattice is extended to fill the frame. So `draw()`, `makeGridMap`
and every tactical tool are agnostic to whether the grid came from CV or the user's
hand. See [decisions.md](decisions.md) ("Unreliable auto grid → photo alone + (i)
guidance + on-demand manual editor").

## Boot path (why a classic script)

OpenCV's Emscripten runtime does **not** initialize when driven from an ES module, so
it is loaded by a **classic** `<script src="/opencv-boot.js">` in `index.html`
(before `src/main.ts`). The bootstrap fetches `opencv.js` with byte progress, injects
it as a blob `<script>`, and signals readiness via a **synchronous** callback
(`cv.onRuntimeInitialized`) exposed as `window.__cvOnReady` — deferring even one
microtask can wedge the main thread. See the header comment block in
`public/opencv-boot.js` and [decisions.md](decisions.md).

`main.ts` `boot()` (`main.ts:96`) subscribes to `window.__cvOnProgress` (loader bar)
and `window.__cvOnReady` (`main.ts:114`); only when ready does it enable capture and
start the camera.

## DEV / test hook — `window.__argrid`

`installDevHook(mod)` lives in `src/dev-hook.ts`; `boot()`'s ready callback calls it only when
`import.meta.env.DEV` (so the whole module is tree-shaken from production builds — `main.ts:119`).
A headless browser (Playwright) uses it to drive detection and the tactical UI on a synthetic
canvas. Fields:

| Field | Purpose |
| --- | --- |
| `detectGrid`, `cv`, `DEFAULT_PARAMS` | Run the pipeline directly on a synthetic `<canvas>`. |
| `render(canvas)` | Feed a canvas straight into `processImage()`. |
| `view` | The result `<canvas>` element. |
| `cellClient(i, j)` | Client-space (screen) position of grid node `(i,j)` — to script taps / ring drags. |
| `ringHandle()` | Grid position of the angle-ring tip handle. |
| `effectiveAngle()` | Current snapped line/cone angle. |
| `state()` | Snapshot `{ gridReliable, gridDims, showingResult }` for assertions. |
| `focus()` / `setFocus(p)` | Read the tap-to-focus point, or set one (normalized `[0,1]`) and re-detect the last capture. |

See [detection-pipeline.md](detection-pipeline.md) for the CV stages and
[tactical-overlays.md](tactical-overlays.md) for the engine.
