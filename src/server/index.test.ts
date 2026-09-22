import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import app from "./index";
import { messageListResponseSchema } from "@shared/dto/messages";
import { UnsupportedObjectStorage } from "@server/lib/blob";
import type { AppHonoEnv, AppRuntime } from "@server/env";

/**
 * Wraps the real app with a stubbed runtime so tests can control whether
 * auth.api.getSession resolves a session, without a database or OIDC provider.
 */
function withStubbedAuth(getSession: () => Promise<unknown>) {
    const runtime: AppRuntime = {
        config: {
            BETTER_AUTH_SECRET: "test-secret",
            BETTER_AUTH_URL: "http://localhost:8787",
            BETTER_AUTH_ALLOWED_HOSTS: "",
            BETTER_AUTH_OIDC_CLIENT_ID: "test-client-id",
            BETTER_AUTH_OIDC_CLIENT_SECRET: "test-client-secret",
        },
        auth: {
            api: { getSession },
            handler: async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }),
        } as unknown as AppRuntime["auth"],
        blob: new UnsupportedObjectStorage(),
    };
    const wrapped = new Hono<AppHonoEnv>();
    wrapped.use("*", async (c, next) => {
        c.set("app", runtime);
        await next();
    });
    wrapped.route("/", app);
    return wrapped;
}

describe("GET /api/health", () => {
    it("returns 200 with status ok", async () => {
        const res = await app.request("/api/health");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "ok" });
    });
});

describe("GET /api/*  (unknown endpoint)", () => {
    it("returns JSON 404 instead of HTML", async () => {
        const res = await app.request("/api/does-not-exist");
        expect(res.status).toBe(404);
        const body = await res.json() as { code: string };
        expect(body.code).toBe("NOT_FOUND");
        expect(res.headers.get("content-type")).toMatch(/application\/json/);
    });
});

describe("GET /api/messages", () => {
    it("returns data matching the shared DTO", async () => {
        const res = await app.request("/api/messages");
        expect(res.status).toBe(200);
        const body = messageListResponseSchema.parse(await res.json());
        expect(body.messages.length).toBeGreaterThan(0);
    });
});

describe("/api/* write guard", () => {
    it("returns 401 for POST to an existing endpoint without a session", async () => {
        const guarded = withStubbedAuth(async () => null);
        const res = await guarded.request("/api/messages", { method: "POST" });
        expect(res.status).toBe(401);
        const body = await res.json() as { code: string };
        expect(body.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 for POST to an unknown endpoint without a session", async () => {
        const guarded = withStubbedAuth(async () => null);
        const res = await guarded.request("/api/no-such-resource", { method: "POST" });
        expect(res.status).toBe(401);
    });

    it("passes writes through the guard when a session exists", async () => {
        const guarded = withStubbedAuth(async () => ({
            user: { id: "user-1" },
            session: { id: "session-1" },
        }));
        // No POST handler exists for /api/messages, so a guarded pass-through
        // surfaces as the app's 404 rather than 401.
        const res = await guarded.request("/api/messages", { method: "POST" });
        expect(res.status).toBe(404);
    });

    it("does not block the better-auth endpoints", async () => {
        const guarded = withStubbedAuth(async () => null);
        const res = await guarded.request("/api/auth/sign-in/social", { method: "POST" });
        expect(res.status).toBe(404);
    });
});
