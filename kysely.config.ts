import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "kysely-ctl";
import { Pool } from "pg";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Missing required environment variable: DATABASE_URL");
}

export default defineConfig({
  dialect: "pg",
  dialectConfig: {
    pool: new Pool({
      connectionString: databaseUrl,
    }),
  },
  migrations: {
    migrationFolder: "migrations/kysely/postgres",
  },
});
