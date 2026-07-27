# Test on a phone (ngrok)

- **Purpose:** run the app on a real phone with a real camera — the only way to test the full capture flow.
- **Applies to:** local dev / preview reached from a phone.
- **Risk:** low.
- **Last verified:** 2026-07-27

## Prerequisites

- The camera requires a **secure context** (`https://` or `localhost`); a phone hitting your LAN IP over
  plain `http` won't get camera access, so tunnel with **ngrok** (which serves `https`).
- `*.ngrok-free.dev` and `*.ngrok-free.app` are already in Vite's `allowedHosts` (`vite.config.ts`).

## Steps

- **Dev server** (fast iteration; no service worker):
  ```bash
  npm run dev
  ngrok http 5173      # or the port Vite printed
  ```
  Open the `https://…ngrok…` URL on the phone.

- **Production build** (to test the PWA / OpenCV download-once caching, which only runs in the built app):
  ```bash
  npm run build && npm run preview
  ngrok http 4173
  ```

## Verify

- The camera opens; framing a grid and shooting detects it and draws the overlay.
- For the built app: OpenCV downloads once, then the app works offline (service worker cache).

## Rollback / if it fails

- Stop ngrok / the dev server (`Ctrl-C`). If the phone shows a stale UI on the built app, it's the service
  worker cache — hard-refresh or reinstall the PWA.
