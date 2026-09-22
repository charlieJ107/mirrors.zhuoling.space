/**
 * Adapter abstraction (docs/03-adr.md ADR-4): pure functions only, no IO.
 * Adapters classify upstream-relative paths and extract integrity
 * expectations; the mirror route performs all network/storage work.
 */

export type PathClass = "immutable" | "mutable" | "passthrough";

export interface IntegrityExpectation {
  algorithm: "sha256";
  /** Lowercase hex digest. */
  digest: string;
}

export interface MirrorAdapter {
  readonly name: string;
  /** Cache strategy for an upstream-relative path (docs/02-architecture.md §2.7). */
  classifyPath(path: string): PathClass;
  /** Upstream URL = registered base_url + path suffix (ADR-6: never from request params). */
  buildUpstreamUrl(baseUrl: string, path: string): string;
  /**
   * Digest the upstream content can be checked against, when one is
   * derivable from the path (apt by-hash) or response headers.
   * NULL means the blob lands as verify_status='unverified' (ADR-7).
   */
  extractIntegrity(path: string, responseHeaders: Headers): IntegrityExpectation | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Join base_url and path without any percent-decode/re-encode (ADR-2). */
export function joinUpstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return suffix.length === 0 ? base : `${base}/${suffix}`;
}

/**
 * Checkable sha256 from common upstream response headers:
 * `X-Checksum-Sha256` (hex) and RFC 9530 `Digest: sha-256=:<base64>:`.
 */
export function integrityFromHeaders(headers: Headers): IntegrityExpectation | null {
  const hex = headers.get("x-checksum-sha256")?.trim();
  if (hex && SHA256_HEX.test(hex)) {
    return { algorithm: "sha256", digest: hex.toLowerCase() };
  }

  const digestHeader = headers.get("digest");
  if (digestHeader) {
    const match = /sha-256=:([A-Za-z0-9+/=]+):/i.exec(digestHeader);
    if (match) {
      try {
        const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
        if (bytes.length === 32) {
          const digest = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
          return { algorithm: "sha256", digest };
        }
      } catch {
        // Malformed base64: treat as no usable digest.
      }
    }
  }
  return null;
}
