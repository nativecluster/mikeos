import { afterEach, describe, expect, it, vi } from "vitest";
import {
    configureNcAppConnectors,
    currentNcPerson,
    isNcAppMode,
    ncAppOrigin,
    ncAppRedirectUri,
    NcAppOriginUnknownError,
    ncAppSecrets,
    NcAppNotConfiguredError,
    ncPersonContext,
    ncPersonMayUse,
    NcPersonUnknownError,
    ncPersonToSave,
    parsePastedAuthorization,
    resetNcAppConnectors,
    withNcPerson,
} from "./ncApp";
import { memoryHostSecrets } from "./ncSecrets";

const req = (headers: Record<string, string>) => ({
    get: (name: string) => headers[name.toLowerCase()],
});

afterEach(() => {
    vi.unstubAllEnvs();
    resetNcAppConnectors();
});

describe("app mode", () => {
    it("is on only with MIKE_NC_APP=1", () => {
        vi.stubEnv("MIKE_NC_APP", "");
        expect(isNcAppMode()).toBe(false);
        vi.stubEnv("MIKE_NC_APP", "true");
        expect(isNcAppMode()).toBe(false);
        vi.stubEnv("MIKE_NC_APP", "1");
        expect(isNcAppMode()).toBe(true);
    });

    it("needs the host's store wired before it keeps anything", () => {
        expect(() => ncAppSecrets()).toThrow(NcAppNotConfiguredError);
        const secrets = memoryHostSecrets();
        configureNcAppConnectors({ secrets });
        expect(ncAppSecrets()).toBe(secrets);
    });
});

describe("the app's own origin", () => {
    it("is the browser's Host when it is 127.0.0.1 on one of NativeCluster's app ports", () => {
        expect(ncAppOrigin(req({ host: "127.0.0.1:8494" }))).toBe("https://127.0.0.1:8494");
        expect(ncAppOrigin(req({ host: "localhost:8490" }))).toBe("https://localhost:8490");
        expect(ncAppOrigin(req({ host: "127.0.0.1:8494", origin: "https://127.0.0.1:8494" }))).toBe(
            "https://127.0.0.1:8494",
        );
        expect(ncAppRedirectUri(req({ host: "127.0.0.1:8499" }), "/user/mcp-connectors/oauth/callback")).toBe(
            "https://127.0.0.1:8499/api/user/mcp-connectors/oauth/callback",
        );
    });

    it("is never another host or port, nor an Origin that is not the Host's", () => {
        expect(ncAppOrigin(req({ host: "evil.example:8494" }))).toBeNull();
        expect(ncAppOrigin(req({ host: "127.0.0.1:8484" }))).toBeNull();
        expect(ncAppOrigin(req({ host: "localhost:3000" }))).toBeNull();
        expect(ncAppOrigin(req({}))).toBeNull();
        expect(ncAppOrigin(req({ host: "127.0.0.1:8494", origin: "https://127.0.0.1:8495" }))).toBeNull();
        expect(ncAppOrigin(req({ host: "127.0.0.1:8494", origin: "https://evil.example" }))).toBeNull();
        expect(() => ncAppRedirectUri(req({ host: "localhost:3000" }), "/x")).toThrow(NcAppOriginUnknownError);
    });
});

