import { describe, expect, it } from "vitest";
import { contentRangeHeader, parseRangeHeader, resolveRange } from "@server/lib/cache/range";

describe("parseRangeHeader", () => {
  it("parses start-end", () => {
    expect(parseRangeHeader("bytes=0-1023")).toEqual({ kind: "offset", offset: 0, length: 1024 });
  });

  it("parses open-ended ranges", () => {
    expect(parseRangeHeader("bytes=1024-")).toEqual({ kind: "offset", offset: 1024, length: undefined });
  });

  it("parses suffix ranges", () => {
    expect(parseRangeHeader("bytes=-500")).toEqual({ kind: "suffix", suffix: 500 });
  });

  it("flags multi-range requests for rejection", () => {
    expect(parseRangeHeader("bytes=1-2,5-6").kind).toBe("multi");
  });

  it("ignores absent, non-bytes, and malformed headers", () => {
    expect(parseRangeHeader(null).kind).toBe("none");
    expect(parseRangeHeader("items=0-10").kind).toBe("none");
    expect(parseRangeHeader("bytes=abc-def").kind).toBe("none");
    expect(parseRangeHeader("bytes=10-5").kind).toBe("none");
    expect(parseRangeHeader("bytes=-").kind).toBe("none");
  });
});

describe("resolveRange", () => {
  it("clamps end beyond the object size", () => {
    expect(resolveRange({ kind: "offset", offset: 0, length: 2000 }, 1000))
      .toEqual({ offset: 0, length: 1000 });
  });

  it("resolves open-ended ranges to the object end", () => {
    expect(resolveRange({ kind: "offset", offset: 100 }, 1000))
      .toEqual({ offset: 100, length: 900 });
  });

  it("resolves suffix ranges", () => {
    expect(resolveRange({ kind: "suffix", suffix: 100 }, 1000)).toEqual({ offset: 900, length: 100 });
    expect(resolveRange({ kind: "suffix", suffix: 5000 }, 1000)).toEqual({ offset: 0, length: 1000 });
  });

  it("rejects unsatisfiable ranges", () => {
    expect(resolveRange({ kind: "offset", offset: 1000 }, 1000)).toBeNull();
    expect(resolveRange({ kind: "suffix", suffix: 0 }, 1000)).toBeNull();
  });
});

describe("contentRangeHeader", () => {
  it("formats Content-Range", () => {
    expect(contentRangeHeader({ offset: 0, length: 1024 }, 5000)).toBe("bytes 0-1023/5000");
  });
});
