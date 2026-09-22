import { betterAuth, type BetterAuthOptions } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import type { AppConfig } from "@server/env";

export const OIDC_PROVIDER_ID = "zhuoling";

export const DEFAULT_OIDC_DISCOVERY_URL =
  "https://auth.zhuoling.space/.well-known/openid-configuration";

/**
 * Shared options for Better Auth used by both:
 * - Runtime (Worker): src/server/platforms/cloudflare.ts with D1
 * - CLI (generate/migrate): better-auth.config.ts with local SQLite
 *
 * Only `database` and runtime env (secret, baseURL) differ; the rest stays in sync here.
 *
 * The console authenticates exclusively via OIDC against auth.zhuoling.space
 * (ADR-5). Local email/password credentials are disabled: identity is owned by
 * the identity provider, and accounts are provisioned on first OIDC sign-in.
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
      enabled: false,
    },
    advanced: {
      database: {
        // Runtime schema validation introspects sqlite_master, which D1
        // rejects (SQLITE_AUTH). Schema correctness is enforced by the
        // migrations instead.
        validateSchema: false,
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            clientId: config.BETTER_AUTH_OIDC_CLIENT_ID,
            clientSecret: config.BETTER_AUTH_OIDC_CLIENT_SECRET,
            discoveryUrl:
              config.BETTER_AUTH_OIDC_DISCOVERY_URL?.trim() || DEFAULT_OIDC_DISCOVERY_URL,
            scopes: ["openid", "profile", "email"],
            // Keep the local profile in sync with the identity provider.
            overrideUserInfo: true,
          },
        ],
      }),
    ],
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
