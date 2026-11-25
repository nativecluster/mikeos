import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Response } from "express";

// Mike's NativeCluster app: a connector whose net plane NativeCluster turned
// off for everyone (its off switch at 0, lib/nc/netPlanes.ts) is refused in
// words by every route that would reach its hosts, link an account there or
// save a key for it, and the reads that only list Mike's own rows answer as
// if nothing were set up. modules/user/user.netPlanes.routes.ts.

const { listUserMcpConnectors, createUserMcpConnector, startUserMcpConnectorOAuth, saveWebSearchSettings, saveApiKey, getCourtlistenerCaseOpinions } =
    vi.hoisted(() => ({
        listUserMcpConnectors: vi.fn(async () => [{ id: "c1" }]),
        createUserMcpConnector: vi.fn(),
        startUserMcpConnectorOAuth: vi.fn(),
        saveWebSearchSettings: vi.fn(),
        saveApiKey: vi.fn(),
        getCourtlistenerCaseOpinions: vi.fn(),
    }));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({})),
}));
vi.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: Response, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: Response, next: () => void) => next(),
}));
vi.mock("../../lib/mcpConnectors", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/mcpConnectors")>()),
    listUserMcpConnectors,
    createUserMcpConnector,
    startUserMcpConnectorOAuth,
}));
vi.mock("../../modules/user/user.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../modules/user/user.service")>()),
    saveWebSearchSettings,
    saveApiKey,
}));
vi.mock("../../lib/courtlistener", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/courtlistener")>()),
    getCourtlistenerCaseOpinions,
}));

import { app } from "../../app";
import { NET_PLANE_OFF_MESSAGES } from "../../lib/nc/netPlanes";
import { netPlaneOfUserRoute } from "../../modules/user/user.netPlanes.routes";
import { serializeProfile } from "../../modules/user/user.profile.serialization";

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const refused = (plane: keyof typeof NET_PLANE_OFF_MESSAGES) => ({
    code: "connector_unavailable",
    detail: NET_PLANE_OFF_MESSAGES[plane],
});

