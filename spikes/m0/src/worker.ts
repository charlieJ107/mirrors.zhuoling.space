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

app.get("/objects/:key", async (c) => {
  const obj = await c.env.BUCKET.get(c.req.param("key"));
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-length": String(obj.size),
      etag: obj.httpEtag,
    },
  });
});

app.on("HEAD", "/objects/:key", async (c) => {
  const obj = await c.env.BUCKET.head(c.req.param("key"));
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

export default app;
export { IngestWorkflow };
