# OpenCV.js hangs when driven from Node — verify detection in a browser

- **Status:** resolved (worked around)
- **First seen · Resolved:** 2026-07 · 2026-07
- **Affected:** unit tests / any attempt to run the detection pipeline (`detectGrid`) outside a browser.
- **Refs:** [`../knowledge-base/opencv-boot.md`](../knowledge-base/opencv-boot.md),
  [`../operations/verify-detection-headless.md`](../operations/verify-detection-headless.md)

## Symptom

Trying to exercise the OpenCV grid-detection pipeline from Node (e.g. inside a Vitest test) **hangs** — the
runtime never signals ready, so the test never completes.

## Investigation

OpenCV.js is an Emscripten module. Its initialization depends on browser conditions (a classic-script load
and a synchronous ready callback — see [`opencv-boot.md`](../knowledge-base/opencv-boot.md)). Under Node
those conditions aren't met and init stalls. This is a runtime property of the Emscripten build, not a bug
in our code.

## Root cause

The Emscripten runtime starves the microtask queue after init and expects a browser environment; Node
doesn't drive it to "ready".

## Resolution

**Split verification by layer:**

- **Pure geometry** (no OpenCV) — `src/overlays.ts` and the pure parts of `src/grid-detector.ts` — is unit
  tested with **Vitest** (`npm test`). This is where the PF2e templates and movement math are locked down.
- **The CV pipeline** is verified in a **headless browser** using the `window.__argrid` DEV hook: inject a
  synthetic grid canvas and call `render()`, then assert on the result. Full procedure:
  [`../operations/verify-detection-headless.md`](../operations/verify-detection-headless.md).

## Prevention / follow-up

Don't add Node tests that call `detectGrid` — they will hang. Keep detection checks in the browser harness.
