import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthSession } from "./authApi";

function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const refusal = {
    code: "nc_person_required",
    detail: "Sign in to NativeCluster to use Mike.",
};

describe("the session in the NativeCluster app", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it("is the NativeCluster person's account, with no credential of Mike's sent", async () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        const user = { id: "user-1", email: "alice@firm.example", pendingEmail: null, createdWithGoogle: false };
        const fetchMock = vi.fn().mockResolvedValue(json(200, { user }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(getAuthSession()).resolves.toEqual(user);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/auth/session");
        expect(new Headers(init.headers).get("Authorization")).toBeNull();
    });

    it("is none, without an error, while nobody is signed in to NativeCluster", async () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, refusal)));
        await expect(getAuthSession()).resolves.toBeNull();
    });

    it("stays a refusal in any other build", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, refusal)));
        await expect(getAuthSession()).rejects.toMatchObject({ status: 403 });
    });
});
