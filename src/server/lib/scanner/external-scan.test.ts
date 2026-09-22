import { describe, it, expect } from "vitest";
import { createTestDb } from "@server/lib/data/test-db";
import {
  ensureExternalAptlySource,
  EXTERNAL_APTLY_BUCKET,
  EXTERNAL_APTLY_SOURCE_ID,
} from "@server/lib/sources/external";
import { scanExternalAptlyBucket } from "@server/lib/scanner/external-scan";

/** In-memory R2Bucket fake implementing R2 list() pagination semantics. */
class FakeR2Bucket {
  private objects = new Map<
    string,
    { size: number; etag: string; uploaded: Date }
  >();
  listCalls: Array<{ prefix?: string; cursor?: string; limit?: number }> = [];

  seed(
    key: string,
    size: number,
    etag = `etag-${key}`,
    uploaded = new Date("2026-01-01T00:00:00.000Z"),
  ) {
    this.objects.set(key, { size, etag, uploaded });
  }

  remove(key: string) {
    this.objects.delete(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    this.listCalls.push({
      prefix: options?.prefix,
      cursor: options?.cursor,
      limit: options?.limit,
    });
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const pageKeys = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: pageKeys.map(
        (key) => ({ key, ...this.objects.get(key)! }) as unknown as R2Object,
      ),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  }
}

const SEED: Array<[string, number]> = [
  ["ros/dists/noetic/Release", 1200],
  ["ros/pool/main/r/pkg/pkg_1.0_amd64.deb", 54321],
  ["ubuntu/dists/jammy/InRelease", 3400],
  ["blobs/sha256/ab/abcdef0123", 999],
];

async function setup() {
  const db = createTestDb();
  await ensureExternalAptlySource(db);
  const bucket = new FakeR2Bucket();
  for (const [key, size] of SEED) bucket.seed(key, size);
  return { db, bucket };
}

describe("scanExternalAptlyBucket", () => {
  it("materializes files/blobs rows for objects under the aptly prefixes", async () => {
    const { db, bucket } = await setup();

    const result = await scanExternalAptlyBucket(db, bucket as unknown as R2Bucket, {
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });

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
      expect(file.upstream_etag).toBe(`etag-${file.path}`);
      expect(file.upstream_last_modified).toBe("2026-01-01T00:00:00.000Z");
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
      const seed = SEED.find(([k]) => k === blob.r2_key);
      expect(seed).toBeDefined();
      expect(blob.size).toBe(seed![1]);
    }

    // files -> blobs mapping resolves to the real r2_key.
    for (const file of files) {
      const blob = blobs.find((b) => b.id === file.current_blob_id);
      expect(blob?.r2_key).toBe(file.path);
    }
  });

  it("ignores objects outside the aptly prefixes", async () => {
    const { db, bucket } = await setup();
    bucket.seed("other/random-object", 1);

    const result = await scanExternalAptlyBucket(db, bucket as unknown as R2Bucket);
    expect(result.listedObjects).toBe(SEED.length);
    const files = await db.selectFrom("files").selectAll().execute();
    expect(files).toHaveLength(SEED.length);
  });

  it("is idempotent: re-running updates in place without duplicating rows", async () => {
    const { db, bucket } = await setup();
    const b = bucket as unknown as R2Bucket;

    const first = await scanExternalAptlyBucket(db, b);
    const fileIdsBefore = (
      await db.selectFrom("files").select("id").execute()
    ).map((r) => r.id);
    const blobIdsBefore = (
      await db.selectFrom("blobs").select("id").execute()
    ).map((r) => r.id);

    const second = await scanExternalAptlyBucket(db, b);
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
    const b = bucket as unknown as R2Bucket;
    await scanExternalAptlyBucket(db, b);

    bucket.remove("ros/pool/main/r/pkg/pkg_1.0_amd64.deb");
    const second = await scanExternalAptlyBucket(db, b);
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
    bucket.seed("ros/pool/main/r/pkg/pkg_1.0_amd64.deb", 54321);
    const third = await scanExternalAptlyBucket(db, b);
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
    bucket.seed("ros/extra-1", 1);
    bucket.seed("ros/extra-2", 2);
    bucket.seed("ros/extra-3", 3);

    const result = await scanExternalAptlyBucket(db, bucket as unknown as R2Bucket, {
      pageSize: 2,
    });
    expect(result.complete).toBe(true);
    // ros/ has 5 objects -> 3 pages; ubuntu/ 1 object -> 1 page; blobs/ 1 -> 1 page.
    expect(result.listPages).toBe(5);
    const rosCalls = bucket.listCalls.filter((c) => c.prefix === "ros/");
    expect(rosCalls).toHaveLength(3);
    expect(rosCalls.every((c) => c.limit === 2)).toBe(true);
    expect(rosCalls[1].cursor).toBeDefined();
    expect(
      await db.selectFrom("files").selectAll().execute(),
    ).toHaveLength(SEED.length + 3);
  });

  it("is resumable: a page-limited run returns a cursor the next run continues from", async () => {
    const { db, bucket } = await setup();
    const b = bucket as unknown as R2Bucket;

    const first = await scanExternalAptlyBucket(db, b, { pageSize: 2, pageLimit: 1 });
    expect(first.complete).toBe(false);
    expect(first.resumeFrom).not.toBeNull();

    let resume = first.resumeFrom;
    let last = first;
    while (!last.complete) {
      expect(resume).not.toBeNull();
      last = await scanExternalAptlyBucket(db, b, {
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
    const b = bucket as unknown as R2Bucket;
    await scanExternalAptlyBucket(db, b);

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

    await scanExternalAptlyBucket(db, b);
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
    const b = bucket as unknown as R2Bucket;
    await scanExternalAptlyBucket(db, b);

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
    bucket.seed("ros/dists/noetic/Release", 7777);
    await scanExternalAptlyBucket(db, b);

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
      scanExternalAptlyBucket(db, bucket as unknown as R2Bucket, {
        resumeFrom: { prefix: "nope/" },
      }),
    ).rejects.toThrow(/not in the scan prefix list/);
  });
});
