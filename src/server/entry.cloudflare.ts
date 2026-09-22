import { Hono } from "hono";
import app from "@server/index";
import { createAppRuntimeFromCloudflare } from "@server/platforms/cloudflare";
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
  .route("/", app);

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handler.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
