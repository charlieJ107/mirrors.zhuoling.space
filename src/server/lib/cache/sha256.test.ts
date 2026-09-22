import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StreamingSha256 } from "@server/lib/cache/sha256";

function reference(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("StreamingSha256", () => {
  it("matches known vectors", () => {
    const h = new StreamingSha256();
    h.update(new TextEncoder().encode("abc"));
    expect(h.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("handles empty input", () => {
    expect(new StreamingSha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches node:crypto across awkward chunk boundaries", () => {
    const data = new Uint8Array(1_000_003).map((_, i) => i % 251);
    for (const chunkSize of [1, 63, 64, 65, 1000, 64 * 64 + 7]) {
      const hh = new StreamingSha256();
      for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
        hh.update(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)));
      }
      expect(hh.digestHex()).toBe(reference(data));
    }
  });
});
