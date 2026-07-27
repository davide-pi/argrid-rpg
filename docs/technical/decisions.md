# Decisions & accepted trade-offs

Settled choices behind the current code, mined from the source comments and the
project's decision notes. Each is **decision + why**, with a pointer to the code.

## Detection

### 2-D lattice model, not a bag of independent lines
**Decision:** reconstruct the grid as a true 2-D lattice — per-family vanishing-point
RANSAC → rectify via the horizon → regular lattice fit — instead of 1-D per-family
line reconstruction (`buildGrid` `src/grid-detector.ts:424`).
**Why:** 1-D reconstruction was weak and a hard angle cut-off discarded real lines under
perspective spread (verticals were being lost). The debug raw lines were fine, so the
loss was in post-processing. The lattice model recovers occluded rows and rejects
non-grid lines that don't concur at the family VP. See [detection-pipeline.md](detection-pipeline.md).

### Focus gating OFF by default
**Decision:** `focusGating: false` in `DEFAULT_PARAMS` (`src/grid-detector.ts:35`);
kept as opt-in (`gateEdgesByFocus` `:296`).
**Why:** it erased faint / hand-drawn / irregular grid lines — reported as "accuratezza
estremamente diminuita." The lattice reconstruction rejects non-grid lines more safely,
so gating is only worth it for strongly out-of-focus backgrounds.

### Occluded lines are rebuilt AND shown
**Decision:** `fillGrid: true`; rebuilt (interpolated) lines are drawn at 0.5 alpha,
detected lines at 1.0 (`src/grid-detector.ts:798`; `drawFamily` `src/main.ts:1097`).
**Why:** an earlier "hide the dashed fills" choice was about the *unreliable* 1-D
interpolation. The 2-D model's rebuilt lines are trustworthy, so the complete grid is
displayed (occluded ones just fainter).

### rho kept SIGNED across the 0/180° wrap
**Decision:** keep Hough's signed rho; merge clusters by projecting onto the cluster
normal, `d = mean(rho·cos(θ − θ̄))` (`src/grid-detector.ts:244`, `mergeDuplicateLines` `:617`).
**Why:** a near-axis line alternates `(+rho, ~0.5°)` / `(−rho, ~179.5°)`; averaging raw
rho collapses it to ~0. Projection is sign-consistent. Unit tests with exact synthetic
θ do not catch this — only real Hough output does.

## Tactical engine

### Unified single grid colour (no H/V distinction)
**Decision:** both families draw in one soft white `#eaf1fb` via two `drawFamily(…)`
calls (`src/main.ts:434`).
**Why:** the user doesn't distinguish horizontals from verticals; the previous cyan +
pink pair added noise. (Trade-off: on a light/parchment map soft white can read faint —
switch to a dark grid colour there.)

### Cone rotates around a FIXED chosen intersection
**Decision:** a cone is a 90° sector of the burst radiating from `area.corner` (the
selected node); rotating turns only the sector, the origin stays put
(`areaCells` `src/overlays.ts:369`; `ringOriginGrid` `src/main.ts:887`).
**Why:** "voglio definire un incrocio e farlo sempre da lì." A helper that derived the
corner from cell + direction moved the origin between corners as you rotated and fed
back into the angle, so it was removed. **Accepted trade-off:** a short orthogonal cone
from a corner is 2,4,2, not the book's cell-centred 1,3,3 — kept for a clean corner origin.

### Angle ring rotates only from the shape's TIP
**Decision:** `ringHit` matches only within ~1.1 cells of the tip handle
(`ringHandleGrid` = origin + `gridDir(angle)·reach`); no full-circle band
(`src/main.ts:1411`, `:905`).
**Why:** "voglio ruotare SOLO se clicco sulla fine della linea o la punta del cono, così
clic su un'altra cella non ruota a caso." The old whole-band grab rotated on stray taps.

