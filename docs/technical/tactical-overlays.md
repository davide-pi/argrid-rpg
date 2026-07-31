# Tactical overlays (`src/overlays.ts` + its UI wiring)

`overlays.ts` is the **engine**: pure geometry + PF2e mechanics on the grid. Shapes are
defined in **grid coordinates** (cells) and mapped to the image through a grid→image
homography, so they stay correct under perspective. The **wiring** is now split by concern:
shared state in `tactical-state.ts` (`S`), the `draw()` loop in `draw-loop.ts`, token/threat/
flanking geometry in `board.ts`, the FAB/area/movement controls + angle ring in `placement.ts`,
pointer input in `gestures.ts`, and the HUD in `hud.ts`.

The detailed PF2e **rule** specifics (distance table, template shapes, reach values)
live in [rpg-rules/README.md](rpg-rules/README.md). This file documents the mechanisms
and where to change them — not the rules themselves.

One cell = 1.5 m = 5 ft (`unitToCells` `overlays.ts:53`, constants `CELL_METERS`/`CELL_FEET` `:49`).

## Grid ↔ image homography

`makeGridMap(familyA, familyB)` (`overlays.ts:115`) intersects every family-A × family-B
line pair to get lattice nodes, then least-squares-fits a homography from grid node
`(i,j)` → image `(x,y)` (`solveHomography` `:81`, `applyH` `:104`; the 3×3 inverse now lives in
`geometry.ts` as `invert3x3`). It returns a `GridMap` (`:109`):

- `toImage(a, b)` — grid → image (used by every draw call).
- `toGrid(x, y)` — image → grid; a tap floors to a **cell** and rounds to the nearest
  **intersection/node** (`gestures.ts` `pointerToGrid` `:29`, `selectCellAt` `:41`).

Built once per capture, in `applyDetectedGrid` (`main.ts:299`); redraws reuse it.

## Distances — alternating diagonals

PF2e diagonals alternate 1 / 2 (odd diagonal costs 1, even costs 2), so a straight
diagonal of `d` steps costs `d + floor(d/2)` → 1, 3, 4, 6, 7, 9…

- `blockDist(oi, oj, w, i, j)` (`overlays.ts:179`) — distance from a `w×w` block to a
  cell (0 inside): `max(gx,gy) + floor(min(gx,gy)/2)`.
- `pf2eDist` (`:154`) — the `w=1` case.
- `burstDist(ci, cj, i, j)` (`:207`) — distance from a grid **corner** (node): the four
  cells touching the corner are at 1, the diagonal ones at 3.

## Area templates — `areaCells(area, na, nb)` (`overlays.ts:340`)

Colours whole cells; areas draw blue (`draw-loop.ts` `drawOverlay` `:490`). `AreaOverlay`
(`overlays.ts:12`) stores both `cell` (floor of tap) and `corner` (nearest node); each
type uses the right origin:

| Type | Origin | Mechanism |
| --- | --- | --- |
| `emanazione` | creature block (`cell`) | `blockDist(bi,bj,w,…) ≤ R` — alternating-diagonal, so R=2 cuts the four corners (a "Chebyshev square" would be wrong). |
| `esplosione` | selected **node** (`corner`) | `burstDist(corner,…) ≤ R`. |
| `cono` | selected **node** (`corner`, fixed) | 90° sector of the burst, direction snapped to 8 grid dirs (`coneDir` `:173`); orthogonal cones widen 2,4,6,8…, diagonal ones are one burst quadrant (a right-triangle staircase). |
| `linea` | selected `cell` | `lineCells` (`:303`) — a supercover staircase from the cell corner opposite the direction, trimmed by PF2e cost. |

`lineCells` (`overlays.ts:303`) walks a densely-sampled segment (`supercover` `:275`)
from a lattice corner, counting cost 1 per orthogonal step and alternating 1/2 per
diagonal — so a straight 6q line spans 6 cells while a 45° 6q line spans 4.

Sizes and angles are **fixed to the book presets** — free-size mode was removed:

- `FIXED_SIZES` (`overlays.ts:32`) — per-type size options.
- `lineAngles(size)` (`:224`) — the four book slopes (0°, ~18.4°, ~26.6°, 45°) reflected
  into every octant; `fixedAngles(type, size)` (`:240`) returns line angles, the 8 cone
  dirs, or `[]`. `snapToAngles` (`:247`) snaps the ring's raw angle to the nearest.

## Reach / threat — `threatCells(bi, bj, w, na, nb)` (`overlays.ts:188`)

Every cell within a creature's reach (`w` cells by the alternating-diagonal rule,
`1 ≤ blockDist ≤ w`) except its own space. Wiring is split between `board.ts` (geometry)
and `draw-loop.ts` (drawing):

- `threatCountMaps()` (`board.ts:37`) — per-cell counts per side; `drawThreat`
  (`draw-loop.ts:95`) borders each cell (solid per side; **contested** by both →
  interleaved red/green dashes) and `drawThreatCounts` (`draw-loop.ts:137`) badges cells
  with ≥2 reaches.
