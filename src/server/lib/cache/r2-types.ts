/**
 * Minimal structural subset of the R2 / Analytics Engine bindings used by the
 * mirror data plane. The real `R2Bucket`/`AnalyticsEngineDataset` bindings are
 * structurally assignable; tests substitute in-memory fakes without needing
 * `@cloudflare/workers-types`.
 */

export interface R2RangeOptions {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2UploadedPartLike {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: Uint8Array | ReadableStream): Promise<R2UploadedPartLike>;
  complete(uploadedParts: R2UploadedPartLike[]): Promise<unknown>;
  abort(): Promise<void>;
}

export interface R2ObjectBodyLike {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface R2BucketLike {
  get(key: string, options?: { range?: R2RangeOptions }): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ReadableStream<Uint8Array> | Uint8Array): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload(key: string): Promise<R2MultipartUploadLike>;
}

export interface AnalyticsEngineLike {
  writeDataPoint(data: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}
