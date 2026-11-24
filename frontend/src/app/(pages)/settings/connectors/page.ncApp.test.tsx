import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "./page";
import {
    type McpConnectorSummary,
    MikeApiError,
    createMcpConnector,
    deleteMcpConnector,
    getGoogleDriveStatus,
    getGoogleWorkspaceStatus,
    getMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
    startMcpConnectorOAuth,
} from "@/app/lib/mikeApi";
import { needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";

// Mike as a NativeCluster app (NEXT_PUBLIC_MIKE_NC_APP=1): linking an MCP
// connector opens no popup; the dialog gives a link and takes back the
// address the browser landed on.
const appApi = vi.hoisted(() => ({
    completeMcpAuthorizationFromAddress: vi.fn(),
    pollMcpDeviceAuthorization: vi.fn(),
}));
vi.mock("@/app/components/settings/ConnectorAppApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/components/settings/ConnectorAppApi")>()),
    ...appApi,
}));

// Replace only the network functions the OAuth popup flow drives; keep the real
// MikeApiError / isMfaRequiredError so `instanceof` checks in the page behave.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        listMcpConnectors: vi.fn(),
        createMcpConnector: vi.fn(),
        deleteMcpConnector: vi.fn(),
        refreshMcpConnectorTools: vi.fn(),
        startMcpConnectorOAuth: vi.fn(),
        getMcpConnector: vi.fn(),
        updateMcpConnector: vi.fn(),
        setMcpToolEnabled: vi.fn(),
        // Google answers "not connected" unless a test says otherwise: the
        // page shows placeholders until every connector source has answered.
        getGoogleDriveStatus: vi.fn(async () => ({
            configured: true, available: true, schemaReady: true, connected: false,
            scope: null, enabled: true, writeEnabled: false, requireWriteApproval: false,
            pickerAvailable: false, tools: [], redirectUri: null,
        })),
        startGoogleDriveOAuth: vi.fn(),
        cancelGoogleDriveOAuth: vi.fn(),
        disconnectGoogleDrive: vi.fn(),
        updateGoogleDriveSettings: vi.fn(),
        setGoogleDriveToolEnabled: vi.fn(),
        getGoogleWorkspaceStatus: vi.fn(async () => ({
            configured: true, available: true, schemaReady: true, connected: false,
            writeEnabled: false, enabled: true, requireWriteApproval: false,
            readOnly: false, tools: [], redirectUri: null,
        })),
        updateGoogleWorkspaceSettings: vi.fn(),
        setGoogleWorkspaceToolEnabled: vi.fn(),
    };
});

// The active workspace. Every test runs in Personal unless it says otherwise.
const workspaceState = vi.hoisted(() => ({
    workspaceId: "personal" as string | null,
    activeOrganization: null as { id: string; name: string } | null,
    // Only Personal unless a test says otherwise.
    organizations: [] as { id: string; name: string }[] | null,
}));
vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/contexts/WorkspaceContext")>()),
    useWorkspace: () => ({
        workspaceId: workspaceState.workspaceId,
        activeOrganization: workspaceState.activeOrganization,
        organizations: workspaceState.organizations,
    }),
}));

beforeEach(() => {
    offPlanes.planes = [];
    offPlanes.setupRequired = [];
    workspaceState.workspaceId = "personal";
    workspaceState.activeOrganization = null;
    workspaceState.organizations = [];
    courtListener.workspaces = [];
});

// CourtListener's state and dialog have their own tests; here a test sets
// where the page should place it, and sees which workspace it was asked for.
const courtListener = vi.hoisted(() => ({
    loading: false,
    loadFailed: false,
    installed: false,
    enabled: true,
    setEnabled: vi.fn(),
    status: null as null | { tokenSource: "user" | "org" | null; bulkData: boolean },
    workspaces: [] as (string | undefined)[],
}));
vi.mock("@/app/components/settings/CourtListenerConnector", () => ({
    COURTLISTENER_NAME: "CourtListener",
    CourtListenerIcon: () => null,
    CourtListenerTokenModal: ({ open }: { open: boolean }) =>
        open ? <div role="dialog" aria-label="CourtListener token" /> : null,
    useCourtListenerConnector: (workspace?: string) => {
        courtListener.workspaces.push(workspace);
        return {
            ...courtListener,
            busy: false,
            saveToken: vi.fn(),
            deleteToken: vi.fn(),
        };
    },
}));

