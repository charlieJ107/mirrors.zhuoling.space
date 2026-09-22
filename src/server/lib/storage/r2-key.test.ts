import { describe, it, expect } from "vitest";
import { normalizeR2Key, R2_KEY_MAX_BYTES } from "@server/lib/storage/r2-key";

describe("normalizeR2Key", () => {
  it("passes ordinary keys through unchanged", () => {
    const result = normalizeR2Key("pool/main/a/apt/pkg_1.0_amd64.deb");
    expect(result).toEqual({ ok: true, key: "pool/main/a/apt/pkg_1.0_amd64.deb" });
  });

  it("strips leading slashes so keys stay bucket-relative", () => {
    expect(normalizeR2Key("/dists/jammy/Release")).toEqual({
      ok: true,
      key: "dists/jammy/Release",
    });
    expect(normalizeR2Key("///a")).toEqual({ ok: true, key: "a" });
  });

  it("does not percent-decode or re-encode", () => {
    const result = normalizeR2Key("simple/flask%2Fnested/index.html");
    expect(result).toEqual({ ok: true, key: "simple/flask%2Fnested/index.html" });
  });

  it("preserves case", () => {
    const result = normalizeR2Key("Dists/Jammy/RELEASE");
    expect(result).toEqual({ ok: true, key: "Dists/Jammy/RELEASE" });
  });

  it("rejects `..` segments", () => {
    for (const key of ["../escape", "a/../../b", "a/..", ".."]) {
      expect(normalizeR2Key(key)).toMatchObject({ ok: false });
    }
  });

  it("allows segments that merely contain dots", () => {
    expect(normalizeR2Key("a/.../b")).toMatchObject({ ok: true });
    expect(normalizeR2Key("pkg_1.0..2.deb")).toMatchObject({ ok: true });
  });

  it("rejects control characters", () => {
    expect(normalizeR2Key("a\0b")).toMatchObject({ ok: false });
    expect(normalizeR2Key("a\nb")).toMatchObject({ ok: false });
    expect(normalizeR2Key("a\tb")).toMatchObject({ ok: false });
    expect(normalizeR2Key("a\x7fb")).toMatchObject({ ok: false });
  });

  it("rejects empty keys", () => {
    expect(normalizeR2Key("")).toMatchObject({ ok: false });
    expect(normalizeR2Key("///")).toMatchObject({ ok: false });
  });

  it("caps keys at 1024 bytes (UTF-8)", () => {
    expect(normalizeR2Key("a".repeat(R2_KEY_MAX_BYTES))).toMatchObject({ ok: true });
    expect(normalizeR2Key("a".repeat(R2_KEY_MAX_BYTES + 1))).toMatchObject({ ok: false });
    // Multi-byte characters count towards the byte limit, not the char limit.
    expect(normalizeR2Key("é".repeat(R2_KEY_MAX_BYTES / 2))).toMatchObject({ ok: true });
    expect(normalizeR2Key("é".repeat(R2_KEY_MAX_BYTES))).toMatchObject({ ok: false });
  });
});
