# Verify detection & the tactical UI in a headless browser

- **Purpose:** exercise the OpenCV pipeline and the on-map UI without a phone — OpenCV can't run in Node
  (see [`../issues/opencv-hangs-in-node.md`](../issues/opencv-hangs-in-node.md)), so drive a real browser.
- **Applies to:** local dev verification of `detectGrid`, overlays, HUD, gestures.
- **Risk:** low — read-only, local.
- **Last verified:** 2026-07-27

## Prerequisites

- Dev server running (`npm run dev`) on **`127.0.0.1`** (not a webcam-backed flow — we inject a synthetic
  grid, which also stops any camera track).
- A browser-automation tool (Playwright MCP, or the Chrome MCP tools).
- The **DEV hook** `window.__argrid` — exposed only in the dev build (`import.meta.env.DEV`), stripped from
  production. Fields (confirm in `src/main.ts`): `detectGrid`, `cv`, `DEFAULT_PARAMS`, `render(canvas)`,
  `view`, `cellClient(i, j)`, `ringHandle()`, `effectiveAngle()`.

## Steps

1. Navigate to the dev URL, e.g. `http://127.0.0.1:5173/` (use the port Vite printed).
2. Wait for OpenCV to be ready (`window.__argrid` to exist), then **inject a synthetic grid** and run the
   real pipeline through `render()`:
   ```js
   // in the page (browser eval)
   const W = 840, H = 640, step = 60, ox = 60, oy = 50;
   const c = document.createElement('canvas'); c.width = W; c.height = H;
   const g = c.getContext('2d');
   g.fillStyle = '#f2efe6'; g.fillRect(0, 0, W, H);
   g.strokeStyle = '#20242c'; g.lineWidth = 3;
   for (let x = ox; x <= W - ox; x += step) { g.beginPath(); g.moveTo(x, oy); g.lineTo(x, H - oy); g.stroke(); }
   for (let y = oy; y <= H - oy; y += step) { g.beginPath(); g.moveTo(ox, y); g.lineTo(W - ox, y); g.stroke(); }
   window.__argrid.render(c);                 // runs detectGrid + draws
   ```
3. Wait until `window.__argrid.cellClient(2, 2)` returns a point (detection finished + `gridMap` built).
4. Drive the UI by mapping **grid coords → client pixels** with `cellClient(i, j)` and dispatching pointer
   events on `#view`. A cell centre is `cellClient(i + 0.5, j + 0.5)`:
   ```js
   const p = window.__argrid.cellClient(4.5, 4.5);
   const view = document.querySelector('#view');
   const base = { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true, pointerType: 'touch', bubbles: true };
   view.dispatchEvent(new PointerEvent('pointerdown', base));
   view.dispatchEvent(new PointerEvent('pointerup', base));   // quick tap
   ```
   - **Tap** a piece = start movement; **long-press** (`> ~450 ms` between down/up) = edit; **drag** (move
     `> 8 px` between down and up) = reposition.
   - For rotation checks use `ringHandle()` (the tip handle's grid point) and `effectiveAngle()`.

## Verify

- `cellClient` returns non-null → the grid was detected and the homography built.
- Assert on DOM state (`#hud`, `#hudTitle`, `#fab` text, `#areaSizeInput.value`, etc.) and take screenshots.

## Rollback / if it fails

- Nothing to undo. Gotchas:
  - After a code edit, **HMR resets `gridMap`** — re-inject the grid (`render()`) before further taps.
  - Re-tapping an **already-selected** piece can toggle it — don't double-tap when a test expects a single
    action.
  - The camera being denied in the automated browser is expected (logged, handled) — not a failure.