// The connectors NativeCluster turned off for everyone, and the MCP
// providers that cannot link here, as the profile says.
const offPlanes = vi.hoisted(() => ({ planes: [] as string[], setupRequired: [] as string[] }));
vi.mock("@/app/hooks/useConnectorsOff", () => ({
    useConnectorsOff: () => ({
        off: (plane: string) => offPlanes.planes.includes(plane),
        mcpSetupRequired: offPlanes.setupRequired,
        loading: false,
    }),
}));

// MFA gate off, and render nothing for the popup itself.
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(),
}));

function makeSummary(
    overrides: Partial<McpConnectorSummary> = {},
): McpConnectorSummary {
    return {
        id: "connector-1",
        name: "Drive",
        transport: "streamable_http",
        serverUrl: "https://drivemcp.googleapis.com/mcp",
        authType: "oauth",
        enabled: true,
        requireWriteApproval: false,
        hasAuthConfig: false,
        customHeaderKeys: [],
        oauthConnected: false,
        toolPolicy: {},
        tools: [],
        toolCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

async function flushMicrotasks() {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function addCustomConnector() {
    render(<ConnectorsPage />);
    await act(async () => {
        await flushMicrotasks();
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom connector" }));
    fireEvent.change(screen.getByPlaceholderText("Connector label"), { target: { value: "Files" } });
    fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
        target: { value: "https://mcp.example.com/mcp" },
    });
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        await flushMicrotasks();
    });
}

describe("ConnectorsPage in the NativeCluster app", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        workspaceState.workspaceId = "personal";
        workspaceState.activeOrganization = null;
        workspaceState.organizations = [];
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(createMcpConnector).mockResolvedValue({
            connector: makeSummary(),
            oauthRequired: true,
        });
        vi.mocked(deleteMcpConnector).mockResolvedValue(undefined);
        vi.mocked(getMcpConnector).mockResolvedValue(makeSummary({ oauthConnected: false }));
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue(makeSummary({ oauthConnected: true }));
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it("links by the pasted address, with no popup", async () => {
        const open = vi.spyOn(window, "open");
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: "https://as.example/authorize?state=s",
            alreadyAuthorized: false,
            callbackOrigin: "https://127.0.0.1:8494",
        });
        appApi.completeMcpAuthorizationFromAddress.mockResolvedValue({ connector: makeSummary() });
        await addCustomConnector();

        expect(open).not.toHaveBeenCalled();
        const link = await screen.findByRole("link", { name: /open the sign-in page/i });
        expect(link.getAttribute("href")).toBe("https://as.example/authorize?state=s");
        fireEvent.change(screen.getByLabelText("Address from your browser"), {
            target: { value: "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback?code=c&state=s" },
        });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Connect" }).at(-1)!);
            await flushMicrotasks();
        });
        expect(appApi.completeMcpAuthorizationFromAddress).toHaveBeenCalledWith(
            "connector-1",
            "https://127.0.0.1:8494/api/user/mcp-connectors/oauth/callback?code=c&state=s",
        );
        expect(refreshMcpConnectorTools).toHaveBeenCalledWith("connector-1");
        expect(screen.queryByLabelText("Address from your browser")).toBeNull();
    });

    it("shows the device code when the server offers the device grant", async () => {
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: false,
            callbackOrigin: "https://127.0.0.1:8494",
            device: {
                state: "st-0123456789abcdef",
                userCode: "WDJB-MJHT",
                verificationUri: "https://as.example/activate",
                verificationUriComplete: null,
                interval: 5,
                expiresIn: 600,
            },
        } as Awaited<ReturnType<typeof startMcpConnectorOAuth>>);
        appApi.pollMcpDeviceAuthorization.mockResolvedValue({ status: "connected" });
        await addCustomConnector();
        expect(await screen.findByTestId("app-link-user-code")).toHaveTextContent("WDJB-MJHT");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
            await flushMicrotasks();
        });
        expect(appApi.pollMcpDeviceAuthorization).toHaveBeenCalledWith("connector-1", "st-0123456789abcdef");
        expect(refreshMcpConnectorTools).toHaveBeenCalledWith("connector-1");
    });

    it("removes the half-made connector when the person cancels", async () => {
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: "https://as.example/authorize?state=s",
            alreadyAuthorized: false,
            callbackOrigin: "https://127.0.0.1:8494",
        });
        await addCustomConnector();
        await screen.findByLabelText("Address from your browser");
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
            await flushMicrotasks();
        });
        expect(deleteMcpConnector).toHaveBeenCalledWith("connector-1");
    });
});

