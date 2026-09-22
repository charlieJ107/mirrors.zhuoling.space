import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createDb } from "@server/lib/data/db";
import {
  ensureExternalAptlySource,
  EXTERNAL_APTLY_BUCKET,
  EXTERNAL_APTLY_SOURCE_ID,
} from "@server/lib/sources/external";
import { scanExternalAptlyBucket } from "@server/lib/scanner/external-scan";
import { resetStorage } from "@server/lib/testing/reset-storage";

// Runs in the workers pool: env.DB / env.ROBOT_APT are real D1/R2 bindings
// backed by local emulation (see vitest.workers.config.ts). Objects are
// seeded through the real R2 binding's put().

beforeEach(resetStorage);

const SEED: Array<[string, number]> = [
  ["ros/dists/noetic/Release", 1200],
  ["ros/pool/main/r/pkg/pkg_1.0_amd64.deb", 54321],
  ["ubuntu/dists/jammy/InRelease", 3400],
  ["blobs/sha256/ab/abcdef0123", 999],
];

async function seed(key: string, size: number): Promise<void> {
  await env.ROBOT_APT.put(key, "x".repeat(size));
}

async function setup() {
  const db = createDb(env.DB);
  await ensureExternalAptlySource(db);
  for (const [key, size] of SEED) await seed(key, size);
  return { db, bucket: env.ROBOT_APT };
}

