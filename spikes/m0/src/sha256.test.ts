// THROWAWAY spike code (issue #1, M0). Not product code.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it("matches node:crypto one-shot digest over a chunked stream", async () => {
    const data = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    const expected = createHash("sha256").update(data).digest("hex");

    const chunkSize = 64 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let off = 0; off < data.length; off += chunkSize) {
          controller.enqueue(data.subarray(off, off + chunkSize));
        }
        controller.close();
      },
    });
    const { hex, bytes } = await sha256Hex(stream);
    expect(hex).toBe(expected);
    expect(bytes).toBe(data.length);
  });

  it("handles an empty stream", async () => {
    const { hex, bytes } = await sha256Hex(new ReadableStream({
      start: (c) => c.close(),
    }));
    expect(bytes).toBe(0);
    expect(hex).toBe(createHash("sha256").digest("hex"));
  });
});
