/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * IngestWorkflow: downloads a large file from an HTTP(S) upstream and stores
 * it in R2 via binding multipart upload, following docs/02-architecture.md §2.6:
 *
 *   probe (HEAD) → create MPU → per-part steps (Range + If-Range) → complete
 *   → finalize: stream the object back from R2 and compute SHA-256.
 *
 * Fallback for upstreams without Range support: a single step streams the
 * body and buffers ~32MiB at a time into UploadPart calls.
 *
 * Any upstream change mid-transfer throws NonRetryableError; the catch path
 * explicitly aborts the multipart upload so a corrupt object can never be
 * assembled. A registry marker per upload (see sweep.ts) backs the sweeper.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { PartChunker } from "./chunker";
import { pickPartSize, planParts, type PartPlan } from "./parts";
import { sha256Hex } from "./sha256";
import { REGISTRY_PREFIX } from "./sweep";
import type { SpikeEnv } from "./env";

export interface IngestParams {
  url: string;
  key: string;
  /** Ranged path part size in bytes. Default 64 MiB (per the design doc). */
  partSize?: number;
  /** Sequential fallback buffer/part size in bytes. Default 32 MiB. */
  chunkSize?: number;
  /** auto = ranged when the upstream advertises Range support. */
  mode?: "auto" | "ranged" | "sequential";
}

interface ProbeResult {
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  acceptRanges: boolean;
}

interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

const PART_RETRY = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

