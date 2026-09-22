import type { Kysely } from "kysely";
import type { Database } from "@server/lib/data/schema";
import { newBlobId, newFileId } from "@server/lib/storage/ids";
import {
  EXTERNAL_APTLY_BUCKET,
  EXTERNAL_APTLY_PREFIXES,
  EXTERNAL_APTLY_SOURCE_ID,
} from "@server/lib/sources/external";

/**
 * Scanner for the read-only external aptly mount (issue #7,
 * docs/02-architecture.md §2.2/§2.3).
 *
 * Paginates `R2Bucket.list()` over the aptly prefixes and materializes
 * `files` / `blobs` rows for every object found:
 * - blobs: tier=external, bucket=robot-apt, real r2_key, size from the
 *   listing, sha256=NULL (until the verify workflow fills it),
 *   verify_status=unverified, refcount=1;
 * - files: path = bucket-relative key, state=present, pinned=1.
 *
 * The scan only ever calls `list()` on the bucket — no `put`/`delete` path
 * exists here, and the source's empty write_prefix rejects writes in code.
 *
 * Idempotent: rows are keyed on `blobs(bucket, r2_key)` and
 * `files(source_id, path)` (unique in the schema), so re-running updates in
 * place instead of duplicating. Resumable: pass the `resumeFrom` cursor of a
 * truncated result into the next call. A fresh (non-resumed) scan pre-marks
 * all of the source's files `missing` and un-marks them as objects are
 * listed, so rows whose objects vanished from the bucket end the scan as
 * state=missing — and an interrupted scan self-heals on the next run.
 * Verification results survive re-scans, except when an object's size
 * changed under the same key: the verified bytes are gone, so the blob is
 * reset to sha256=NULL / verify_status=unverified.
 */

export interface ScanCursor {
  prefix: string;
  /** Opaque R2 list cursor; undefined = start of the prefix. */
  cursor?: string;
}

export interface ScanExternalOptions {
  /** Defaults to the aptly prefixes ros/, ubuntu/, blobs/. */
  prefixes?: readonly string[];
  /** Resume point from a previous truncated result. */
  resumeFrom?: ScanCursor;
  /** Max number of list() pages per invocation (resumability/testing). */
  pageLimit?: number;
  /** R2 list page size; defaults to the R2 maximum of 1000. */
  pageSize?: number;
  now?: () => Date;
}

export interface ScanExternalResult {
  sourceId: string;
  /** True when every prefix was listed to completion. */
  complete: boolean;
  /** Pass back as `resumeFrom` when `complete` is false; null otherwise. */
  resumeFrom: ScanCursor | null;
  listedObjects: number;
  listPages: number;
  filesCreated: number;
  filesUpdated: number;
  blobsCreated: number;
  blobsUpdated: number;
  /** Files currently state=missing; only set when complete. */
  missingFiles: number | null;
}

const DEFAULT_PAGE_SIZE = 1000;

