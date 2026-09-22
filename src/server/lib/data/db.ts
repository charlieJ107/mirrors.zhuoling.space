import { Kysely } from "kysely";
import { D1Dialect } from "@server/lib/data/kysely-d1";
import type { Database } from "@server/lib/data/schema";

/**
 * Kysely instance over the D1 `DB` binding for the storage-foundation tables.
 * Mirrors how better-auth consumes the D1 dialect in platforms/cloudflare.ts.
 */
export function createDb(database: D1Database): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new D1Dialect({ database }),
  });
}
