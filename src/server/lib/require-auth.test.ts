import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { guardApiWrites, requireSession, type SessionVariables } from "@server/lib/require-auth";
import { UnsupportedObjectStorage } from "@server/lib/blob";
import type { AppHonoEnv, AppRuntime } from "@server/env";

function fakeRuntime(getSession: () => Promise<unknown>): AppRuntime {
    return {
        config: {
            BETTER_AUTH_SECRET: "test-secret",
            BETTER_AUTH_URL: "http://localhost:8787",
            BETTER_AUTH_ALLOWED_HOSTS: "",
            BETTER_AUTH_OIDC_CLIENT_ID: "test-client-id",
            BETTER_AUTH_OIDC_CLIENT_SECRET: "test-client-secret",
        },
        auth: { api: { getSession } } as unknown as AppRuntime["auth"],
        blob: new UnsupportedObjectStorage(),
    };
}

const fakeSession = {
    user: { id: "user-1", email: "user@example.com", name: "Test User" },
    session: { id: "session-1", token: "token-1" },
};

function buildApp(getSession: () => Promise<unknown>) {
    const app = new Hono<AppHonoEnv>();
    app.use("*", async (c, next) => {
        c.set("app", fakeRuntime(getSession));
        await next();
    });
    app.use("/api/*", guardApiWrites);
    app.get("/api/things", (c) => c.json({ ok: true }));
    app.post("/api/things", (c) => c.json({ ok: true }, 201));
    return app;
}

describe("guardApiWrites", () => {
    it("returns 401 for POST without a session", async () => {
        const app = buildApp(async () => null);
        const res = await app.request("/api/things", { method: "POST" });
        expect(res.status).toBe(401);
        const body = await res.json() as { code: string };
        expect(body.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 for PUT/PATCH/DELETE without a session", async () => {
        const app = buildApp(async () => null);
        for (const method of ["PUT", "PATCH", "DELETE"]) {
            const res = await app.request("/api/things", { method });
            expect(res.status).toBe(401);
        }
    });

    it("returns 401 for writes to unknown paths (no existence leak)", async () => {
        const app = buildApp(async () => null);
        const res = await app.request("/api/does-not-exist", { method: "POST" });
        expect(res.status).toBe(401);
    });

    it("lets writes through with a valid session", async () => {
        const app = buildApp(async () => fakeSession);
        const res = await app.request("/api/things", { method: "POST" });
        expect(res.status).toBe(201);
    });

    it("leaves safe methods open without a session", async () => {
        const app = buildApp(async () => null);
        const res = await app.request("/api/things");
        expect(res.status).toBe(200);
    });

    it("does not guard the better-auth endpoints themselves", async () => {
        let called = false;
        const app = new Hono<AppHonoEnv>();
        app.use("*", async (c, next) => {
            c.set("app", fakeRuntime(async () => {
                called = true;
                return null;
            }));
            await next();
        });
        app.use("/api/*", guardApiWrites);
        const res = await app.request("/api/auth/sign-in/social", { method: "POST" });
        // Not blocked by the guard; falls through to 404 in this bare test app.
        expect(res.status).toBe(404);
        expect(called).toBe(false);
    });
});

describe("requireSession", () => {
    function buildProtectedApp(getSession: () => Promise<unknown>) {
        const app = new Hono<{ Variables: SessionVariables }>();
        app.use("*", async (c, next) => {
            c.set("app", fakeRuntime(getSession));
            await next();
        });
        app.use("/protected/*", requireSession);
        app.get("/protected/me", (c) => c.json({ user: c.get("user") }));
        return app;
    }

    it("returns 401 without a session", async () => {
        const app = buildProtectedApp(async () => null);
        const res = await app.request("/protected/me");
        expect(res.status).toBe(401);
    });

    it("exposes the session user to handlers", async () => {
        const app = buildProtectedApp(async () => fakeSession);
        const res = await app.request("/protected/me");
        expect(res.status).toBe(200);
        const body = await res.json() as { user: { id: string } };
        expect(body.user.id).toBe("user-1");
    });
});
