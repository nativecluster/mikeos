// Google Drive, Gmail and Calendar in Mike's NativeCluster app (MIKE_NC_APP=1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    browseGoogleDriveFiles,
    completeGoogleDriveOAuth,
    createGoogleDrivePickerSession,
    disconnectGoogleDrive,
    getGoogleDriveStatus,
    GoogleDriveUnavailableError,
    startGoogleDriveOAuth,
} from "../googleDrive";
import {
    isWorkspaceProviderAvailable,
    startWorkspaceOAuth,
} from "../googleWorkspaceAuth";
import { decryptString, setConnectorEncryptionSecret } from "../../mcp/client";
import { forgetResolvedHostSecrets, HOST_SECRET_IV } from "../../mcp/hostSecretColumns";
import { configureNcAppConnectors, resetNcAppConnectors, withNcPerson } from "../../mcp/ncApp";
import { memoryHostSecrets } from "../../mcp/ncSecrets";
import { personalConnectorOwner } from "../../connectorOwner";
import * as sentry from "../../observability/sentry";
import { driveDb } from "./googleDriveDb";

const ORIGIN = "https://127.0.0.1:8494";
const REDIRECT = `${ORIGIN}/api/user/integrations/google-drive/oauth/callback`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let store: ReturnType<typeof memoryHostSecrets>;

beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    for (const key of [
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "GOOGLE_MCP_OAUTH_CLIENT_ID",
        "GOOGLE_MCP_OAUTH_CLIENT_SECRET",
        "GOOGLE_WORKSPACE_OAUTH_CLIENT_ID",
        "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET",
        "GOOGLE_DRIVE_PICKER_API_KEY",
        "GOOGLE_DRIVE_PICKER_APP_ID",
        "GOOGLE_WORKSPACE_DISABLED_PROVIDERS",
        "MIKE_NC_GOOGLE_CONNECTORS",
    ])
        vi.stubEnv(key, "");
    setConnectorEncryptionSecret("k".repeat(64));
    store = memoryHostSecrets();
    configureNcAppConnectors({ secrets: store });
    forgetResolvedHostSecrets();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(sentry, "reportError").mockReturnValue(null);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetNcAppConnectors();
    setConnectorEncryptionSecret(null);
});

function withClient() {
    vi.stubEnv("MIKE_NC_GOOGLE_CONNECTORS", "1");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "client-secret");
}

describe("Google in the app's first version", () => {
    it("is not offered even with a client, and Drive's routes refuse it in words", async () => {
        vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "client-id");
        vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "client-secret");
        vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", "ws-id");
        vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "ws-secret");
        const { db } = driveDb();
        const owner = personalConnectorOwner("u1");
        expect(await getGoogleDriveStatus(owner, db)).toMatchObject({ available: false, pickerAvailable: false });
        await expect(startGoogleDriveOAuth(owner, REDIRECT, db)).rejects.toThrow("Google Drive is not offered");
        await expect(browseGoogleDriveFiles(owner, {}, db)).rejects.toBeInstanceOf(GoogleDriveUnavailableError);
        expect(isWorkspaceProviderAvailable("gmail")).toBe(false);
        expect(isWorkspaceProviderAvailable("google-calendar")).toBe(false);
    });
});

describe("Google in the app, switched on, without a Google OAuth client", () => {
    beforeEach(() => vi.stubEnv("MIKE_NC_GOOGLE_CONNECTORS", "1"));

    it("offers no Drive, Gmail or Calendar, and starting one says it is not offered", async () => {
        const { db } = driveDb();
        const status = await getGoogleDriveStatus(personalConnectorOwner("u1"), db);
        expect(status).toMatchObject({ configured: false, available: false, pickerAvailable: false });
        await expect(startGoogleDriveOAuth(personalConnectorOwner("u1"), REDIRECT, db)).rejects.toBeInstanceOf(
            GoogleDriveUnavailableError,
        );
        expect(isWorkspaceProviderAvailable("gmail")).toBe(false);
        expect(isWorkspaceProviderAvailable("google-calendar")).toBe(false);
    });

    it("is unchanged outside app mode: the card stays, with its setup steps", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        const { db } = driveDb();
        expect(await getGoogleDriveStatus(personalConnectorOwner("u1"), db)).toMatchObject({
            configured: false,
            available: true,
        });
        expect(isWorkspaceProviderAvailable("gmail")).toBe(true);
    });
});

