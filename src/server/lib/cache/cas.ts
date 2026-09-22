import { casKey } from "@server/lib/storage/keys";
import { newBlobId } from "@server/lib/storage/ids";
import { withKnownLength } from "./tee";
import type { R2BucketLike } from "./r2-types";
import type {
  BlobsTable,
  BlobVerifyStatus,
  FilesTable,
  SourcesTable,
} from "@server/lib/data/schema";

/**
 * CAS write path (docs/02-architecture.md §2.4) and the D1 access layer used
 * by the mirror route. `MirrorStore` is a narrow interface so the data-plane
 * logic is testable with in-memory fakes; `store.ts` implements it on Kysely.
 */

export interface MirrorStore {
  getSource(id: string): Promise<SourcesTable | null>;
  getFile(sourceId: string, path: string): Promise<FilesTable | null>;
  getBlobById(id: string): Promise<BlobsTable | null>;
  findBlobBySha256(sha256: string): Promise<BlobsTable | null>;
  createBlob(row: BlobsTable): Promise<void>;
  /** refcount + 1. */
  acquireBlob(id: string): Promise<void>;
  /** refcount - 1; a blob reaching 0 becomes 'orphaned' for the gc workflow. */
  releaseBlob(id: string): Promise<void>;
  upsertFileAfterIngest(input: UpsertFileInput): Promise<FilesTable>;
  markFileMissing(fileId: string): Promise<void>;
}

export interface UpsertFileInput {
  sourceId: string;
  path: string;
  blobId: string;
  etag: string | null;
  lastModified: string | null;
  now?: string;
}

export interface FinalizeInput {
  tmpKey: string;
  sha256: string;
  size: number;
  verifyStatus: BlobVerifyStatus;
  now?: string;
}

export interface FinalizeResult {
  blob: BlobsTable;
  /** True when the content already existed (cross-source dedup / refetch). */
  deduplicated: boolean;
}

/** Pure placement decision for a completed tmp upload (unit-tested directly). */
export function planCasAction(
  existing: BlobsTable | null,
  sha256: string,
): { action: "reuse"; blob: BlobsTable } | { action: "place"; key: string } {
  if (existing) return { action: "reuse", blob: existing };
  return { action: "place", key: casKey(sha256) };
}

/**
 * Land a completed tmp upload in the CAS:
 * - content already known -> delete tmp (Delete is free), refcount + 1;
 * - new content -> copy tmp to `objects/{sha256:2}/{sha256}`, delete tmp,
 *   insert the blob row with refcount 1.
 */
export async function finalizeCasBlob(
  store: MirrorStore,
  bucket: R2BucketLike,
  bucketName: string,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const now = input.now ?? new Date().toISOString();
  const existing = await store.findBlobBySha256(input.sha256);
  const plan = planCasAction(existing, input.sha256);

  if (plan.action === "reuse") {
    await bucket.delete(input.tmpKey);
    await store.acquireBlob(plan.blob.id);
    return { blob: plan.blob, deduplicated: true };
  }

  await copyObject(bucket, input.tmpKey, plan.key);
  await bucket.delete(input.tmpKey);

  const blob: BlobsTable = {
    id: newBlobId(),
    sha256: input.sha256,
    bucket: bucketName,
    r2_key: plan.key,
    size: input.size,
    refcount: 1,
    tier: "hot",
    status: "active",
    fetched_at: now,
    verified_at: input.verifyStatus === "ok" ? now : null,
    verify_status: input.verifyStatus,
    last_access_at: now,
    access_count: 0,
  };
  await store.createBlob(blob);
  return { blob, deduplicated: false };
}

/**
 * Server-side copy via the bucket binding. The binding exposes no CopyObject
 * (the S3 API does), so this streams through the isolate: one Class B read +
 * one Class A write, no egress. Documented deviation from docs/02 §2.4.
 */
export async function copyObject(bucket: R2BucketLike, fromKey: string, toKey: string): Promise<void> {
  const source = await bucket.get(fromKey);
  if (!source) {
    throw new Error(`copyObject: source object missing: ${fromKey}`);
  }
  // workerd rejects unknown-length streams for PUT; we know the size.
  await bucket.put(toKey, withKnownLength(source.body, source.size));
}
