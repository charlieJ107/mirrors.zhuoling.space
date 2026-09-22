import type { MiddlewareHandler } from "hono";
import type { AppHonoEnv, AppVariables } from "@server/env";
import type { AuthSession } from "@server/lib/auth";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_API_PREFIX = "/api/auth/";

/**
 * Guards /api/* write endpoints: any non-safe method requires a valid session.
 * Runs before route matching, so unauthenticated writes to unknown paths get the
 * same 401 as writes to real resources — no resource-existence leak.
 *
 * /api/auth/* is excluded: those endpoints are the sign-in flow itself.
 */
export const guardApiWrites: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith(AUTH_API_PREFIX)) {
    return next();
  }
  const session = await c.var.app.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ code: "UNAUTHORIZED", message: "Authentication required" }, 401);
  }
  await next();
};

export type SessionVariables = AppVariables & {
  user: AuthSession["user"];
  session: AuthSession["session"];
};

/**
 * Requires a valid session for every request in scope and exposes the
 * authenticated user/session as Hono variables.
 */
export const requireSession: MiddlewareHandler<{ Variables: SessionVariables }> = async (c, next) => {
  const session = await c.var.app.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ code: "UNAUTHORIZED", message: "Authentication required" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
};
