-- Migration number: 0002
-- Storage foundation per docs/02-architecture.md §2.3 and docs/03-adr.md ADR-2/ADR-10:
-- logical file -> physical blob mapping with content-addressed (CAS) blobs.
-- Timestamps are ISO 8601 strings; booleans are 0/1 integers.

create table "sources" (
    "id" text not null primary key,
    "name" text not null,
    "adapter" text not null check ("adapter" in ('apt', 'conda', 'pypi', 'static')),
    "mode" text not null check ("mode" in ('lazy', 'pinned', 'external-pinned')),
    "base_url" text,
    "allow_insecure_http" integer not null default 0,
    "write_prefix" text not null default '',
    "access_level" text not null default 'public' check ("access_level" in ('public', 'token')),
    "noindex" integer not null default 1,
    "daily_bytes_cap" integer,
    "status" text not null default 'active' check ("status" in ('active', 'disabled')),
    "created_at" date not null,
    "updated_at" date not null
);

-- blobs before files: files.current_blob_id references blobs.id.
create table "blobs" (
    "id" text not null primary key,
    "sha256" text unique,
    "bucket" text not null,
    "r2_key" text not null,
    "size" integer not null,
    "refcount" integer not null default 0,
    "tier" text not null check ("tier" in ('hot', 'cold', 'external')),
    "status" text not null default 'active' check ("status" in ('active', 'orphaned', 'pending-deletion')),
    "fetched_at" date,
    "verified_at" date,
    "verify_status" text not null default 'unverified' check ("verify_status" in ('ok', 'failed', 'unverified')),
    "last_access_at" date,
    "access_count" integer not null default 0
);
create index "blobs_status_idx" on "blobs" ("status");
create index "blobs_tier_idx" on "blobs" ("tier");

create table "source_tokens" (
    "id" text not null primary key,
    "source_id" text not null references "sources" ("id") on delete cascade,
    "token_hash" text not null,
    "label" text,
    "created_at" date not null,
    "revoked_at" date
);
create unique index "source_tokens_token_hash_idx" on "source_tokens" ("token_hash");
create index "source_tokens_source_id_idx" on "source_tokens" ("source_id");

create table "files" (
    "id" text not null primary key,
    "source_id" text not null references "sources" ("id") on delete cascade,
    "path" text not null,
    "current_blob_id" text references "blobs" ("id") on delete set null,
    "state" text not null default 'present' check ("state" in ('present', 'missing')),
    "upstream_etag" text,
    "upstream_last_modified" text,
    "pinned" integer not null default 0,
    "created_at" date not null,
    "updated_at" date not null,
    unique ("source_id", "path")
);
create index "files_current_blob_id_idx" on "files" ("current_blob_id");

create table "jobs" (
    "id" text not null primary key,
    "type" text not null check ("type" in ('ingest', 'verify', 'tier', 'gc')),
    "source_id" text references "sources" ("id") on delete set null,
    "workflow_instance_id" text,
    "status" text not null default 'queued',
    "progress_json" text,
    "created_at" date not null,
    "finished_at" date
);
create index "jobs_source_id_idx" on "jobs" ("source_id");
create index "jobs_status_idx" on "jobs" ("status");
