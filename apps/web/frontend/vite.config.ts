import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * `@scanlist/ts-core` is imported from TypeScript source, not from node_modules:
 * the alias points at shared/ts-core/src/index.ts, exactly like the `paths` entry in
 * tsconfig.json. No workspace root, no publish step, no build artefact — Vite transpiles
 * the shared .ts files itself, and Vitest picks the same alias up because it uses this
 * config. `server.fs.allow` widens the dev server to the repo root so the aliased files
 * (outside this package) can be served in `npm run dev`.
 */
const tsCore = fileURLToPath(new URL("../../../shared/ts-core/src/index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@scanlist/ts-core": tsCore,
    },
  },
  // Preact without @preact/preset-vite: Oxc's automatic JSX runtime is enough.
  // (Vite 8 transforms JSX with Oxc; the old `esbuild.jsx` switches are gone.)
  oxc: {
    jsx: { runtime: "automatic", importSource: "preact" },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