### Line/cone angles snap to the book slopes only
**Decision:** fixed orientations — line = the four book slopes reflected into every
octant (`lineAngles` `src/overlays.ts:242`), cone = the 8 grid dirs; `snapToAngles`
snaps coarsely (`:265`).
**Why:** "il cerchio consente tutti gli angoli, deve andare a scatti / solo quegli
angoli." A continuous ring produced irregular, non-book staircases.

### Movement fixed at 5 movements; speed is per-piece
**Decision:** `MOVE_ACTIONS = 5` and `MAX_PATH_MOVES = 5` — no movements selector; each
token carries its own `speed` (default `DEFAULT_PIECE_SPEED = 6` cells / 30 ft)
(`src/main.ts:134`, `:135`, `:601`).
**Why:** simplifies the HUD; movement always previews up to 5 bands, and the reachable
distance is driven by the piece's speed rather than a global control.

### Threat shown only during movement, both sides
**Decision:** `threatSidesToShow()` returns `['ally','enemy']` in a move overlay, else
`[]` (`src/main.ts:506`); the Minaccia toggle was removed.
**Why:** "l'area di minaccia lasciamola visualizzata solo durante il movimento,
togliamo lo switch." Showing both sides lets you read the whole board's threat while
planning a move.

### Route preview = Pareto frontier counting DISTINCT creatures
**Decision:** `movePareto` returns the `(movements ↔ threats)` frontier; threats are
counted **per distinct creature, once**, including the start square, via a subset-state
search over `(cell, parity, creature-bitmask)` (`src/overlays.ts:692`).
**Why:** earlier previews (an oval of every route, then the full shortest-path DAG) were
too dense and rejected. The user wanted the fastest route plus each alternative that
spends +1 movement to be threatened by fewer *creatures* (not cells) — a creature met in
many cells still counts once.

### Area removed only by the ✕ (single control surface)
**Decision:** the FAB becomes an ✕ that both drops and removes the active area; a tap on
empty ground or on the area origin does nothing (`updateFabIcon` `src/main.ts:1274`,
`removeActiveArea` `:223`). The whole bottom sheet was replaced by one on-map HUD.
**Why:** "si toglie solo con la X." A stray tap must not clear an area, and there is one
contextual control surface (the HUD) instead of a sheet + panel.

### HUD does not reopen when you reposition
**Decision:** dragging an area calls a slimmed `selectCellAt` that only moves the
overlay; the HUD auto-expands only on explicit actions (add area / open editor / start
movement) or the chevron (`refreshHud` `src/main.ts:185`, `showHud` `:216`).
**Why:** "se riduco il menù non deve riaprirsi se sposto l'area."

## Platform

### OpenCV via classic script + synchronous ready callback
**Decision:** load `opencv.js` from a **classic** `<script src="/opencv-boot.js">` (not
an ES module) and signal readiness through a **synchronous** `cv.onRuntimeInitialized`
callback exposed as `window.__cvOnReady` (`public/opencv-boot.js`, `index.html:171`).
**Why:** the Emscripten runtime does not initialize when driven from a module, and
deferring the ready hook by even one microtask (a `.then()`) leaves the main thread
frozen. Also: never `revokeObjectURL` the blob script — Emscripten keeps referencing it.

### Redraw is cheap — never re-run OpenCV
**Decision:** detection runs once per capture; every interaction calls `draw()`
(`src/main.ts:403`) which repaints the photo + vector overlays only.
**Why:** OpenCV work is synchronous and heavy; keeping the interaction loop off it keeps
the phone UI responsive.

### Stage centering via `display:grid; place-items:center`
**Decision:** `.stage` centres the map with `display: grid; place-items: center` plus
`min-width: 0` on the canvas (`src/style.css:229`, `:246`).
**Why:** the flexbox min-content quirk pushed a landscape canvas off-centre in portrait;
the grid + `min-width:0` fix keeps it centred.

## Related

- [detection-pipeline.md](detection-pipeline.md) · [tactical-overlays.md](tactical-overlays.md) · [architecture.md](architecture.md)
- Rule specifics: [rpg-rules/README.md](rpg-rules/README.md)
