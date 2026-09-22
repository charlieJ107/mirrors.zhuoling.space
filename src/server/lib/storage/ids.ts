/**
 * Short random primary keys, e.g. `s_x7q2kz81m4np` (docs/02-architecture.md §2.3).
 *
 * Base32 alphabet: 256 % 32 === 0, so `getRandomValues` bytes map uniformly
 * with no modulo bias. 12 chars = 60 bits of entropy.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 12;

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let suffix = "";
  for (const byte of bytes) {
    suffix += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

export const newSourceId = (): string => newId("s");
export const newSourceTokenId = (): string => newId("tok");
export const newFileId = (): string => newId("f");
export const newBlobId = (): string => newId("b");
export const newJobId = (): string => newId("j");
