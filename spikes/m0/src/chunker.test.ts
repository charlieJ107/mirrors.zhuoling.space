// THROWAWAY spike code (issue #1, M0). Not product code.
import { describe, expect, it } from "vitest";
import { PartChunker } from "./chunker";

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("PartChunker", () => {
  it("emits a part exactly when enough bytes arrive", () => {
    const c = new PartChunker(10);
    expect(c.push(bytes(4, 1))).toHaveLength(0);
    expect(c.push(bytes(6, 2))).toHaveLength(1);
    expect(c.bufferedBytes).toBe(0);
    expect(c.flush()).toBeNull();
  });

  it("splits oversized chunks across part boundaries, preserving order", () => {
    const c = new PartChunker(4);
    const out = c.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    expect(out).toHaveLength(1);
    expect([...out[0]]).toEqual([1, 2, 3, 4]);
    const rest = c.flush();
    expect(rest && [...rest]).toEqual([5, 6, 7]);
  });

  it("assembles parts from many small chunks", () => {
    const c = new PartChunker(3);
    const parts: number[][] = [];
    for (const b of [1, 2, 3, 4, 5, 6, 7]) {
      for (const p of c.push(new Uint8Array([b]))) parts.push([...p]);
    }
    expect(parts).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(c.flush()).toEqual(new Uint8Array([7]));
  });

  it("never holds more than one part plus the current chunk", () => {
    const partSize = 32 * 1024 * 1024;
    const c = new PartChunker(partSize);
    // Simulate 64KiB stream chunks: buffered stays below 2x part size.
    for (let i = 0; i < 5000; i++) {
      c.push(bytes(64 * 1024, 7));
      expect(c.bufferedBytes).toBeLessThan(partSize + 64 * 1024);
    }
  });
});
