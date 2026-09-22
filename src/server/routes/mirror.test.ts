import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMirrorApp } from "@server/routes/mirror";
import { FakeR2Bucket, InMemoryMirrorStore, bytes, streamOf } from "@server/lib/cache/testing";
import { casKey } from "@server/lib/storage/keys";
import { createHash } from "node:crypto";
import type { AppHonoEnv, AppRuntime, MirrorRuntime } from "@server/env";
import type { SourcesTable } from "@server/lib/data/schema";

const NOW = "2026-09-22T00:00:00.000Z";

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeSource(overrides: Partial<SourcesTable> = {}): SourcesTable {
  return {
    id: "s_test1",
    name: "test source",
    adapter: "apt",
    mode: "lazy",
    base_url: "https://upstream.test",
    allow_insecure_http: 0,
    write_prefix: "",
    access_level: "public",
    noindex: 1,
    daily_bytes_cap: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

type UpstreamHandler = (url: string, headers: Headers) => Response | Promise<Response>;

function stubFetch(handler: UpstreamHandler): { calls: string[]; headers: Headers[] } {
  const calls: string[] = [];
  const headers: Headers[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const reqHeaders = new Headers(init?.headers);
    headers.push(reqHeaders);
    return handler(url, reqHeaders);
  });
  return { calls, headers };
}

interface TestContext {
  app: Hono<AppHonoEnv>;
  store: InMemoryMirrorStore;
  bucket: FakeR2Bucket;
  analytics: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }>;
  pending: Promise<unknown>[];
  flush: () => Promise<void>;
}

