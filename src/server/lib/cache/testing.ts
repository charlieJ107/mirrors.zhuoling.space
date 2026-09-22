import type {
  R2BucketLike,
  R2MultipartUploadLike,
  R2ObjectBodyLike,
  R2RangeOptions,
  R2UploadedPartLike,
} from "./r2-types";
import type { MirrorStore, UpsertFileInput } from "./cas";
import type { BlobsTable, FilesTable, SourcesTable } from "@server/lib/data/schema";

/**
 * In-memory fakes shared by the data-plane unit tests (not used in prod code).
 */

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function applyRange(data: Uint8Array, range?: R2RangeOptions): Uint8Array {
  if (!range) return data;
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, data.byteLength);
    return data.subarray(data.byteLength - length);
  }
  const offset = range.offset ?? 0;
  const end = range.length !== undefined ? offset + range.length : data.byteLength;
  return data.subarray(offset, Math.min(end, data.byteLength));
}

export class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();
  readonly multipartParts = new Map<string, number>();
  readonly abortedUploads: string[] = [];
  failPuts = false;

  async get(key: string, options?: { range?: R2RangeOptions }): Promise<R2ObjectBodyLike | null> {
    const data = this.objects.get(key);
    if (!data) return null;
    const sliced = applyRange(data, options?.range);
    const size = data.byteLength;
    return { body: streamOf(sliced), size };
  }

  async put(key: string, value: ReadableStream<Uint8Array> | Uint8Array): Promise<unknown> {
    if (this.failPuts) throw new Error("injected put failure");
    this.objects.set(key, value instanceof Uint8Array ? value : await streamToBytes(value));
    return {};
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async createMultipartUpload(key: string): Promise<R2MultipartUploadLike> {
    const parts: Uint8Array[] = [];
    return {
      uploadPart: async (partNumber: number, value: Uint8Array | ReadableStream) => {
        parts[partNumber - 1] = value instanceof Uint8Array ? value : await streamToBytes(value);
        return { partNumber, etag: `etag-${partNumber}` } satisfies R2UploadedPartLike;
      },
      complete: async () => {
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        this.objects.set(key, out);
        this.multipartParts.set(key, parts.length);
        return {};
      },
      abort: async () => {
        this.abortedUploads.push(key);
      },
    };
  }
}

export class InMemoryMirrorStore implements MirrorStore {
  readonly sources = new Map<string, SourcesTable>();
  readonly files = new Map<string, FilesTable>();
  readonly blobs = new Map<string, BlobsTable>();

  async getSource(id: string): Promise<SourcesTable | null> {
    return this.sources.get(id) ?? null;
  }

  async getFile(sourceId: string, path: string): Promise<FilesTable | null> {
    return [...this.files.values()].find((f) => f.source_id === sourceId && f.path === path) ?? null;
  }

  async getBlobById(id: string): Promise<BlobsTable | null> {
    return this.blobs.get(id) ?? null;
  }

  async findBlobBySha256(sha256: string): Promise<BlobsTable | null> {
    return [...this.blobs.values()].find((b) => b.sha256 === sha256) ?? null;
  }

  async createBlob(row: BlobsTable): Promise<void> {
    this.blobs.set(row.id, row);
  }

  async acquireBlob(id: string): Promise<void> {
    const blob = this.blobs.get(id);
    if (blob) this.blobs.set(id, { ...blob, refcount: blob.refcount + 1 });
  }

  async releaseBlob(id: string): Promise<void> {
    const blob = this.blobs.get(id);
    if (!blob) return;
    const next = Math.max(0, blob.refcount - 1);
    this.blobs.set(id, { ...blob, refcount: next, status: next === 0 ? "orphaned" : blob.status });
  }

  async upsertFileAfterIngest(input: UpsertFileInput): Promise<FilesTable> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.getFile(input.sourceId, input.path);
    if (existing) {
      const updated: FilesTable = {
        ...existing,
        current_blob_id: input.blobId,
        state: "present",
        upstream_etag: input.etag,
        upstream_last_modified: input.lastModified,
        updated_at: now,
      };
      this.files.set(existing.id, updated);
      if (existing.current_blob_id) {
        await this.releaseBlob(existing.current_blob_id);
      }
      return updated;
    }
    const row: FilesTable = {
      id: `f_test_${this.files.size + 1}`,
      source_id: input.sourceId,
      path: input.path,
      current_blob_id: input.blobId,
      state: "present",
      upstream_etag: input.etag,
      upstream_last_modified: input.lastModified,
      pinned: 0,
      created_at: now,
      updated_at: now,
    };
    this.files.set(row.id, row);
    return row;
  }

  async markFileMissing(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (file) this.files.set(fileId, { ...file, state: "missing" });
  }
}
