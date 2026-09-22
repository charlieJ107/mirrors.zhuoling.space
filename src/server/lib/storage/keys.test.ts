import { describe, it, expect } from "vitest";
import { casKey, tmpKey } from "@server/lib/storage/keys";

const SHA = "a".repeat(64);

describe("casKey", () => {
  it("derives objects/{first2}/{sha256}", () => {
    expect(casKey(SHA)).toBe(`objects/aa/${SHA}`);
  });

  it("shards on the first two hex chars", () => {
    const sha = `f3${"0".repeat(62)}`;
    expect(casKey(sha)).toBe(`objects/f3/${sha}`);
  });

  it("rejects invalid sha256 values", () => {
    expect(() => casKey("abc")).toThrow(/Invalid sha256/);
    expect(() => casKey("A".repeat(64))).toThrow(/Invalid sha256/);
    expect(() => casKey("")).toThrow(/Invalid sha256/);
  });
});

describe("tmpKey", () => {
  it("derives tmp/{uuid}", () => {
    expect(tmpKey("0190-uuid")).toBe("tmp/0190-uuid");
  });

  it("generates a uuid when omitted", () => {
    expect(tmpKey()).toMatch(
      /^tmp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
