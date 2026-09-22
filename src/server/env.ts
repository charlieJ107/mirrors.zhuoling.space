import type { betterAuth } from "better-auth";
import type { MirrorStore } from "@server/lib/cache/cas";
import type { AnalyticsEngineLike, R2BucketLike } from "@server/lib/cache/r2-types";

export type AppConfig = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_ALLOWED_HOSTS: string;
  NODE_ENV?: string;
};

export interface ObjectStorage {
  get(key: string): Promise<ReadableStream | null>;
  put(key: string, body: ReadableStream | Blob | ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Bindings the `/s/*` lazy data plane needs (Cloudflare runtime only). */
export interface MirrorRuntime {
  store: MirrorStore;
  /** Bucket bindings keyed by bucket name (blobs.bucket stores the name). */
  buckets: Record<string, R2BucketLike>;
  /** Bucket name where new lazy ingests land (docs/02-architecture.md §2.5). */
  hotBucketName: string;
  analytics: AnalyticsEngineLike | null;
}

export type AppRuntime = {
  config: AppConfig;
  auth: ReturnType<typeof betterAuth>;
  blob: ObjectStorage;
  /** Absent on runtimes without the mirror bindings (Node); /s/* then returns 501. */
  mirror?: MirrorRuntime;
};

export type AppVariables = {
  app: AppRuntime;
};

export type AppHonoEnv = {
  Variables: AppVariables;
};
