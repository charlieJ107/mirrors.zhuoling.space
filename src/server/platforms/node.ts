import { Pool } from "pg";
import { createAuth, createAuthOptions } from "@server/lib/auth";
import { UnsupportedObjectStorage } from "@server/lib/blob";
import type { AppConfig, AppRuntime } from "@server/env";

let cachedRuntime: AppRuntime | undefined;

export function createAppRuntimeFromNode(): AppRuntime {
  if (cachedRuntime) return cachedRuntime;

  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
  });
  const config = createAppConfigFromNode();

  cachedRuntime = {
    config,
    auth: createAuth(createAuthOptions(pool, config)),
    blob: new UnsupportedObjectStorage(),
  };

  return cachedRuntime;
}

function createAppConfigFromNode(): AppConfig {
  return {
    BETTER_AUTH_SECRET: requireEnv("BETTER_AUTH_SECRET"),
    BETTER_AUTH_URL: requireEnv("BETTER_AUTH_URL"),
    BETTER_AUTH_ALLOWED_HOSTS: process.env.BETTER_AUTH_ALLOWED_HOSTS ?? "",
    BETTER_AUTH_OIDC_CLIENT_ID: requireEnv("BETTER_AUTH_OIDC_CLIENT_ID"),
    BETTER_AUTH_OIDC_CLIENT_SECRET: requireEnv("BETTER_AUTH_OIDC_CLIENT_SECRET"),
    BETTER_AUTH_OIDC_DISCOVERY_URL: process.env.BETTER_AUTH_OIDC_DISCOVERY_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
