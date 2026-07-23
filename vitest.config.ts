import { defineConfig } from "vitest/config";

// The suite covers the pure geometry in grid-detector.ts and overlays.ts, which
// touch no DOM, so a plain node environment is enough (the CV pipeline itself
// is verified via Playwright, not here). Coverage mirrors the shared repo setup.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts", // UI/orchestration glue, exercised via Playwright
        "src/camera.ts",
        "src/zoom.ts",
        "src/vite-env.d.ts",
      ],
    },
  },
});
