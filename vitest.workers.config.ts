import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Workers test project: runs inside workerd with the bindings from
 * wrangler.jsonc (D1 `DB`, R2 buckets) provided by local emulation. The real
 * migrations from migrations/d1 are made available as the TEST_MIGRATIONS
 * binding and applied by the setup file
 * (src/server/lib/testing/apply-migrations.ts).
 *
 * BETTER_AUTH_* are provided as test-only vars because the worker entry's
 * middleware constructs the auth runtime on every request; they carry no
 * real secrets.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations", "d1"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: "vitest-only-secret-0123456789abcdef",
            BETTER_AUTH_URL: "http://localhost:8787",
            BETTER_AUTH_ALLOWED_HOSTS: "",
          },
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@client": path.resolve(import.meta.dirname, "src/client"),
        "@server": path.resolve(import.meta.dirname, "src/server"),
        "@shared": path.resolve(import.meta.dirname, "src/shared"),
      },
    },
    test: {
      name: "workers",
      include: [
        "src/server/index.test.ts",
        "src/server/entry.cloudflare.test.ts",
        "src/server/lib/scanner/**/*.test.ts",
        "src/server/lib/sources/external.test.ts",
      ],
      setupFiles: ["./src/server/lib/testing/apply-migrations.ts"],
    },
  };
});
