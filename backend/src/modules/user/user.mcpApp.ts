// Linking connectors from inside Mike's NativeCluster app (MIKE_NC_APP=1):
// the service behind user.mcpApp.routes.ts. See lib/mcp/appLinking.ts.

import { createServerSupabase } from "../../lib/supabase";
import {
    completeMcpConnectorOAuthFromPaste,
    McpLinkError,
    pollMcpDeviceAuthorization,
    type McpDevicePoll,
} from "../../lib/mcp/appLinking";
import { refreshUserMcpConnectorTools } from "../../lib/mcpConnectors";
import { McpOAuthRequiredError } from "../../lib/mcp/oauth";
import { parsePastedAuthorization } from "../../lib/mcp/ncApp";
import { completeGoogleDriveOAuth } from "../../lib/integrations/googleDrive";
import {
    completeWorkspaceOAuth,
    type GoogleProvider,
} from "../../lib/integrations/googleWorkspaceAuth";
import { log } from "../../lib/log";
import type { Db } from "./user.shared";

export const DEVICE_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type DevicePollResult =
    | { ok: true; poll: McpDevicePoll; connector?: unknown }
    | { ok: false; status: number; code?: string; detail: string };

/** One poll of a device grant; on approval, the connector with its tools. */
export async function pollMcpDevice(
    userId: string,
    connectorId: string,
    state: unknown,
    db: Db = createServerSupabase(),
): Promise<DevicePollResult> {
    if (typeof state !== "string" || !DEVICE_STATE_RE.test(state))
        return { ok: false, status: 400, detail: "Invalid authorization attempt." };
    try {
        const poll = await pollMcpDeviceAuthorization(userId, connectorId, state, db);
        if (poll.status !== "connected") return { ok: true, poll };
        const connector = await refreshUserMcpConnectorTools(userId, connectorId, db);
        return { ok: true, poll, connector };
    } catch (err) {
        if (err instanceof McpOAuthRequiredError)
            return { ok: false, status: 409, code: err.code, detail: "Connect again." };
        log.warn("user/mcp-connectors", "device poll failed", { userId, connectorId, error: err });
        return { ok: false, status: 400, detail: "The authorization could not be checked. Try again." };
    }
}

export type PasteResult =
    | { ok: true; connector: unknown }
    | { ok: false; code: string; detail: string };

/** Finishes the code flow from the address the person pasted. */
export async function completeMcpPaste(
    userId: string,
    connectorId: string,
    address: unknown,
    origin: string | null,
    db: Db = createServerSupabase(),
): Promise<PasteResult> {
    try {
        await completeMcpConnectorOAuthFromPaste(userId, connectorId, address, db, origin);
        return { ok: true, connector: await refreshUserMcpConnectorTools(userId, connectorId, db) };
    } catch (err) {
        if (err instanceof McpLinkError) return { ok: false, code: err.code, detail: err.message };
        // Never the pasted address, which holds the code.
        log.warn("user/mcp-connectors", "pasted authorization failed", { userId, connectorId, error: err });
        return {
            ok: false,
            code: "oauth_complete_failed",
            detail: "The authorization could not be completed. Start again.",
        };
    }
}

/**
 * The page a browser sees when it does reach the app's callback (it trusts
 * NativeCluster's CA and is signed in there). No script: nothing to post
 * back to, since the app's window polls for the result.
 */
export function ncAppCallbackPage(success: boolean): { headers: Record<string, string>; html: string } {
    const title = success ? "Connected" : "Not connected";
    const words = success
        ? "The connection is made. You can close this tab and return to Mike."
        : "The connection could not be made. Return to Mike and try again.";
    return {
        headers: {
            "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
        html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#111827;background:#f9fafb}main{max-width:360px;padding:24px;text-align:center}p{color:#6b7280}</style></head><body><main><h1>${title}</h1><p>${words}</p></main></body></html>`,
    };
}

/**
 * The page a browser sees when it reaches a Google callback in app mode: it
 * carries no Mike session, so the person pastes this page's address into
 * Mike, which finishes from there.
 */
export function ncAppPastePage(): { headers: Record<string, string>; html: string } {
    const page = ncAppCallbackPage(false);
    return {
        headers: page.headers,
        html: page.html
            .replace("<title>Not connected</title>", "<title>Almost connected</title>")
            .replace("<h1>Not connected</h1>", "<h1>Almost connected</h1>")
            .replace(
                "The connection could not be made. Return to Mike and try again.",
                "Copy this page's address from the address bar, return to Mike and paste it there.",
            ),
    };
}

export const GOOGLE_PASTE_PROVIDERS = ["google-drive", "gmail", "google-calendar"] as const;
export type GooglePasteProvider = (typeof GOOGLE_PASTE_PROVIDERS)[number];

/**
 * Finishes a Google connection from the address the person pasted. The
 * state must be one this account started (Mike's own check), for this
 * NativeCluster person on this app origin (app mode's).
 */
export async function completeGooglePaste(
    userId: string,
    provider: GooglePasteProvider,
    address: unknown,
    origin: string | null,
    db: Db = createServerSupabase(),
): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    const { code, state, error } = parsePastedAuthorization(address);
    if (error)
        return { ok: false, code: "oauth_denied", detail: "Access was not granted. Start again and approve it." };
    if (!code || !state)
        return {
            ok: false,
            code: "oauth_paste_invalid",
            detail: "That address has no authorization in it. Paste the whole address your browser shows after you approve.",
        };
    try {
        if (provider === "google-drive") await completeGoogleDriveOAuth(userId, state, code, db, { origin });
        else await completeWorkspaceOAuth(db, userId, provider as GoogleProvider, state, code, { origin });
        return { ok: true };
    } catch (err) {
        // Never the pasted address, which holds the code.
        log.warn("google", "pasted authorization failed", { userId, provider, error: err });
        return {
            ok: false,
            code: "oauth_complete_failed",
            detail: "The Google authorization could not be completed. Start again.",
        };
    }
}
