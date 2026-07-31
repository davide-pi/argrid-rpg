# Pathfinder 2e — rules as implemented

The tactical rules argrid-rpg applies, and where each is realized in `src/overlays.ts`. This is a **rules**
reference; for the engine (homography, movement search, the Pareto preview) and exact `file:line` anchors,
see [`../tactical-overlays.md`](../tactical-overlays.md). Templates were matched pixel-for-pixel against the
book diagram (`assets/pf2e-areas.png`, git-ignored copyrighted art).

## Distances & diagonals

- **1 cell (q) = 5 ft = 1.5 m** (`unitToCells` + the `CELL_METERS`/`CELL_FEET` constants in
  `overlays.ts`; the UI-side inverse `cellsToUnit` is in `placement.ts`).
- **Diagonals alternate 1/2**: a diagonal step costs 1, the next 2, and so on — so distance =
  `max(Δi, Δj) + floor(min(Δi, Δj) / 2)`, giving the sequence 1, 3, 4, 6, 7, 9 … `pf2eDist`, and from a
  creature's *N×N* block, `blockDist`. This single rule drives areas, reach and movement.

## Creature sizes

`CREATURE_SIZES` → an *N×N* block via `creatureBlock` (odd sizes centre on the tapped cell, even sizes on
its top-right corner):

| Label | Cells |
|---|---|
| Media o inferiore | 1×1 |
| Grande | 2×2 |
| Enorme | 3×3 |
| Mastodontica | 4×4 |

## Area templates (`areaCells`)

Coloured whole cells (blue). Sizes are the **book presets** (`FIXED_SIZES`); line/cone orientations snap to
the book angles (`snapToAngles`).

- **Emanazione** — `blockDist` from the creature's block (alternating-diagonal, **not** Chebyshev), with a
  selectable creature size. R=1 → 3×3; R=2 → a 5×5 with its **four corners cut** (they are 3 away by the
  diagonal rule) = 21 cells; R=2 on a Large creature → 6×6 minus corners.
- **Esplosione** (burst) — from a **chosen grid intersection** (the tap picks the nearest node, marked with
  a dot); `burstDist` puts the four touching cells at 1 and the diagonal-out cells at 3 → 1 → 2×2, 2 → a
  cross, 3 → 24 cells.
- **Cono** — a 90° sector of a burst from a **fixed chosen intersection**, direction snapped to one of the
  8 grid orientations (`coneDir`). Orthogonal cones widen 2,4,6,8… (30 ft = 28 cells; a short one is
  **2,4,2**); diagonal cones are one burst quadrant → a right-triangle staircase.
  - **Accepted trade-off:** the book draws a short *orthogonal* cone cell-centred as **1,3,3**; from a
    corner it is **2,4,2**. We keep the corner origin so the origin, dot and rotation ring sit on one clean
    intersection. See [`decisions.md`](../decisions.md).
- **Linea** — 1-cell-wide staircase from the selected cell's far corner (`lineCells`); its length is
  trimmed by PF2e cost (a straight 6q line is 6 cells, a 45° 6q line is 4). It snaps to the **four book
  slopes** (`lineAngles`, reflected into every octant): 0°, a shallow **1:3 ≈ 18.4°** (the [3,3]/[3,3,3,2]
  staircase — same for all lengths), a steep length-dependent slope (**1:2 ≈ 26.6°** at 12q), and 45°.

**Rotation:** lines and cones are turned on the map by grabbing the handle at the shape's **tip**; the
origin stays fixed. Faint ticks mark the book orientations and the angle snaps to them (`fixedAngles`).

## Reach & threat (`threatCells`)

A creature **threatens** the cells within its reach (default reach 1 → the ring of adjacent cells, by the
alternating-diagonal rule; own squares excluded). Reach scales with the creature's block. Threat reach is
drawn **only during movement**, for **both sides** (enemy red, ally green; contested cells get an
alternating dashed border + a per-side counter).

## Movement (`moveCells`)

- Reachable cells are banded by `ceil(cost / speed)` up to **5 moves** (fixed), where cost uses the
  alternating-diagonal rule. Each piece has its **own speed** (in cells/q).
- You **pass through** squares of **your own side** but **cannot pass** the **opposite side** (its squares
  are impassable, barred with a red ✕).

### Route preview — (movements ↔ threats) Pareto set (`movePareto`)

Selecting a destination shows a Pareto set of routes: the **fastest** route first (boldest), then each route
that spends **+1 movement** to be threatened by **fewer distinct creatures**, down to 0 or the cap.

- **Threats are counted per DISTINCT creature, once each** — many cells of one creature count as 1 — and a
  creature counts if the route is **ever** in its reach, **including the square you start on**.
- Implemented as a subset-state search over `(cell, diagonal-parity, creature-bitmask)` with subset
  dominance; the badge on each route is the number of threatening creatures met.

## Flanking

An enemy is **flanked** when two allies that both threaten it sit on opposite sides/corners (the segment
between their space-centres crosses opposite sides of the enemy's space). Flanked enemies get an amber
dashed ring and a ⚔ marker.

## Where the tabletop rule was simplified (accepted trade-offs)

- **Cone origin** — corner-based (2,4,2) instead of the book's cell-centred short cone (1,3,3), for a clean
  single-intersection origin/ring.
- **Line staircase** — generated from the cell corner (the clean, regular book staircase) rather than the
  cell centre.

These are recorded in [`decisions.md`](../decisions.md). When any of the above changes in
`src/overlays.ts`, update this page in the same change.
