// Mike's NativeCluster app: the words for a server whose sign-in can never
// finish from this computer (it refuses the app's address as a redirect, or
// registers no client for Mike).
import { afterEach, describe, expect, it, vi } from "vitest";

const { guardedFetchMock } = vi.hoisted(() => ({
    guardedFetchMock: vi.fn(async (_input?: unknown, _init?: unknown) => new Response("{}", { status: 404 })),
}));

vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return {
        ...actual,
        guardedFetch: (input?: unknown, init?: unknown) => guardedFetchMock(input, init),
    };
});

import {
    linkUnsupported,
    watchRegistration,
} from "./oauth";
import { ConnectorLinkUnsupportedError } from "./errors";
import { registerClient } from "@modelcontextprotocol/sdk/client/auth.js";

afterEach(() => {
    vi.unstubAllEnvs();
    guardedFetchMock.mockReset();
    guardedFetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));
});

describe("a server whose sign-in can never finish from this computer", () => {
    const REDIRECT = "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback";
    const register = (watch: ReturnType<typeof watchRegistration>) =>
        watch.fetch("https://mcp.example.test/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_name: "Mike", redirect_uris: [REDIRECT] }),
        });

    it("is named when its registration refuses Mike's address here", async () => {
        guardedFetchMock.mockImplementation(async () =>
            Response.json(
                { error: "invalid_redirect_uri", error_description: "redirect_uri must be http://localhost" },
                { status: 400 },
            ),
        );
        const watch = watchRegistration(guardedFetchMock as never);
        await register(watch);
        expect(watch.refused).toEqual({
            status: 400,
            error: "invalid_redirect_uri",
            description: "redirect_uri must be http://localhost",
        });
        // The SDK folds the answer into a generic server error.
        const failure = linkUnsupported(new Error("HTTP 400"), watch.refused, "https://mcp.example.test/mcp", REDIRECT);
        expect(failure).toBeInstanceOf(ConnectorLinkUnsupportedError);
        expect(failure?.code).toBe("connector_redirect_rejected");
        expect(failure?.message).toBe(
            "mcp.example.test won't send you back to Mike after you sign in: it refuses Mike's address on this computer (https://127.0.0.1:8494), so it can't be linked from Mike's NativeCluster app by signing in. If mcp.example.test gives you an API token, add it as a custom connector with that token instead.",
        );
    });

    it("is named when its metadata calls the redirect the invalid part", async () => {
        const failure = linkUnsupported(
            new Error("x"),
            { status: 400, error: "invalid_client_metadata", description: "Redirect URIs must use loopback http" },
            "https://mcp.example.test/mcp",
            REDIRECT,
        );
        expect(failure?.code).toBe("connector_redirect_rejected");
        expect(
            linkUnsupported(
                new Error("x"),
                { status: 400, error: "invalid_client_metadata", description: "client_name is too long" },
                "https://mcp.example.test/mcp",
                REDIRECT,
            ),
        ).toBeNull();
    });

    it("is named when it registers no client at all", async () => {
        // The MCP SDK's own words, from its registerClient.
        const sdkError = await registerClient("https://mcp.asana.com", {
            metadata: {
                issuer: "https://mcp.asana.com",
                authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
                token_endpoint: "https://app.asana.com/-/oauth_token",
                response_types_supported: ["code"],
            },
            clientMetadata: { client_name: "Mike", redirect_uris: [REDIRECT] },
        }).catch((err: unknown) => err);
        const failure = linkUnsupported(
            sdkError,
            null,
            "https://mcp.asana.com/v2/mcp",
            REDIRECT,
        );
        expect(failure?.code).toBe("connector_registration_unsupported");
        expect(failure?.message).toMatch(/^mcp\.asana\.com can't be linked from Mike's NativeCluster app by signing in/);
    });

    it("is not claimed for another failure, or a registration that succeeded", async () => {
        guardedFetchMock.mockImplementation(async () => Response.json({ client_id: "c" }, { status: 201 }));
        const watch = watchRegistration(guardedFetchMock as never);
        await register(watch);
        expect(watch.refused).toBeNull();
        expect(linkUnsupported(new Error("fetch failed"), watch.refused, "https://mcp.example.test/mcp", REDIRECT)).toBeNull();
    });
});
