import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "@server/lib/data/schema";

/**
 * Test-only database helper: a real `Kysely<Database>` over an in-memory
 * better-sqlite3 database via Kysely's official `SqliteDialect`, with the
 * real migrations from migrations/d1 applied in filename order.
 *
 * Dialect split: production runs Kysely's D1 dialect (`createDb`) against
 * the D1 binding; unit tests run Kysely's SqliteDialect here. Same query
 * builder, same generated SQL — but D1-specific runtime quirks are not
 * covered by unit tests, which is why the `wrangler dev` integration smoke
 * remains part of the validation evidence.
 */

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../../migrations/d1");

/** In-memory better-sqlite3 database with every D1 migration applied. */
export function createTestSqlite(): BetterSqlite3.Database {
  const sqlite = new BetterSqlite3(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return sqlite;
}

export function createTestDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: createTestSqlite() }),
  });
}
