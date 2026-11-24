// Finding an authorization server's metadata. Airtable's MCP server, as
// served on 2026-11-24, names an issuer with a path, whose metadata exists
// only at the RFC 8414 address: looked up anywhere else, adding Airtable
// failed with "Connector settings are invalid or the server could not be
// reached".
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
    authorizationServerMetadataUrls,
    discoverOAuthMetadata,
} from "./oauth";

afterEach(() => {
    vi.unstubAllEnvs();
    guardedFetchMock.mockReset();
    guardedFetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));
});

describe("an authorization server whose issuer has a path", () => {
    it("is looked up where RFC 8414 puts its metadata first", () => {
        expect(authorizationServerMetadataUrls("https://airtable.com/oauth2/v1")).toEqual([
            "https://airtable.com/.well-known/oauth-authorization-server/oauth2/v1",
            "https://airtable.com/.well-known/openid-configuration/oauth2/v1",
            "https://airtable.com/oauth2/v1/.well-known/openid-configuration",
            "https://airtable.com/oauth2/v1/.well-known/oauth-authorization-server",
            "https://airtable.com/oauth2/v1",
        ]);
        expect(authorizationServerMetadataUrls("https://mcp.notion.com")).toEqual([
            "https://mcp.notion.com/.well-known/oauth-authorization-server",
            "https://mcp.notion.com/.well-known/openid-configuration",
            "https://mcp.notion.com",
        ]);
    });

    it("is found for Airtable's MCP server, so adding it asks for authorization instead of failing", async () => {
        // Airtable's answers as served on 2026-11-24: its metadata exists at
        // the RFC 8414 address alone (every appended form is a 404).
        const served: Record<string, () => Response> = {
            "https://mcp.airtable.com/mcp": () =>
                new Response('{"error":"UNAUTHORIZED"}', {
                    status: 401,
                    headers: {
                        "www-authenticate":
                            'Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://mcp.airtable.com/.well-known/oauth-protected-resource"',
                    },
                }),
            "https://mcp.airtable.com/.well-known/oauth-protected-resource": () =>
                Response.json({
                    resource: "https://mcp.airtable.com",
                    authorization_servers: ["https://airtable.com/oauth2/v1"],
                }),
            "https://airtable.com/.well-known/oauth-authorization-server/oauth2/v1": () =>
                Response.json({
                    issuer: "https://airtable.com/oauth2/v1",
                    authorization_endpoint: "https://airtable.com/oauth2/v1/authorize",
                    token_endpoint: "https://airtable.com/oauth2/v1/token",
                    registration_endpoint: "https://airtable.com/oauth2/v1/register",
                }),
        };
        guardedFetchMock.mockImplementation(async (input) => {
            const answer = served[String(input)];
            return answer ? answer() : new Response("not found", { status: 404 });
        });
        await expect(discoverOAuthMetadata("https://mcp.airtable.com/mcp")).resolves.toMatchObject({
            authorizationServer: "https://airtable.com/oauth2/v1",
            authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
            registrationEndpoint: "https://airtable.com/oauth2/v1/register",
        });
    });
});
