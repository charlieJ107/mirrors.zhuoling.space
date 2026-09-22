/**
 * CLI-only Better Auth config for `npx auth@latest generate --config better-auth.config.ts`.
 * Uses local SQLite (better-sqlite3) because the Worker auth instance depends on runtime env (D1)
 * and cannot be exported for the CLI. Options are kept in sync with the runtime via createAuthOptions.
 *
 * After generating schema, apply it to D1 with wrangler (see README).
 */
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { createAuthOptions } from "@server/lib/auth";

const cliDatabase = new Database(".auth-schema.sqlite");
const auth = betterAuth(
    createAuthOptions(cliDatabase, {
        BETTER_AUTH_SECRET: "cli-placeholder-for-schema-generation",
        BETTER_AUTH_URL: "http://localhost:8787",
        BETTER_AUTH_ALLOWED_HOSTS: "",
    })
);

export { auth };
export default auth;
