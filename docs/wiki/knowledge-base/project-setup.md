# Project setup — run, build, test, lint

- **Scope:** getting argrid-rpg running locally and the npm scripts. Not deployment (see
  [`../operations/deploy.md`](../operations/deploy.md)).
- **Last verified:** 2026-07-27
- **Refs:** [`../../technical/architecture.md`](../../technical/architecture.md), `package.json`

## Content

Stack: **Vite + TypeScript + OpenCV.js**, packaged as a PWA (`vite-plugin-pwa`). OpenCV (~11 MB, wasm
embedded) is **vendored** at `public/opencv.js` and served from our own origin.

```bash
npm install
npm run dev        # dev server (Vite; prints the localhost port — 5173 if free)
npm run build      # tsc + vite build (+ PWA/service worker)
npm run preview    # serve the production build
npm test           # Vitest unit tests (pure geometry + PF2e templates)
npm run lint       # ESLint
```

### Notes

- The **camera** needs a secure context: `https://` or `localhost`. On desktop the camera is often denied
  in automated/headless contexts — that's expected and handled (the app catches it).
- The **service worker runs only in the built app** (`devOptions.enabled: false`). To test the
  download-once OpenCV caching, use `npm run build && npm run preview`, not the dev server. A stale service
  worker can serve an old `index.html`; hard-refresh after deploying.
- The unit tests **cannot** exercise the CV pipeline (OpenCV hangs in Node) — see
  [`../issues/opencv-hangs-in-node.md`](../issues/opencv-hangs-in-node.md). They cover the pure geometry in
  `src/overlays.ts` / `src/grid-detector.ts`. To verify detection, drive a headless browser — see
  [`../operations/verify-detection-headless.md`](../operations/verify-detection-headless.md).
- `assets/pf2e-areas.png` (the book reference used while building the templates) is **copyrighted Paizo
  art** and is git-ignored — do not commit it.