function createTestContext(): TestContext {
  const store = new InMemoryMirrorStore();
  const bucket = new FakeR2Bucket();
  const analytics: TestContext["analytics"] = [];
  const pending: Promise<unknown>[] = [];

  const mirror: MirrorRuntime = {
    store,
    buckets: { "mirror-hot": bucket, "mirror-cold": new FakeR2Bucket() },
    hotBucketName: "mirror-hot",
    analytics: { writeDataPoint: (point) => analytics.push(point) },
  };

  const app = new Hono<AppHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("app", { mirror } as unknown as AppRuntime);
    await next();
  });
  app.route("/", createMirrorApp({ waitUntil: (p) => pending.push(p) }));

  return {
    app,
    store,
    bucket,
    analytics,
    pending,
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mirror data plane", () => {
  it("returns 404 for unknown sources", async () => {
    const { app } = createTestContext();
    const res = await app.request("/s/s_unknown/dists/bionic/Release");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("rejects multi-range requests", async () => {
    const { app, store } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const res = await app.request("/s/s_test1/pool/x.deb", {
      headers: { range: "bytes=1-2,5-6" },
    });
    expect(res.status).toBe(400);
  });

  it("immutable miss: proxies, persists to CAS, then serves from R2 without upstream", async () => {
    const { app, store, bucket, analytics, flush } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const data = bytes("fake deb payload");
    const { calls } = stubFetch(() =>
      new Response(streamOf(data), {
        status: 200,
        headers: { "content-type": "application/vnd.debian.binary-package" },
      }),
    );

    const res1 = await app.request("/s/s_test1/pool/main/x.deb");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-mirror-cache")).toBe("miss");
    expect(new Uint8Array(await res1.arrayBuffer())).toEqual(data);
    await flush();

    // CAS landed: tmp gone, object at objects/{sha:2}/{sha}, rows written.
    const sha = sha256(data);
    expect(bucket.objects.get(casKey(sha))).toEqual(data);
    expect([...bucket.objects.keys()].some((k) => k.startsWith("tmp/"))).toBe(false);
    const file = await store.getFile("s_test1", "pool/main/x.deb");
    expect(file?.current_blob_id).toBeTruthy();
    const blob = await store.getBlobById(file!.current_blob_id!);
    expect(blob?.sha256).toBe(sha);
    expect(blob?.verify_status).toBe("unverified");

    expect(calls).toEqual(["https://upstream.test/pool/main/x.deb"]);

    const res2 = await app.request("/s/s_test1/pool/main/x.deb");
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-mirror-cache")).toBe("hit");
    expect(new Uint8Array(await res2.arrayBuffer())).toEqual(data);
    expect(calls.length).toBe(1); // no second upstream contact

    expect(analytics.map((p) => p.blobs?.[1])).toEqual(["miss", "hit"]);
  });

  it("serves Range requests from cache with 206 and correct Content-Range", async () => {
    const { app, store, flush } = createTestContext();
    store.sources.set("s_test1", makeSource({ adapter: "static" }));
    const data = bytes("0123456789abcdef");
    stubFetch(() => new Response(streamOf(data), { status: 200 }));

    await (await app.request("/s/s_test1/releases/x.iso")).arrayBuffer();
    await flush();

    const res = await app.request("/s/s_test1/releases/x.iso", {
      headers: { range: "bytes=4-7" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("4567");

    const unsatisfiable = await app.request("/s/s_test1/releases/x.iso", {
      headers: { range: "bytes=100-200" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */16");
  });

  it("passes Range through upstream on a cold miss without caching", async () => {
    const { app, store, bucket, flush } = createTestContext();
    store.sources.set("s_test1", makeSource({ adapter: "static" }));
    const data = bytes("0123456789abcdef");
    stubFetch((_url, headers) => {
      expect(headers.get("range")).toBe("bytes=0-3");
      return new Response(streamOf(data.subarray(0, 4)), {
        status: 206,
        headers: { "content-range": "bytes 0-3/16", "content-length": "4" },
      });
    });

    const res = await app.request("/s/s_test1/releases/x.iso", {
      headers: { range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/16");
    expect(await res.text()).toBe("0123");
    await flush();
    expect(bucket.objects.size).toBe(0); // not cached
    expect(store.files.size).toBe(0);
  });

  it("mutable: revalidates with conditionals, 304 serves cache, upstream-down serves stale", async () => {
    const { app, store, flush } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const v1 = bytes("Release v1");
    let upstream: Response | "throw" = new Response(streamOf(v1), {
      status: 200,
      headers: { etag: '"v1"', "content-type": "text/plain" },
    });
    const { headers: sentHeaders } = stubFetch((_url, headers) => {
      if (upstream === "throw") throw new Error("network down");
      if (headers.get("if-none-match") === '"v1"') {
        return new Response(null, { status: 304 });
      }
      return upstream;
    });

    // Cold miss: cached with etag.
    const res1 = await app.request("/s/s_test1/dists/bionic/Release");
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("Release v1");
    await flush();

    // Revalidation: conditional sent, 304 -> cached copy served.
    const res2 = await app.request("/s/s_test1/dists/bionic/Release");
    expect(res2.headers.get("x-mirror-cache")).toBe("revalidated");
    expect(await res2.text()).toBe("Release v1");
    expect(sentHeaders[1]?.get("if-none-match")).toBe('"v1"');

    // Upstream down: stale copy served.
    upstream = "throw";
    const res3 = await app.request("/s/s_test1/dists/bionic/Release");
    expect(res3.status).toBe(200);
    expect(res3.headers.get("x-mirror-cache")).toBe("stale");
    expect(await res3.text()).toBe("Release v1");
  });

  it("mutable: upstream 200 re-ingests, switches the pointer, orphans the old blob", async () => {
    const { app, store, bucket, flush } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const v1 = bytes("Release v1");
    const v2 = bytes("Release v2 -- longer");
    let version = 1;
    stubFetch((_url, headers) => {
      if (headers.get("if-none-match") === `"v${version}"`) {
        return new Response(null, { status: 304 });
      }
      const data = version === 1 ? v1 : v2;
      return new Response(streamOf(data), { status: 200, headers: { etag: `"v${version}"` } });
    });

    await (await app.request("/s/s_test1/dists/bionic/Release")).arrayBuffer();
    await flush();
    const oldBlobId = (await store.getFile("s_test1", "dists/bionic/Release"))!.current_blob_id!;

    version = 2;
    const res = await app.request("/s/s_test1/dists/bionic/Release");
    expect(await res.text()).toBe("Release v2 -- longer");
    await flush();

    const file = await store.getFile("s_test1", "dists/bionic/Release");
    expect(file!.current_blob_id).not.toBe(oldBlobId);
    expect(file!.upstream_etag).toBe('"v2"');
    expect(store.blobs.get(oldBlobId)!.refcount).toBe(0);
    expect(store.blobs.get(oldBlobId)!.status).toBe("orphaned");
    expect(bucket.objects.get(casKey(sha256(v2)))).toEqual(v2);
  });

  it("by-hash paths are immutable and integrity-checked against the filename", async () => {
    const { app, store, bucket, flush } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const good = bytes("hashable content");
    const goodSha = sha256(good);
    const { calls } = stubFetch(() => new Response(streamOf(good), { status: 200 }));

    const path = `dists/bionic/main/binary-amd64/by-hash/SHA256/${goodSha}`;
    const res1 = await app.request(`/s/s_test1/${path}`);
    expect(res1.status).toBe(200);
    await res1.arrayBuffer();
    await flush();

    const blob = await store.getBlobById((await store.getFile("s_test1", path))!.current_blob_id!);
    expect(blob!.verify_status).toBe("ok");
    expect(blob!.verified_at).toBeTruthy();

    const res2 = await app.request(`/s/s_test1/${path}`);
    expect(res2.headers.get("x-mirror-cache")).toBe("hit");
    expect(calls.length).toBe(1);

    // Content that does NOT match the by-hash name is not persisted.
    const badSha = "f".repeat(64);
    const badRes = await app.request(`/s/s_test1/dists/bionic/by-hash/SHA256/${badSha}`);
    expect(badRes.status).toBe(200); // bytes still served to the client
    await badRes.arrayBuffer();
    await flush();
    expect(await store.getFile("s_test1", `dists/bionic/by-hash/SHA256/${badSha}`)).toBeNull();
    expect([...bucket.objects.keys()].some((k) => k.startsWith("tmp/"))).toBe(false);
  });

  it("passthrough paths are proxied without caching", async () => {
    const { app, store, bucket, flush } = createTestContext();
    store.sources.set("s_test1", makeSource());
    stubFetch(() => new Response(streamOf(bytes("transient")), { status: 200 }));

    const res = await app.request("/s/s_test1/random/thing.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-cache")).toBe("passthrough");
    expect(await res.text()).toBe("transient");
    await flush();
    expect(bucket.objects.size).toBe(0);
    expect(store.files.size).toBe(0);
  });

  it("deduplicates identical content across sources (refcount=2, one object)", async () => {
    const { app, store, bucket, flush } = createTestContext();
    store.sources.set("s_a", makeSource({ id: "s_a", base_url: "https://a.test" }));
    store.sources.set("s_b", makeSource({ id: "s_b", base_url: "https://b.test" }));
    const data = bytes("same deb everywhere");
    stubFetch(() => new Response(streamOf(data), { status: 200 }));

    await (await app.request("/s/s_a/pool/main/x.deb")).arrayBuffer();
    await flush();
    await (await app.request("/s/s_b/pool/main/x.deb")).arrayBuffer();
    await flush();

    const sha = sha256(data);
    const blobs = [...store.blobs.values()].filter((b) => b.sha256 === sha);
    expect(blobs.length).toBe(1);
    expect(blobs[0].refcount).toBe(2);
    expect(bucket.objects.get(casKey(sha))).toEqual(data);
  });

  it("rejects path traversal and control characters", async () => {
    const { app, store } = createTestContext();
    store.sources.set("s_test1", makeSource());
    const res = await app.request("/s/s_test1/../secret");
    expect([400, 404]).toContain(res.status);
  });

  it("returns 501 when the mirror runtime is not configured", async () => {
    const app = new Hono<AppHonoEnv>();
    app.use("*", async (c, next) => {
      c.set("app", {} as unknown as AppRuntime);
      await next();
    });
    app.route("/", createMirrorApp());
    const res = await app.request("/s/s_test1/pool/x.deb");
    expect(res.status).toBe(501);
  });
});
