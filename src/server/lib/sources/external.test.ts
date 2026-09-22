import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createDb } from "@server/lib/data/db";
import {
  ensureExternalAptlySource,
  EXTERNAL_APTLY_PREFIXES,
  EXTERNAL_APTLY_SOURCE_ID,
} from "@server/lib/sources/external";
import { isWriteAllowed } from "@server/lib/storage/write-prefix";
import { resetStorage } from "@server/lib/testing/reset-storage";

// Runs in the workers pool: env.DB is a real D1 binding (local emulation)
// with the migrations from migrations/d1 applied (see vitest.workers.config.ts).

beforeEach(resetStorage);

function setup() {
  return createDb(env.DB);
}

describe("ensureExternalAptlySource", () => {
  it("creates the aptly source row with the external-pinned invariants", async () => {
    const db = setup();
    const source = await ensureExternalAptlySource(db, new Date("2026-09-22T00:00:00Z"));

    expect(source.id).toBe(EXTERNAL_APTLY_SOURCE_ID);
    expect(source.adapter).toBe("apt");
    expect(source.mode).toBe("external-pinned");
    expect(source.base_url).toBeNull();
    expect(source.write_prefix).toBe("");
    expect(source.status).toBe("active");
    expect(source.created_at).toBe("2026-09-22T00:00:00.000Z");
  });

  it("is idempotent: re-running keeps the same row and never duplicates", async () => {
    const db = setup();
    await ensureExternalAptlySource(db);
    await ensureExternalAptlySource(db);
    const again = await ensureExternalAptlySource(db);

    const rows = await db.selectFrom("sources").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(again.id).toBe(EXTERNAL_APTLY_SOURCE_ID);
  });

  it("re-asserts the read-only invariants if the row was tampered with", async () => {
    const db = setup();
    await ensureExternalAptlySource(db);
    await db
      .updateTable("sources")
      .set({ write_prefix: "ros/", mode: "pinned", base_url: "https://evil.example" })
      .where("id", "=", EXTERNAL_APTLY_SOURCE_ID)
      .execute();

    const source = await ensureExternalAptlySource(db);
    expect(source.write_prefix).toBe("");
    expect(source.mode).toBe("external-pinned");
    expect(source.base_url).toBeNull();
  });
});

describe("integrity guard (issue #7 / ADR-10 decision 5)", () => {
  it("no write can target ros/, ubuntu/ or blobs/ on the registered source", async () => {
    const db = setup();
    const source = await ensureExternalAptlySource(db);

    const targets = [
      "ros/dists/noetic/Release",
      "ros/pool/main/r/ros-noetic-desktop/ros-noetic-desktop_1.0_amd64.deb",
      "ubuntu/dists/jammy/InRelease",
      "ubuntu/pool/main/h/hello/hello_2.10_amd64.deb",
      "blobs/sha256/ab/abcdef0123456789",
      // Sibling-prefix and traversal-shaped attempts must also fail.
      "ros",
      "ROS/x",
      "ros/../ubuntu/x",
    ];
    for (const target of targets) {
      expect(isWriteAllowed(source.write_prefix, target), target).toBe(false);
    }
  });

  it("every aptly prefix itself is unwritable on the registered source", async () => {
    const db = setup();
    const source = await ensureExternalAptlySource(db);
    for (const prefix of EXTERNAL_APTLY_PREFIXES) {
      expect(isWriteAllowed(source.write_prefix, `${prefix}any-object`)).toBe(false);
    }
  });
});
