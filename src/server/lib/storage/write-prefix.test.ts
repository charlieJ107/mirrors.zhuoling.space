import { describe, it, expect } from "vitest";
import { isWriteAllowed, normalizeWritePrefix } from "@server/lib/storage/write-prefix";

describe("normalizeWritePrefix", () => {
  it("keeps the empty prefix empty (writes disabled)", () => {
    expect(normalizeWritePrefix("")).toBe("");
  });

  it("strips leading slashes and ensures a trailing slash", () => {
    expect(normalizeWritePrefix("pool")).toBe("pool/");
    expect(normalizeWritePrefix("/pool/main")).toBe("pool/main/");
    expect(normalizeWritePrefix("pool/")).toBe("pool/");
  });

  it("rejects invalid prefixes", () => {
    expect(normalizeWritePrefix("../x")).toBeNull();
    expect(normalizeWritePrefix("a\nb")).toBeNull();
  });
});

describe("isWriteAllowed", () => {
  it("allows targets inside the declared prefix", () => {
    expect(isWriteAllowed("pool", "pool/main/pkg_1.0.deb")).toBe(true);
    expect(isWriteAllowed("pool/", "pool/x")).toBe(true);
    expect(isWriteAllowed("/pool", "pool/x")).toBe(true);
  });

  it("rejects targets outside the prefix", () => {
    expect(isWriteAllowed("pool", "dists/jammy/Release")).toBe(false);
  });

  it("does not match on segment boundary confusion", () => {
    expect(isWriteAllowed("pool", "pool2/x")).toBe(false);
  });

  it("rejects targets that escape via `..`", () => {
    expect(isWriteAllowed("pool", "pool/../dists/Release")).toBe(false);
  });

  it("rejects invalid target keys", () => {
    expect(isWriteAllowed("pool", "")).toBe(false);
    expect(isWriteAllowed("pool", "pool/a\0b")).toBe(false);
  });

  it("an empty write_prefix disables all writes", () => {
    expect(isWriteAllowed("", "anything/at.all")).toBe(false);
  });

  it("keeps the external aptly prefixes ros/, ubuntu/, blobs/ read-only (ADR-10)", () => {
    // The robot-apt source is mounted with write_prefix = "" (read-only).
    for (const key of [
      "ros/dists/noetic/Release",
      "ubuntu/dists/jammy/InRelease",
      "blobs/sha256/ab/abcdef",
    ]) {
      expect(isWriteAllowed("", key)).toBe(false);
    }
    // A source with a narrower prefix still cannot write to those trees.
    for (const key of ["ros/x", "ubuntu/x", "blobs/x"]) {
      expect(isWriteAllowed("staging", key)).toBe(false);
    }
    expect(isWriteAllowed("staging", "staging/x")).toBe(true);
  });
});
