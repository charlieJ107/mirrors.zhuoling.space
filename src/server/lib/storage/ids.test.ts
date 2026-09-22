import { describe, it, expect } from "vitest";
import {
  newId,
  newBlobId,
  newFileId,
  newJobId,
  newSourceId,
  newSourceTokenId,
} from "@server/lib/storage/ids";

describe("newId", () => {
  it("formats as {prefix}_{12 base32 chars}", () => {
    expect(newId("s")).toMatch(/^s_[a-z2-7]{12}$/);
  });

  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("s")));
    expect(ids.size).toBe(1000);
  });

  it("provides per-table factories", () => {
    expect(newSourceId()).toMatch(/^s_/);
    expect(newSourceTokenId()).toMatch(/^tok_/);
    expect(newFileId()).toMatch(/^f_/);
    expect(newBlobId()).toMatch(/^b_/);
    expect(newJobId()).toMatch(/^j_/);
  });
});
