// THROWAWAY spike code (issue #1, M0). Not product code.
import { describe, expect, it } from "vitest";
import {
  REGISTRY_PREFIX,
  selectStaleUploads,
  sweepStaleUploads,
  type MultipartUploadInfo,
  type SweepBucket,
} from "./sweep";

const up = (
  key: string,
  uploadId: string,
  initiatedAt: number,
): MultipartUploadInfo => ({ key, uploadId, initiatedAt });

describe("selectStaleUploads", () => {
  const now = 1_000_000;
  it("aborts only uploads matching both key prefix and age", () => {
    const uploads = [
      up("iso/ubuntu.iso", "a", now - 10_000), // stale, matching
      up("iso/fedora.iso", "b", now - 500), // fresh
      up("other/x.iso", "c", now - 10_000), // stale, wrong prefix
    ];
    const { abort, keep } = selectStaleUploads(uploads, {
      keyPrefix: "iso/",
      olderThanMs: 5_000,
      now,
    });
    expect(abort.map((u) => u.uploadId)).toEqual(["a"]);
    expect(keep.map((u) => u.uploadId)).toEqual(["b", "c"]);
  });

  it("with no key prefix, aborts everything stale", () => {
    const { abort } = selectStaleUploads(
      [up("a", "1", 0), up("b", "2", 1_000_000)],
      { olderThanMs: 5_000, now: 1_000_000 },
    );
    expect(abort.map((u) => u.uploadId)).toEqual(["1"]);
  });
});

function fakeBucket(markers: Record<string, MultipartUploadInfo>) {
  const aborted: string[] = [];
  const deleted: string[] = [];
  const bucket: SweepBucket = {
    async list() {
      return {
        objects: Object.keys(markers).map((uploadId) => ({
          key: REGISTRY_PREFIX + uploadId,
        })),
        truncated: false,
      };
    },
    async get(key: string) {
      const m = markers[key.slice(REGISTRY_PREFIX.length)];
      return m ? { text: async () => JSON.stringify(m) } : null;
    },
    async delete(keys: string | string[]) {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return {
        async abort() {
          aborted.push(`${key}:${uploadId}`);
        },
      };
    },
  };
  return { bucket, aborted, deleted };
}

describe("sweepStaleUploads", () => {
  it("aborts stale uploads and removes their markers", async () => {
    const now = 1_000_000;
    const markers: Record<string, MultipartUploadInfo> = {
      "id-stale": up("iso/ubuntu.iso", "id-stale", now - 60_000),
      "id-fresh": up("iso/fedora.iso", "id-fresh", now),
    };
    const { bucket, aborted, deleted } = fakeBucket(markers);
    const res = await sweepStaleUploads(bucket, {
      olderThanMs: 5_000,
      now,
    });
    expect(res.errors).toEqual([]);
    expect(res.aborted.map((u) => u.uploadId)).toEqual(["id-stale"]);
    expect(aborted).toEqual(["iso/ubuntu.iso:id-stale"]);
    expect(deleted).toEqual([REGISTRY_PREFIX + "id-stale"]);
  });
});
