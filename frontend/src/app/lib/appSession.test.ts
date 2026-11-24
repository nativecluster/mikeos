import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    APP_SESSION_HEADER,
    REFRESH_AHEAD_SECONDS,
    appAccessToken,
    clearAppSession,
    fetchWithAppSession,
    readAppSession,
    refreshAppSession,
    resetAppSessionForTests,
    storeAppSession,
} from "./appSession";
import { AUTH_SESSION_INVALIDATED_EVENT, authenticatedFetch } from "./authEvents";
import { clearLegacyBrowserAuthStorage } from "./authApi";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function session(overrides: Partial<{ access_token: string; refresh_token: string; expires_at: number }> = {}) {
    return {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: nowSeconds() + 3600,
        expires_in: 3600,
        token_type: "bearer",
        ...overrides,
    };
}

function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, call: number): Headers {
    return new Headers((fetchMock.mock.calls[call]![1] as RequestInit).headers);
}

describe("Mike's session in the NativeCluster app", () => {
    beforeEach(() => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        window.localStorage.clear();
        resetAppSessionForTests();
    });
    afterEach(() => {
        resetAppSessionForTests();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("keeps the tokens an auth answer carries, and survives the legacy-storage sweep", () => {
        expect(storeAppSession(session())).toBe(true);
        clearLegacyBrowserAuthStorage();
        expect(readAppSession()).toEqual({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_at: expect.any(Number),
        });
        clearAppSession();
        expect(readAppSession()).toBeNull();
    });

    it("ignores an answer without tokens, and everything outside the app", () => {
        expect(storeAppSession(undefined)).toBe(false);
        expect(storeAppSession({ access_token: "a" })).toBe(false);
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "");
        expect(storeAppSession(session())).toBe(false);
        expect(readAppSession()).toBeNull();
    });

    it("presents the access token in X-Mike-Session, never Authorization", async () => {
        storeAppSession(session());
        const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
        vi.stubGlobal("fetch", fetchMock);
        await authenticatedFetch("/api/projects", {
            headers: { Authorization: "Bearer stray" },
        });
        const headers = sentHeaders(fetchMock, 0);
        expect(headers.get(APP_SESSION_HEADER)).toBe("access-1");
        expect(headers.get("Authorization")).toBe("Bearer stray");
        expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("same-origin");
    });

    it("refreshes before the token expires, once for many calls at a time", async () => {
        storeAppSession(session({ expires_at: nowSeconds() + REFRESH_AHEAD_SECONDS - 5 }));
        const fetchMock = vi.fn<typeof fetch>(async (input) =>
            String(input) === "/api/auth/refresh"
                ? json(200, { session: session({ access_token: "access-2", refresh_token: "refresh-2" }) })
                : json(200, {}),
        );
        vi.stubGlobal("fetch", fetchMock);
        const tokens = await Promise.all([appAccessToken(), appAccessToken(), appAccessToken()]);
        expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
        const refreshes = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/auth/refresh");
        expect(refreshes).toHaveLength(1);
        expect(JSON.parse(String((refreshes[0]![1] as RequestInit).body))).toEqual({
            refresh_token: "refresh-1",
        });
        expect(readAppSession()?.refresh_token).toBe("refresh-2");
    });

    it("refreshes on a timer ahead of expiry", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue(
            json(200, { session: session({ access_token: "access-2", refresh_token: "refresh-2" }) }),
        );
        vi.stubGlobal("fetch", fetchMock);
        storeAppSession(session({ expires_at: nowSeconds() + 600 }));
        await vi.advanceTimersByTimeAsync((600 - REFRESH_AHEAD_SECONDS - 10) * 1000);
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetchMock).toHaveBeenCalledWith("/api/auth/refresh", expect.anything());
        expect(readAppSession()?.access_token).toBe("access-2");
    });

    it("answers a 401 with one refresh and one retry", async () => {
        storeAppSession(session());
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(401, { detail: "Invalid or expired session" }))
            .mockResolvedValueOnce(json(200, { session: session({ access_token: "access-2", refresh_token: "refresh-2" }) }))
            .mockResolvedValueOnce(json(200, { ok: true }));
        vi.stubGlobal("fetch", fetchMock);
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        const response = await authenticatedFetch("/api/projects", {
            method: "POST",
            body: JSON.stringify({ name: "Matter" }),
        });
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sentHeaders(fetchMock, 2).get(APP_SESSION_HEADER)).toBe("access-2");
        expect((fetchMock.mock.calls[2]![1] as RequestInit).body).toBe(JSON.stringify({ name: "Matter" }));
        expect(listener).not.toHaveBeenCalled();
    });

    it("signs out when the refresh is refused, and never replays a streamed body", async () => {
        storeAppSession(session());
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(401, {}))
            .mockResolvedValueOnce(json(401, { code: "session_expired" }));
        vi.stubGlobal("fetch", fetchMock);
        const listener = vi.fn();
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        const response = await authenticatedFetch("/api/projects");
        expect(response.status).toBe(401);
        expect(readAppSession()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);

        storeAppSession(session());
        fetchMock.mockReset().mockResolvedValue(json(401, {}));
        const stream = new ReadableStream({ start: (c) => c.close() });
        await fetchWithAppSession("/api/upload", { method: "PUT", body: stream });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
    });

    it("keeps the session when nobody answers the refresh", async () => {
        storeAppSession(session());
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
        await expect(refreshAppSession()).resolves.toEqual({ kind: "unavailable" });
        expect(readAppSession()?.access_token).toBe("access-1");
    });

    it("drops another person's session with the app's own sentence", async () => {
        storeAppSession(session());
        const detail =
            "This Mike account belongs to another NativeCluster person on this computer.";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(json(403, { code: "nc_person_mismatch", detail })),
        );
        const messages: Array<string | null> = [];
        const listener = (event: Event) =>
            messages.push((event as CustomEvent<{ message: string | null }>).detail.message);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        const response = await authenticatedFetch("/api/projects");
        window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, listener);
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ code: "nc_person_mismatch" });
        expect(readAppSession()).toBeNull();
        expect(messages).toEqual([detail]);
    });

    it("leaves an ordinary 403 and other deployments alone", async () => {
        storeAppSession(session());
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { code: "forbidden" })));
        await authenticatedFetch("/api/projects/1");
        expect(readAppSession()).not.toBeNull();

        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "");
        const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
        vi.stubGlobal("fetch", fetchMock);
        await authenticatedFetch("/api/projects");
        expect(sentHeaders(fetchMock, 0).get(APP_SESSION_HEADER)).toBeNull();
        expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
        await expect(appAccessToken()).resolves.toBeNull();
    });
});
