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

### Chromatic edges added to the luminance Canny (`colorEdges: true`)
**Decision:** besides the grayscale Canny, auto-Canny the Lab **a/b** chroma channels and
OR them into the edge map before Hough; a near-neutral channel (std < `CHROMA_MIN_STD`)
contributes nothing (`chromaEdges`, wired in `detectGridFromMat` `src/grid-detector.ts`).
**Why:** the pipeline works on luminance (`COLOR_RGBA2GRAY`), so a grid separated from its
background only by **hue** at similar brightness leaves no luminance edge and is missed
entirely. The Lab a/b channels carry exactly that colour information.
**Cost/scope:** a couple of extra Canny passes on the chroma channels (a few ms). It is
**orthogonal** to the noisy-texture fallback: colour recovers hue-contrast grids, the
morphological path recovers low-contrast texture — neither replaces the other. Verified
live: an **iso-luminance** grid (magenta lines on a gray of identical Y) is `0×0` with
`colorEdges:false` and the full grid with it on; clean gray grids and the dirt photo are
unchanged (near-neutral chroma adds nothing).

### Perspective robustness: stable VP, orthogonal split, sub-multiple rejection
**Decision:** two cheap, pure-geometry fixes make the lattice fit survive strong
perspective (`buildGrid` / `ransacVP` / `fitFamilyGrid`, `src/grid-detector.ts`):
- **Orthogonal second axis** — `axisB = axisA + 90`. An earlier attempt made `axisB` an
  *independent* histogram mode ≥30° from `axisA`, but on the real corpus it bought nothing
  the guards below weren't already delivering and could latch `axisB` onto a spurious cluster
  (hand-drawn walls, text, a dominant diagonal), tilting the drawn grid off-square on angled
  shots — the user saw this as a regression, so it was reverted to the robust orthogonal prior.
- **Guarded vanishing point** — `ransacVP` trusts a *finite* VP only when the inliers
  actually fan (`VP_MIN_FAN_DEG`) **and** the VP lands outside the frame (`VP_FRAME_MARGIN`);
  otherwise it uses the stable at-infinity VP. A near-parallel family's noisy far
  intersection used to corrupt the rectifying horizon and compress the lattice to a sub-pitch.
- **Sub-multiple rejection** — `coarsenPitch` prefers the coarsest integer multiple of the
  base cell that still holds (almost) all offsets, so the fit can't lock onto a 1/m harmonic
  (tolerance is absolute, tied to the base cell, so occluded/dropped lines don't over-coarsen).
**Why:** on real angled photos these compounded into a spurious ~7–8 px pitch → **hundreds**
of bogus lines (measured 113×65, 202×73). Combined effect on the test corpus: a tiles-in-
perspective shot went from a 202-line explosion (spacing 7/19) to a sane 12×19 (spacing 117/76);
no photo explodes any more.

### Degenerate lattices are still guarded (no fill/extend) as a backstop
**Decision:** after the perspective fixes, `fitFamilyGrid` still rejects a residual degenerate
fit: the **median** image-space cell across the detected extent (sampled, robust to genuine
far-cell foreshortening) must be ≥ `image / MAX_CELLS_ACROSS` (50), else fill/extension are
skipped for that family; extension also stops once cells crowd below `0.5·minCell`. A family
whose spacing is below the floor drops `confidence` to 0 so the UI warns.
**Accepted limitation:** extreme perspective on a *fine* grid (the far edge genuinely
compresses toward invisibility) is still only partially recovered — such cases come back with
low confidence (warned) rather than a clean grid; a full fix (per-row TLS / node-based fit) is
a larger task tracked for the corner-node fallback.

### Unreliable auto grid → fallback panel + manual grid, never a wrong grid
**Decision:** when the detection `confidence` is below `MIN_GRID_CONFIDENCE` (0.35,
`src/main.ts`) the app does **not** draw the auto grid or build tactics on it. Instead it shows
the photo alone under a fallback card (`#gridFail`) with two choices: **retake**, or **manual
grid**. The manual editor (`src/main.ts`, "Manual grid editor") overlays a **quad** (4 draggable
corner handles) tiled into N×M cells; the quad→unit-square homography (`solveHomography`/`applyH`
from `overlays.ts`) yields projective, perspective-correct nodes, from which it builds the same
`familyA`/`familyB` `Line2[]` the detector would — so drawing (`drawFamily`) and every tactical
tool (`makeGridMap`, tokens, areas, movement) work unchanged. Grid drawing + the tactical layer
are gated on `gridReliable` (or the editor being active); the FAB/HUD are hidden while a grid is
unreliable or being edited.
**Why:** on genuinely hard shots (strong perspective, noise, or distractors like a tiled floor)
detection fails in *any* variant of the pipeline — and drawing the resulting degenerate
micro/macro grid over the photo is what reads as a "drastic loss of precision". Showing the clean
photo + an honest choice (retake / place it yourself) is far better than a confident-looking wrong
grid. The confidence score already collapses to ~0 on degenerate fits, so it is the natural gate.
**Deferred:** a second manual sub-mode — *freehand draw → the system recalculates/expands the
lattice* — and improving auto recall on the hard cases (distractor rejection, stronger sub-pitch
guard, corner-node / map-boundary-quad fallbacks).

### Grid extrapolated to the whole frame by default (`extend: 'frame'`)
**Decision:** after fitting the regular lattice, continue it `a + b·k` outward past the
detected extent and tile the **entire image frame** with the inferred grid; extrapolated
lines are drawn faint (0.5α), flagged `extended`+`filled` (`fitFamilyGrid`, `DEFAULT_PARAMS`
`src/grid-detector.ts`). Bounded by the frame and a vanishing-point crowding guard;
`'border'` (a couple of cells) and `'off'` remain as options.
**Why:** the detector missed the **outer sides** of a grid whose edge is a colour-only
boundary (similar luminance), and, more broadly, the user wanted a **virtual tactical
grid** covering the whole photo, not just the drawn map. Extrapolation is exact in the
rectified plane (pure arithmetic continuation), so it needs no extra detection.
**Accepted trade-off:** it draws grid over empty areas beyond the physical map and lets
pieces be placed off the real map; the faint styling flags those cells as inferred. The
user chose full-frame over the conservative `'border'` mode.

### Fallback strength gates on DETECTED lines only
**Decision:** the `lineMorph` retry fires on `min(detected(familyA), detected(familyB)) < 3`,
counting only non-`filled` lines, not `info.aCount/bCount` (`detectGridFromMat`
`src/grid-detector.ts`).
**Why:** with `fillGrid` and especially `extend: 'frame'`, the family sizes are inflated by
rebuilt/extrapolated lines. Gating on the totals would let a weak 2-line detection look
strong and skip the morphological fallback the noisy-photo path depends on.

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
