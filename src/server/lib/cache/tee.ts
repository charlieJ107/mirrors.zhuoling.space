import { StreamingSha256 } from "./sha256";
import type { R2BucketLike, R2MultipartUploadLike, R2UploadedPartLike } from "./r2-types";

/**
 * Streaming tee (docs/02-architecture.md §2.4, ADR-3): the upstream body is
 * forwarded to the client and to an R2 `tmp/{uuid}` object simultaneously,
 * with SHA-256 computed over the full stream. Nothing is buffered whole;
 * backpressure from either side paces the upstream reader.
 *
 * Objects whose size is unknown or above `multipartThresholdBytes` are
 * written as a streaming multipart upload (`partSizeBytes` parts); smaller
 * ones use a single streaming PUT (R2 single-PUT limit is 5GiB, default
 * threshold 4GiB). Both sizes are injectable so tests can exercise the
 * multipart path with tiny parts.
 *
 * Client disconnect: `clientStream.cancel()` cancels the upstream reader and
 * the upload; `done` resolves null and the caller cleans up the tmp object.
 */

export const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;

export interface TeeUploadOptions {
  bucket: R2BucketLike;
  key: string;
  /** From the upstream Content-Length header; null when unknown. */
  contentLength: number | null;
  partSizeBytes?: number;
  multipartThresholdBytes?: number;
}

export interface TeeUploadOutcome {
  sha256: string;
  size: number;
}

export interface TeeUpload {
  clientStream: ReadableStream<Uint8Array>;
  /** Resolves with the digest once the upload finished; null on abort/failure. */
  done: Promise<TeeUploadOutcome | null>;
}

export function teeUpload(source: ReadableStream<Uint8Array>, options: TeeUploadOptions): TeeUpload {
  const partSize = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  const threshold = options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
  const useMultipart =
    options.contentLength === null || options.contentLength > threshold;

  const reader = source.getReader();
  const hasher = new StreamingSha256();
  const uploadStream = new TransformStream<Uint8Array, Uint8Array>();
  const uploadWriter = uploadStream.writable.getWriter();

  let size = 0;
  let uploadFailed = false;
  let settled = false;

  let resolveDone!: (outcome: TeeUploadOutcome | null) => void;
  const done = new Promise<TeeUploadOutcome | null>((resolve) => {
    resolveDone = resolve;
  });

  const settle = (outcome: TeeUploadOutcome | null) => {
    if (!settled) {
      settled = true;
      resolveDone(outcome);
    }
  };

  const uploadPromise = (
    useMultipart
      ? uploadMultipart(options.bucket, options.key, uploadStream.readable, partSize)
      : options.bucket.put(options.key, uploadStream.readable).then(() => undefined)
  ).catch((err: unknown) => {
    uploadFailed = true;
    console.error("tee: R2 upload failed", err);
    // Unblock any pending write/close on the upload side of the tee.
    void uploadWriter.abort(err).catch(() => undefined);
    settle(null);
  });

  const clientStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done: finished, value } = await reader.read();
      if (finished) {
        controller.close();
        try {
          await uploadWriter.close();
        } catch {
          // Upload side already failed; recorded via uploadPromise.
        }
        uploadPromise.then(() => {
          settle(uploadFailed ? null : { sha256: hasher.digestHex(), size });
        });
        return;
      }
      hasher.update(value);
      size += value.byteLength;
      controller.enqueue(value);
      if (!uploadFailed) {
        try {
          await uploadWriter.write(value);
        } catch (err) {
          // Upload broke mid-stream: keep serving the client, drop the copy.
          uploadFailed = true;
          console.error("tee: upload stream broken, continuing without caching", err);
        }
      }
    },
    async cancel(reason) {
      uploadFailed = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Upstream already gone.
      }
      try {
        await uploadWriter.abort(reason);
      } catch {
        // Upload side already closed.
      }
      uploadPromise.then(() => settle(null));
    },
  });

  return { clientStream, done };
}

async function uploadMultipart(
  bucket: R2BucketLike,
  key: string,
  stream: ReadableStream<Uint8Array>,
  partSize: number,
): Promise<void> {
  const upload: R2MultipartUploadLike = await bucket.createMultipartUpload(key);
  const parts: R2UploadedPartLike[] = [];
  let partNumber = 1;
  const chunks: Uint8Array[] = [];
  let buffered = 0;

  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      buffered += value.byteLength;
      while (buffered >= partSize) {
        const part = take(chunks, partSize);
        buffered -= partSize;
        parts.push(await upload.uploadPart(partNumber++, part));
      }
    }
    // The final part may be smaller than partSize (including the only part).
    if (buffered > 0 || parts.length === 0) {
      parts.push(await upload.uploadPart(partNumber++, take(chunks, buffered)));
    }
    await upload.complete(parts);
  } catch (err) {
    try {
      await upload.abort();
    } catch {
      // Abort is best-effort; the bucket lifecycle rule sweeps the rest.
    }
    throw err;
  }
}

/** Consume exactly `n` bytes from the chunk queue (concatenating as needed). */
function take(chunks: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let written = 0;
  while (written < n) {
    const head = chunks[0];
    const need = n - written;
    if (head.byteLength <= need) {
      out.set(head, written);
      written += head.byteLength;
      chunks.shift();
    } else {
      out.set(head.subarray(0, need), written);
      chunks[0] = head.subarray(need);
      written += need;
    }
  }
  return out;
}
