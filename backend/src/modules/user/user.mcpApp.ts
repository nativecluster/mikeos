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
