import {
  integrityFromHeaders,
  joinUpstreamUrl,
  type IntegrityExpectation,
  type MirrorAdapter,
  type PathClass,
} from "./types";

/**
 * static adapter (docs/02-architecture.md §2.7): for plain file trees
 * (ISO mirrors, release downloads). Everything is immutable except obvious
 * index / listing names, which are revalidated on every request.
 */
const MUTABLE_BASENAME =
  /^(?:index\.(?:html?|json|txt)|(?:sha-?1|sha-?256|sha-?512|md5)sums(?:\.txt)?|manifest\.json)$/i;

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export const staticAdapter: MirrorAdapter = {
  name: "static",

  classifyPath(path: string): PathClass {
    return MUTABLE_BASENAME.test(basename(path)) ? "mutable" : "immutable";
  },

  buildUpstreamUrl: joinUpstreamUrl,

  extractIntegrity(_path: string, responseHeaders: Headers): IntegrityExpectation | null {
    return integrityFromHeaders(responseHeaders);
  },
};
