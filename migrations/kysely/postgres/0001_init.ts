import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("emailVerified", "integer", (col) => col.notNull())
    .addColumn("image", "text")
    .addColumn("createdAt", "date", (col) => col.notNull())
    .addColumn("updatedAt", "date", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("session")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("expiresAt", "date", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("createdAt", "date", (col) => col.notNull())
    .addColumn("updatedAt", "date", (col) => col.notNull())
    .addColumn("ipAddress", "text")
    .addColumn("userAgent", "text")
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("cascade").notNull(),
    )
    .execute();

  await db.schema
    .createTable("account")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("accountId", "text", (col) => col.notNull())
    .addColumn("providerId", "text", (col) => col.notNull())
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("cascade").notNull(),
    )
    .addColumn("accessToken", "text")
    .addColumn("refreshToken", "text")
    .addColumn("idToken", "text")
    .addColumn("accessTokenExpiresAt", "date")
    .addColumn("refreshTokenExpiresAt", "date")
    .addColumn("scope", "text")
    .addColumn("password", "text")
    .addColumn("createdAt", "date", (col) => col.notNull())
    .addColumn("updatedAt", "date", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("verification")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("identifier", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("expiresAt", "date", (col) => col.notNull())
    .addColumn("createdAt", "date", (col) => col.notNull())
    .addColumn("updatedAt", "date", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("session_userId_idx")
    .ifNotExists()
    .on("session")
    .column("userId")
    .execute();

  await db.schema
    .createIndex("account_userId_idx")
    .ifNotExists()
    .on("account")
    .column("userId")
    .execute();

  await db.schema
    .createIndex("verification_identifier_idx")
    .ifNotExists()
    .on("verification")
    .column("identifier")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("verification_identifier_idx").ifExists().execute();
  await db.schema.dropIndex("account_userId_idx").ifExists().execute();
  await db.schema.dropIndex("session_userId_idx").ifExists().execute();
  await db.schema.dropTable("verification").ifExists().execute();
  await db.schema.dropTable("account").ifExists().execute();
  await db.schema.dropTable("session").ifExists().execute();
  await db.schema.dropTable("user").ifExists().execute();
}
