import {
  integrityFromHeaders,
  joinUpstreamUrl,
  type IntegrityExpectation,
  type MirrorAdapter,
  type PathClass,
} from "./types";

/**
 * apt adapter (docs/02-architecture.md §2.7):
 * - immutable: `dists/.../by-hash/SHA256|SHA512/<hex>`, `pool/**`, package files
 *   (`.deb`/`.udeb`/`.dsc`) — content-addressed or never-modified artifacts.
 * - mutable: repository metadata (`Release`, `InRelease`, `Release.gpg`,
 *   `Packages.*`, `Sources.*`, `Translation-*`, `Contents-*`) — revalidate
 *   upstream on every request, serve stale when upstream is unreachable.
 * - everything else: passthrough (never cached).
 *
 * by-hash paths are immutable by construction: the filename IS the sha256 of
 * the content, so `extractIntegrity` can verify them byte-for-byte.
 */

const BY_HASH_SHA256 = /(?:^|\/)by-hash\/SHA256\/([0-9a-f]{64})$/;
const BY_HASH_ANY = /(?:^|\/)by-hash\/SHA(?:256|512)\/[0-9a-f]+$/;

const IMMUTABLE: RegExp[] = [
  BY_HASH_ANY,
  /^pool\//,
  /\.(?:deb|udeb|dsc)$/,
];

const COMPRESSED_INDEX = String.raw`(?:\.(?:gz|xz|bz2|lz4|zst))?`;
const MUTABLE: RegExp[] = [
  /(?:^|\/)(?:InRelease|Release|Release\.gpg)$/,
  new RegExp(String.raw`(?:^|\/)Packages${COMPRESSED_INDEX}$`),
  new RegExp(String.raw`(?:^|\/)Sources${COMPRESSED_INDEX}$`),
  new RegExp(String.raw`(?:^|\/)Translation-[^/]+${COMPRESSED_INDEX}$`),
  new RegExp(String.raw`(?:^|\/)Contents-[^/]+${COMPRESSED_INDEX}$`),
];

export const aptAdapter: MirrorAdapter = {
  name: "apt",

  classifyPath(path: string): PathClass {
    if (IMMUTABLE.some((re) => re.test(path))) return "immutable";
    if (MUTABLE.some((re) => re.test(path))) return "mutable";
    return "passthrough";
  },

  buildUpstreamUrl: joinUpstreamUrl,

  extractIntegrity(path: string, responseHeaders: Headers): IntegrityExpectation | null {
    const byHash = BY_HASH_SHA256.exec(path);
    if (byHash) {
      return { algorithm: "sha256", digest: byHash[1] };
    }
    return integrityFromHeaders(responseHeaders);
  },
};
