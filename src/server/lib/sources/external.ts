import type { Kysely } from "kysely";
import type { Database, SourcesTable } from "@server/lib/data/schema";

/**
 * Registration of the existing aptly bucket `robot-apt` as a read-only
 * `external-pinned` source (docs/02-architecture.md §2.2, ADR-10 decision 5).
 *
 * The bucket holds production aptly output under `ros/`, `ubuntu/` and
 * `blobs/` and must never be modified by this system. Read-only is enforced
 * in code: this module accepts no `write_prefix` input at all, always writes
 * the row with `write_prefix = ""` (which `isWriteAllowed` maps to "deny
 * every write"), and the upsert restores that invariant if the row was
 * tampered with out of band.
 */

/** Well-known stable id for the aptly mount; never randomly generated. */
export const EXTERNAL_APTLY_SOURCE_ID = "s_robotapt";
export const EXTERNAL_APTLY_SOURCE_NAME = "robot-apt";
export const EXTERNAL_APTLY_BUCKET = "robot-apt";

/** aptly-published prefixes inside the bucket; all read-only. */
export const EXTERNAL_APTLY_PREFIXES = ["ros/", "ubuntu/", "blobs/"] as const;

function aptlySourceRow(now: string) {
  return {
    id: EXTERNAL_APTLY_SOURCE_ID,
    name: EXTERNAL_APTLY_SOURCE_NAME,
    adapter: "apt",
    mode: "external-pinned",
    base_url: null,
    allow_insecure_http: 0,
    // Empty write prefix = read-only (isWriteAllowed denies everything).
    write_prefix: "",
    access_level: "public",
    noindex: 1,
    daily_bytes_cap: null,
    status: "active",
  } as const;
}

/**
 * Idempotently ensure the `sources` row for the aptly mount exists.
 * Re-running updates the row in place and re-asserts the read-only
 * invariants; it never creates a second source row.
 */
export async function ensureExternalAptlySource(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<SourcesTable> {
  const nowIso = now.toISOString();
  const row = aptlySourceRow(nowIso);

  await db
    .insertInto("sources")
    .values({ ...row, created_at: nowIso, updated_at: nowIso })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        name: row.name,
        adapter: row.adapter,
        mode: row.mode,
        base_url: row.base_url,
        allow_insecure_http: row.allow_insecure_http,
        write_prefix: row.write_prefix,
        noindex: row.noindex,
        updated_at: nowIso,
      }),
    )
    .execute();

  const stored = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", EXTERNAL_APTLY_SOURCE_ID)
    .executeTakeFirstOrThrow();

  return stored;
}
