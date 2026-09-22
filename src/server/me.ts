import { Hono } from "hono";
import { requireSession, type SessionVariables } from "@server/lib/require-auth";

/**
 * Dedicated Hono app for auth-protected API. The requireSession middleware
 * returns 401 when unauthenticated, so handlers can assume user/session are set.
 */
const meApp = new Hono<{ Variables: SessionVariables }>();

meApp.use("*", requireSession);

meApp.get("/", (c) => c.json({ user: c.get("user") }));

export default meApp;
