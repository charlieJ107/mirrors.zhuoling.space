import { D1Dialect } from "@server/lib/data/kysely-d1";
import { createAuth, createAuthOptions } from "@server/lib/auth";
import { UnsupportedObjectStorage } from "@server/lib/blob";
import type { AppConfig, AppRuntime } from "@server/env";

export function createAppRuntimeFromCloudflare(env: Env): AppRuntime {
  const config = createAppConfigFromCloudflare(env);
  const auth = createAuth(
    createAuthOptions(
      {
        dialect: new D1Dialect({ database: env.DB }),
        type: "sqlite",
        transaction: false,
      },
      config,
    ),
  );

  return {
    config,
    auth,
    blob: new UnsupportedObjectStorage(),
  };
}

function createAppConfigFromCloudflare(env: Env): AppConfig {
  const optionalEnv = env as Env & {
    BETTER_AUTH_ALLOWED_HOSTS?: string;
    BETTER_AUTH_OIDC_DISCOVERY_URL?: string;
  };

  return {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_ALLOWED_HOSTS: optionalEnv.BETTER_AUTH_ALLOWED_HOSTS ?? "",
    BETTER_AUTH_OIDC_CLIENT_ID: env.BETTER_AUTH_OIDC_CLIENT_ID,
    BETTER_AUTH_OIDC_CLIENT_SECRET: env.BETTER_AUTH_OIDC_CLIENT_SECRET,
    BETTER_AUTH_OIDC_DISCOVERY_URL: optionalEnv.BETTER_AUTH_OIDC_DISCOVERY_URL,
  };
}
