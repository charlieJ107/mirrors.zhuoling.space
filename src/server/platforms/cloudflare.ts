import { D1Dialect } from "@server/lib/data/kysely-d1";
import { createDb } from "@server/lib/data/db";
import { createMirrorStore } from "@server/lib/cache/store";
import { createAuth, createAuthOptions } from "@server/lib/auth";
import { UnsupportedObjectStorage } from "@server/lib/blob";
import type { R2BucketLike } from "@server/lib/cache/r2-types";
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
    mirror: {
      store: createMirrorStore(createDb(env.DB)),
      // R2Bucket's overloaded `get` is not structurally assignable to the
      // narrower R2BucketLike; the subset the data plane uses is compatible.
      buckets: {
        "mirror-hot": env.MIRROR_HOT as R2BucketLike,
        "mirror-cold": env.MIRROR_COLD as R2BucketLike,
        "robot-apt": env.ROBOT_APT as R2BucketLike,
      },
      hotBucketName: "mirror-hot",
      analytics: env.MIRROR_ANALYTICS,
    },
  };
}

function createAppConfigFromCloudflare(env: Env): AppConfig {
  const optionalEnv = env as Env & { BETTER_AUTH_ALLOWED_HOSTS?: string };

  return {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_ALLOWED_HOSTS: optionalEnv.BETTER_AUTH_ALLOWED_HOSTS ?? "",
  };
}
