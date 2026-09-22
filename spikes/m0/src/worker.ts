/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * Control-plane HTTP API for driving the ingest workflow locally:
 *
 *   POST /ingest              {url, key, partSize?, chunkSize?, mode?} -> {id}
 *   GET  /instances/:id       workflow instance status (incl. output/error)
 *   POST /instances/:id/terminate
 *   GET  /objects/:key        stream an object back out of R2 (verification)
 *   HEAD /objects/:key        existence/size check
 *   POST /mpu/orphan          {key} -> create a real MPU + junk part + marker,
 *                             simulating a crashed ingest (sweeper target)
 *   GET  /mpu/registry        list in-flight MPU registry markers
 *   POST /sweep               {keyPrefix?, olderThanMs?} -> abort stale MPUs
 */

import { Hono } from "hono";
import { IngestWorkflow, type IngestParams } from "./ingest-workflow";
import { REGISTRY_PREFIX, sweepStaleUploads } from "./sweep";
import type { SpikeEnv } from "./env";

const app = new Hono<{ Bindings: SpikeEnv }>();

app.post("/ingest", async (c) => {
  const params = (await c.req.json()) as IngestParams;
  if (!params.url || !params.key) {
    return c.json({ error: "url and key are required" }, 400);
  }
  const instance = await c.env.INGEST.create({ params });
  return c.json({ id: instance.id });
});

app.get("/instances/:id", async (c) => {
  const instance = await c.env.INGEST.get(c.req.param("id"));
  return c.json(await instance.status());
});

app.post("/instances/:id/terminate", async (c) => {
  const instance = await c.env.INGEST.get(c.req.param("id"));
  await instance.terminate();
  return c.json({ ok: true });
});

function objectKey(c: { req: { path: string } }): string {
  return c.req.path.replace(/^\/objects\//, "");
}

app.get("/objects/*", async (c) => {
  const obj = await c.env.BUCKET.get(objectKey(c));
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-length": String(obj.size),
      etag: obj.httpEtag,
    },
  });
});

app.on("HEAD", "/objects/*", async (c) => {
  const obj = await c.env.BUCKET.head(objectKey(c));
  if (!obj) return new Response(null, { status: 404 });
  return new Response(null, {
    headers: { "content-length": String(obj.size), etag: obj.httpEtag },
  });
});

app.post("/mpu/orphan", async (c) => {
  const { key } = (await c.req.json()) as { key: string };
  const mpu = await c.env.BUCKET.createMultipartUpload(key);
  await mpu.uploadPart(1, new Uint8Array(1024).fill(0xab));
  await c.env.BUCKET.put(
    REGISTRY_PREFIX + mpu.uploadId,
    JSON.stringify({
      key,
      uploadId: mpu.uploadId,
      initiatedAt: Date.now(),
    }),
  );
  return c.json({ key, uploadId: mpu.uploadId });
});

app.get("/mpu/registry", async (c) => {
  const listed = await c.env.BUCKET.list({ prefix: REGISTRY_PREFIX });
  const markers = [];
  for (const obj of listed.objects) {
    const body = await c.env.BUCKET.get(obj.key);
    markers.push(body ? JSON.parse(await body.text()) : { key: obj.key });
  }
  return c.json({ markers });
});

app.post("/sweep", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    keyPrefix?: string;
    olderThanMs?: number;
  };
  const result = await sweepStaleUploads(c.env.BUCKET, {
    keyPrefix: body.keyPrefix,
    olderThanMs: body.olderThanMs ?? 0,
  });
  return c.json(result);
});

// Diagnostics: list objects (cleanup verification).
app.get("/diag/list", async (c) => {
  const listed = await c.env.BUCKET.list({ limit: 100 });
  return c.json({
    truncated: listed.truncated,
    objects: listed.objects.map((o) => ({ key: o.key, size: o.size })),
  });
});

// Diagnostics: delete an object (cleanup).
app.post("/diag/delete", async (c) => {
  const { key } = (await c.req.json()) as { key: string };
  await c.env.BUCKET.delete(key);
  const after = await c.env.BUCKET.head(key);
  return c.json({ deleted: key, stillPresent: after !== null });
});

// Diagnostics: fire N Range+If-Range requests at an upstream from this
// worker's fetch context and report the status-code/etag distribution.
// (Spike-only; host allowlisted to avoid an open proxy.)
app.get("/diag/range-check", async (c) => {
  const url = c.req.query("url") ?? "";
  if (!url.startsWith("https://releases.ubuntu.com/")) {
    return c.json({ error: "host not allowlisted" }, 400);
  }
  const n = Math.min(Number(c.req.query("n") ?? "10"), 50);
  const head = await fetch(url, { method: "HEAD" });
  const etag = head.headers.get("etag");
  const outcomes: { status: number; etag: string | null }[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-1023", ...(etag ? { "If-Range": etag } : {}) },
    });
    outcomes.push({ status: res.status, etag: res.headers.get("etag") });
    await res.body?.cancel();
  }
  const summary: Record<string, number> = {};
  for (const o of outcomes) {
    summary[`${o.status} etag=${o.etag}`] =
      (summary[`${o.status} etag=${o.etag}`] ?? 0) + 1;
  }
  return c.json({ probeEtag: etag, n, summary });
});

export default app;
export { IngestWorkflow };
