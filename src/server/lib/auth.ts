import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { AppConfig } from "@server/env";


/**
 * Shared options for Better Auth used by both:
 * - Runtime (Worker): src/server/platforms/cloudflare.ts with D1
 * - CLI (generate/migrate): better-auth.config.ts with local SQLite
 *
 * Only `database` and runtime env (secret, baseURL) differ; the rest stays in sync here.
 */
export function createAuthOptions(
  database: BetterAuthOptions["database"],
  config: AppConfig,
): BetterAuthOptions {
  return {
    secret: config.BETTER_AUTH_SECRET,
    baseURL: {
      allowedHosts: getAllowedHosts(config),
      protocol: "https",
      fallback: new URL(config.BETTER_AUTH_URL).origin,
    },
    database,
    emailAndPassword: {
      enabled: true,
    },
  } satisfies BetterAuthOptions;
}

function getAllowedHosts(config: AppConfig): string[] {
  const configuredHosts = config.BETTER_AUTH_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0) ?? [];

  return Array.from(new Set([
    new URL(config.BETTER_AUTH_URL).host,
    ...configuredHosts,
  ]));
}

export function createAuth(authOptions: BetterAuthOptions): ReturnType<typeof betterAuth> {
  return betterAuth(authOptions);
}

export type AuthInstance = ReturnType<typeof createAuth>;
export type AuthSession = AuthInstance["$Infer"]["Session"];
