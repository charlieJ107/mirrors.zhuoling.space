import { describe, it, expect } from "vitest";
import worker from "./entry.cloudflare";
import { createTestSqlite } from "@server/lib/data/test-db";
import { EXTERNAL_APTLY_SOURCE_ID } from "@server/lib/sources/external";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

/**
 * Route-level tests for the temporary internal scan endpoint (issue #7).
 * The endpoint is fail-closed: disabled (403) unless INTERNAL_SCAN_TOKEN is
 * configured, and Bearer-gated when it is.
 *
 * The route's production code path goes through `createDb(c.env.DB)` (the
 * Kysely D1 dialect), so it needs a D1Database-shaped binding. `asD1Binding`
 * is a thin adapter that forwards `prepare().bind().all()` to a real
 * better-sqlite3 database (with the real migrations applied); it does not
 * pretend to validate D1 dialect behavior — data-layer correctness is
 * covered by the SqliteDialect unit tests and the wrangler dev smoke.
 */

const READ_RE = /^\s*(select|with|pragma|explain)\b/i;

function asD1Binding(sqlite: ReturnType<typeof createTestSqlite>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all(): Promise<D1Result> {
              const stmt = sqlite.prepare(sql);
              if (READ_RE.test(sql)) {
                return {
                  success: true,
                  results: stmt.all(...params.map((p) => p as never)),
                  meta: { changes: 0, last_row_id: 0 },
                } as unknown as D1Result;
              }
              const info = stmt.run(...params.map((p) => p as never));
              return {
                success: true,
                results: [],
                meta: {
                  changes: Number(info.changes),
                  last_row_id: Number(info.lastInsertRowid),
                },
              } as unknown as D1Result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: asD1Binding(createTestSqlite()),
    ROBOT_APT: {
      async list() {
        return { objects: [], truncated: false, delimitedPrefixes: [] };
      },
    },
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef-0123456789",
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_ALLOWED_HOSTS: "",
    ...extra,
  } as unknown as Env;
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function scanRequest(token?: string) {
  return new Request("http://localhost/api/internal/scan-external", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("POST /api/internal/scan-external", () => {
  it("responds 403 (disabled) when INTERNAL_SCAN_TOKEN is not configured", async () => {
    const res = await worker.fetch(scanRequest("anything"), makeEnv(), ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("responds 401 without a bearer token when configured", async () => {
    const env = makeEnv({ INTERNAL_SCAN_TOKEN: "s3cret" });
    const res = await worker.fetch(scanRequest(), env, ctx);
    expect(res.status).toBe(401);
  });

  it("responds 401 with the wrong bearer token", async () => {
    const env = makeEnv({ INTERNAL_SCAN_TOKEN: "s3cret" });
    const res = await worker.fetch(scanRequest("wrong"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("runs the scan when the correct bearer token is presented", async () => {
    const env = makeEnv({ INTERNAL_SCAN_TOKEN: "s3cret" });
    const res = await worker.fetch(scanRequest("s3cret"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceId: string;
      complete: boolean;
      missingFiles: number;
    };
    expect(body.sourceId).toBe(EXTERNAL_APTLY_SOURCE_ID);
    expect(body.complete).toBe(true);
    expect(body.missingFiles).toBe(0);
  });
});
