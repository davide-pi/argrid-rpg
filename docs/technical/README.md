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
| Grid line **drawing** (colour, occluded/filled lines, clipping to border) | `main.ts` — `draw` / `drawFamily` | `rg -n "drawFamily\|gridColor\|l\.filled" src/main.ts` |
| Add / adjust an **area template** (emanation/burst/cone/line) | `overlays.ts` — `areaCells` | `rg -n "areaCells\|blockDist\|burstDist\|lineCells\|coneDir" src/overlays.ts` |
| Change area **size / angle presets** | `overlays.ts` — `FIXED_SIZES`, `lineAngles`, `fixedAngles` | `rg -n "FIXED_SIZES\|lineAngles\|fixedAngles\|snapToAngles" src/overlays.ts` |
| Change **movement** search (Dijkstra, diagonals, reachable bands) | `overlays.ts` — `dijkstraStates`, `moveCells` | `rg -n "dijkstraStates\|moveSearch\|moveCells" src/overlays.ts` |
| Change **route preview** (Pareto cost↔threats) | `overlays.ts` — `movePareto`; `main.ts` — `drawPaths` | `rg -n "movePareto\|ParetoRoute\|drawPaths" src/overlays.ts src/main.ts` |
| Change **reach / threat / flanking** display | `main.ts` — `drawThreat`, `flankedEnemies`; `overlays.ts` — `threatCells` | `rg -n "threatCells\|drawThreat\|flankedEnemies\|threatSidesToShow" src/*.ts` |
| Tweak the **HUD** (contextual panel) | `main.ts` — `refreshHud` / `hudContext`; `index.html` `#hud` | `rg -n "refreshHud\|hudContext\|showHud" src/main.ts` |
| Tweak the **FAB** speed-dial / placement modes | `main.ts` — `setPlaceMode`, `updateFabIcon`, `placeAreaAt` | `rg -n "placeMode\|setPlaceMode\|fab\b" src/main.ts` |
| Change **pointer gestures** (tap/long-press/drag/pinch, angle ring) | `main.ts` — `pointerdown`/`pointermove`/`pointerup` handlers | `rg -n "addEventListener\('pointer" src/main.ts` |
| Grid↔image mapping (homography) | `overlays.ts` — `makeGridMap`, `toImage`/`toGrid` | `rg -n "makeGridMap\|solveHomography\|toGrid" src/overlays.ts` |
| **Camera** capture (getUserMedia, grabFrame) | `camera.ts` — `Camera` | `rg -n "getUserMedia\|grabFrame" src/camera.ts` |
| **Zoom / pan** (pinch, wheel, drag; suppress during gestures) | `zoom.ts` — `attachZoomPan` | `rg -n "attachZoomPan\|suppress\|zoomAt" src/zoom.ts` |
| **OpenCV boot** / ready callback | `public/opencv-boot.js`; `main.ts` — `boot` | `rg -n "__cvOnReady\|__cvOnProgress\|onRuntimeInitialized" src/main.ts public/opencv-boot.js` |
| **DEV / test hook** (`window.__argrid`) | `main.ts` — inside `__cvOnReady` (DEV-only) | `rg -n "__argrid\|import\.meta\.env\.DEV" src/main.ts` |
| Debug overlay (edges + raw Hough) | `main.ts` — `draw` (`debug` branch); triple-tap logo | `rg -n "\bdebug\b\|r\.edges\|rawLines" src/main.ts` |

## Related

- [architecture.md](architecture.md) — module map, runtime data flow, boot path, DEV hook.
- [detection-pipeline.md](detection-pipeline.md) — the CV pipeline in `grid-detector.ts`, stage by stage.
- [tactical-overlays.md](tactical-overlays.md) — the geometry + RPG engine in `overlays.ts` and its wiring.
- [decisions.md](decisions.md) — settled decisions and accepted trade-offs.
- [rpg-rules/README.md](rpg-rules/README.md) — the Pathfinder 2e **rule** specifics (distances, templates, reach). The engine here implements these; the rule tables live there.