describe("Google in the app with a Google OAuth client", () => {
    it("is offered, without the Picker, which cannot load in the app's window", async () => {
        withClient();
        vi.stubEnv("GOOGLE_DRIVE_PICKER_API_KEY", "key");
        vi.stubEnv("GOOGLE_DRIVE_PICKER_APP_ID", "app");
        const { db } = driveDb();
        expect(await getGoogleDriveStatus(personalConnectorOwner("u1"), db)).toMatchObject({
            configured: true,
            available: true,
            pickerAvailable: false,
        });
        expect(isWorkspaceProviderAvailable("gmail")).toBe(true);
        await expect(createGoogleDrivePickerSession(personalConnectorOwner("u1"), db)).rejects.toMatchObject({
            code: "google_drive_picker_unavailable",
        });
    });

    it("links from the pasted address, for the same person and origin, and keeps the tokens with the host", async () => {
        withClient();
        const drive = driveDb();
        const { authorizationUrl } = await withNcPerson("p_alice", () =>
            startGoogleDriveOAuth(personalConnectorOwner("u1"), REDIRECT, drive.db),
        );
        const url = new URL(authorizationUrl);
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
        expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
        const state = url.searchParams.get("state")!;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown) =>
                String(input).endsWith("/userinfo")
                    ? json({ email: "a@example.com", email_verified: true })
                    : json({
                          access_token: "g-access",
                          refresh_token: "g-refresh",
                          scope: "https://www.googleapis.com/auth/drive.file",
                          expires_in: 3600,
                      }),
            ),
        );
        // Another person, or another origin, cannot finish it.
        await expect(
            withNcPerson("p_bob", () => completeGoogleDriveOAuth("u1", state, "code", drive.db, { origin: ORIGIN })),
        ).rejects.toThrow(/another person/);
        await expect(
            withNcPerson("p_alice", () =>
                completeGoogleDriveOAuth("u1", state, "code", drive.db, { origin: "https://127.0.0.1:8495" }),
            ),
        ).rejects.toThrow(/another origin/);
        await withNcPerson("p_alice", () => completeGoogleDriveOAuth("u1", state, "code", drive.db, { origin: ORIGIN }));
        const row = drive.tokens[0];
        expect(row.access_token_iv).toBe(HOST_SECRET_IV);
        expect(JSON.stringify(row)).not.toContain("g-access");
        expect(JSON.stringify(row)).not.toContain("g-refresh");
        expect([...store.values.values()].sort()).toEqual(["g-access", "g-refresh"]);
        expect([...store.values.keys()].every((k) => k.startsWith("mike:p_alice:gdrive:"))).toBe(true);

        // Read back after a restart; then disconnecting deletes what the host kept.
        forgetResolvedHostSecrets();
        await withNcPerson("p_alice", async () => {
            const status = await getGoogleDriveStatus(personalConnectorOwner("u1"), drive.db);
            expect(status.connected).toBe(true);
            expect(
                decryptString(
                    String(drive.tokens[0].encrypted_access_token),
                    String(drive.tokens[0].access_token_iv),
                    String(drive.tokens[0].access_token_tag),
                ),
            ).toBe("g-access");
            await disconnectGoogleDrive(personalConnectorOwner("u1"), drive.db);
        });
        expect(store.values.size).toBe(0);
    });

    it("asks for drive.readonly too only when the app is set to", async () => {
        withClient();
        vi.stubEnv("MIKE_NC_GOOGLE_DRIVE_READONLY", "1");
        const { db } = driveDb();
        const { authorizationUrl } = await withNcPerson("p_alice", () =>
            startGoogleDriveOAuth(personalConnectorOwner("u1"), REDIRECT, db),
        );
        expect(new URL(authorizationUrl).searchParams.get("scope")).toContain(
            "https://www.googleapis.com/auth/drive.readonly",
        );
    });

    it("lists the Drive files the connection reaches, on the server, in place of the Picker", async () => {
        withClient();
        const drive = driveDb();
        const owner = personalConnectorOwner("u1");
        await withNcPerson("p_alice", async () => {
            const { authorizationUrl } = await startGoogleDriveOAuth(owner, REDIRECT, drive.db);
            const state = new URL(authorizationUrl).searchParams.get("state")!;
            const calls: string[] = [];
            vi.stubGlobal(
                "fetch",
                vi.fn(async (input: unknown, init?: RequestInit) => {
                    const url = String(input);
                    calls.push(url);
                    if (url.endsWith("/userinfo")) return json({ email: "a@example.com", email_verified: true });
                    if (url.includes("/drive/v3/files")) {
                        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer g-access");
                        return json({
                            nextPageToken: "next-1",
                            files: [
                                {
                                    id: "f1",
                                    name: "Lease.docx",
                                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                    modifiedTime: "2026-11-20T10:00:00Z",
                                    webViewLink: "https://docs.google.com/document/d/f1",
                                },
                                { id: "f2", name: "Notes", webViewLink: "javascript:alert(1)" },
                            ],
                        });
                    }
                    return json({
                        access_token: "g-access",
                        refresh_token: "g-refresh",
                        scope: "https://www.googleapis.com/auth/drive.file",
                        expires_in: 3600,
                    });
                }),
            );
            await completeGoogleDriveOAuth("u1", state, "code", drive.db, { origin: ORIGIN });
            const page = await browseGoogleDriveFiles(owner, { query: "Lea'se" }, drive.db);
            expect(page.nextPageToken).toBe("next-1");
            expect(page.files).toEqual([
                expect.objectContaining({ id: "f1", name: "Lease.docx", webViewLink: "https://docs.google.com/document/d/f1" }),
                expect.objectContaining({ id: "f2", name: "Notes", webViewLink: null }),
            ]);
            const listed = new URL(calls.find((c) => c.includes("/drive/v3/files"))!);
            expect(listed.searchParams.get("q")).toContain("name contains 'Lea\\'se'");
        });
    });

    it("starts Gmail with the person and the app's origin bound to the attempt", async () => {
        vi.stubEnv("MIKE_NC_GOOGLE_CONNECTORS", "1");
        vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", "ws-id");
        vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "ws-secret");
        const drive = driveDb();
        const { authorizationUrl } = await withNcPerson("p_alice", () =>
            startWorkspaceOAuth(
                drive.db,
                personalConnectorOwner("u1"),
                "gmail",
                `${ORIGIN}/api/user/integrations/gmail/oauth/callback`,
            ),
        );
        expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
            `${ORIGIN}/api/user/integrations/gmail/oauth/callback`,
        );
        const row = drive.states[0];
        const config = JSON.parse(
            decryptString(String(row.encrypted_state_config), String(row.state_config_iv), String(row.state_config_tag))!,
        );
        expect(config).toMatchObject({ person: "p_alice", origin: ORIGIN });
    });
});
