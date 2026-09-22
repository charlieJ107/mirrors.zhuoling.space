import type { betterAuth } from "better-auth";

export type AppConfig = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_ALLOWED_HOSTS: string;
  BETTER_AUTH_OIDC_CLIENT_ID: string;
  BETTER_AUTH_OIDC_CLIENT_SECRET: string;
  /** Optional; defaults to the auth.zhuoling.space discovery document. */
  BETTER_AUTH_OIDC_DISCOVERY_URL?: string;
  NODE_ENV?: string;
};

export interface ObjectStorage {
  get(key: string): Promise<ReadableStream | null>;
  put(key: string, body: ReadableStream | Blob | ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AppRuntime = {
  config: AppConfig;
  auth: ReturnType<typeof betterAuth>;
  blob: ObjectStorage;
};

export type AppVariables = {
  app: AppRuntime;
};

export type AppHonoEnv = {
  Variables: AppVariables;
};
