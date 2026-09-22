import { Hono } from "hono";
import type { AuthSession } from "@server/lib/auth";
import type { AppVariables } from "@server/env";

type Variables = {
    app: AppVariables["app"];
    user: AuthSession["user"];
    session: AuthSession["session"];
};

/**
 * Dedicated Hono app for auth-protected API. Middleware returns 401 when unauthenticated,
 * so handlers can assume user/session are set.
 */
const meApp = new Hono<{ Variables: Variables }>();

meApp.use("*", async (c, next) => {
    const session = await c.var.app.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
        return c.json({ code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
    }
    c.set("user", session.user);
    c.set("session", session.session);
    await next();
});

meApp.get("/", (c) => c.json({ user: c.get("user") }));

export default meApp;