describe("ConnectorsPage's buttons in the NativeCluster app", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        // As Mike's package ships: no Slack or Google client, so the
        // profile names both.
        offPlanes.setupRequired = ["google", "slack"];
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(deleteMcpConnector).mockResolvedValue(undefined);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    async function renderPage() {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
    }

    it("offers no Slack, whose sign-in needs a client nobody set up here, and every preset that can link", async () => {
        await renderPage();
        expect(screen.queryByRole("button", { name: "Add Slack connector" })).toBeNull();
        for (const name of ["Notion", "Airtable", "Linear", "Lawve", "Legal Data Hunter", "CourtListener"])
            expect(screen.getByRole("button", { name: `Add ${name} connector` })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add custom connector" })).toBeInTheDocument();
    });

    it("links a preset in the app's own dialog, with no popup", async () => {
        const open = vi.spyOn(window, "open");
        const notion = makeSummary({ id: "notion-1", name: "Notion", serverUrl: "https://mcp.notion.com/mcp" });
        vi.mocked(createMcpConnector).mockResolvedValue({ connector: notion, oauthRequired: true });
        vi.mocked(getMcpConnector).mockResolvedValue(notion);
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: "https://mcp.notion.com/authorize?state=s",
            alreadyAuthorized: false,
            callbackOrigin: "https://127.0.0.1:8494",
        });
        await renderPage();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Notion connector" }));
            await flushMicrotasks();
        });
        expect(createMcpConnector).toHaveBeenCalledWith(
            { name: "Notion", serverUrl: "https://mcp.notion.com/mcp", bearerToken: null },
            "personal",
        );
        const link = await screen.findByRole("link", { name: /open the sign-in page/i });
        expect(link.getAttribute("href")).toBe("https://mcp.notion.com/authorize?state=s");
        expect(screen.getByLabelText("Address from your browser")).toBeInTheDocument();
        expect(open).not.toHaveBeenCalled();
        expect(screen.queryByText("Could not add connector")).toBeNull();
    });

    it("connects a custom server by its token, with no sign-in", async () => {
        const files = makeSummary({
            id: "files-1",
            name: "Files",
            serverUrl: "https://mcp.example.com/mcp",
            authType: "bearer",
            hasAuthConfig: true,
            tools: [
                {
                    id: "t1", toolName: "search", openaiToolName: "files_search", title: "Search",
                    description: null, enabled: true, write: false,
                } as McpConnectorSummary["tools"][number],
            ],
            toolCount: 1,
        });
        vi.mocked(createMcpConnector).mockResolvedValue({ connector: files, oauthRequired: false });
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        fireEvent.click(screen.getByRole("button", { name: "Add custom connector" }));
        fireEvent.change(screen.getByPlaceholderText("Connector label"), { target: { value: "Files" } });
        fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
            target: { value: "https://mcp.example.com/mcp" },
        });
        fireEvent.change(screen.getByPlaceholderText("Bearer token"), { target: { value: "tok-1" } });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Connect" }));
            await flushMicrotasks();
        });
        expect(createMcpConnector).toHaveBeenCalledWith(
            { name: "Files", serverUrl: "https://mcp.example.com/mcp", bearerToken: "tok-1" },
            "personal",
        );
        expect(startMcpConnectorOAuth).not.toHaveBeenCalled();
        expect(await screen.findByText(/Files is connected\./)).toBeInTheDocument();
    });

    it("says in words when a server's sign-in can't finish from the app, with no operator's guide", async () => {
        const words =
            "mcp.example.com won't send you back to Mike after you sign in: it refuses Mike's address on this computer (https://127.0.0.1:8494), so it can't be linked from Mike's NativeCluster app by signing in.";
        vi.mocked(createMcpConnector).mockResolvedValue({ connector: makeSummary(), oauthRequired: true });
        vi.mocked(startMcpConnectorOAuth).mockRejectedValue(
            new MikeApiError({ message: words, status: 400, code: "connector_redirect_rejected" }),
        );
        await addCustomConnector();
        expect(await screen.findByText("Could not add connector")).toBeInTheDocument();
        expect(screen.getByText(words)).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open connector setup guide" })).toBeNull();
        expect(deleteMcpConnector).toHaveBeenCalledWith("connector-1");
    });

    it("shows no operator's guide for a Slack address typed into Custom", async () => {
        vi.mocked(createMcpConnector).mockRejectedValue(
            new MikeApiError({
                message: "Slack can't be linked from Mike's NativeCluster app.",
                status: 400,
                code: "connector_setup_required",
            }),
        );
        await addCustomConnector();
        expect(await screen.findByText("Slack can't be linked from Mike's NativeCluster app.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Open connector setup guide" })).toBeNull();
    });
});

