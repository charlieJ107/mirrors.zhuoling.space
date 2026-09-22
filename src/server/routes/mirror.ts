import { Hono } from "hono";
import type { Context } from "hono";
import { getAdapter } from "@server/lib/adapters";
import type { IntegrityExpectation, MirrorAdapter } from "@server/lib/adapters";
import { finalizeCasBlob, type MirrorStore } from "@server/lib/cache/cas";
import { LruCache } from "@server/lib/cache/lru";
import {
  contentRangeHeader,
  parseRangeHeader,
  resolveRange,
  toR2Range,
  type ParsedRange,
  type ResolvedRange,
} from "@server/lib/cache/range";
import { teeUpload } from "@server/lib/cache/tee";
import { tmpKey } from "@server/lib/storage/keys";
import { normalizeR2Key } from "@server/lib/storage/r2-key";
import type { AppHonoEnv, MirrorRuntime } from "@server/env";
import type { BlobsTable, BlobVerifyStatus, FilesTable, SourcesTable } from "@server/lib/data/schema";

/**
 * Lazy data plane (issue #3): GET/HEAD `/s/{sourceId}/*`.
 *
 * Flow per docs/02-architecture.md §2.7:
 * - immutable: serve from R2 if mapped, never revalidate; fetch + tee + CAS on miss;
 * - mutable: conditional upstream request (If-None-Match / If-Modified-Since),
 *   304 serves cache, 200 re-ingests, upstream-down serves stale;
 * - passthrough: proxy without caching.
 *
 * Range (§2.8): single ranges map to R2 binding range reads on hits; on cold
 * misses the Range is passed upstream and the response proxied without
 * caching; multi-range requests are rejected.
 */

export interface MirrorRouteOptions {
  /** Isolate LRU TTL for source configs (ms). Default 60_000 (§2.3). */
  sourceCacheTtlMs?: number;
  /** Isolate LRU TTL for file -> blob mappings (ms). Default 60_000. */
  mappingCacheTtlMs?: number;
  maxCacheEntries?: number;
  /** Injectable for tests (R2 requires >= 5MiB per non-final part in prod). */
  partSizeBytes?: number;
  multipartThresholdBytes?: number;
  /** waitUntil hook; defaults to c.executionCtx.waitUntil. Overridden in tests. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

type CacheOutcome =
  | "hit"
  | "miss"
  | "stale"
  | "revalidated"
  | "passthrough"
  | "bypass"
  | "aborted"
  | "integrity-failed";

interface CachedMapping {
  fileId: string;
  blobId: string;
  bucket: string;
  r2Key: string;
  size: number;
  sha256: string | null;
  etag: string | null;
  lastModified: string | null;
}

const CONTENT_TYPES: Array<[RegExp, string]> = [
  [/\.u?deb$/i, "application/vnd.debian.binary-package"],
  [/\.dsc$/i, "text/plain; charset=utf-8"],
  [/\.tar\.gz$|\.tgz$/i, "application/gzip"],
  [/\.tar\.xz$/i, "application/x-xz"],
  [/\.gz$/i, "application/gzip"],
  [/\.xz$/i, "application/x-xz"],
  [/\.zst$/i, "application/zstd"],
  [/\.json$/i, "application/json"],
  [/\.html?$/i, "text/html; charset=utf-8"],
  [/\.txt$/i, "text/plain; charset=utf-8"],
  [/\.iso$/i, "application/x-iso9660-image"],
];

function guessContentType(path: string): string {
  for (const [pattern, type] of CONTENT_TYPES) {
    if (pattern.test(path)) return type;
  }
  return "application/octet-stream";
}

/** Headers relayed from upstream responses to the client. */
const RELAY_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "cache-control",
  "accept-ranges",
];