describe("the routes of a plane that is off for everyone", () => {
    it("names each route's plane, and leaves every other route alone", () => {
        expect(netPlaneOfUserRoute("GET", "/mcp-connectors")).toBe("mcp");
        expect(netPlaneOfUserRoute("POST", "/mcp-connectors/c1/oauth/device/poll")).toBe("mcp");
        expect(netPlaneOfUserRoute("GET", "/mcp-connectors/oauth/callback")).toBe("mcp");
        expect(netPlaneOfUserRoute("PUT", "/integrations/courtlistener/token")).toBe("courtlistener");
        expect(netPlaneOfUserRoute("PUT", "/web-search")).toBe("websearch");
        expect(netPlaneOfUserRoute("GET", "/web-search")).toBeNull();
        expect(netPlaneOfUserRoute("PUT", "/api-keys/brave")).toBe("websearch");
        expect(netPlaneOfUserRoute("PUT", "/api-keys/tavily")).toBe("websearch");
        expect(netPlaneOfUserRoute("PUT", "/api-keys/claude")).toBeNull();
        expect(netPlaneOfUserRoute("GET", "/profile")).toBeNull();
        expect(netPlaneOfUserRoute("GET", "/integrations/google-drive")).toBeNull();
    });

    it("MCP: the list is empty, and adding or linking one is refused in words", async () => {
        vi.stubEnv("LB_MIKE_MCP", "0");
        expect((await request(app).get("/user/mcp-connectors")).body).toEqual([]);
        const add = await request(app)
            .post("/user/mcp-connectors")
            .send({ name: "Slack", serverUrl: "https://mcp.slack.com/mcp" });
        expect(add.status).toBe(404);
        expect(add.body).toEqual(refused("mcp"));
        const link = await request(app).post("/user/mcp-connectors/c1/oauth/start");
        expect(link.body).toEqual(refused("mcp"));
        expect(listUserMcpConnectors).not.toHaveBeenCalled();
        expect(createUserMcpConnector).not.toHaveBeenCalled();
        expect(startUserMcpConnectorOAuth).not.toHaveBeenCalled();
    });

    // Review L1: Express routes a path whatever its case, and the guard read
    // it as written, so POST /user/MCP-Connectors reached the connector's
    // create (a DNS query for the caller's name, the key kept) with MCP off.
    it("refuses a route whatever the case or a trailing slash of its path", async () => {
        vi.stubEnv("LB_MIKE_MCP", "0");
        vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
        vi.stubEnv("LB_MIKE_COURTLISTENER", "0");
        for (const path of ["/user/MCP-Connectors", "/user/mcp-CONNECTORS/", "/USER/Mcp-Connectors"]) {
            const add = await request(app).post(path).send({ name: "x", serverUrl: "https://bob-chosen.example.test/mcp" });
            expect(add.status, path).toBe(404);
            expect(add.body, path).toEqual(refused("mcp"));
        }
        expect((await request(app).post("/user/Mcp-Connectors/c1/OAuth/Start")).body).toEqual(refused("mcp"));
        expect((await request(app).get("/user/MCP-connectors/")).body).toEqual([]);
        expect((await request(app).put("/user/Web-Search").send({ enabled: true })).body).toEqual(refused("websearch"));
        expect((await request(app).put("/user/web-search/").send({ enabled: true })).body).toEqual(refused("websearch"));
        expect((await request(app).put("/user/API-Keys/Brave").send({ api_key: "k" })).body).toEqual(refused("websearch"));
        expect((await request(app).put("/user/Integrations/CourtListener/Token").send({ token: "t" })).body).toEqual(
            refused("courtlistener"),
        );
        expect(netPlaneOfUserRoute("POST", "/MCP-Connectors")).toBe("mcp");
        expect(netPlaneOfUserRoute("PUT", "/API-KEYS/TAVILY/")).toBe("websearch");
        expect(createUserMcpConnector).not.toHaveBeenCalled();
        expect(startUserMcpConnectorOAuth).not.toHaveBeenCalled();
        expect(saveWebSearchSettings).not.toHaveBeenCalled();
        expect(saveApiKey).not.toHaveBeenCalled();
    });

    it("CourtListener: its status says unavailable, and its switch and token are refused", async () => {
        vi.stubEnv("LB_MIKE_COURTLISTENER", "0");
        const status = await request(app).get("/user/integrations/courtlistener");
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({ available: false, installed: false, enabled: false });
        for (const res of [
            await request(app).patch("/user/integrations/courtlistener").send({ enabled: true }),
            await request(app).put("/user/integrations/courtlistener/token").send({ token: "t" }),
        ]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(refused("courtlistener"));
        }
    });

    it("CourtListener: a case is not fetched for the panel", async () => {
        vi.stubEnv("LB_MIKE_COURTLISTENER", "0");
        const res = await request(app).get("/documents/case:123");
        expect(res.status).toBe(404);
        expect(res.body).toEqual(refused("courtlistener"));
        expect(getCourtlistenerCaseOpinions).not.toHaveBeenCalled();
    });

    it("web search: its settings and its keys are refused in words", async () => {
        vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
        const settings = await request(app).put("/user/web-search").send({ enabled: true });
        expect(settings.status).toBe(404);
        expect(settings.body).toEqual(refused("websearch"));
        const key = await request(app).put("/user/api-keys/brave").send({ api_key: "k" });
        expect(key.body).toEqual(refused("websearch"));
        expect(saveWebSearchSettings).not.toHaveBeenCalled();
        expect(saveApiKey).not.toHaveBeenCalled();
    });

    it("the profile names the planes that are off, for the pages to hide", () => {
        vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
        vi.stubEnv("LB_MIKE_MCP", "0");
        expect(serializeProfile({} as never, {} as never).connectorsOff).toEqual(["websearch", "mcp"]);
        vi.unstubAllEnvs();
        expect(serializeProfile({} as never, {} as never).connectorsOff).toEqual([]);
    });

    it("the profile names the MCP providers that cannot link here, in the app alone", () => {
        for (const key of ["SLACK_MCP_OAUTH_CLIENT_ID", "SLACK_MCP_OAUTH_CLIENT_SECRET", "GOOGLE_MCP_OAUTH_CLIENT_ID", "GOOGLE_MCP_OAUTH_CLIENT_SECRET"])
            vi.stubEnv(key, "");
        vi.stubEnv("MIKE_NC_APP", "1");
        expect(serializeProfile({} as never, {} as never).mcpSetupRequired).toEqual(["google", "slack"]);
        vi.stubEnv("SLACK_MCP_OAUTH_CLIENT_ID", "slack-id");
        vi.stubEnv("SLACK_MCP_OAUTH_CLIENT_SECRET", "slack-secret");
        expect(serializeProfile({} as never, {} as never).mcpSetupRequired).toEqual(["google"]);
        // Elsewhere an operator reads the setup steps instead: nothing hidden.
        vi.stubEnv("MIKE_NC_APP", "");
        expect(serializeProfile({} as never, {} as never).mcpSetupRequired).toEqual([]);
    });
});
