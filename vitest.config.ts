import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  "@client": path.resolve(import.meta.dirname, "src/client"),
  "@server": path.resolve(import.meta.dirname, "src/server"),
  "@shared": path.resolve(import.meta.dirname, "src/shared"),
};

/**
 * Test projects:
 * - "node": pure-function tests with no binding dependencies, plain Node.
 * - "workers": tests that touch D1/R2/the worker entry, run inside workerd
 *   via @cloudflare/vitest-plugin against real local-emulated bindings
 *   (see vitest.workers.config.ts).
 */
const WORKERS_TESTS = [
  "src/server/index.test.ts",
  "src/server/entry.cloudflare.test.ts",
  "src/server/lib/scanner/**/*.test.ts",
  "src/server/lib/sources/external.test.ts",
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "spikes/**/*.test.ts"],
          exclude: WORKERS_TESTS,
        },
      },
      "./vitest.workers.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/server/lib/data/kysely-d1.ts"],
    },
  },
});
