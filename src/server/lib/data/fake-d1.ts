import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";

/**
 * Test-only local D1 emulation: wraps `node:sqlite` in the minimal
 * `D1Database` surface that the Kysely D1 dialect consumes
 * (`prepare(sql).bind(...params).all()`), with the real D1 migrations
 * applied. Lets storage-layer tests run under plain `vitest run` without a
 * wrangler/miniflare harness.
 */

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../../migrations/d1");

const READ_RE = /^\s*(select|with|pragma|explain)\b/i;

class FakeD1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, this.sql, values) as unknown as D1PreparedStatement;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const params = this.params.map((p) =>
      p === undefined ? null : (p as never),
    );
    if (READ_RE.test(this.sql)) {
      const results = stmt.all(...params) as T[];
      return {
        success: true,
        results,
        meta: { changes: 0, last_row_id: 0 },
      } as unknown as D1Result<T>;
    }
    const info = stmt.run(...params);
    return {
      success: true,
      results: [] as T[],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    } as unknown as D1Result<T>;
  }
}

class FakeD1Database {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string): D1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, sql) as unknown as D1PreparedStatement;
  }
}

/**
 * An in-memory `D1Database` with every migration in migrations/d1 applied
 * (in filename order).
 */
export function createFakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  return new FakeD1Database(db) as unknown as D1Database;
}
