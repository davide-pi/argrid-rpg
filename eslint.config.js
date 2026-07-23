import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Vanilla TS + browser project (no framework). Mirrors the shared repo setup
// (flat config, @eslint/js + typescript-eslint recommended) adapted from the
// React repos by dropping the react-* plugins.
export default tseslint.config(
  { ignores: ["dist", "coverage", "public", ".remember"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // OpenCV Mats and the injected window globals are intentionally untyped.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
