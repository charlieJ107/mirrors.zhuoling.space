import { Hono } from "hono";
import meApp from "./me";
import { createMirrorApp } from "./routes/mirror";
import type { AppHonoEnv } from "@server/env";
import { messageListResponseSchema } from "@shared/dto/messages";

const app = new Hono<AppHonoEnv>();

app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ code: "INTERNAL_ERROR", message: "Internal server error" }, 500);
});

app.on(["POST", "GET"], "/api/auth/*", (c) => c.var.app.auth.handler(c.req.raw));

app.route("/api/me", meApp);

// Lazy mirror data plane (issue #3): /s/{sourceId}/*.
app.route("/", createMirrorApp());

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/messages", (c) => c.json(messageListResponseSchema.parse({
    messages: [
        {
            id: "welcome",
            title: "Shared DTOs",
            body: "This response is validated by a schema in src/shared/dto.",
        },
        {
            id: "runtime",
            title: "Platform adapters",
            body: "The same Hono API runs on Cloudflare Workers and Node.",
        },
    ],
})));

app.notFound((c) => c.json({ code: "NOT_FOUND", message: "Not found" }, 404));

export default app;
export type AppType = typeof app;
