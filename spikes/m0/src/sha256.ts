/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * Streaming SHA-256 over a web ReadableStream. Uses node:crypto (available
 * in Workers via nodejs_compat) because WebCrypto has no incremental digest.
 */

import { createHash } from "node:crypto";

export async function sha256Hex(
  stream: ReadableStream<Uint8Array>,
): Promise<{ hex: string; bytes: number }> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    bytes += value.byteLength;
  }
  return { hex: hash.digest("hex"), bytes };
}
