import { normalizeR2Key } from "@server/lib/storage/r2-key";

/**
 * Write-prefix allowlist (docs/02-architecture.md §2.2, ADR-10 decision 5).
 *
 * A write target is allowed only if it falls inside the source's declared
 * `write_prefix`. An empty prefix disables writes entirely (safe default), so
 * a source mounted over the external aptly bucket — where `ros/`, `ubuntu/`
 * and `blobs/` must stay read-only — rejects every write in code.
 */

/**
 * Canonical form of a write prefix: relative, trailing `/`, or empty.
 * Returns null when the prefix itself is not a valid key fragment.
 */
export function normalizeWritePrefix(prefix: string): string | null {
  if (prefix === "") return "";
  const result = normalizeR2Key(prefix);
  if (!result.ok) return null;
  return result.key.endsWith("/") ? result.key : `${result.key}/`;
}

export function isWriteAllowed(writePrefix: string, targetKey: string): boolean {
  const prefix = normalizeWritePrefix(writePrefix);
  if (prefix === null || prefix === "") {
    return false;
  }
  const target = normalizeR2Key(targetKey);
  if (!target.ok) {
    return false;
  }
  return target.key.startsWith(prefix);
}