- **Threat is shown only during movement**, for **both** sides — `threatSidesToShow()`
  returns `['ally','enemy']` in a move overlay, else `[]` (`placement.ts:23`). No global toggle.
- Flanking: `flankedEnemies()` (`board.ts:107`) marks an enemy flanked when two allies
  both threaten it and their centre-to-centre segment crosses opposite sides of its
  space (`segCrossesRect`, Liang-Barsky, `board.ts:85`) → amber dashed ring + ⚔ badge
  (`drawFlanking` `draw-loop.ts:330`).

## Movement — Dijkstra over `(cell, parity)`

Because a diagonal's cost depends on how many diagonals were taken, the search state
carries a **parity** (diagonals mod 2):

- `dijkstraStates(na, nb, obs, sources, diagCost)` (`overlays.ts:444`) — binary-heap
  Dijkstra over `(i, j, parity)`; orthogonal step = 1 (parity unchanged), diagonal =
  `diagCost(parity)` then flips parity. Returns per-state cost + predecessors (a DAG of
  all shortest paths).
- `moveSearch` (`:495`) seeds sources from the whole creature block (cost 0).
- `moveCells(mv, na, nb, obs)` (`:528`) — reachable cells tagged by band
  `move = ceil(cost / speed)`, `1…moves`. `MoveObstacles` (`:388`): `impassable` (can't
  enter/pass — opposite side) vs `occupied` (can pass, can't stop — own side); built by
  `tokenObstaclesFor(group)` (`board.ts:21`).
- `shortestRoutes` / `shortestRoute` / `movePaths` (`:576`, `:610`, `:659`) reconstruct
  routes from the predecessor DAG (kept mainly for tests).

## Route preview — bi-objective `movePareto` (`overlays.ts:696`)

The `(cost ↔ threats)` Pareto frontier of routes to a target: the **fastest** route
first, then each route that spends +1 movement to be threatened by **fewer creatures**,
until 0 threats or the movement cap.

- **Threats are counted per DISTINCT creature, once** — passing several cells of one
  creature's reach counts 1; a creature counts if the route is ever in its reach,
  **including the start square** you move out of. So the metric is a *set* of creatures,
  tracked as a **bitmask** (≤30 creatures fit a JS int, `:716`).
- State = `(cell, parity, creature-mask)`. Each `(cell, parity)` keeps only its
  **non-dominated** labels: a label `(cost, mask)` is dominated by `(c, m)` when
  `c ≤ cost` **and** `m ⊆ mask` (subset-domination, `addLabel` `:739`).
- Start label mask = every creature threatening the mover's whole block (`:755`).
- The frontier is emitted per movement budget `m·speed`, shown only when the creature
  count strictly drops (`:817`); `ParetoRoute` (`:669`) carries `cells`, `cost`,
  `threats`, `move`.
- `threatAreas` = one cell-set per opposite creature, supplied by `oppThreatAreas(group)`
  (`board.ts:54`).

Wiring: `drawPaths` (`draw-loop.ts:186`) calls `movePareto` (capped at
`MAX_PATH_MOVES = 5`, `draw-loop.ts:179`), draws each route slowest→fastest so the fastest
lands on top boldest (`drawRouteLine` `draw-loop.ts:239`), and badges each route's **apex**
with the creatures met.

## On-map angle ring — tip-handle rotation

Line/cone orientation is set by dragging a handle on the shape's **tip**, drawn in grid
space so it follows perspective (`drawAngleRing` `draw-loop.ts:390`). Its geometry lives in
`placement.ts`:

- `ringOriginGrid()` (`placement.ts:38`) — a **fixed** centre during a drag: the chosen
  intersection (`corner`) for a cone, the selected cell's centre for a line.
- `ringHandleGrid()` (`placement.ts:58`) — origin + `gridDir(effectiveAngle()) ·
  ringReachCells()` (`:52`), i.e. the line end / cone front.
- `ringHit` (`placement.ts:264`) matches **only** within ~1.1 cells of that tip handle, so
  a tap on any other cell never rotates. `rotateFromPointer` (`:272`) sets
  `areaAngleDeg = angleOfGridDir(g − o)`; faint ticks mark the allowed snapped
  orientations. `gridDir` / `angleOfGridDir` (`overlays.ts:163`,`:166`) convert
  angle↔grid-direction (0 = up = `(0,−1)`, clockwise).

Pan is suppressed while rotating or dragging (or editing a manual grid) via
`attachZoomPan(view, { suppress: () => S.ringRotating || S.dragKind !== null || … })`
(`main.ts:75`).

## Draw order (`draw` `draw-loop.ts:14`)

Photo → grid (`drawFamily` ×2) → overlay → path preview → threat/counters → flanking →
tokens → blocked-X → selection + angle ring. See [architecture.md](architecture.md).