function relayUpstreamHeaders(upstream: Response, headers: Headers): void {
  for (const name of RELAY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
}

export function createMirrorApp(options: MirrorRouteOptions = {}): Hono<AppHonoEnv> {
  const sourceCache = new LruCache<string, SourcesTable | null>({
    maxEntries: options.maxCacheEntries ?? 512,
    ttlMs: options.sourceCacheTtlMs ?? 60_000,
  });
  const mappingCache = new LruCache<string, CachedMapping | null>({
    maxEntries: options.maxCacheEntries ?? 4096,
    ttlMs: options.mappingCacheTtlMs ?? 60_000,
  });

  const app = new Hono<AppHonoEnv>();

  app.on(["GET", "HEAD"], ["/s/:sourceId", "/s/:sourceId/", "/s/:sourceId/*"], async (c) => {
    const mirror = c.var.app?.mirror;
    if (!mirror) {
      return mirrorError(c, 501, "MIRROR_UNAVAILABLE", "The mirror data plane is not configured on this runtime");
    }

    const sourceId = c.req.param("sourceId");
    const rawPath = extractWildcardPath(c, sourceId);
    const normalized = normalizeR2Key(rawPath);
    if (!normalized.ok) {
      return mirrorError(c, normalized.reason === "key is empty" ? 404 : 400, "BAD_PATH", normalized.reason);
    }
    const path = normalized.key;

    const waitUntil =
      options.waitUntil ??
      ((promise: Promise<unknown>) => {
        try {
          c.executionCtx.waitUntil(promise);
        } catch {
          // No ExecutionContext (non-Workers runtime): run detached.
          void promise.catch((err) => console.error("mirror: background task failed", err));
        }
      });

    const range = parseRangeHeader(c.req.header("range") ?? null);
    if (range.kind === "multi") {
      return mirrorError(c, 400, "MULTI_RANGE_UNSUPPORTED", "Multiple ranges are not supported");
    }

    const source = await lookupSource(mirror.store, sourceCache, sourceId);
    if (!source || source.status !== "active" || source.mode !== "lazy" || !source.base_url) {
      return mirrorError(c, 404, "NOT_FOUND", "Not found");
    }

    const adapter = getAdapter(source.adapter);
    const classification = adapter.classifyPath(path);
    const mappingKey = `${source.id} ${path}`;

    if (classification === "passthrough") {
      return proxyUpstream(c, mirror, source, adapter, path, "passthrough");
    }

    const mapping = await lookupMapping(mirror.store, mappingCache, mappingKey, source.id, path);

    if (classification === "immutable") {
      if (mapping) {
        const cached = await serveFromCache(c, mirror, source, path, mapping, range, "hit");
        if (cached) return cached;
        // Object vanished from R2 (inconsistent state): fall through and refetch.
        mappingCache.delete(mappingKey);
      }
      if (range.kind !== "none") {
        // Range on a cold miss: pass the Range upstream and proxy without
        // caching (§2.8); the full object is not fetched just to serve a slice.
        return proxyUpstream(c, mirror, source, adapter, path, "bypass");
      }
      return ingestAndServe(c, mirror, source, adapter, path, mappingCache, mappingKey, options, waitUntil);
    }

    // mutable
    if (mapping) {
      const conditional = new Headers();
      if (mapping.etag) conditional.set("if-none-match", mapping.etag);
      if (mapping.lastModified) conditional.set("if-modified-since", mapping.lastModified);

      const upstream = await tryFetchUpstream(source, adapter, path, conditional);
      if (!upstream) {
        // Upstream unreachable: serve stale and log (§2.7, EOL scenario).
        console.warn(`mirror: upstream unreachable for ${source.id}/${path}, serving stale`);
        const stale = await serveFromCache(c, mirror, source, path, mapping, range, "stale");
        return stale ?? mirrorError(c, 502, "UPSTREAM_UNREACHABLE", "Upstream unreachable and no cached copy");
      }
      if (upstream.status === 304) {
        void upstream.body?.cancel();
        const cached = await serveFromCache(c, mirror, source, path, mapping, range, "revalidated");
        if (cached) return cached;
        // Cached object vanished from R2: refetch unconditionally below.
        mappingCache.delete(mappingKey);
        return ingestAndServe(c, mirror, source, adapter, path, mappingCache, mappingKey, options, waitUntil);
      }
      if (upstream.status === 404) {
        void upstream.body?.cancel();
        waitUntil(handleUpstreamGone(mirror.store, mapping));
        mappingCache.set(mappingKey, null);
        return mirrorError(c, 404, "NOT_FOUND", "Not found");
      }
      if (upstream.status === 200 && upstream.body) {
        return ingestResponse(mirror, source, adapter, path, mappingCache, mappingKey, options, waitUntil, upstream);
      }
      return relayResponse(c, mirror, source.id, "passthrough", upstream);
    }

    return ingestAndServe(c, mirror, source, adapter, path, mappingCache, mappingKey, options, waitUntil);
  });

  app.all("/s/*", (c) => mirrorError(c, 405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported"));

  return app;
}

type MirrorContext = Context<AppHonoEnv>;

function extractWildcardPath(c: MirrorContext, sourceId: string): string {
  // Raw pathname: percent-encoding preserved per ADR-2 (no decode/re-encode).
  const pathname = new URL(c.req.url).pathname;
  const prefix = `/s/${sourceId}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
}

function mirrorError(c: MirrorContext, status: 400 | 404 | 405 | 416 | 502 | 501, code: string, message: string) {
  c.header("X-Robots-Tag", "noindex");
  return c.json({ code, message }, status);
}

async function lookupSource(
  store: MirrorStore,
  cache: LruCache<string, SourcesTable | null>,
  sourceId: string,
): Promise<SourcesTable | null> {
  const cached = cache.get(sourceId);
  if (cached !== undefined) return cached;
  const source = await store.getSource(sourceId);
  cache.set(sourceId, source);
  return source;
}

function toCachedMapping(file: FilesTable, blob: BlobsTable): CachedMapping {
  return {
    fileId: file.id,
    blobId: blob.id,
    bucket: blob.bucket,
    r2Key: blob.r2_key,
    size: blob.size,
    sha256: blob.sha256,
    etag: file.upstream_etag,
    lastModified: file.upstream_last_modified,
  };
}

async function lookupMapping(
  store: MirrorStore,
  cache: LruCache<string, CachedMapping | null>,
  cacheKey: string,
  sourceId: string,
  path: string,
): Promise<CachedMapping | null> {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const file = await store.getFile(sourceId, path);
  if (!file || file.state !== "present" || !file.current_blob_id) {
    cache.set(cacheKey, null);
    return null;
  }
  const blob = await store.getBlobById(file.current_blob_id);
  if (!blob || blob.status !== "active") {
    cache.set(cacheKey, null);
    return null;
  }
  const mapping = toCachedMapping(file, blob);
  cache.set(cacheKey, mapping);
  return mapping;
}

async function tryFetchUpstream(
  source: SourcesTable,
  adapter: MirrorAdapter,
  path: string,
  extraHeaders?: Headers,
): Promise<Response | null> {
  try {
    return await fetch(adapter.buildUpstreamUrl(source.base_url!, path), {
      headers: extraHeaders,
      redirect: "follow",
    });
  } catch (err) {
    console.error(`mirror: upstream fetch failed for ${source.id}/${path}`, err);
    return null;
  }
}

function track(runtime: MirrorRuntime, sourceId: string, outcome: CacheOutcome, bytesServed: number): void {
  try {
    runtime.analytics?.writeDataPoint({
      blobs: [sourceId, outcome],
      doubles: [bytesServed],
      indexes: [sourceId],
    });
  } catch (err) {
    console.error("mirror: analytics write failed", err);
  }
}

/** Pass-through proxy: no caching, Range and method relayed upstream. */
async function proxyUpstream(
  c: MirrorContext,
  mirror: MirrorRuntime,
  source: SourcesTable,
  adapter: MirrorAdapter,
  path: string,
  outcome: CacheOutcome,
): Promise<Response> {
  const headers = new Headers();
  const rangeHeader = c.req.header("range");
  if (rangeHeader) headers.set("range", rangeHeader);

  const upstream = await tryFetchUpstream(source, adapter, path, headers);
  if (!upstream) {
    return mirrorError(c, 502, "UPSTREAM_UNREACHABLE", "Upstream fetch failed");
  }
  return relayResponse(c, mirror, source.id, outcome, upstream);
}

function relayResponse(
  c: MirrorContext,
  mirror: MirrorRuntime,
  sourceId: string,
  outcome: CacheOutcome,
  upstream: Response,
): Response {
  const headers = new Headers();
  relayUpstreamHeaders(upstream, headers);
  headers.set("X-Robots-Tag", "noindex");
  headers.set("X-Mirror-Cache", outcome);
  track(mirror, sourceId, outcome, Number(upstream.headers.get("content-length")) || 0);
  return new Response(c.req.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

/** Serve a cached blob from R2, honoring Range. Null => object missing. */
async function serveFromCache(
  c: MirrorContext,
  mirror: MirrorRuntime,
  source: SourcesTable,
  path: string,
  mapping: CachedMapping,
  range: ParsedRange,
  outcome: CacheOutcome,
): Promise<Response | null> {
  const bucket = mirror.buckets[mapping.bucket];
  if (!bucket) return null;

  const size = mapping.size;
  const headers = new Headers({
    "content-type": guessContentType(path),
    "accept-ranges": "bytes",
    "x-robots-tag": "noindex",
    "x-mirror-cache": outcome,
  });
  if (mapping.sha256) headers.set("etag", `"${mapping.sha256}"`);
  if (mapping.lastModified) headers.set("last-modified", mapping.lastModified);

  let status = 200;
  let resolved: ResolvedRange | null = null;
  if (range.kind === "offset" || range.kind === "suffix") {
    resolved = resolveRange(range, size);
    if (!resolved) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "x-robots-tag": "noindex" },
      });
    }
    status = 206;
    headers.set("content-range", contentRangeHeader(resolved, size));
    headers.set("content-length", String(resolved.length));
  } else {
    headers.set("content-length", String(size));
  }

  const object = await bucket.get(mapping.r2Key, resolved ? { range: toR2Range(resolved) } : undefined);
  if (!object) return null;

  track(mirror, source.id, outcome, resolved ? resolved.length : size);
  return new Response(c.req.method === "HEAD" ? null : object.body, { status, headers });
}

/** Cold miss: fetch upstream, tee to client + R2 tmp, CAS-finalize in the background. */
async function ingestAndServe(
  c: MirrorContext,
  mirror: MirrorRuntime,
  source: SourcesTable,
  adapter: MirrorAdapter,
  path: string,
  mappingCache: LruCache<string, CachedMapping | null>,
  mappingKey: string,
  options: MirrorRouteOptions,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (c.req.method === "HEAD") {
    // HEAD on a cold miss: proxy the upstream HEAD; never ingest without bytes.
    return proxyUpstream(c, mirror, source, adapter, path, "bypass");
  }
  const upstream = await tryFetchUpstream(source, adapter, path);
  if (!upstream) {
    return mirrorError(c, 502, "UPSTREAM_UNREACHABLE", "Upstream fetch failed");
  }
  if (upstream.status !== 200 || !upstream.body) {
    // Non-200 statuses (404 etc.) are relayed without caching.
    return relayResponse(c, mirror, source.id, "passthrough", upstream);
  }
  return ingestResponse(mirror, source, adapter, path, mappingCache, mappingKey, options, waitUntil, upstream);
}

async function ingestResponse(
  mirror: MirrorRuntime,
  source: SourcesTable,
  adapter: MirrorAdapter,
  path: string,
  mappingCache: LruCache<string, CachedMapping | null>,
  mappingKey: string,
  options: MirrorRouteOptions,
  waitUntil: (promise: Promise<unknown>) => void,
  upstream: Response,
): Promise<Response> {
  const bucket = mirror.buckets[mirror.hotBucketName];
  const contentLengthHeader = upstream.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  const expectation = adapter.extractIntegrity(path, upstream.headers);
  const tmp = tmpKey();

  const tee = teeUpload(upstream.body!, {
    bucket,
    key: tmp,
    contentLength: contentLength !== null && Number.isSafeInteger(contentLength) ? contentLength : null,
    partSizeBytes: options.partSizeBytes,
    multipartThresholdBytes: options.multipartThresholdBytes,
  });

  waitUntil(
    finalizeIngest(mirror, source.id, path, tmp, expectation, upstream.headers, tee.done)
      .then((mapping) => {
        if (mapping) mappingCache.set(mappingKey, mapping);
      })
      .catch((err) => console.error(`mirror: finalize failed for ${source.id}/${path}`, err)),
  );

  const headers = new Headers();
  relayUpstreamHeaders(upstream, headers);
  headers.set("accept-ranges", "bytes");
  headers.set("x-robots-tag", "noindex");
  headers.set("x-mirror-cache", "miss");
  return new Response(tee.clientStream, { status: 200, headers });
}

/**
 * Background finalize (§2.4): verify integrity when a digest is checkable,
 * land the tmp object in the CAS, switch the file pointer, release the old
 * blob. Client disconnect makes tee.done resolve null -> tmp is cleaned up.
 */
async function finalizeIngest(
  mirror: MirrorRuntime,
  sourceId: string,
  path: string,
  tmp: string,
  expectation: IntegrityExpectation | null,
  upstreamHeaders: Headers,
  done: Promise<{ sha256: string; size: number } | null>,
): Promise<CachedMapping | null> {
  const bucket = mirror.buckets[mirror.hotBucketName];
  const outcome = await done;

  if (!outcome) {
    await bucket.delete(tmp).catch(() => undefined);
    track(mirror, sourceId, "aborted", 0);
    return null;
  }

  let verifyStatus: BlobVerifyStatus = "unverified";
  if (expectation) {
    if (expectation.digest !== outcome.sha256) {
      // Integrity failure (ADR-7): drop the tmp object, cache nothing.
      console.error(
        `mirror: integrity mismatch for ${sourceId}/${path}: expected ${expectation.digest}, got ${outcome.sha256}`,
      );
      await bucket.delete(tmp).catch(() => undefined);
      track(mirror, sourceId, "integrity-failed", outcome.size);
      return null;
    }
    verifyStatus = "ok";
  }

  const { blob } = await finalizeCasBlob(mirror.store, bucket, mirror.hotBucketName, {
    tmpKey: tmp,
    sha256: outcome.sha256,
    size: outcome.size,
    verifyStatus,
  });

  const file = await mirror.store.upsertFileAfterIngest({
    sourceId,
    path,
    blobId: blob.id,
    etag: upstreamHeaders.get("etag"),
    lastModified: upstreamHeaders.get("last-modified"),
  });

  track(mirror, sourceId, "miss", outcome.size);
  return toCachedMapping(file, blob);
}

/** Mutable file deleted upstream: mark missing, release the blob pointer. */
async function handleUpstreamGone(
  store: MirrorStore,
  mapping: CachedMapping,
): Promise<void> {
  await store.markFileMissing(mapping.fileId);
  await store.releaseBlob(mapping.blobId);
}
