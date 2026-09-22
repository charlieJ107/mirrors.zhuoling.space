import { Hono } from "hono";
import app from "@server/index";
import { createAppRuntimeFromCloudflare } from "@server/platforms/cloudflare";
import { createDb } from "@server/lib/data/db";
import { ensureExternalAptlySource } from "@server/lib/sources/external";
import { scanExternalAptlyBucket } from "@server/lib/scanner/external-scan";
import type { AppVariables } from "@server/env";

type CloudflareHonoEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

const handler = new Hono<CloudflareHonoEnv>()
  .use("*", async (c, next) => {
    c.set("app", createAppRuntimeFromCloudflare(c.env));
    await next();
  })
  // Temporary internal entry point for the external aptly scanner (issue #7).
  // The real control-plane trigger is issue #6 and auth is issue #5; until
  // then this is optionally gated by an INTERNAL_SCAN_TOKEN secret.
  .post("/api/internal/scan-external", async (c) => {
    const token = (c.env as Env & { INTERNAL_SCAN_TOKEN?: string })
      .INTERNAL_SCAN_TOKEN;
    if (token && c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ code: "UNAUTHORIZED", message: "Invalid internal token" }, 401);
    }
    const db = createDb(c.env.DB);
    await ensureExternalAptlySource(db);
    const result = await scanExternalAptlyBucket(db, c.env.ROBOT_APT);
    return c.json(result);
  })
  .route("/", app);

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handler.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export {
  IngestWorkflow,
  VerifyWorkflow,
  TierWorkflow,
  GcWorkflow,
} from "@server/workflows";
