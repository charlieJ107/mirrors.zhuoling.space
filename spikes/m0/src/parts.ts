/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * Pure multipart part planning: uniform part size except the last part,
 * enforcing the R2 limits verified in docs/01-platform-limits.md
 * (part 5MiB-5GiB, max 10_000 parts).
 */

export const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
export const MAX_PARTS = 10_000;

export interface PartPlan {
  partNumber: number; // 1-based, as R2 expects
  start: number; // inclusive byte offset
  end: number; // inclusive byte offset
  size: number;
}

export function planParts(
  totalSize: number,
  partSize: number,
): PartPlan[] {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new Error(`invalid totalSize: ${totalSize}`);
  }
  if (
    !Number.isSafeInteger(partSize) ||
    partSize < MIN_PART_SIZE ||
    partSize > MAX_PART_SIZE
  ) {
    throw new Error(
      `partSize must be within [${MIN_PART_SIZE}, ${MAX_PART_SIZE}], got ${partSize}`,
    );
  }
  const count = Math.ceil(totalSize / partSize);
  if (count > MAX_PARTS) {
    throw new Error(
      `object of ${totalSize} bytes needs ${count} parts of ${partSize} bytes; ` +
        `exceeds the ${MAX_PARTS}-part limit, increase part size`,
    );
  }
  const parts: PartPlan[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, totalSize) - 1;
    parts.push({ partNumber: i + 1, start, end, size: end - start + 1 });
  }
  return parts;
}

/** Smallest legal uniform part size that keeps the object under the part cap. */
export function pickPartSize(totalSize: number, preferred: number): number {
  if (Math.ceil(totalSize / preferred) <= MAX_PARTS) return preferred;
  const needed = Math.ceil(totalSize / MAX_PARTS);
  if (needed > MAX_PART_SIZE) {
    throw new Error(`object of ${totalSize} bytes exceeds R2 multipart maximum`);
  }
  return needed;
}
