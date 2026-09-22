import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // workerd-only module; stubbed so worker-entry tests run under Node.
      "cloudflare:workers": path.resolve(
        import.meta.dirname,
        "src/server/lib/testing/cloudflare-workers-stub.ts",
      ),
      "@": path.resolve(import.meta.dirname, "src"),
      "@client": path.resolve(import.meta.dirname, "src/client"),
      "@server": path.resolve(import.meta.dirname, "src/server"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "spikes/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/server/lib/data/kysely-d1.ts"],
    },
  }
});
