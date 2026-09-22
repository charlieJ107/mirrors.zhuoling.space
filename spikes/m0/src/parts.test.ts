// THROWAWAY spike code (issue #1, M0). Not product code.
import { describe, expect, it } from "vitest";
import {
  MAX_PARTS,
  MIN_PART_SIZE,
  pickPartSize,
  planParts,
} from "./parts";

describe("planParts", () => {
  it("splits into uniform parts with a smaller last part", () => {
    const MiB = 1024 * 1024;
    const parts = planParts(3 * 64 * MiB + 12345, 64 * MiB);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({
      partNumber: 1,
      start: 0,
      end: 64 * MiB - 1,
      size: 64 * MiB,
    });
    expect(parts[3].size).toBe(12345);
    expect(parts[3].start).toBe(3 * 64 * MiB);
    // Contiguous, non-overlapping coverage of the whole object.
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].start).toBe(parts[i - 1].end + 1);
    }
    expect(parts.at(-1)!.end).toBe(3 * 64 * MiB + 12345 - 1);
  });

  it("handles an exact multiple of the part size", () => {
    const MiB = 1024 * 1024;
    const parts = planParts(2 * 64 * MiB, 64 * MiB);
    expect(parts).toHaveLength(2);
    expect(parts[1].size).toBe(64 * MiB);
  });

  it("rejects part sizes below the 5MiB R2 minimum", () => {
    expect(() => planParts(100 * 1024 * 1024, MIN_PART_SIZE - 1)).toThrow(
      /partSize/,
    );
  });

  it("rejects plans exceeding 10,000 parts", () => {
    const MiB = 1024 * 1024;
    expect(() => planParts((MAX_PARTS + 1) * MIN_PART_SIZE, MIN_PART_SIZE)).toThrow(
      /10_?000|10000/,
    );
    // 6 GiB at 64 MiB = 96 parts: fine (the M0 Ubuntu ISO case).
    expect(planParts(6 * 1024 * MiB, 64 * MiB)).toHaveLength(96);
  });
});

describe("pickPartSize", () => {
  it("keeps the preferred size when it fits", () => {
    const MiB = 1024 * 1024;
    expect(pickPartSize(6 * 1024 * MiB, 64 * MiB)).toBe(64 * MiB);
  });

  it("grows the part size to stay under the part cap", () => {
    const MiB = 1024 * 1024;
    const twoTiB = 2 * 1024 * 1024 * MiB;
    const size = pickPartSize(twoTiB, 64 * MiB); // 32768 parts at 64MiB > cap
    expect(Math.ceil(twoTiB / size)).toBeLessThanOrEqual(MAX_PARTS);
    expect(size).toBeGreaterThan(64 * MiB);
  });
});
