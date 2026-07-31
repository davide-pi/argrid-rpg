import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// App version for the on-map badge. In CI, GitVersion provides it via APP_VERSION.
// Local dev/builds have no APP_VERSION, so they show a fixed "0.0.0-local" marker
// (rather than package.json's version, which would masquerade as a real release).
const appVersion = process.env.APP_VERSION || '0.0.0-local';

export default defineConfig({
  // Replaced verbatim in the bundle; consumed as `__APP_VERSION__` in the app.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: true, // listen on all interfaces (needed for ngrok / LAN devices)
    // A leading dot allows the host and all of its subdomains.
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app'],
  },
  preview: {
    host: true,
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'opencv.js'],
      manifest: {
        name: 'ARGrid — Grid Detector',
        short_name: 'ARGrid',
        description: 'Detect a grid of squares in a photo and highlight it in AR style.',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      devOptions: {
        enabled: false, // keep the service worker out of the way during dev
      },
      workbox: {
        // Precache everything including the vendored ~11 MB opencv.js, so it is
        // downloaded once on install and then served from cache (offline too).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
    }),
  ],
});
