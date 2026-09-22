/**
 * Kysely table types for the storage foundation.
 * Mirrors migrations/d1/0002_storage_foundation.sql (docs/02-architecture.md §2.3).
 *
 * Conventions: timestamps are ISO 8601 strings, booleans are 0/1 integers.
 */

export type SourceAdapter = "apt" | "conda" | "pypi" | "static";
export type SourceMode = "lazy" | "pinned" | "external-pinned";
export type SourceAccessLevel = "public" | "token";
export type SourceStatus = "active" | "disabled";

export type FileState = "present" | "missing";

export type BlobTier = "hot" | "cold" | "external";
export type BlobStatus = "active" | "orphaned" | "pending-deletion";
export type BlobVerifyStatus = "ok" | "failed" | "unverified";

export type JobType = "ingest" | "verify" | "tier" | "gc";

export interface SourcesTable {
  /** Short random id, e.g. `s_x7q2...` (see lib/storage/ids.ts). */
  id: string;
  name: string;
  adapter: SourceAdapter;
  mode: SourceMode;
  /** Upstream base URL. NULL for external-pinned sources (bucket mounts). */
  base_url: string | null;
  /** 0/1. Must be 1 to register an http:// base_url. */
  allow_insecure_http: number;
  /** Only writes under this prefix are allowed; empty string disables writes. */
  write_prefix: string;
  access_level: SourceAccessLevel;
  /** 0/1. */
  noindex: number;
  /** Per-day served-bytes hard cap; NULL = unlimited. */
  daily_bytes_cap: number | null;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
}

export interface SourceTokensTable {
  id: string;
  source_id: string;
  /** Hash of the bearer token; the plaintext token is never stored. */
  token_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface FilesTable {
  id: string;
  source_id: string;
  /** Upstream-relative path; UNIQUE(source_id, path). */
  path: string;
  /** NULL until the content has been fetched/materialized. */
  current_blob_id: string | null;
  state: FileState;
  upstream_etag: string | null;
  /** Raw HTTP Last-Modified header value. */
  upstream_last_modified: string | null;
  /** 0/1. */
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface BlobsTable {
  id: string;
  /** NULL for external blobs until first verification. UNIQUE. */
  sha256: string | null;
  bucket: string;
  /** Managed blobs: `objects/{sha256[:2]}/{sha256}`. External blobs: real key. */
  r2_key: string;
  size: number;
  refcount: number;
  tier: BlobTier;
  status: BlobStatus;
  fetched_at: string | null;
  verified_at: string | null;
  verify_status: BlobVerifyStatus;
  last_access_at: string | null;
  access_count: number;
}

export interface JobsTable {
  id: string;
  type: JobType;
  source_id: string | null;
  workflow_instance_id: string | null;
  /** Workflow instance status plus terminal app states; free-form on purpose. */
  status: string;
  /** JSON-serialized progress payload written back by workflow steps. */
  progress_json: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Database {
  sources: SourcesTable;
  source_tokens: SourceTokensTable;
  files: FilesTable;
  blobs: BlobsTable;
  jobs: JobsTable;
}
