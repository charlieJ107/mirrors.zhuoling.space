import { aptAdapter } from "./apt";
import { staticAdapter } from "./static";
import type { MirrorAdapter } from "./types";
import type { SourceAdapter } from "@server/lib/data/schema";

/**
 * Built-in adapter registry (ADR-4). conda/pypi land with their own issues;
 * they fall back to `static` classification until then so a source row with
 * those adapters still gets sane caching behavior.
 */
const ADAPTERS: Partial<Record<SourceAdapter, MirrorAdapter>> = {
  apt: aptAdapter,
  static: staticAdapter,
};

export function getAdapter(name: SourceAdapter | string): MirrorAdapter {
  return ADAPTERS[name as SourceAdapter] ?? staticAdapter;
}

export { aptAdapter, staticAdapter };
export type { IntegrityExpectation, MirrorAdapter, PathClass } from "./types";
