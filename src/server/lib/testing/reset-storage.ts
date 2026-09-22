import { env } from "cloudflare:workers";
import { createDb } from "@server/lib/data/db";

/**
 * Workers-pool test helpers. Storage isolation is per test file; within a
 * file, tests share the emulated D1/R2 state, so each test file resets the
 * rows and objects it may have touched in a `beforeEach`.
 */
export async function resetStorage(): Promise<void> {
  const db = createDb(env.DB);
  // Delete children before parents (files -> blobs/sources FKs).
  await db.deleteFrom("files").execute();
  await db.deleteFrom("source_tokens").execute();
  await db.deleteFrom("blobs").execute();
  await db.deleteFrom("jobs").execute();
  await db.deleteFrom("sources").execute();

  for (const bucket of [env.ROBOT_APT, env.MIRROR_HOT, env.MIRROR_COLD]) {
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ cursor });
      for (const object of page.objects) {
        await bucket.delete(object.key);
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }
}
