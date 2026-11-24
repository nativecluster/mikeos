import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedFetchMock, authMock } = vi.hoisted(() => ({
    guardedFetchMock: vi.fn(),
    authMock: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return { ...actual, guardedFetch: (input: unknown, init?: unknown) => guardedFetchMock(input, init) };
});
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
    auth: (...args: unknown[]) => authMock(...args),
}));

import { decryptString, setConnectorEncryptionSecret } from "./client";
import {
    completeMcpConnectorOAuthFromPaste,
    discoverMcpDeviceGrant,
    McpLinkError,
    pollMcpDeviceAuthorization,
    startMcpDeviceAuthorization,
} from "./appLinking";
import { forgetResolvedHostSecrets, HOST_SECRET_IV } from "./hostSecretColumns";
import { configureNcAppConnectors, resetNcAppConnectors, withNcPerson } from "./ncApp";
import { memoryHostSecrets } from "./ncSecrets";
import { DbMcpOAuthProvider, loadOAuthToken } from "./oauth";
import { memoryDb } from "./__tests__/memoryDb";
import type { ConnectorRow } from "./types";

const SERVER = "https://mcp.example/mcp";
const AS = "https://as.example";
const REDIRECT = "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let tokenAnswers: Response[];
let asMetadata: Record<string, unknown>;
let seenBodies: Record<string, string>;

function server() {
    guardedFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.body !== undefined) seenBodies[url] = String(init.body);
        if (url === SERVER)
            return new Response("", {
                status: 401,
                headers: { "www-authenticate": `Bearer resource_metadata="${AS}/.well-known/oauth-protected-resource"` },
            });
        if (url === `${AS}/.well-known/oauth-protected-resource`)
            return json({ resource: SERVER, authorization_servers: [AS], scopes_supported: ["files.read"] });
        if (url === `${AS}/.well-known/oauth-authorization-server`) return json(asMetadata);
        if (url === `${AS}/register`) return json({ client_id: "dyn-1" }, 201);
        if (url === `${AS}/device`)
            return json({
                device_code: "dev-code-1",
                user_code: "WDJB-MJHT",
                verification_uri: `${AS}/activate`,
                verification_uri_complete: `${AS}/activate?user_code=WDJB-MJHT`,
                interval: 5,
                expires_in: 900,
            });
        if (url === `${AS}/token`) return tokenAnswers.shift() ?? json({ error: "expired_token" }, 400);
        return new Response("{}", { status: 404 });
    });
}

const connector: ConnectorRow = {
    id: "11111111-1111-1111-1111-111111111111",
    user_id: "user-1",
    name: "Files",
    transport: "streamable_http",
    server_url: SERVER,
    auth_type: "oauth",
    enabled: true,
    tool_policy: {},
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
};

let store: ReturnType<typeof memoryHostSecrets>;

beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    setConnectorEncryptionSecret("k".repeat(64));
    store = memoryHostSecrets();
    configureNcAppConnectors({ secrets: store });
    forgetResolvedHostSecrets();
    tokenAnswers = [];
    seenBodies = {};
    asMetadata = {
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        device_authorization_endpoint: `${AS}/device`,
        registration_endpoint: `${AS}/register`,
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    };
    server();
    authMock.mockReset();
});

afterEach(() => {
    vi.unstubAllEnvs();
    resetNcAppConnectors();
    setConnectorEncryptionSecret(null);
    guardedFetchMock.mockReset();
});

