# OpenCV boot constraints — don't "modernize" the loader

- **Scope:** why `public/opencv-boot.js` is a **classic** script with a **synchronous** ready callback,
  and what breaks if you change it. Fundamental gotcha — easy to "clean up" and break.
- **Last verified:** 2026-07-27
- **Refs:** `public/opencv-boot.js` (its header comments), `src/main.ts` (`window.__cvOnReady` consumer)

## Content

OpenCV.js is an Emscripten build. It only initializes reliably under a specific set of conditions that were
pinned down with a headless-browser harness. **These are not preferences — violating them hangs or fails
initialization**, and the symptom (a silent hang before "ready") is hard to debug. Keep the loader as-is.

- **Load it from a CLASSIC script, not the ES-module app code.** OpenCV's Emscripten runtime does **not**
  finish initializing when injected/driven from an ES module. `index.html` loads `public/opencv-boot.js`
  as a classic `<script>`; the module app (`src/main.ts`) only *consumes* the globals it exposes.
- **The ready signal must be a SYNCHRONOUS callback** (`window.__cvOnReady`), **not** a promise `.then`.
  Emscripten starves the microtask queue right after init, so a `.then` continuation never runs.
- **Do not revoke the injected blob URL** — Emscripten keeps referencing it.
- `public/opencv-boot.js` exposes `window.__cvOnReady(fn)` and `window.__cvOnProgress(fn)`; `src/main.ts`
  registers on them to flip the app from the loading screen to ready. **Assumption:** the exact callback
  names are the current contract — confirm in both files if you touch either.

> If you find yourself "simplifying" this into `import`/`await`, stop: it will hang. The comments in
> `public/opencv-boot.js` explain each constraint inline.
