/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * PartChunker accumulates arbitrary stream chunks and emits fixed-size part
 * bodies (for the no-Range sequential fallback path). Peak extra memory is
 * one part size plus the unconsumed remainder of the current input chunk.
 */

export class PartChunker {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private readonly partSize: number;

  constructor(partSize: number) {
    this.partSize = partSize;
  }

  /** Feed a chunk; returns zero or more complete part bodies. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    const out: Uint8Array[] = [];
    while (this.buffered >= this.partSize) {
      out.push(this.take(this.partSize));
    }
    return out;
  }

  /** Final partial part body, or null if nothing is buffered. */
  flush(): Uint8Array | null {
    return this.buffered > 0 ? this.take(this.buffered) : null;
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  private take(n: number): Uint8Array {
    const buf = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const need = n - offset;
      if (head.byteLength <= need) {
        buf.set(head, offset);
        offset += head.byteLength;
        this.chunks.shift();
      } else {
        buf.set(head.subarray(0, need), offset);
        this.chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    this.buffered -= n;
    return buf;
  }
}
