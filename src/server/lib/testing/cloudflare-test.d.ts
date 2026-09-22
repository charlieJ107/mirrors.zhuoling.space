/// <reference types="@cloudflare/vitest-plugin/types" />

// The Workers Vitest integration types `env` (cloudflare:workers) as
// Cloudflare.Env; extend it with the test-only migration binding defined in
// vitest.workers.config.ts.
declare namespace Cloudflare {
  interface Env {
    /** D1 migrations loaded by vitest.workers.config.ts via readD1Migrations(). */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