describe("ConnectorsPage with a connector NativeCluster turned off for everyone", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        vi.mocked(listMcpConnectors).mockResolvedValue([makeSummary({ name: "Files", serverUrl: "https://mcp.example.com/mcp" })]);
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllEnvs();
    });

    async function renderPage() {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
    }

    it("offers every connector while each plane is on", async () => {
        await renderPage();
        expect(screen.getByRole("button", { name: "Add custom connector" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add Slack connector" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add CourtListener connector" })).toBeInTheDocument();
        expect(screen.getByText("Files")).toBeInTheDocument();
    });

    it("MCP off: no MCP connector, preset or Custom button", async () => {
        offPlanes.planes = ["mcp"];
        await renderPage();
        expect(screen.queryByRole("button", { name: "Add custom connector" })).toBeNull();
        for (const name of ["Slack", "Notion", "Airtable", "Linear", "Lawve", "Legal Data Hunter"])
            expect(screen.queryByRole("button", { name: `Add ${name} connector` })).toBeNull();
        expect(screen.queryByText("Files")).toBeNull();
        expect(screen.getByRole("button", { name: "Add CourtListener connector" })).toBeInTheDocument();
    });

    it("CourtListener off: no CourtListener card, installed or not", async () => {
        offPlanes.planes = ["courtlistener"];
        await renderPage();
        expect(screen.queryByRole("button", { name: "Add CourtListener connector" })).toBeNull();
        courtListener.installed = true;
        cleanup();
        await renderPage();
        expect(screen.queryByText("CourtListener")).toBeNull();
        courtListener.installed = false;
        expect(screen.getByRole("button", { name: "Add Slack connector" })).toBeInTheDocument();
    });

    it("both off, and Google unavailable as in the app: nothing is offered and Discover says nothing", async () => {
        offPlanes.planes = ["courtlistener", "mcp"];
        vi.mocked(getGoogleDriveStatus).mockResolvedValueOnce({
            ...(await getGoogleDriveStatus()),
            available: false,
        });
        vi.mocked(getGoogleWorkspaceStatus).mockImplementation(async () => ({
            configured: true, available: false, schemaReady: true, connected: false,
            writeEnabled: false, enabled: true, requireWriteApproval: false,
            readOnly: false, tools: [], redirectUri: null,
        }));
        await renderPage();
        expect(screen.queryByRole("button", { name: /^Add .* connector$/ })).toBeNull();
        expect(screen.queryByText("Every available connector is installed.")).toBeNull();
    });
});
