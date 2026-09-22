import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "./entry.cloudflare";
import { EXTERNAL_APTLY_SOURCE_ID } from "@server/lib/sources/external";
import { resetStorage } from "@server/lib/testing/reset-storage";

/**
 * Route-level tests for the temporary internal scan endpoint (issue #7),
 * running inside workerd against the real local-emulated D1/R2 bindings.
 * The endpoint is fail-closed: disabled (403) unless INTERNAL_SCAN_TOKEN is
 * configured, and Bearer-gated when it is.
 */

beforeEach(resetStorage);

type TestEnv = Env & { INTERNAL_SCAN_TOKEN?: string };

function makeEnv(extra: Partial<TestEnv> = {}): TestEnv {
  return { ...(env as TestEnv), ...extra };
}

function scanRequest(token?: string) {
  return new Request("http://localhost/api/internal/scan-external", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function postScan(request: Request, envOverrides: Partial<TestEnv> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, makeEnv(envOverrides), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /api/internal/scan-external", () => {
  it("responds 403 (disabled) when INTERNAL_SCAN_TOKEN is not configured", async () => {
    const res = await postScan(scanRequest("anything"), {
      // Explicitly unset: .dev.vars may define a token locally.
      INTERNAL_SCAN_TOKEN: undefined,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("responds 401 without a bearer token when configured", async () => {
    const res = await postScan(scanRequest(), { INTERNAL_SCAN_TOKEN: "s3cret" });
    expect(res.status).toBe(401);
  });

  it("responds 401 with the wrong bearer token", async () => {
    const res = await postScan(scanRequest("wrong"), { INTERNAL_SCAN_TOKEN: "s3cret" });
    expect(res.status).toBe(401);
  });

  it("runs the scan when the correct bearer token is presented", async () => {
    const res = await postScan(scanRequest("s3cret"), { INTERNAL_SCAN_TOKEN: "s3cret" });
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
