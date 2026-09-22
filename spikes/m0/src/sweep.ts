/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * Orphan multipart sweeper.
 *
 * IMPORTANT FINDING: the R2 *Workers binding* has no `listMultipartUploads`
 * (verified against @cloudflare/workers-types 20260922.1 — only
 * createMultipartUpload/resumeMultipartUpload exist). The S3-compatible API
 * has ListMultipartUploads, but that needs R2 API credentials which a Worker
 * binding does not have.
 *
 * So the spike tracks in-flight uploads with tiny marker objects under
 * `__mpu_registry__/` (written right after CreateMultipartUpload, deleted on
 * complete/abort) and the sweeper lists that prefix. The selection/abort
 * logic below is listing-mechanism-agnostic; the remote run
 * (spikes/m0/run-remote.md) re-validates the same logic against the real S3
 * ListMultipartUploads output.
 */

export const REGISTRY_PREFIX = "__mpu_registry__/";

export interface MultipartUploadInfo {
  key: string;
  uploadId: string;
  initiatedAt: number; // epoch ms
}

export interface SweepDecision {
  abort: MultipartUploadInfo[];
  keep: MultipartUploadInfo[];
}

/** Pure selection: which tracked uploads are stale enough to abort. */
export function selectStaleUploads(
  uploads: MultipartUploadInfo[],
  opts: { keyPrefix?: string; olderThanMs: number; now: number },
): SweepDecision {
  const abort: MultipartUploadInfo[] = [];
  const keep: MultipartUploadInfo[] = [];
  for (const up of uploads) {
    const keyMatches = !opts.keyPrefix || up.key.startsWith(opts.keyPrefix);
    const stale = opts.now - up.initiatedAt >= opts.olderThanMs;
    if (keyMatches && stale) abort.push(up);
    else keep.push(up);
  }
  return { abort, keep };
}

/** Minimal bucket surface the sweeper needs (structural, test-friendly). */
export interface SweepBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): { abort(): Promise<void> };
}

export interface SweepResult {
  aborted: MultipartUploadInfo[];
  errors: { uploadId: string; key: string; error: string }[];
}

export async function sweepStaleUploads(
  bucket: SweepBucket,
  opts: { keyPrefix?: string; olderThanMs: number; now?: number },
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const tracked: MultipartUploadInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: REGISTRY_PREFIX, cursor });
    for (const obj of page.objects) {
      const body = await bucket.get(obj.key);
      if (!body) continue;
      try {
        tracked.push(JSON.parse(await body.text()) as MultipartUploadInfo);
      } catch {
        // Corrupt marker: still try to clean it up below via delete.
        tracked.push({
          key: "",
          uploadId: obj.key.slice(REGISTRY_PREFIX.length),
          initiatedAt: 0,
        });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const { abort } = selectStaleUploads(tracked, { ...opts, now });
  const result: SweepResult = { aborted: [], errors: [] };
  for (const up of abort) {
    try {
      if (up.key) {
        await bucket.resumeMultipartUpload(up.key, up.uploadId).abort();
      }
      await bucket.delete(REGISTRY_PREFIX + up.uploadId);
      result.aborted.push(up);
    } catch (err) {
      result.errors.push({
        uploadId: up.uploadId,
        key: up.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