describe("the person", () => {
    it("is the ticket's, for the work run under it", async () => {
        expect(currentNcPerson()).toBeNull();
        await withNcPerson("p_abc123", async () => {
            await Promise.resolve();
            expect(currentNcPerson()).toBe("p_abc123");
        });
        expect(currentNcPerson()).toBeNull();
    });

    it("is never a value that is not a person id", () => {
        withNcPerson("someone@example.com", () => expect(currentNcPerson()).toBeNull());
        withNcPerson("", () => expect(currentNcPerson()).toBeNull());
    });

    it("comes from X-NC-Person in app mode only", () => {
        let inside: string | null = "unset";
        vi.stubEnv("MIKE_NC_APP", "");
        ncPersonContext(req({ "x-nc-person": "p_1" }), {}, () => {
            inside = currentNcPerson();
        });
        expect(inside).toBeNull();
        vi.stubEnv("MIKE_NC_APP", "1");
        ncPersonContext(req({ "x-nc-person": "p_1" }), {}, () => {
            inside = currentNcPerson();
        });
        expect(inside).toBe("p_1");
    });

    // Review L3: a sign-in's state saved with no person was finished by
    // anyone, and one was started for no one.
    it("saves nothing for no one, and lets only its own person use a saved state", () => {
        vi.stubEnv("MIKE_NC_APP", "1");
        expect(() => ncPersonToSave()).toThrow(NcPersonUnknownError);
        withNcPerson("p_alice", () => expect(ncPersonToSave()).toBe("p_alice"));
        withNcPerson("p_alice", () => {
            expect(ncPersonMayUse("p_alice")).toBe(true);
            expect(ncPersonMayUse("p_bob")).toBe(false);
            expect(ncPersonMayUse(undefined)).toBe(false);
            expect(ncPersonMayUse("")).toBe(false);
        });
        expect(ncPersonMayUse("p_alice")).toBe(false);
        expect(ncPersonMayUse(undefined)).toBe(false);
        // Elsewhere states carry no person, as before.
        vi.stubEnv("MIKE_NC_APP", "");
        expect(ncPersonToSave()).toBeNull();
        expect(ncPersonMayUse(undefined)).toBe(true);
    });

    it("is read by the one rule for a person id", () => {
        withNcPerson("p_al.ice", () => expect(currentNcPerson()).toBeNull());
        withNcPerson("p_al-ice", () => expect(currentNcPerson()).toBeNull());
        withNcPerson(" p_7f3a ", () => expect(currentNcPerson()).toBe("p_7f3a"));
    });

    it("falls back to the wired resolver outside a request", () => {
        configureNcAppConnectors({ secrets: memoryHostSecrets(), currentPerson: () => "p_job" });
        expect(currentNcPerson()).toBe("p_job");
        withNcPerson(null, () => expect(currentNcPerson()).toBeNull());
    });
});

describe("the address the person pastes", () => {
    it("takes the code and state from the whole address", () => {
        expect(
            parsePastedAuthorization(
                "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback?code=abc%2F1&state=st-2&iss=https%3A%2F%2Fas",
            ),
        ).toEqual({ code: "abc/1", state: "st-2", error: null });
    });

    it("takes them from the query alone, and reads a refusal", () => {
        expect(parsePastedAuthorization("?code=c&state=s")).toEqual({ code: "c", state: "s", error: null });
        expect(parsePastedAuthorization("https://127.0.0.1:8494/cb?error=access_denied&state=s")).toEqual({
            code: null,
            state: "s",
            error: "access_denied",
        });
    });

    it("takes them from inside NativeCluster's sign-in hand-off", () => {
        // Measured on 0.4.23: an outside browser at the app's origin is sent
        // through :8484 and back to /.nc/handoff?next=<the callback, encoded>.
        expect(
            parsePastedAuthorization(
                "https://127.0.0.1:8496/.nc/handoff?next=%2Fapi%2Fuser%2Fmcp-connectors%2Foauth%2Fcallback%3Fcode%3Dc-1%26state%3Ds-1",
            ),
        ).toEqual({ code: "c-1", state: "s-1", error: null });
        expect(parsePastedAuthorization("https://127.0.0.1:8496/.nc/handoff?next=https%3A%2F%2Fevil.test%2F%3Fcode%3Dx")).toEqual({
            code: null,
            state: null,
            error: null,
        });
    });

    it("reads nothing from text that is not an authorization", () => {
        expect(parsePastedAuthorization("")).toEqual({ code: null, state: null, error: null });
        expect(parsePastedAuthorization(42)).toEqual({ code: null, state: null, error: null });
        expect(parsePastedAuthorization("x".repeat(9000)).code).toBeNull();
        expect(parsePastedAuthorization("https://example.com/").code).toBeNull();
    });
});
