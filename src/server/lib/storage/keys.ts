/**
 * R2 object key derivation for the CAS write path (docs/02-architecture.md §2.4, ADR-2).
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Content-addressed key for a managed blob: `objects/{sha256[:2]}/{sha256}`.
 * The two-hex-char shard keeps per-prefix object counts low for list operations.
 */
export function casKey(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new Error(`Invalid sha256 for CAS key: expected 64 lowercase hex chars, got ${JSON.stringify(sha256)}`);
  }
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Key for an in-flight upload whose sha256 is not known yet: `tmp/{uuid}`.
 * Orphaned tmp objects are swept by the gc workflow.
 */
export function tmpKey(uuid: string = crypto.randomUUID()): string {
  return `tmp/${uuid}`;
}
