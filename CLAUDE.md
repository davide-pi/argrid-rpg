# argrid-rpg

> Thin orientation map for AI assistants. Open the one topic file you need — don't scan everything.

**What it is.** A mobile-first PWA (Vite + TypeScript + OpenCV.js) that detects a square grid in a photo
and overlays a **Pathfinder 2e** tactical map on it (pieces, area templates, movement, threat). The rules
layer is built to grow into **other RPG systems**.

## Modules (where things live)

| Module | File | Does |
|---|---|---|
| Detection | `src/grid-detector.ts` | CV pipeline: Canny + Hough + vanishing-point RANSAC + rectify + lattice fit |
| Rules/geometry | `src/overlays.ts` | distances, area templates, reach/threat, movement (`moveCells`, `movePareto`) — **the seam for RPG systems** |
| App wiring | `src/main.ts` | capture, draw loop, on-map HUD, FAB placement, pointer gestures, `window.__argrid` DEV hook |
| Camera / zoom | `src/camera.ts`, `src/zoom.ts` | camera capture; zoom/pan of the result canvas |
| OpenCV boot | `public/opencv-boot.js` | classic-script loader — **do not "modernize"** (see its comments) |

## Find the right doc (route here first)

`docs/` splits by **source of truth** ([`docs/README.md`](docs/README.md) is the map): **`docs/technical/`**
is code-derived (kept correct against source), **`docs/wiki/`** is experience-derived (known issues,
operations, fundamentals — not in the code).

| I want to… | Go to |
|---|---|
| find the entry file for a task (routing table) | [`docs/technical/README.md`](docs/technical/README.md) |
| understand the module map / data flow | [`docs/technical/architecture.md`](docs/technical/architecture.md) |
| work on grid detection | [`docs/technical/detection-pipeline.md`](docs/technical/detection-pipeline.md) |
| work on areas / movement / threat geometry | [`docs/technical/tactical-overlays.md`](docs/technical/tactical-overlays.md) |
| add/adjust an **RPG rule system** | [`docs/technical/rpg-rules/`](docs/technical/rpg-rules/README.md) |
| know *why* something is built this way | [`docs/technical/decisions.md`](docs/technical/decisions.md) |
| run/build/test on a phone, verify detection, deploy | [`docs/wiki/`](docs/wiki/README.md) |

## Build / test / lint

```bash
npm run dev      # dev server
npm run build    # tsc + vite build (+ PWA)
npm test         # Vitest unit tests (geometry + PF2e templates)
npm run lint     # ESLint
```

OpenCV **cannot** run in Node — verify detection in a headless browser via the `window.__argrid` DEV hook
(see [`docs/wiki/operations/`](docs/wiki/operations/)).

## Custom agents (`.claude/agents/`)

- **`tech-doc-keeper`** — writes `docs/technical/` + this `CLAUDE.md` only; syncs the code-derived docs
  (incl. `rpg-rules/`) against source after a change; never invents.
- **`wiki-keeper`** — writes `docs/wiki/` only; captures experience-derived knowledge proactively (the
  user approves).

> **Maintenance:** when you change structure (a module, a detection param, a rule, the HUD), update the
> affected doc **in the same change** — delegate code-derived docs to `tech-doc-keeper` and record settled
> decisions in `docs/technical/decisions.md`; delegate experience-derived knowledge to `wiki-keeper`.
