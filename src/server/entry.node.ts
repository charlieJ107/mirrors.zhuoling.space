import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import app from "@server/index";
import type { AppHonoEnv } from "@server/env";
import { createAppRuntimeFromNode } from "@server/platforms/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, "../client");
const port = Number(process.env.PORT ?? 3000);
const appRuntime = createAppRuntimeFromNode();
const serveClientStatic = serveStatic({ root: clientRoot });
const serveClientIndex = serveStatic({ path: resolve(clientRoot, "index.html") });

const server = new Hono<AppHonoEnv>()
  .onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ code: "INTERNAL_ERROR", message: "Internal server error" }, 500);
  })
  .use('*', async (c, next) => {
    c.set('app', appRuntime)
    await next()
  })
  .route("/", app)
  .all("/api/*", (c) => c.json({ code: "NOT_FOUND", message: "Not found" }, 404))
  .use("/*", serveClientStatic)
  .get("*", serveClientIndex);

serve({ fetch: server.fetch, port });
console.log(`Server running on http://localhost:${port}`);
