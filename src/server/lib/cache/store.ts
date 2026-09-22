import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@server/lib/data/schema";
import { newFileId } from "@server/lib/storage/ids";
import type { MirrorStore, UpsertFileInput } from "./cas";

/**
 * Kysely/D1 implementation of the mirror store (docs/02-architecture.md §2.3).
 * The route caches hot reads in an isolate LRU; these queries are the
 * fallback and the write side.
 */
export function createMirrorStore(db: Kysely<Database>): MirrorStore {
  const store: MirrorStore = {
    async getSource(id) {
      const row = await db
        .selectFrom("sources")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ?? null;
    },

    async getFile(sourceId, path) {
      const row = await db
        .selectFrom("files")
        .selectAll()
        .where("source_id", "=", sourceId)
        .where("path", "=", path)
        .executeTakeFirst();
      return row ?? null;
    },

    async getBlobById(id) {
      const row = await db
        .selectFrom("blobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ?? null;
    },

    async findBlobBySha256(sha256) {
      const row = await db
        .selectFrom("blobs")
        .selectAll()
        .where("sha256", "=", sha256)
        .executeTakeFirst();
      return row ?? null;
    },

    async createBlob(row) {
      await db.insertInto("blobs").values(row).execute();
    },

    async acquireBlob(id) {
      // Single atomic UPDATE; resurrects an orphaned blob that is being
      // referenced again (a premature refcount=0 must not leave a live blob
      // marked for the gc workflow).
      await db
        .updateTable("blobs")
        .set({
          refcount: sql`refcount + 1`,
          status: sql`case when status = 'orphaned' then 'active' else status end`,
        })
        .where("id", "=", id)
        .execute();
    },

    async releaseBlob(id) {
      // Atomic decrement + conditional orphan marking: no read-modify-write,
      // so concurrent release/acquire interleavings cannot produce a
      // premature refcount=0 (a blob a file still points at must never
      // become 'orphaned' — the gc workflow would delete live bytes).
      await db
        .updateTable("blobs")
        .set({ refcount: sql`max(0, refcount - 1)` })
        .where("id", "=", id)
        .execute();
      await db
        .updateTable("blobs")
        .set({ status: "orphaned" })
        .where("id", "=", id)
        .where("refcount", "=", 0)
        .where("status", "!=", "orphaned")
        .execute();
    },

    async upsertFileAfterIngest(input: UpsertFileInput) {
      const now = input.now ?? new Date().toISOString();
      const existing = await store.getFile(input.sourceId, input.path);

      if (existing) {
        await db
          .updateTable("files")
          .set({
            current_blob_id: input.blobId,
            state: "present",
            upstream_etag: input.etag,
            upstream_last_modified: input.lastModified,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
        // The finalize step acquired the new blob (+1); releasing the previous
        // pointer here keeps refcount balanced, including the case where the
        // revalidation landed on the same blob (release cancels the acquire).
        if (existing.current_blob_id) {
          await store.releaseBlob(existing.current_blob_id);
        }
        return { ...existing, current_blob_id: input.blobId, state: "present" as const };
      }

      const row = {
        id: newFileId(),
        source_id: input.sourceId,
        path: input.path,
        current_blob_id: input.blobId,
        state: "present" as const,
        upstream_etag: input.etag,
        upstream_last_modified: input.lastModified,
        pinned: 0,
        created_at: now,
        updated_at: now,
      };
      await db.insertInto("files").values(row).execute();
      return row;
    },

    async markFileMissing(fileId) {
      await db
        .updateTable("files")
        .set({ state: "missing", updated_at: new Date().toISOString() })
        .where("id", "=", fileId)
        .execute();
    },
  };

  return store;
}