const CRITICAL_RETRY = {
  retries: { limit: 10, delay: "1 second", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

export class IngestWorkflow extends WorkflowEntrypoint<SpikeEnv, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const params = event.payload;
    const { url, key } = params;
    const startedAt = Date.now();
    let uploadId: string | null = null;

    try {
      const probe = await step.do("probe", CRITICAL_RETRY, () =>
        this.probe(url),
      );

      const ranged =
        params.mode === "ranged" ||
        (params.mode !== "sequential" && probe.acceptRanges && probe.size !== null);

      const mpu = await step.do("create-mpu", CRITICAL_RETRY, async () => {
        const created = await this.env.BUCKET.createMultipartUpload(key);
        await this.env.BUCKET.put(
          REGISTRY_PREFIX + created.uploadId,
          JSON.stringify({
            key,
            uploadId: created.uploadId,
            initiatedAt: Date.now(),
          }),
        );
        return { uploadId: created.uploadId };
      });
      uploadId = mpu.uploadId;

      let parts: UploadedPart[];
      let path: "ranged" | "sequential";
      if (ranged) {
        path = "ranged";
        if (probe.size === null) {
          throw new NonRetryableError("ranged mode requires Content-Length");
        }
        const partSize = pickPartSize(
          probe.size,
          params.partSize ?? 64 * 1024 * 1024,
        );
        const plan = planParts(probe.size, partSize);
        parts = [];
        for (const part of plan) {
          const uploaded = await step.do(
            `part-${part.partNumber}`,
            PART_RETRY,
            () => this.uploadRangedPart(url, key, uploadId!, probe, part),
          );
          parts.push(uploaded);
        }
      } else {
        path = "sequential";
        parts = await step.do(
          "sequential-upload",
          { retries: { limit: 2, delay: "5 seconds" }, timeout: "60 minutes" },
          () =>
            this.uploadSequential(
              url,
              key,
              uploadId!,
              probe,
              params.chunkSize ?? 32 * 1024 * 1024,
            ),
        );
      }

      const completed = await step.do("complete", CRITICAL_RETRY, async () => {
        const obj = await this.env.BUCKET.resumeMultipartUpload(
          key,
          uploadId!,
        ).complete(parts);
        await this.env.BUCKET.delete(REGISTRY_PREFIX + uploadId!);
        return { etag: obj.etag, size: obj.size };
      });

      const digest = await step.do(
        "finalize-sha256",
        { ...CRITICAL_RETRY, timeout: "30 minutes" },
        async () => {
          const obj = await this.env.BUCKET.get(key);
          if (!obj) throw new Error(`object ${key} missing after complete`);
          return sha256Hex(obj.body);
        },
      );

      return {
        ok: true as const,
        key,
        path,
        size: completed.size,
        sha256: digest.hex,
        hashedBytes: digest.bytes,
        parts: parts.length,
        upstreamEtag: probe.etag,
        durationMs: Date.now() - startedAt,
        r2Ops: {
          createMultipartUpload: 1,
          uploadPart: parts.length,
          complete: 1,
          get: 1,
          registryPut: 1,
          registryDelete: 1,
        },
      };
    } catch (err) {
      if (uploadId) {
        // Never leave a half-uploaded object behind; abort is free.
        await step.do("abort-mpu", CRITICAL_RETRY, async () => {
          await this.env.BUCKET.resumeMultipartUpload(key, uploadId!).abort();
          await this.env.BUCKET.delete(REGISTRY_PREFIX + uploadId!);
        });
      }
      throw err;
    }
  }

  private async probe(url: string): Promise<ProbeResult> {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) throw new Error(`HEAD ${url} -> ${res.status}`);
    const len = res.headers.get("content-length");
    return {
      size: len === null ? null : Number(len),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      acceptRanges: (res.headers.get("accept-ranges") ?? "")
        .toLowerCase()
        .includes("bytes"),
    };
  }

  private async uploadRangedPart(
    url: string,
    key: string,
    uploadId: string,
    probe: ProbeResult,
    part: PartPlan,
  ): Promise<UploadedPart> {
    const headers: Record<string, string> = {
      Range: `bytes=${part.start}-${part.end}`,
    };
    // If-Range: upstream answers 200 (full body) instead of 206 when the file
    // changed since the probe — our cue to abort rather than mix bytes.
    if (probe.etag) headers["If-Range"] = probe.etag;
    else if (probe.lastModified) headers["If-Range"] = probe.lastModified;

    const res = await fetch(url, { headers });
    if (res.status === 200) {
      await res.body?.cancel();
      throw new NonRetryableError(
        `upstream changed mid-transfer (If-Range triggered a 200 on part ${part.partNumber})`,
      );
    }
    if (res.status !== 206 || !res.body) {
      await res.body?.cancel();
      throw new Error(`part ${part.partNumber}: unexpected status ${res.status}`);
    }
    // Defence for upstreams that ignore If-Range: compare the response ETag
    // and the total size in Content-Range against the probe.
    const etag = res.headers.get("etag");
    if (probe.etag && etag && etag !== probe.etag) {
      await res.body.cancel();
      throw new NonRetryableError(
        `ETag changed mid-transfer: ${probe.etag} -> ${etag}`,
      );
    }
    const total = res.headers.get("content-range")?.split("/")[1];
    if (probe.size !== null && total && total !== "*" && Number(total) !== probe.size) {
      await res.body.cancel();
      throw new NonRetryableError(
        `size changed mid-transfer: ${probe.size} -> ${total}`,
      );
    }
    const mpu = this.env.BUCKET.resumeMultipartUpload(key, uploadId);
    const uploaded = await mpu.uploadPart(part.partNumber, res.body);
    return {
      partNumber: uploaded.partNumber,
      etag: uploaded.etag,
      size: part.size,
    };
  }

  private async uploadSequential(
    url: string,
    key: string,
    uploadId: string,
    probe: ProbeResult,
    chunkSize: number,
  ): Promise<UploadedPart[]> {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`GET ${url} -> ${res.status}`);
    }
    const mpu = this.env.BUCKET.resumeMultipartUpload(key, uploadId);
    const chunker = new PartChunker(chunkSize);
    const parts: UploadedPart[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const body of chunker.push(value)) {
        const part = await mpu.uploadPart(parts.length + 1, body);
        parts.push({
          partNumber: part.partNumber,
          etag: part.etag,
          size: body.byteLength,
        });
      }
    }
    const tail = chunker.flush();
    if (tail) {
      const part = await mpu.uploadPart(parts.length + 1, tail);
      parts.push({
        partNumber: part.partNumber,
        etag: part.etag,
        size: tail.byteLength,
      });
    }
    // No Range support means no mid-transfer protection: re-check the upstream
    // identity with a trailing HEAD before allowing completion.
    const after = await this.probe(url);
    if (probe.etag && after.etag && after.etag !== probe.etag) {
      throw new NonRetryableError(
        `upstream changed during sequential download (ETag ${probe.etag} -> ${after.etag})`,
      );
    }
    if (
      probe.size !== null &&
      after.size !== null &&
      after.size !== probe.size
    ) {
      throw new NonRetryableError(
        `upstream changed during sequential download (size ${probe.size} -> ${after.size})`,
      );
    }
    return parts;
  }
}
