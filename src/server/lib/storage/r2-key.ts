/**
 * R2 key normalization per ADR-2:
 * - no percent-decode / re-encode (avoids `%2F` vs `/` ambiguity);
 * - case is preserved (R2 keys are case-sensitive);
 * - `..` path segments and ASCII control characters are rejected;
 * - keys are relative (leading `/` stripped) and capped at 1024 bytes.
 */

export const R2_KEY_MAX_BYTES = 1024;

export type NormalizeR2KeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: string };

function fail(reason: string): NormalizeR2KeyResult {
  return { ok: false, reason };
}

export function normalizeR2Key(input: string): NormalizeR2KeyResult {
  if (typeof input !== "string" || input.length === 0) {
    return fail("key is empty");
  }

  // Strip leading slashes: keys are bucket-relative, never absolute.
  let key = input;
  while (key.startsWith("/")) {
    key = key.slice(1);
  }
  if (key.length === 0) {
    return fail("key is empty");
  }

  // Reject ASCII control chars (0x00-0x1F, 0x7F). Everything else, including
  // literal `%` sequences and non-ASCII UTF-8, passes through untouched.
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return fail(`key contains a control character at index ${i}`);
    }
  }

  // Reject `..` segments to prevent escaping a source's namespace.
  if (key.split("/").some((segment) => segment === "..")) {
    return fail("key contains a `..` path segment");
  }

  if (new TextEncoder().encode(key).byteLength > R2_KEY_MAX_BYTES) {
    return fail(`key exceeds ${R2_KEY_MAX_BYTES} bytes`);
  }

  return { ok: true, key };
}
