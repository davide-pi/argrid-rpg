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
detected lines at 1.0 (`fitFamilyGrid` in `src/grid-detector.ts`; `drawFamily`
`src/draw-loop.ts:545`, which fades `l.filled` lines).
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
**Removed:** an earlier *separate* chromatic candidate (its own Hough + fusion entry, `houghChroma`)
never won and was always degenerate, so the colour edges now live **only** inside the luminance
flow (OR'd in before the main Hough). In the debug graph the colour node is extraction-only
('Bordi colore' → *Bordi uniti*; the 'Colore' log group is just 'Estrazione').

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
  **Strong-evidence override** (added later): a finite VP *inside* the frame is trusted anyway
  when many inliers concur over a wide fan (`VP_STRONG_MIN_INLIERS` + `VP_STRONG_FAN_DEG`) —
  a genuine shallow-angle floor/table VP. Without it, a low-angle floor (VP legitimately
  in-frame) was rejected → no rectification → collapse to a fronto-parallel **2×2**. A
  fronto-parallel grid fans ~0° so it never triggers the override (no regression there);
  `MIN_GRID_CELLS` (5, in `grid-detector.ts`) is the backstop that hides any residual 2×2 collapse.
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

### Unreliable auto grid → photo alone + (i) guidance + on-demand manual editor, never a wrong grid
**Decision:** the app **always draws the grid it found when it is reliable, or the photo alone
otherwise** — there is **no** automatic fallback card. Reliability is ONE calibrated score, in
`applyDetectedGrid` (`src/main.ts`) → `isGridReliable` (`src/grid-detector.ts`): the
`gridConfidence` must clear `DRAW_THRESHOLD` (0.65), plus two HARD guards the score can't
override (`!degenerate`, `detectedA,detectedB ≥ 2`). Regularity, size and cell-aspect are
**folded into** `confidence` (`familyQuality` × `squareness`, the latter via `harmonicAspect`),
so the earlier scattered structural gate (cell-count / inlier / aspect floors) is gone — the
debug chip, the winner choice and "drawn?" now share the same number. When no grid is drawn, the
single info **(i)** button (bottom-left)
carries the guidance ("Nessuna griglia rilevata — usa il tasto griglia / fotocamera"). A top-bar
**edit-grid** button opens an on-demand chooser (`#editChooser`: **grid to adapt** / **draw by
hand**) on *any* result, so a well-detected grid can also be tweaked. **Cancelling** the editor
restores the detected grid (`applyDetectedGrid`), never discards it. The manual editor
(`src/manual-grid.ts`) has two modes, both producing the same `familyA`/`familyB`
`Line2[]` the detector would — so drawing (`drawFamily`) and every tactical tool (`makeGridMap`,
tokens, areas, movement) work unchanged:
- **Adapt** — a **quad** (4 draggable corners) tiled into N×M cells; the quad→unit-square
  homography (`solveHomography`/`applyH` from `overlays.ts`) gives projective, perspective-correct
  nodes. Seeded from the current grid when there is one, else a default inset. Cell counts via ±
  steppers or direct numeric entry; **two-finger pinch** resizes it (image zoom is handed to the
  editor via `manualActive`); a **magnifier loupe** shows the vertex under the finger.
- **Draw by hand** — the user TRACES reference lines along columns/rows; each stroke → a `RawLine`
  fed to `buildGrid` (family split + VP fit + `extend:'frame'`), so a few lines generate the whole
  lattice. Strokes have draggable endpoints and a × delete badge; the grid regenerates live.
On **commit** ("Fatto") the grid is EXTENDED past the drawn quad to fill the frame
(`commitManualGrid`, mirroring `extend:'frame'`). The controls bar sits at the top and is
collapsible so it never hides a corner handle (the collapse chevron is hidden when there's nothing
to collapse — draw mode). Grid drawing + the tactical layer are gated on `gridReliable` (or the
editor being active); the FAB is hidden while a grid is unreliable or being edited.
**Why:** on genuinely hard shots (strong perspective, noise, or distractors like a tiled floor)
detection fails in *any* variant of the pipeline — and drawing the resulting degenerate
micro/macro grid over the photo is what reads as a "drastic loss of precision". Showing the clean
photo + an honest choice (edit it yourself / retake) is far better than a confident-looking wrong
grid.
**Calibration (user-labelled 16-photo corpus).** The user labelled which auto-detections are
actually correct — **only 3/16** were (auto-detection accuracy is genuinely low on hard photos).
The calibrated `gridConfidence` now separates most of them: the genuinely-correct grids score
≥ ~0.86 while the false positives / imprecise fits (a self-consistent but wrong lattice, a texture
sub-pitch) sit at 0.43–0.53, so `DRAW_THRESHOLD` = **0.65** splits them with ~zero recall cost on
the real grids and kills the #13-style false positive. Confidence measures lattice self-consistency
+ size + squareness, **not image support yet**, so the bar stays here rather than trusting a low
score outright. Do NOT re-tune detection against my own guesses — establish ground truth from the
user first (see the memory note). The remaining gap is detection *accuracy*, not the gate.

### Map-boundary quad auto-rescue was attempted and dropped (unreliable segmentation)
**Decision:** an auto "map boundary" step (restrict the edges to the detected map quad before
Hough, to shake off distractors like a tiled floor) was prototyped twice — Canny→contours→
`approxPolyDP`, then Otsu→`minAreaRect` with both polarities — as a non-regressive *rescue*
(runs only on a weak fit, kept only if strictly better). On the real corpus it found **no usable
map quad** (cluttered scenes: mat + floor + objects don't segment into a clean rectangle; results
were near-frame or nothing, and the target grids in the distractor cases are too faint to detect
even when isolated). It improved nothing, so it was reverted rather than shipped as inert code.
The reliable path for these hard cases is the **manual grid** above. A corner/intersection-node
fallback remains a possible future direction.

### Periodicity-first rework (v2/v3) prototyped and reverted
**Decision:** the periodicity-first detection rework — a global 2-D periodic model fit from an FFT
orientation prior + projection/autocorrelation pitch (planned in the former `detection-v2-plan.md`
/ `detection-v3-plan.md`) — was implemented (`periodicPitch` / `periodicExtract`, ~535 lines) and
then **removed in full**; the pipeline is back to the bottom-up chain (Canny → Hough → family split
→ VP RANSAC → rectify → lattice fit) with the calibrated `gridConfidence` draw gate above.
**Why:** it did not beat the existing pipeline on the labelled corpus and added a large, interacting
surface (comb-pitch / rectify-stability / horizon-sweep experiments — `combPitch`, `periodicExtract`,
`rectifyStability`, etc.). The related tuning flags (`profilePitch`, `cornerVerify`, `lineSupport`,
`morphCloseFirst`, `ridgeHysteresis`, `ridgeLocalThresh`) were likewise added and reverted — **no
experimental detector flags remain** (the ridge binarisation `ridgeLocalThresh` became the fixed
local-mean + 1σ threshold in `enhanceGridLines`). The two plan docs were retired to obsolete
tombstones; this note is the historical record.

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
**Decision:** both families draw in one soft white `#eaf1fb` (`gridColor` in `draw()`) via two
`drawFamily(…)` calls (`src/draw-loop.ts:56`).
**Why:** the user doesn't distinguish horizontals from verticals; the previous cyan +
pink pair added noise. (Trade-off: on a light/parchment map soft white can read faint —
switch to a dark grid colour there.)

### Cone rotates around a FIXED chosen intersection
**Decision:** a cone is a 90° sector of the burst radiating from `area.corner` (the
selected node); rotating turns only the sector, the origin stays put
(`areaCells` `src/overlays.ts:340`; `ringOriginGrid` `src/placement.ts:38`).
**Why:** "voglio definire un incrocio e farlo sempre da lì." A helper that derived the
corner from cell + direction moved the origin between corners as you rotated and fed
back into the angle, so it was removed. **Accepted trade-off:** a short orthogonal cone
from a corner is 2,4,2, not the book's cell-centred 1,3,3 — kept for a clean corner origin.

### Angle ring rotates only from the shape's TIP
**Decision:** `ringHit` matches only within ~1.1 cells of the tip handle
(`ringHandleGrid` = origin + `gridDir(angle)·reach`); no full-circle band
(`src/placement.ts:264`, `:58`).
**Why:** "voglio ruotare SOLO se clicco sulla fine della linea o la punta del cono, così
clic su un'altra cella non ruota a caso." The old whole-band grab rotated on stray taps.

### Line/cone angles snap to the book slopes only
**Decision:** fixed orientations — line = the four book slopes reflected into every
octant (`lineAngles` `src/overlays.ts:224`), cone = the 8 grid dirs; `snapToAngles`
snaps coarsely (`:247`).
**Why:** "il cerchio consente tutti gli angoli, deve andare a scatti / solo quegli
angoli." A continuous ring produced irregular, non-book staircases.

### Movement fixed at 5 movements; speed is per-piece
**Decision:** `MOVE_ACTIONS = 5` and `MAX_PATH_MOVES = 5` — no movements selector; each
token carries its own `speed` (default `DEFAULT_PIECE_SPEED = 6` cells / 30 ft)
(`MOVE_ACTIONS`/`DEFAULT_PIECE_SPEED` `src/placement.ts:13`,`:11`; `MAX_PATH_MOVES`
`src/draw-loop.ts:179`).
**Why:** simplifies the HUD; movement always previews up to 5 bands, and the reachable
distance is driven by the piece's speed rather than a global control.

### Threat shown only during movement, both sides
**Decision:** `threatSidesToShow()` returns `['ally','enemy']` in a move overlay, else
`[]` (`src/placement.ts:23`); the Minaccia toggle was removed.
**Why:** "l'area di minaccia lasciamola visualizzata solo durante il movimento,
togliamo lo switch." Showing both sides lets you read the whole board's threat while
planning a move.

### Route preview = Pareto frontier counting DISTINCT creatures
**Decision:** `movePareto` returns the `(movements ↔ threats)` frontier; threats are
counted **per distinct creature, once**, including the start square, via a subset-state
search over `(cell, parity, creature-bitmask)` (`src/overlays.ts:696`).
**Why:** earlier previews (an oval of every route, then the full shortest-path DAG) were
too dense and rejected. The user wanted the fastest route plus each alternative that
spends +1 movement to be threatened by fewer *creatures* (not cells) — a creature met in
many cells still counts once.

### Area removed only by the ✕ (single control surface)
**Decision:** the FAB becomes an ✕ that both drops and removes the active area; a tap on
empty ground or on the area origin does nothing (`updateFabIcon` `src/placement.ts:110`,
`removeActiveArea` `src/hud.ts:118`). The whole bottom sheet was replaced by one on-map HUD.
**Why:** "si toglie solo con la X." A stray tap must not clear an area, and there is one
contextual control surface (the HUD) instead of a sheet + panel.

### HUD does not reopen when you reposition
**Decision:** dragging an area calls a slimmed `selectCellAt` that only moves the
overlay; the HUD auto-expands only on explicit actions (add area / open editor / start
movement) or the chevron (`refreshHud` `src/hud.ts:76`, `showHud` `src/hud.ts:118`).
**Why:** "se riduco il menù non deve riaprirsi se sposto l'area."

### The piece editor follows the PIECE, not the context
**Decision:** the Taglia / Movimento controls (and the trash) show whenever a piece is
selected **and** while that piece's movement is on the map; only a movement whose piece is
gone stays bodyless (`refreshHud` `src/hud.ts:76`, `showPiece` `:90`). Editing either one
re-anchors the live movement instead of dropping it, keeping the chosen arrival
(`syncMoveOverlayTo` `src/placement.ts:83`).
**Why:** a placed piece was effectively frozen — tapping it starts a movement, and the
movement HUD had no body, so size/speed were reachable only through an undiscoverable
long-press (and not at all while placing). Speed is also exactly what one wants to fix
*while* looking at the movement it produces.

### Placement mode: tap removes a piece, drag moves it
**Decision:** in `ally`/`enemy` placement a pointer landing on a piece starts a `piece`
drag (no long-press); the release deletes it **only if it never moved**
(`src/gestures.ts:157` and the `pointerup` `piece` branch `:229`).
**Why:** "rimuoverle con un click … ma anche spostarle tramite drag and drop senza che
vengano cancellate." Before, a drag in placement mode did nothing at all. Pieces are
always addressed through `tokenBlock` (`pieceCell` `src/gestures.ts:97`) because `t.i/t.j`
are raw values the block clamps at the board edge.

### Redraws are coalesced to one per animation frame
**Decision:** interactive callers (drag, rotate, HUD edits) go through `requestDraw()`
(`src/draw-loop.ts:20`), a `requestAnimationFrame`-coalesced repaint; `draw()` stays
synchronous for detection results, the debug panel and the DEV hook. Two costs were
removed alongside it: the canvas size is only assigned when it actually changes
(assigning `width`/`height` *always* resets the canvas and reallocates its buffer), and
`movePareto` is memoized on its inputs (`pathCache` `src/draw-loop.ts:200`). Dragging a
piece no longer rebuilds the HUD per pointermove — it syncs once on release
(`anchorSelectionTo` `src/placement.ts:196`).
**Why:** "mi sembra un po' laggoso quando si ruotano le aree o si muove qualcosa."
A pointer fires far more often than the screen refreshes, and each repaint redraws a
full-resolution photo plus every overlay.

### The rotation handle is pulled back to stay on screen
**Decision:** `ringHandleGrid` (`src/placement.ts:82`) puts the handle on the shape's tip
only while that tip is visible; otherwise it walks back along the direction to the
farthest point still on screen (`gridPointOnScreen`, which reads the canvas's rendered
rect, so it accounts for zoom/pan). The orientation ticks follow the handle's arc
(`drawAngleRing` `src/draw-loop.ts:437`).
**Why:** "se l'area esce dallo schermo non riesco più a ruotarla" — a 24 q line or a
zoomed-in map put the only grab point outside the viewport. The area keeps its full
length; only the handle moves.

### The magnifier loupe is shared with tactical drags
**Decision:** `S.dragPoint` (image pixels, set by the gesture layer) drives the same
loupe the manual-grid editor uses, captured LAST in `draw()` so it magnifies the finished
frame (`src/draw-loop.ts:100`).
**Why:** the finger hides exactly the cell being aimed at — the reason the loupe exists
for grid corners applies just as much to dropping a piece, an area or an arrival cell.

### Area size is free (1 q steps) with preset chips
**Decision:** the size select is gone. The HUD has a manual stepper whose step is exactly
one cell — relabelled in the chosen unit (1 q / 1.5 m / 5 ft) — plus one-tap chips from
`AREA_PRESETS` (`src/overlays.ts:35`). The field is 3 digits wide, so the cap is on the
DISPLAYED number (`MAX_SIZE_SHOWN = 999`, `:44`) and the cap in cells follows the unit
(999 q, 666 m-cells, 199 ft-cells — `maxCellsIn`). The size in cells lives on the input's
`dataset.cells`, the text being only its view. The **piece's movement** uses the very same
component (`makeCellStepper` `src/placement.ts:271`) — it was a 1..12 dropdown, and a
speed is exactly the same kind of hand-set, whole-cell quantity.
**Why:** the preset list could not express the sizes a table actually needs; presets stay
as shortcuts for the common templates. Line ANGLES stay snapped to the book slopes, so a
free length only ever truncates an existing staircase — pinned for every length by
`test/line-stairs.test.ts` (runs of 2 or 3, last one may be short, never overlapping).

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
(`src/draw-loop.ts:14`) which repaints the photo + vector overlays only.
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