describe("scanExternalAptlyBucket", () => {
  it("materializes files/blobs rows for objects under the aptly prefixes", async () => {
    const { db, bucket } = await setup();

    const result = await scanExternalAptlyBucket(db, bucket);

    expect(result.complete).toBe(true);
    expect(result.listedObjects).toBe(SEED.length);
    expect(result.filesCreated).toBe(SEED.length);
    expect(result.blobsCreated).toBe(SEED.length);
    expect(result.missingFiles).toBe(0);

    const files = await db
      .selectFrom("files")
      .selectAll()
      .where("source_id", "=", EXTERNAL_APTLY_SOURCE_ID)
      .orderBy("path")
      .execute();
    expect(files.map((f) => f.path)).toEqual(SEED.map(([k]) => k).sort());
    for (const file of files) {
      expect(file.state).toBe("present");
      expect(file.pinned).toBe(1);
      expect(file.current_blob_id).not.toBeNull();
      // Real R2 etag (MD5 hex for single-part uploads) and upload time.
      expect(file.upstream_etag).toMatch(/^[0-9a-f]{32}$/);
      expect(Number.isNaN(Date.parse(file.upstream_last_modified!))).toBe(false);
    }

    const blobs = await db.selectFrom("blobs").selectAll().execute();
    expect(blobs).toHaveLength(SEED.length);
    for (const blob of blobs) {
      expect(blob.tier).toBe("external");
      expect(blob.bucket).toBe(EXTERNAL_APTLY_BUCKET);
      expect(blob.sha256).toBeNull();
      expect(blob.verify_status).toBe("unverified");
      expect(blob.refcount).toBe(1);
      expect(blob.status).toBe("active");
      const seedEntry = SEED.find(([k]) => k === blob.r2_key);
      expect(seedEntry).toBeDefined();
      expect(blob.size).toBe(seedEntry![1]);
    }

    // files -> blobs mapping resolves to the real r2_key.
    for (const file of files) {
      const blob = blobs.find((b) => b.id === file.current_blob_id);
      expect(blob?.r2_key).toBe(file.path);
    }
  });

  it("ignores objects outside the aptly prefixes", async () => {
    const { db, bucket } = await setup();
    await seed("other/random-object", 1);

    const result = await scanExternalAptlyBucket(db, bucket);
    expect(result.listedObjects).toBe(SEED.length);
    const files = await db.selectFrom("files").selectAll().execute();
    expect(files).toHaveLength(SEED.length);
  });

  it("is idempotent: re-running updates in place without duplicating rows", async () => {
    const { db, bucket } = await setup();

    const first = await scanExternalAptlyBucket(db, bucket);
    const fileIdsBefore = (
      await db.selectFrom("files").select("id").execute()
    ).map((r) => r.id);
    const blobIdsBefore = (
      await db.selectFrom("blobs").select("id").execute()
    ).map((r) => r.id);

    const second = await scanExternalAptlyBucket(db, bucket);
    expect(second.filesCreated).toBe(0);
    expect(second.blobsCreated).toBe(0);
    expect(second.filesUpdated).toBe(SEED.length);
    expect(second.blobsUpdated).toBe(SEED.length);
    expect(second.missingFiles).toBe(0);

    const fileIdsAfter = (
      await db.selectFrom("files").select("id").execute()
    ).map((r) => r.id);
    const blobIdsAfter = (
      await db.selectFrom("blobs").select("id").execute()
    ).map((r) => r.id);
    expect(fileIdsAfter.sort()).toEqual(fileIdsBefore.sort());
    expect(blobIdsAfter.sort()).toEqual(blobIdsBefore.sort());
    expect(await db.selectFrom("files").selectAll().execute()).toHaveLength(SEED.length);
    expect(await db.selectFrom("blobs").selectAll().execute()).toHaveLength(SEED.length);
    expect(first.complete).toBe(true);
  });

  it("marks rows whose objects vanished as missing, and revives reappearing ones", async () => {
    const { db, bucket } = await setup();
    await scanExternalAptlyBucket(db, bucket);

    await bucket.delete("ros/pool/main/r/pkg/pkg_1.0_amd64.deb");
    const second = await scanExternalAptlyBucket(db, bucket);
    expect(second.missingFiles).toBe(1);
    expect(second.listedObjects).toBe(SEED.length - 1);

    const gone = await db
      .selectFrom("files")
      .selectAll()
      .where("path", "=", "ros/pool/main/r/pkg/pkg_1.0_amd64.deb")
      .executeTakeFirstOrThrow();
    expect(gone.state).toBe("missing");
    // The blob row is retained (verify/GC decisions belong to other jobs).
    const blob = await db
      .selectFrom("blobs")
      .selectAll()
      .where("id", "=", gone.current_blob_id!)
      .executeTakeFirstOrThrow();
    expect(blob.r2_key).toBe("ros/pool/main/r/pkg/pkg_1.0_amd64.deb");

    // Object reappears -> file flips back to present on the next scan.
    await seed("ros/pool/main/r/pkg/pkg_1.0_amd64.deb", 54321);
    const third = await scanExternalAptlyBucket(db, bucket);
    expect(third.missingFiles).toBe(0);
    const revived = await db
      .selectFrom("files")
      .select("state")
      .where("path", "=", "ros/pool/main/r/pkg/pkg_1.0_amd64.deb")
      .executeTakeFirstOrThrow();
    expect(revived.state).toBe("present");
  });

  it("paginates list() until each prefix is exhausted", async () => {
    const { db, bucket } = await setup();
    await seed("ros/extra-1", 1);
    await seed("ros/extra-2", 2);
    await seed("ros/extra-3", 3);

    const result = await scanExternalAptlyBucket(db, bucket, { pageSize: 2 });
    expect(result.complete).toBe(true);
    // ros/ has 5 objects -> 3 pages; ubuntu/ 1 object -> 1 page; blobs/ 1 -> 1 page.
    expect(result.listPages).toBe(5);
    expect(
      await db.selectFrom("files").selectAll().execute(),
    ).toHaveLength(SEED.length + 3);
  });

  it("is resumable: a page-limited run returns a cursor the next run continues from", async () => {
    const { db, bucket } = await setup();

    const first = await scanExternalAptlyBucket(db, bucket, { pageSize: 2, pageLimit: 1 });
    expect(first.complete).toBe(false);
    expect(first.resumeFrom).not.toBeNull();

    let resume = first.resumeFrom;
    let last = first;
    while (!last.complete) {
      expect(resume).not.toBeNull();
      last = await scanExternalAptlyBucket(db, bucket, {
        pageSize: 2,
        pageLimit: 1,
        resumeFrom: resume!,
      });
      resume = last.resumeFrom;
    }
    expect(last.missingFiles).toBe(0);

    const files = await db.selectFrom("files").selectAll().execute();
    expect(files).toHaveLength(SEED.length);
    expect(files.every((f) => f.state === "present")).toBe(true);
  });

  it("a re-scan does not clobber verification results", async () => {
    const { db, bucket } = await setup();
    await scanExternalAptlyBucket(db, bucket);

    // Simulate the verify workflow having hashed one object.
    await db
      .updateTable("blobs")
      .set({
        sha256: "a".repeat(64),
        verify_status: "ok",
        verified_at: "2026-09-01T00:00:00.000Z",
      })
      .where("r2_key", "=", "ubuntu/dists/jammy/InRelease")
      .execute();

    await scanExternalAptlyBucket(db, bucket);
    const blob = await db
      .selectFrom("blobs")
      .selectAll()
      .where("r2_key", "=", "ubuntu/dists/jammy/InRelease")
      .executeTakeFirstOrThrow();
    expect(blob.sha256).toBe("a".repeat(64));
    expect(blob.verify_status).toBe("ok");
    expect(blob.verified_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("voids verification when an object's size changes under the same key", async () => {
    const { db, bucket } = await setup();
    await scanExternalAptlyBucket(db, bucket);

    // Simulate the verify workflow having hashed one object.
    await db
      .updateTable("blobs")
      .set({
        sha256: "c".repeat(64),
        verify_status: "ok",
        verified_at: "2026-09-01T00:00:00.000Z",
      })
      .where("r2_key", "=", "ros/dists/noetic/Release")
      .execute();

    // The object is replaced with different bytes under the same key.
    await seed("ros/dists/noetic/Release", 7777);
    await scanExternalAptlyBucket(db, bucket);

    const blob = await db
      .selectFrom("blobs")
      .selectAll()
      .where("r2_key", "=", "ros/dists/noetic/Release")
      .executeTakeFirstOrThrow();
    expect(blob.size).toBe(7777);
    // The verified bytes are gone: the stored hash must not keep claiming
    // to describe the object.
    expect(blob.verify_status).toBe("unverified");
    expect(blob.sha256).toBeNull();
    expect(blob.verified_at).toBeNull();
  });

  it("rejects a resume cursor for an unknown prefix", async () => {
    const { db, bucket } = await setup();
    await expect(
      scanExternalAptlyBucket(db, bucket, {
        resumeFrom: { prefix: "nope/" },
      }),
    ).rejects.toThrow(/not in the scan prefix list/);
  });
});
