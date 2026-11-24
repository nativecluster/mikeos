import { afterEach, describe, expect, it, vi } from "vitest";

// Every send of the three planes goes out through guardedFetch (CourtListener,
// MCP and its sign-in, web pages) or the search service's fetch: with a
// plane's switch at 0 none of them may be reached.
const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("../../mcp/client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../mcp/client")>()),
    guardedFetch,
}));

import {
    assertNetPlaneOn,
    isNetPlaneOff,
    NET_PLANE_OFF_MESSAGES,
    NET_PLANE_SWITCHES,
    netPlaneOfTool,
    netPlanesOff,
    NetPlaneOffError,
    offNetPlaneToolResult,
} from "../netPlanes";
import { searchCourtlistenerCaseLaw, getCourtlistenerCases } from "../../courtlistener";
import { createWebSearch, readWebPage } from "../../webSearch";
import { fetchJson, refreshOAuthAccessToken } from "../../mcp/oauth";
import { discoverMcpDeviceGrant } from "../../mcp/appLinking";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

function turnOff(...planes: (keyof typeof NET_PLANE_SWITCHES)[]) {
    for (const plane of planes) vi.stubEnv(NET_PLANE_SWITCHES[plane], "0");
}

describe("the net planes' off switches", () => {
    it("are the ones nc-app.json declares, and only 0 turns a plane off", () => {
        expect(NET_PLANE_SWITCHES).toEqual({
            courtlistener: "LB_MIKE_COURTLISTENER",
            websearch: "LB_MIKE_WEBSEARCH",
            mcp: "LB_MIKE_MCP",
        });
        expect(netPlanesOff({})).toEqual([]);
        expect(netPlanesOff({ LB_MIKE_MCP: "1", LB_MIKE_WEBSEARCH: "" })).toEqual([]);
        expect(netPlanesOff({ LB_MIKE_MCP: "0", LB_MIKE_COURTLISTENER: "0" })).toEqual([
            "courtlistener",
            "mcp",
        ]);
        expect(isNetPlaneOff("websearch", { LB_MIKE_WEBSEARCH: "0" })).toBe(true);
    });

    it("name each tool's plane, and answer a call on an off plane in words", () => {
        expect(netPlaneOfTool("courtlistener_search_case_law")).toBe("courtlistener");
        expect(netPlaneOfTool("web_search")).toBe("websearch");
        expect(netPlaneOfTool("read_webpage")).toBe("websearch");
        expect(netPlaneOfTool("mcp_slack_search_1a2b3c4d")).toBe("mcp");
        expect(netPlaneOfTool("read_document")).toBeNull();
        expect(netPlaneOfTool("google_drive_search")).toBeNull();

        expect(offNetPlaneToolResult("web_search")).toBeNull();
        turnOff("websearch");
        expect(JSON.parse(offNetPlaneToolResult("web_search")!)).toEqual({
            ok: false,
            error: NET_PLANE_OFF_MESSAGES.websearch,
        });
        expect(offNetPlaneToolResult("courtlistener_get_cases")).toBeNull();
        expect(offNetPlaneToolResult("read_document")).toBeNull();
    });

    it("throw the plane's words, under connector_unavailable", () => {
        expect(() => assertNetPlaneOn("mcp")).not.toThrow();
        turnOff("mcp");
        const error = (() => {
            try {
                assertNetPlaneOn("mcp");
            } catch (e) {
                return e;
            }
        })();
        expect(error).toBeInstanceOf(NetPlaneOffError);
        expect(error).toMatchObject({
            code: "connector_unavailable",
            message: "MCP connectors are turned off for everyone using Mike on this NativeCluster.",
        });
    });
});

describe("with a plane's switch at 0 nothing is sent to its hosts", () => {
    it("CourtListener: no search and no case is fetched", async () => {
        turnOff("courtlistener");
        await expect(
            searchCourtlistenerCaseLaw({ query: "qualified immunity", apiToken: "t" }),
        ).rejects.toThrow(NET_PLANE_OFF_MESSAGES.courtlistener);
        // Each case reports its own failure, in the plane's words.
        expect(await getCourtlistenerCases({ clusterIds: [123], apiToken: "t" })).toMatchObject({
            cases: [{ clusterId: 123, error: NET_PLANE_OFF_MESSAGES.courtlistener }],
        });
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("web search: no search and no page read", async () => {
        turnOff("websearch");
        const fetch = vi.fn();
        const searchWeb = createWebSearch({ fetch, now: Date.now, sleep: async () => {} });
        await expect(
            searchWeb("the act", { account: { backend: "brave", apiKey: "k" } }),
        ).rejects.toThrow(NET_PLANE_OFF_MESSAGES.websearch);
        await expect(readWebPage("https://law.test/act")).rejects.toThrow(
            NET_PLANE_OFF_MESSAGES.websearch,
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("MCP: no discovery, no device grant and no token refresh", async () => {
        turnOff("mcp");
        await expect(fetchJson("https://mcp.slack.com/.well-known/oauth")).rejects.toThrow(
            NET_PLANE_OFF_MESSAGES.mcp,
        );
        await expect(discoverMcpDeviceGrant("https://mcp.slack.com/mcp")).rejects.toThrow(
            NET_PLANE_OFF_MESSAGES.mcp,
        );
        await expect(refreshOAuthAccessToken({} as never, {} as never)).rejects.toThrow(
            NET_PLANE_OFF_MESSAGES.mcp,
        );
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("a plane that is on still sends", async () => {
        turnOff("mcp", "courtlistener");
        const fetch = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } })));
        const searchWeb = createWebSearch({ fetch, now: Date.now, sleep: async () => {} });
        await searchWeb("the act", { account: { backend: "brave", apiKey: "k" } }).catch(() => {});
        expect(fetch).toHaveBeenCalled();
    });
});
