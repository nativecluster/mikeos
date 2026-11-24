import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    challengeAndVerifyMfa,
    getAuthSession,
    login,
    logout,
    signup,
} from "./authApi";
import {
    APP_SESSION_HEADER,
    readAppSession,
    resetAppSessionForTests,
    storeAppSession,
} from "./appSession";

const user = {
    id: "user-1",
    email: "lawyer@example.test",
    pendingEmail: null,
    createdWithGoogle: false,
};

function tokens(access: string, refresh: string) {
    return {
        access_token: access,
        refresh_token: refresh,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: "bearer",
    };
}

function json(status: number, body: unknown) {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("auth client in the NativeCluster app", () => {
    beforeEach(() => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        window.localStorage.clear();
        resetAppSessionForTests();
    });
    afterEach(() => {
        resetAppSessionForTests();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it("keeps the session a log-in answers, then presents it to /session", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(200, { user, session: tokens("access-1", "refresh-1") }))
            .mockResolvedValueOnce(json(200, { user }));
        vi.stubGlobal("fetch", fetchMock);
        await login(user.email, "correct horse");
        expect(readAppSession()?.access_token).toBe("access-1");
        await expect(getAuthSession()).resolves.toEqual(user);
        const headers = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
        expect(fetchMock.mock.calls[1]![0]).toBe("/api/auth/session");
        expect(headers.get(APP_SESSION_HEADER)).toBe("access-1");
    });

    it("asks nothing for the session when it holds none", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(getAuthSession()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps a sign-up's session when GoTrue confirmed it at once", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                json(201, {
                    user,
                    requiresEmailConfirmation: false,
                    session: tokens("access-1", "refresh-1"),
                }),
            ),
        );
        await signup(user.email, "a long enough password", "/onboarding/profile");
        expect(readAppSession()?.refresh_token).toBe("refresh-1");
    });

    it("keeps the aal2 tokens an MFA verification answers", async () => {
        storeAppSession(tokens("access-aal1", "refresh-aal1"));
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(json(200, { user, session: tokens("access-aal2", "refresh-aal2") })),
        );
        await challengeAndVerifyMfa("factor-1", "123456");
        expect(readAppSession()?.access_token).toBe("access-aal2");
    });

    it("signs out in GoTrue with the session, and forgets it even if that fails", async () => {
        storeAppSession(tokens("access-1", "refresh-1"));
        const fetchMock = vi.fn().mockResolvedValue(json(204, null));
        vi.stubGlobal("fetch", fetchMock);
        await logout();
        const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
        expect(headers.get(APP_SESSION_HEADER)).toBe("access-1");
        expect(readAppSession()).toBeNull();

        storeAppSession(tokens("access-1", "refresh-1"));
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
        await expect(logout()).rejects.toThrow();
        expect(readAppSession()).toBeNull();
    });

    it("shows the app's sentence when a log-in is another person's account", async () => {
        const detail =
            "This Mike account belongs to another NativeCluster person on this computer. Sign in to NativeCluster as that person, or log in to Mike with an account of your own.";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(json(403, { code: "nc_person_mismatch", detail })),
        );
        await expect(login(user.email, "correct horse")).rejects.toMatchObject({
            status: 403,
            code: "nc_person_mismatch",
            message: detail,
        });
        expect(readAppSession()).toBeNull();
    });
});