describe("the device grant for an MCP connector", () => {
    it("is found only where the authorization server advertises it", async () => {
        expect(await discoverMcpDeviceGrant(SERVER)).toMatchObject({
            deviceAuthorizationEndpoint: `${AS}/device`,
            tokenEndpoint: `${AS}/token`,
            scope: "files.read",
        });
        delete asMetadata.device_authorization_endpoint;
        expect(await discoverMcpDeviceGrant(SERVER)).toBeNull();
        asMetadata.device_authorization_endpoint = `${AS}/device`;
        asMetadata.grant_types_supported = ["authorization_code"];
        expect(await discoverMcpDeviceGrant(SERVER)).toBeNull();
    });

    it("shows the code and the link, polls, and keeps the token in NativeCluster's store", async () => {
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        const device = await withNcPerson("p_alice", () =>
            startMcpDeviceAuthorization(connector, "user-1", REDIRECT, db),
        );
        expect(device).toMatchObject({
            userCode: "WDJB-MJHT",
            verificationUri: `${AS}/activate`,
            verificationUriComplete: `${AS}/activate?user_code=WDJB-MJHT`,
            interval: 5,
        });
        // The client registered for the device grant, with the app's redirect.
        expect(seenBodies[`${AS}/register`]).toContain("urn:ietf:params:oauth:grant-type:device_code");
        expect(new URLSearchParams(seenBodies[`${AS}/device`]).get("client_id")).toBe("dyn-1");
        expect(new URLSearchParams(seenBodies[`${AS}/device`]).get("scope")).toBe("files.read");

        tokenAnswers.push(json({ error: "authorization_pending" }, 400));
        tokenAnswers.push(json({ error: "slow_down" }, 400));
        tokenAnswers.push(json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" }));
        await withNcPerson("p_alice", async () => {
            expect(await pollMcpDeviceAuthorization("user-1", connector.id, device!.state, db)).toEqual({
                status: "pending",
                interval: 5,
            });
            expect(await pollMcpDeviceAuthorization("user-1", connector.id, device!.state, db)).toEqual({
                status: "pending",
                interval: 10,
            });
            expect(await pollMcpDeviceAuthorization("user-1", connector.id, device!.state, db)).toEqual({
                status: "connected",
            });
        });
        const tokenBody = new URLSearchParams(seenBodies[`${AS}/token`]);
        expect(tokenBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(tokenBody.get("device_code")).toBe("dev-code-1");

        const row = db.tables.get("user_mcp_oauth_tokens")![0];
        expect(row.grant_id).toBeTruthy();
        expect(row.access_token_iv).toBe(HOST_SECRET_IV);
        expect(JSON.stringify(row)).not.toContain("at-1");
        expect(JSON.stringify(row)).not.toContain("rt-1");
        expect([...store.values.keys()].every((name) => name.startsWith("mike:p_alice:mcp:"))).toBe(true);
        expect([...store.values.values()]).toEqual(expect.arrayContaining(["at-1", "rt-1"]));
        expect(db.tables.get("user_mcp_oauth_states")).toHaveLength(0);

        // Read back after a restart of the backend: resolved from the host.
        forgetResolvedHostSecrets();
        await withNcPerson("p_alice", async () => {
            const loaded = await loadOAuthToken(connector.id, db);
            expect(decryptString(loaded!.encrypted_access_token, loaded!.access_token_iv, loaded!.access_token_tag)).toBe(
                "at-1",
            );
        });
    });

    it("is polled only by the person and account who started it", async () => {
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        const device = await withNcPerson("p_alice", () =>
            startMcpDeviceAuthorization(connector, "user-1", REDIRECT, db),
        );
        tokenAnswers.push(json({ access_token: "at-1", expires_in: 3600 }));
        expect(
            await withNcPerson("p_bob", () => pollMcpDeviceAuthorization("user-1", connector.id, device!.state, db)),
        ).toEqual({ status: "expired" });
        expect(
            await withNcPerson("p_alice", () => pollMcpDeviceAuthorization("user-2", connector.id, device!.state, db)),
        ).toEqual({ status: "expired" });
        expect(tokenAnswers).toHaveLength(1);
    });

    it("stops when the person says no", async () => {
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        const device = await withNcPerson("p_alice", () =>
            startMcpDeviceAuthorization(connector, "user-1", REDIRECT, db),
        );
        tokenAnswers.push(json({ error: "access_denied" }, 400));
        expect(
            await withNcPerson("p_alice", () => pollMcpDeviceAuthorization("user-1", connector.id, device!.state, db)),
        ).toEqual({ status: "denied" });
        expect(db.tables.get("user_mcp_oauth_states")).toHaveLength(0);
    });

    it("is not offered when the server has no device grant", async () => {
        delete asMetadata.device_authorization_endpoint;
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        expect(await withNcPerson("p_alice", () => startMcpDeviceAuthorization(connector, "user-1", REDIRECT, db))).toBeNull();
    });
});

describe("finishing the code flow from a pasted address", () => {
    async function started(db: ReturnType<typeof memoryDb>) {
        const provider = new DbMcpOAuthProvider(db, connector, "user-1", "initiate", REDIRECT, "state-token-0123456789");
        await withNcPerson("p_alice", () => provider.saveCodeVerifier("verifier"));
        return "state-token-0123456789";
    }

    it("finishes the authorization the same person started", async () => {
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        const state = await started(db);
        authMock.mockResolvedValue("AUTHORIZED");
        await withNcPerson("p_alice", () =>
            completeMcpConnectorOAuthFromPaste(
                "user-1",
                connector.id,
                `${REDIRECT}?code=the-code&state=${state}`,
                db,
                "https://127.0.0.1:8494",
            ),
        );
        expect(authMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ authorizationCode: "the-code", serverUrl: SERVER }),
        );
        expect(db.tables.get("user_mcp_oauth_states")).toHaveLength(0);
    });

    it("refuses another person, another account, a refusal and an address with no code", async () => {
        const db = memoryDb({ user_mcp_connectors: [connector as unknown as Record<string, unknown>] });
        const state = await started(db);
        const paste = (person: string, user: string, address: string, origin = "https://127.0.0.1:8494") =>
            withNcPerson(person, () =>
                completeMcpConnectorOAuthFromPaste(user, connector.id, address, db, origin),
            ).catch((e: unknown) => e);
        expect(await paste("p_bob", "user-1", `${REDIRECT}?code=c&state=${state}`)).toMatchObject({
            code: "oauth_state_invalid",
        });
        expect(await paste("p_alice", "user-2", `${REDIRECT}?code=c&state=${state}`)).toMatchObject({
            code: "oauth_state_invalid",
        });
        expect(await paste("p_alice", "user-1", `${REDIRECT}?error=access_denied&state=${state}`)).toMatchObject({
            code: "oauth_denied",
        });
        expect(await paste("p_alice", "user-1", "https://127.0.0.1:8494/")).toBeInstanceOf(McpLinkError);
        // Started on this computer's port 8494: never finished from another origin.
        expect(
            await paste("p_alice", "user-1", `${REDIRECT}?code=c&state=${state}`, "https://127.0.0.1:8495"),
        ).toMatchObject({ code: "oauth_state_invalid" });
        expect(authMock).not.toHaveBeenCalled();
    });
});