export async function scanExternalAptlyBucket(
  db: Kysely<Database>,
  bucket: R2Bucket,
  options: ScanExternalOptions = {},
): Promise<ScanExternalResult> {
  const prefixes = options.prefixes ?? EXTERNAL_APTLY_PREFIXES;
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sourceId = EXTERNAL_APTLY_SOURCE_ID;

  // Fresh full scan: pre-mark everything missing; the listing loop below
  // flips each listed object back to present. Vanished objects stay missing.
  if (!options.resumeFrom) {
    await db
      .updateTable("files")
      .set({ state: "missing", updated_at: now().toISOString() })
      .where("source_id", "=", sourceId)
      .where("state", "=", "present")
      .execute();
  }

  const result: ScanExternalResult = {
    sourceId,
    complete: false,
    resumeFrom: null,
    listedObjects: 0,
    listPages: 0,
    filesCreated: 0,
    filesUpdated: 0,
    blobsCreated: 0,
    blobsUpdated: 0,
    missingFiles: null,
  };

  let prefixIndex = options.resumeFrom
    ? prefixes.indexOf(options.resumeFrom.prefix)
    : 0;
  if (prefixIndex < 0) {
    throw new Error(
      `resume prefix "${options.resumeFrom?.prefix}" is not in the scan prefix list`,
    );
  }
  let cursor = options.resumeFrom?.cursor;

  for (; prefixIndex < prefixes.length; prefixIndex++) {
    const prefix = prefixes[prefixIndex];
    for (;;) {
      const page = await bucket.list({ prefix, cursor, limit: pageSize });
      result.listPages++;
      for (const object of page.objects) {
        const created = await upsertObject(db, sourceId, object, now());
        result.listedObjects++;
        if (created.blob) result.blobsCreated++;
        else result.blobsUpdated++;
        if (created.file) result.filesCreated++;
        else result.filesUpdated++;
      }

      if (page.truncated) {
        cursor = page.cursor;
      } else {
        cursor = undefined;
        break;
      }

      if (options.pageLimit !== undefined && result.listPages >= options.pageLimit) {
        result.resumeFrom = { prefix, cursor };
        return result;
      }
    }

    if (
      options.pageLimit !== undefined &&
      result.listPages >= options.pageLimit &&
      prefixIndex + 1 < prefixes.length
    ) {
      result.resumeFrom = { prefix: prefixes[prefixIndex + 1] };
      return result;
    }
  }

  result.complete = true;
  const missing = await db
    .selectFrom("files")
    .select(({ fn }) => fn.countAll().as("n"))
    .where("source_id", "=", sourceId)
    .where("state", "=", "missing")
    .executeTakeFirstOrThrow();
  result.missingFiles = Number(missing.n);
  return result;
}

async function upsertObject(
  db: Kysely<Database>,
  sourceId: string,
  object: R2Object,
  now: Date,
): Promise<{ blob: boolean; file: boolean }> {
  const nowIso = now.toISOString();
  const lastModified = object.uploaded.toISOString();

  const existingBlob = await db
    .selectFrom("blobs")
    .select(["id", "size"])
    .where("bucket", "=", EXTERNAL_APTLY_BUCKET)
    .where("r2_key", "=", object.key)
    .where("tier", "=", "external")
    .executeTakeFirst();

  let blobId: string;
  let blobCreated = false;
  if (existingBlob) {
    // Never clobber sha256/verify_status: the verify workflow may already
    // have filled them; a re-scan only refreshes the listing facts.
    if (existingBlob.size !== object.size) {
      // The object was replaced under the same key — the verified bytes are
      // no longer what is there, so any previous verification is void.
      await db
        .updateTable("blobs")
        .set({
          size: object.size,
          sha256: null,
          verified_at: null,
          verify_status: "unverified",
        })
        .where("id", "=", existingBlob.id)
        .execute();
    } else {
      await db
        .updateTable("blobs")
        .set({ size: object.size })
        .where("id", "=", existingBlob.id)
        .execute();
    }
    blobId = existingBlob.id;
  } else {
    blobId = newBlobId();
    blobCreated = true;
    await db
      .insertInto("blobs")
      .values({
        id: blobId,
        sha256: null,
        bucket: EXTERNAL_APTLY_BUCKET,
        r2_key: object.key,
        size: object.size,
        refcount: 1,
        tier: "external",
        status: "active",
        fetched_at: null,
        verified_at: null,
        verify_status: "unverified",
        last_access_at: null,
        access_count: 0,
      })
      .execute();
  }

  const existingFile = await db
    .selectFrom("files")
    .select("id")
    .where("source_id", "=", sourceId)
    .where("path", "=", object.key)
    .executeTakeFirst();
  const fileCreated = !existingFile;

  await db
    .insertInto("files")
    .values({
      id: existingFile?.id ?? newFileId(),
      source_id: sourceId,
      path: object.key,
      current_blob_id: blobId,
      state: "present",
      upstream_etag: object.etag,
      upstream_last_modified: lastModified,
      pinned: 1,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .onConflict((oc) =>
      oc.columns(["source_id", "path"]).doUpdateSet({
        current_blob_id: blobId,
        state: "present",
        upstream_etag: object.etag,
        upstream_last_modified: lastModified,
        pinned: 1,
        updated_at: nowIso,
      }),
    )
    .execute();

  return { blob: blobCreated, file: fileCreated };
}
