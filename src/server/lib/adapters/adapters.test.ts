import { describe, expect, it } from "vitest";
import { aptAdapter } from "@server/lib/adapters/apt";
import { staticAdapter } from "@server/lib/adapters/static";
import { getAdapter } from "@server/lib/adapters";
import { integrityFromHeaders, joinUpstreamUrl } from "@server/lib/adapters/types";

describe("aptAdapter.classifyPath", () => {
  it("treats by-hash/SHA256 paths as immutable", () => {
    const sha = "a".repeat(64);
    expect(aptAdapter.classifyPath(`dists/bionic/main/binary-amd64/by-hash/SHA256/${sha}`)).toBe("immutable");
  });

  it("treats pool/** and package files as immutable", () => {
    expect(aptAdapter.classifyPath("pool/main/r/ros/ros.deb")).toBe("immutable");
    expect(aptAdapter.classifyPath("pool/main/h/hello/hello_1.0_amd64.udeb")).toBe("immutable");
    expect(aptAdapter.classifyPath("some/dir/package_1.0.dsc")).toBe("immutable");
  });

  it("treats repository metadata as mutable", () => {
    expect(aptAdapter.classifyPath("dists/bionic/Release")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/InRelease")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/Release.gpg")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/main/binary-amd64/Packages")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/main/binary-amd64/Packages.xz")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/main/source/Sources.gz")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/main/i18n/Translation-en.xz")).toBe("mutable");
    expect(aptAdapter.classifyPath("dists/bionic/Contents-amd64.gz")).toBe("mutable");
  });

  it("falls back to passthrough for unknown paths", () => {
    expect(aptAdapter.classifyPath("dists/bionic/")).toBe("passthrough");
    expect(aptAdapter.classifyPath("random/file.bin")).toBe("passthrough");
    expect(aptAdapter.classifyPath("dists/bionic/main/binary-amd64/Packages.diff/Index")).toBe("passthrough");
  });
});

describe("aptAdapter.extractIntegrity", () => {
  it("derives the expected sha256 from by-hash paths", () => {
    const sha = "b".repeat(64);
    const result = aptAdapter.extractIntegrity(`dists/x/by-hash/SHA256/${sha}`, new Headers());
    expect(result).toEqual({ algorithm: "sha256", digest: sha });
  });

  it("returns null when nothing is checkable", () => {
    expect(aptAdapter.extractIntegrity("pool/main/x.deb", new Headers())).toBeNull();
  });
});

describe("staticAdapter.classifyPath", () => {
  it("treats obvious index names as mutable", () => {
    expect(staticAdapter.classifyPath("index.html")).toBe("mutable");
    expect(staticAdapter.classifyPath("releases/22.04/SHA256SUMS")).toBe("mutable");
    expect(staticAdapter.classifyPath("dir/index.json")).toBe("mutable");
  });

  it("treats everything else as immutable", () => {
    expect(staticAdapter.classifyPath("releases/22.04/ubuntu.iso")).toBe("immutable");
    expect(staticAdapter.classifyPath("data/archive.tar.gz")).toBe("immutable");
  });
});

describe("getAdapter", () => {
  it("returns built-in adapters by name", () => {
    expect(getAdapter("apt").name).toBe("apt");
    expect(getAdapter("static").name).toBe("static");
  });

  it("falls back to static for adapters without a built-in yet", () => {
    expect(getAdapter("conda").name).toBe("static");
    expect(getAdapter("pypi").name).toBe("static");
  });
});

describe("joinUpstreamUrl", () => {
  it("joins base and path with exactly one slash", () => {
    expect(joinUpstreamUrl("https://mirror.example.com/apt/", "pool/x.deb"))
      .toBe("https://mirror.example.com/apt/pool/x.deb");
    expect(joinUpstreamUrl("https://mirror.example.com/apt", "pool/x.deb"))
      .toBe("https://mirror.example.com/apt/pool/x.deb");
  });

  it("preserves percent-encoding untouched (ADR-2)", () => {
    expect(joinUpstreamUrl("https://m.example.com", "dir/libc%2B%2B.deb"))
      .toBe("https://m.example.com/dir/libc%2B%2B.deb");
  });
});

describe("integrityFromHeaders", () => {
  it("reads x-checksum-sha256", () => {
    const sha = "c".repeat(64);
    const headers = new Headers({ "x-checksum-sha256": sha.toUpperCase() });
    expect(integrityFromHeaders(headers)).toEqual({ algorithm: "sha256", digest: sha });
  });

  it("parses RFC 9530 Digest: sha-256=:<base64>:", () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const headers = new Headers({ digest: "sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:" });
    expect(integrityFromHeaders(headers)).toEqual({
      algorithm: "sha256",
      digest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("returns null for missing or malformed digests", () => {
    expect(integrityFromHeaders(new Headers())).toBeNull();
    expect(integrityFromHeaders(new Headers({ "x-checksum-sha256": "not-hex" }))).toBeNull();
  });
});
