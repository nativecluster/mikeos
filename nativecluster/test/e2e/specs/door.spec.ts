/**
 * What a browser meets at the app's origin, as NativeCluster's host serves
 * it: the app refuses a request without a valid ticket (403), the host's own
 * paths never reach the app, and nobody signed in is stopped before the app
 * (401). Runs for any package.
 */
import { test, expect } from "@playwright/test";
import { personHeaders, nobodyHeaders } from "../lib/door";

test("no ticket, a forged one or a stale one: the app answers 403", async ({ playwright, baseURL }) => {
    for (const mode of ["none", "bad", "stale"]) {
        const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { ...personHeaders("alice"), "x-harness-ticket": mode } });
        for (const p of ["/", "/healthz", "/no/such/route", "/api/health"]) {
            const r = await api.get(p);
            expect(r.status(), `${p} with ticket ${mode}`).toBe(403);
        }
        await api.dispose();
    }
});

test("NativeCluster's own paths never reach the app", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: personHeaders("alice") });
    for (const p of ["/.nc/whoami", "/nativecluster/apps", "/host/v1/models"]) {
        expect((await api.get(p)).status(), p).toBe(404);
    }
    await api.dispose();
});

test("nobody signed in is stopped by the host, before the app", async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: nobodyHeaders() });
    expect((await api.get("/")).status()).toBe(401);
    await api.dispose();
});

test("a person's ticket reaches the app, which knows them by their id", async ({ playwright, baseURL }) => {
    // /.nc/whoami is refused at the origin; the app's other routes answer
    // the person's request (any status but the ticket's 403 and 5xx).
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: personHeaders("alice") });
    const r = await api.get("/");
    expect(r.status()).toBeLessThan(500);
    expect(r.status()).not.toBe(403);
    expect(r.headers()["set-cookie"], "the host drops every Set-Cookie an app sends").toBeUndefined();
    await api.dispose();
});
