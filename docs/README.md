# docs/ — the map

Two subtrees, split by **source of truth** (how a doc is kept correct), not by audience —
everyone (humans and AI) reads both.

| Subtree | Source of truth | Kept correct by | Owner agent |
|---|---|---|---|
| [`technical/`](technical/) | the **code** | reading/grepping source; *never invent* | `tech-doc-keeper` |
| [`wiki/`](wiki/) | **human experience & runtime behaviour** | what the team/session reveals; **cannot** be verified against source | `wiki-keeper` |

## `technical/` — code-derived reference (routing map)

How the app **is built**. Start at [`technical/README.md`](technical/README.md) (the routing table:
task → entry file + grep). Key pages:

- [`architecture.md`](technical/architecture.md) — module map + runtime data flow.
- [`detection-pipeline.md`](technical/detection-pipeline.md) — the OpenCV grid-detection pipeline.
- [`tactical-overlays.md`](technical/tactical-overlays.md) — the geometry engine (homography, distances,
  area templates, movement/threat, the Pareto route preview).
- [`rpg-rules/`](technical/rpg-rules/README.md) — **the supported RPG rule systems**, one page each
  (Pathfinder 2e today), and the contract a new system implements in `src/overlays.ts`.
- [`decisions.md`](technical/decisions.md) — settled decisions / accepted trade-offs (the "why").

## `wiki/` — experience-derived knowledge

What we **learned** building, testing and operating the app — not derivable from code. See
[`wiki/README.md`](wiki/README.md) for the index and where each thing goes.

| You have… | Go to |
|---|---|
| a **known issue** (symptom + how it was investigated/resolved) | [`wiki/issues/`](wiki/issues/) |
| a **procedure** to run (test on a phone, verify detection headless, deploy…) | [`wiki/operations/`](wiki/operations/) |
| a **fundamental** (how to run/build it, the OpenCV-boot constraints, environments) | [`wiki/knowledge-base/`](wiki/knowledge-base/) |

## Maintenance

These docs are kept up to date **in the same change** as the code. Delegate code-derived docs to the
**`tech-doc-keeper`** agent (writes `technical/` + the project `CLAUDE.md` only) and record any settled
decision in [`technical/decisions.md`](technical/decisions.md). For experience-derived knowledge (known
issues, operations, fundamentals), delegate to the **`wiki-keeper`** agent (writes `wiki/` only,
proactively — the user approves). A stale doc here is worse than none.
