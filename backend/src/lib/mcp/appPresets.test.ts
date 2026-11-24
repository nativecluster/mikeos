// What Mike's NativeCluster app offers on Settings → Connectors: a preset
// whose provider has no dynamic client registration (Slack, Google's MCP)
// and no client configured here can only fail, so it is not offered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    mcpConnectorSetupInstructions,
    mcpProvidersNeedingSetup,
} from "./oauth";

const CLIENT_ENV = [
    "SLACK_MCP_OAUTH_CLIENT_ID",
    "SLACK_MCP_OAUTH_CLIENT_SECRET",
    "GOOGLE_MCP_OAUTH_CLIENT_ID",
    "GOOGLE_MCP_OAUTH_CLIENT_SECRET",
];

beforeEach(() => {
    for (const key of CLIENT_ENV) vi.stubEnv(key, "");
    vi.stubEnv("MIKE_NC_APP", "");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("providers that need a company-registered client", () => {
    it("are Slack and Google while neither has a client configured", () => {
        expect(mcpProvidersNeedingSetup()).toEqual(["google", "slack"]);
    });

    it("leave the list once their client is configured, secret included", () => {
        vi.stubEnv("SLACK_MCP_OAUTH_CLIENT_ID", "slack-id");
        expect(mcpProvidersNeedingSetup()).toEqual(["google", "slack"]);
        vi.stubEnv("SLACK_MCP_OAUTH_CLIENT_SECRET", "slack-secret");
        expect(mcpProvidersNeedingSetup()).toEqual(["google"]);
    });

    it("are refused in the app in words for the person, and for an operator elsewhere", () => {
        expect(mcpConnectorSetupInstructions("https://mcp.slack.com/mcp")).toMatch(/administrator setup/);
        vi.stubEnv("MIKE_NC_APP", "1");
        const words = mcpConnectorSetupInstructions("https://mcp.slack.com/mcp");
        expect(words).toBe(
            "Slack can't be linked from Mike's NativeCluster app: Slack lets only apps registered with it in advance sign in, and none is set up for this Mike.",
        );
        expect(mcpConnectorSetupInstructions("https://mcp.notion.com/mcp")).toBeNull();
    });
});
