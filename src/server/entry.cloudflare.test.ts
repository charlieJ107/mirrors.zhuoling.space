import { describe, it, expect } from "vitest";
import worker from "./entry.cloudflare";
import { createFakeD1 } from "@server/lib/data/fake-d1";
import { EXTERNAL_APTLY_SOURCE_ID } from "@server/lib/sources/external";

/**
 * Route-level tests for the temporary internal scan endpoint (issue #7).
 * The endpoint is fail-closed: disabled (403) unless INTERNAL_SCAN_TOKEN is
 * configured, and Bearer-gated when it is.
 */

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: createFakeD1(),
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
