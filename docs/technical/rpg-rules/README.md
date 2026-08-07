# RPG rule systems

argrid-rpg overlays a **tabletop RPG's tactical rules** on the detected grid. This folder documents each
**supported system** — one page per system, stating the rules **as implemented in the code** — plus the
**rules surface** a system has to define. It is the extensible heart of the app: detection and rendering are
system-agnostic; only this layer knows a game's rules.

> Where the rules live in code: **`src/overlays.ts`** (pure geometry). Its UI wiring is split across
> `src/draw-loop.ts` (rendering), `src/board.ts` (token/threat/flanking geometry), `src/placement.ts`
> (area/movement controls) and `src/hud.ts`. The *engine/mechanisms* (homography, the movement search,
> the Pareto route preview) are documented in [`../tactical-overlays.md`](../tactical-overlays.md); the
> *rules* are documented here.

## Supported systems

| System | Page | Status |
|---|---|---|
| Pathfinder 2e | [`pathfinder-2e.md`](pathfinder-2e.md) | Implemented (the only system today) |

## The rules surface (what a system defines)

A system is characterized by how it answers these questions on a square grid. Today these are realized as
concrete functions/constants in `src/overlays.ts` — tuned for **Pathfinder 2e**:

| Rule | Question it answers | Where (PF2e, `src/overlays.ts`) |
|---|---|---|
| **Distance / diagonals** | how far is cell A from cell B / a creature block? | `blockDist` / `pf2eDist` (alternating diagonal 1,2,1,2…) |
| **Creature footprint** | how big is a creature on the grid? | `CREATURE_SIZES`, `creatureBlock` (an *N×N* block) |
| **Area templates** | which cells does an emanation / burst / cone / line cover? | `areaCells` (+ `burstDist`, `coneDir`, `lineCells`, `lineAngles`, `fixedAngles`) |
| **Reach / threat** | which cells does a creature threaten? | `threatCells` |
| **Movement cost** | what does moving cell→cell cost? | the step cost inside `moveCells` / `movePareto` (diagonals alternate) |
| **Sizes / orientations** | free size in 1 q steps (presets = the book's common sizes) + the book angles | `AREA_PRESETS`, `MAX_SIZE_SHOWN`, `snapToAngles` |
| **Unit conversion** | cells ↔ metres / feet | `unitToCells` + `CELL_METERS`/`CELL_FEET` (**1 cell = 1.5 m = 5 ft**); the UI-side inverse `cellsToUnit` lives in `src/placement.ts` |

## Adding a new system

Today the rules are **PF2e-specific**, not yet a formal plugin interface — the functions above encode PF2e
directly. To add another system (e.g. D&D 5e, whose diagonals are 1-1-1 or optional 5-10-5), the path is:

1. **Generalize the seam.** Extract the per-rule choices above behind a small "ruleset" abstraction (a
   distance function, a set of area-template builders, a threat function, a movement step-cost, size &
   unit tables) so `areaCells` / `moveCells` / `threatCells` take the active ruleset instead of hard-coding
   PF2e.
2. **Add the system's page here** (`<system>.md`) stating its rules as implemented, and a row in the table
   above.
3. **Add a system selector** in the UI (currently there is none — PF2e is implicit).
4. **Cover it with tests** in `test/overlays.test.ts` (the PF2e tests are the model — verify each template
   against the book).

Until that generalization lands, treat `src/overlays.ts` as "the PF2e ruleset" and keep
[`pathfinder-2e.md`](pathfinder-2e.md) in sync with it.
