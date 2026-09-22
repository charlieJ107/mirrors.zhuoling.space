import type { R2RangeOptions } from "./r2-types";

/**
 * Range header parsing (docs/02-architecture.md §2.8). Single ranges map to
 * the R2 binding range API; multi-range requests are rejected outright (apt
 * and browsers never need them); malformed headers are ignored per RFC 9110.
 */

export type ParsedRange =
  | { kind: "none" }
  | { kind: "offset"; offset: number; length?: number }
  | { kind: "suffix"; suffix: number }
  | { kind: "multi" };

export interface ResolvedRange {
  offset: number;
  length: number;
}

const SPEC = /^(\d+)-(\d*)$/;

export function parseRangeHeader(header: string | null): ParsedRange {
  if (!header) return { kind: "none" };
  const match = /^bytes=(.+)$/.exec(header.trim());
  if (!match) return { kind: "none" };
  const spec = match[1];
  if (spec.includes(",")) return { kind: "multi" };

  if (spec.startsWith("-")) {
    const suffix = Number(spec.slice(1));
    if (!Number.isSafeInteger(suffix) || spec.slice(1) === "") return { kind: "none" };
    return { kind: "suffix", suffix };
  }

  const m = SPEC.exec(spec);
  if (!m) return { kind: "none" };
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return { kind: "none" };
  if (m[2] === "") {
    return { kind: "offset", offset: start };
  }
  const end = Number(m[2]);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "none" };
  return { kind: "offset", offset: start, length: end - start + 1 };
}

/**
 * Clamp a parsed range against the object size.
 * Returns null when the range is unsatisfiable (caller responds 416).
 */
export function resolveRange(range: ParsedRange, size: number): ResolvedRange | null {
  if (range.kind === "suffix") {
    if (range.suffix <= 0) return null;
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  if (range.kind === "offset") {
    if (range.offset >= size) return null;
    const length = Math.min(range.length ?? size - range.offset, size - range.offset);
    return { offset: range.offset, length };
  }
  return null;
}

export function toR2Range(resolved: ResolvedRange): R2RangeOptions {
  return { offset: resolved.offset, length: resolved.length };
}

export function contentRangeHeader(resolved: ResolvedRange, size: number): string {
  return `bytes ${resolved.offset}-${resolved.offset + resolved.length - 1}/${size}`;
}
