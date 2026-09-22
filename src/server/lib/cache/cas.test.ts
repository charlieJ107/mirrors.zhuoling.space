import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { finalizeCasBlob, planCasAction } from "@server/lib/cache/cas";
import { casKey } from "@server/lib/storage/keys";
import { FakeR2Bucket, InMemoryMirrorStore, bytes } from "@server/lib/cache/testing";
import type { BlobsTable } from "@server/lib/data/schema";

const NOW = "2026-09-22T00:00:00.000Z";

function existingBlob(overrides: Partial<BlobsTable> = {}): BlobsTable {
  return {
    id: "b_existing",
    sha256: "a".repeat(64),
    bucket: "mirror-hot",
    r2_key: casKey("a".repeat(64)),
    size: 10,
    refcount: 1,
    tier: "hot",
    status: "active",
    fetched_at: NOW,
    verified_at: NOW,
    verify_status: "ok",
    last_access_at: NOW,
    access_count: 0,
    ...overrides,
  };
}

describe("planCasAction", () => {
  it("reuses an existing blob", () => {
    const blob = existingBlob();
    expect(planCasAction(blob, blob.sha256!)).toEqual({ action: "reuse", blob });
  });

  it("places new content at its CAS key", () => {
    const sha = "b".repeat(64);
    expect(planCasAction(null, sha)).toEqual({ action: "place", key: casKey(sha) });
  });
});

describe("finalizeCasBlob", () => {
  it("deduplicates: deletes tmp, bumps refcount, stores nothing new", async () => {
    const store = new InMemoryMirrorStore();
    const bucket = new FakeR2Bucket();
    const data = bytes("duplicate content");
    const sha = createHash("sha256").update(data).digest("hex");
    const blob = existingBlob({ sha256: sha, r2_key: casKey(sha) });
    store.blobs.set(blob.id, blob);
    bucket.objects.set("tmp/dup", data);

    const result = await finalizeCasBlob(store, bucket, "mirror-hot", {
      tmpKey: "tmp/dup",
      sha256: sha,
      size: data.byteLength,
      verifyStatus: "unverified",
      now: NOW,
    });

    expect(result.deduplicated).toBe(true);
    expect(result.blob.id).toBe(blob.id);
    expect(bucket.objects.has("tmp/dup")).toBe(false);
    expect(store.blobs.size).toBe(1);
    expect(store.blobs.get(blob.id)!.refcount).toBe(2);
  });

  it("places new content: copies tmp to the CAS key, deletes tmp, inserts the row", async () => {
    const store = new InMemoryMirrorStore();
    const bucket = new FakeR2Bucket();
    const data = bytes("brand new content");
    const sha = createHash("sha256").update(data).digest("hex");
    bucket.objects.set("tmp/new", data);

    const result = await finalizeCasBlob(store, bucket, "mirror-hot", {
      tmpKey: "tmp/new",
      sha256: sha,
      size: data.byteLength,
      verifyStatus: "ok",
      now: NOW,
    });

    expect(result.deduplicated).toBe(false);
    expect(bucket.objects.get(casKey(sha))).toEqual(data);
    expect(bucket.objects.has("tmp/new")).toBe(false);
    const row = store.blobs.get(result.blob.id)!;
    expect(row.sha256).toBe(sha);
    expect(row.r2_key).toBe(casKey(sha));
    expect(row.refcount).toBe(1);
    expect(row.verify_status).toBe("ok");
    expect(row.verified_at).toBe(NOW);
  });

  it("records unverified blobs without a verified_at timestamp", async () => {
    const store = new InMemoryMirrorStore();
    const bucket = new FakeR2Bucket();
    const data = bytes("unchecked");
    const sha = createHash("sha256").update(data).digest("hex");
    bucket.objects.set("tmp/unv", data);

    const result = await finalizeCasBlob(store, bucket, "mirror-hot", {
      tmpKey: "tmp/unv",
      sha256: sha,
      size: data.byteLength,
      verifyStatus: "unverified",
      now: NOW,
    });

    expect(result.blob.verify_status).toBe("unverified");
    expect(result.blob.verified_at).toBeNull();
  });

  it("throws when the tmp object is missing", async () => {
    const store = new InMemoryMirrorStore();
    const bucket = new FakeR2Bucket();
    await expect(
      finalizeCasBlob(store, bucket, "mirror-hot", {
        tmpKey: "tmp/gone",
        sha256: "c".repeat(64),
        size: 1,
        verifyStatus: "unverified",
        now: NOW,
      }),
    ).rejects.toThrow(/source object missing/);
  });
});

describe("file pointer updates (InMemoryMirrorStore semantics)", () => {
  it("switches the pointer and releases the old blob", async () => {
    const store = new InMemoryMirrorStore();
    const oldBlob = existingBlob({ id: "b_old", refcount: 1 });
    const newBlob = existingBlob({ id: "b_new", refcount: 1, sha256: "d".repeat(64) });
    store.blobs.set(oldBlob.id, oldBlob);
    store.blobs.set(newBlob.id, newBlob);
    store.files.set("f_1", {
      id: "f_1",
      source_id: "s_1",
      path: "dists/x/Release",
      current_blob_id: oldBlob.id,
      state: "present",
      upstream_etag: '"old"',
      upstream_last_modified: null,
      pinned: 0,
      created_at: NOW,
      updated_at: NOW,
    });

    await store.upsertFileAfterIngest({
      sourceId: "s_1",
      path: "dists/x/Release",
      blobId: newBlob.id,
      etag: '"new"',
      lastModified: null,
      now: NOW,
    });

    const file = await store.getFile("s_1", "dists/x/Release");
    expect(file!.current_blob_id).toBe(newBlob.id);
    expect(file!.upstream_etag).toBe('"new"');
    expect(store.blobs.get(oldBlob.id)!.refcount).toBe(0);
    expect(store.blobs.get(oldBlob.id)!.status).toBe("orphaned");
  });

  it("keeps refcount balanced when revalidation lands on the same blob", async () => {
    const store = new InMemoryMirrorStore();
    const blob = existingBlob({ refcount: 2 }); // 1 original file + 1 fresh acquire
    store.blobs.set(blob.id, blob);
    store.files.set("f_1", {
      id: "f_1",
      source_id: "s_1",
      path: "dists/x/Release",
      current_blob_id: blob.id,
      state: "present",
      upstream_etag: '"same"',
      upstream_last_modified: null,
      pinned: 0,
      created_at: NOW,
      updated_at: NOW,
    });

    await store.upsertFileAfterIngest({
      sourceId: "s_1",
      path: "dists/x/Release",
      blobId: blob.id,
      etag: '"same"',
      lastModified: null,
      now: NOW,
    });

    expect(store.blobs.get(blob.id)!.refcount).toBe(1);
    expect((await store.getFile("s_1", "dists/x/Release"))!.current_blob_id).toBe(blob.id);
  });
});
