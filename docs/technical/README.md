# argrid-rpg — Technical docs (investigation guide)

**argrid-rpg** is a mobile-first PWA (Vite + TypeScript + OpenCV.js). It photographs a
square grid, reconstructs it as a true 2-D lattice, and overlays a Pathfinder 2e
tactical map (areas of effect, movement, reach/threat, flanking) drawn with the
Canvas 2D API through a grid↔image homography.

These docs are a **routing map**, not a re-explanation of the source: each row points
you at the entry file, the symbol, and a grep to confirm the current line. All
`file:line` anchors were checked against the source at the time of writing — if a line
has drifted, use the grep column to relocate the symbol.

Everything runs client-side. OpenCV is used **only** for detection; all drawing and
tactical geometry is plain TypeScript, so a redraw (`draw()`) never re-runs OpenCV.

## Where to look (task → entry point)

| Task / symptom | Entry file (`src/…`) | Grep to locate it |
| --- | --- | --- |
| Tune detection (Canny/Hough/CLAHE, retry loop, family split) | `grid-detector.ts` — `detectGridFromMat` | `rg -n "cv\.(CLAHE\|Canny\|HoughLines)\|THRESH_OTSU" src/grid-detector.ts` |
| Detection knobs (reconstruct, fillGrid, focusGating, maxDim, tolerances) | `grid-detector.ts` — `DetectorParams` / `DEFAULT_PARAMS` | `rg -n "DetectorParams\|DEFAULT_PARAMS" src/grid-detector.ts` |
| Grid lines look wrong / missing / off-lattice (VP, rectify, lattice fit) | `grid-detector.ts` — `buildGrid`, `ransacVP`, `fitFamilyGrid` | `rg -n "buildGrid\|ransacVP\|fitFamilyGrid\|buildRectify" src/grid-detector.ts` |
| Shared projective math (`intersect`, matrix inverse) | `geometry.ts` — `intersect`, `invert3x3` | `rg -n "intersect\|invert3x3" src/geometry.ts` |
| Grid line **drawing** (colour, occluded/filled lines, clipping to border) | `draw-loop.ts` — `draw` / `drawFamily` | `rg -n "drawFamily\|gridColor\|l\.filled" src/draw-loop.ts` |
| Add / adjust an **area template** (emanation/burst/cone/line) | `overlays.ts` — `areaCells` | `rg -n "areaCells\|blockDist\|burstDist\|lineCells\|coneDir" src/overlays.ts` |
| Change area **size presets / cap / angle presets** | `overlays.ts` — `AREA_PRESETS`, `MAX_SIZE_SHOWN`, `lineAngles`, `fixedAngles` | `rg -n "AREA_PRESETS\|MAX_SIZE_SHOWN\|lineAngles\|fixedAngles\|snapToAngles" src/overlays.ts` |
| Change a **hand-set size field** (area size or piece movement: manual entry, 1 q steps, preset chips) | `placement.ts` — `makeCellStepper`, `maxCellsIn`, `refreshSizeUI`, `showPieceSpeed`; `index.html` `#areaSizeStep` / `#pieceMoveStep` / `#areaPresets` | `rg -n "makeCellStepper\|maxCellsIn\|SizeCells\|PieceSpeed" src/placement.ts` |
| Change **movement** search (Dijkstra, diagonals, reachable bands) | `overlays.ts` — `dijkstraStates`, `moveCells` | `rg -n "dijkstraStates\|moveSearch\|moveCells" src/overlays.ts` |
| Change **route preview** (Pareto cost↔threats) | `overlays.ts` — `movePareto`; `draw-loop.ts` — `drawPaths` | `rg -n "movePareto\|ParetoRoute\|drawPaths" src/overlays.ts src/draw-loop.ts` |
| Change **reach / threat / flanking** display | `overlays.ts` — `threatCells`; `board.ts` — `threatCountMaps`/`flankedEnemies`; `draw-loop.ts` — `drawThreat` | `rg -n "threatCells\|drawThreat\|flankedEnemies\|threatSidesToShow" src/*.ts` |
| Change **tokens / obstacles** logic (blocks, occupancy) | `board.ts` — `tokenBlock`, `tokenObstaclesFor`, `tokenAt` | `rg -n "tokenBlock\|tokenObstaclesFor\|tokenAt\|blockToCell" src/board.ts` |
| Tweak the **HUD** (contextual panel + `(i)` help) | `hud.ts` — `refreshHud` / `hudContext` / `currentInfo`; `index.html` `#hud` | `rg -n "refreshHud\|hudContext\|showHud\|currentInfo" src/hud.ts` |
| Tweak the **FAB** speed-dial / placement modes | `placement.ts` — `setPlaceMode`, `updateFabIcon`, `placeAreaAt` | `rg -n "placeMode\|setPlaceMode\|fab\b" src/placement.ts` |
| Change **pointer gestures** (tap/long-press/drag/pinch, angle ring) | `gestures.ts` — `initGestures` (`pointerdown`/`move`/`up` handlers) | `rg -n "addEventListener\('pointer" src/gestures.ts` |
| Edit a grid **by hand** (adapt a quad / trace lines) | `manual-grid.ts` — `enterManualMode`, `commitManualGrid` | `rg -n "enterManualMode\|commitManualGrid\|manualToFamilies\|regenerateFromStrokes" src/manual-grid.ts` |
| Read/mutate shared **app state** (`S`) | `tactical-state.ts` — the `S` object, `Token`, `ImgPt` | `rg -n "export const S\|interface Token" src/tactical-state.ts` |
| Grid↔image mapping (homography) | `overlays.ts` — `makeGridMap`, `toImage`/`toGrid` | `rg -n "makeGridMap\|solveHomography\|toGrid" src/overlays.ts` |
| **Camera** capture (getUserMedia, grabFrame) | `camera.ts` — `Camera` | `rg -n "getUserMedia\|grabFrame" src/camera.ts` |
| **Tap-to-focus** (live-preview reticle → focus point) | `tap-to-focus.ts` — `initTapToFocus`, `mapPreviewTap` | `rg -n "initTapToFocus\|mapPreviewTap\|focusPoint" src/tap-to-focus.ts` |
| **Zoom / pan** (pinch, wheel, drag; suppress during gestures) | `zoom.ts` — `attachZoomPan` | `rg -n "attachZoomPan\|suppress\|zoomAt" src/zoom.ts` |
| **OpenCV boot** / ready callback | `public/opencv-boot.js`; `main.ts` — `boot` | `rg -n "__cvOnReady\|__cvOnProgress\|onRuntimeInitialized" src/main.ts public/opencv-boot.js` |
| **DEV / test hook** (`window.__argrid`) | `dev-hook.ts` — `installDevHook`; called from `main.ts` (DEV-only) | `rg -n "__argrid\|installDevHook\|import\.meta\.env\.DEV" src/dev-hook.ts src/main.ts` |
| Debug overlay + pipeline panel (edges, raw Hough, graph) | `draw-loop.ts` — `draw` (`S.debug` branch); `debug-panel.ts` — panel + triple-tap toggle | `rg -n "S\.debug\|r\.edges\|rawLines\|rebuildDebugBar" src/draw-loop.ts src/debug-panel.ts` |

## Related

- [architecture.md](architecture.md) — module map, runtime data flow, boot path, DEV hook.
- [detection-pipeline.md](detection-pipeline.md) — the CV pipeline in `grid-detector.ts`, stage by stage.
- [tactical-overlays.md](tactical-overlays.md) — the geometry + RPG engine in `overlays.ts` and its wiring.
- [decisions.md](decisions.md) — settled decisions and accepted trade-offs.
- [rpg-rules/README.md](rpg-rules/README.md) — the Pathfinder 2e **rule** specifics (distances, templates, reach). The engine here implements these; the rule tables live there.
