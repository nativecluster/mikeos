// Linking an MCP connector's account from inside Mike's NativeCluster app
// (MIKE_NC_APP=1). See ncApp.ts for why: nothing can call into the app but
// NativeCluster's host, the app's origin is https://127.0.0.1:<port> under a
// CA the person's browser does not trust, and the browser is not signed in
// to NativeCluster, so a provider's redirect lands in the browser and stops
// there. The ways, in order:
//
// 1. The device grant (RFC 8628), when the server's authorization server
//    advertises a device_authorization_endpoint: the page shows a code and
//    a link, and polls.
// 2. The authorization code with PKCE, redirected to the app's own page
//    (`https://127.0.0.1:<port>/api/user/mcp-connectors/oauth/callback`).
//    If the browser does reach the app (it trusts NativeCluster's CA and is
//    signed in there), the callback finishes it. Otherwise the person copies
//    the address the browser landed on and pastes it into Mike
//    (completeMcpConnectorOAuthFromPaste): the code and state are in it.
// 3. A pasted token or headers, as before (create/update with bearerToken).

import crypto from "node:crypto";
import { createServerSupabase } from "../supabase";
import {
    base64Url,
    decryptString,
    encryptString,
    guardedFetch,
    loadConnector,
    stateHash,
} from "./client";
import {
    DbMcpOAuthProvider,
    completeMcpConnectorOAuthAuthorization,
    discoverProtectedResourceMetadataUrl,
    fetchAuthorizationServerMetadata,
    fetchJson,
    loadOAuthToken,
    oauthClientEnvFor,
    storeOAuthToken,
} from "./oauth";
import { currentNcPerson, parsePastedAuthorization } from "./ncApp";
import { OAUTH_STATE_TTL_MS, type ConnectorRow, type Db, type OAuthStateConfig } from "./types";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What the page shows for the device grant. Nothing secret: the code is the person's to type. */
export type McpDeviceAuthorization = {
    state: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    interval: number;
    expiresIn: number;
};

/** A linking failure whose message is repo-authored and safe to show. */
export class McpLinkError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
        this.name = "McpLinkError";
    }
}

type DeviceDiscovery = {
    authorizationServer: string;
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string | null;
    scope: string | null;
    resource: string;
};

/**
 * The server's device grant, when its authorization server offers one;
 * null when it does not, or when discovery fails (the code flow then runs
 * and reports its own errors).
 */
export async function discoverMcpDeviceGrant(
    serverUrl: string,
): Promise<DeviceDiscovery | null> {
    try {
        const metadataUrl = await discoverProtectedResourceMetadataUrl(serverUrl);
        const resourceMetadata = await fetchJson(metadataUrl);
        const servers = resourceMetadata.authorization_servers;
        const authorizationServer =
            Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
        if (!authorizationServer) return null;
        const metadata = await fetchAuthorizationServerMetadata(authorizationServer);
        const device = metadata.device_authorization_endpoint;
        const token = metadata.token_endpoint;
        if (typeof device !== "string" || typeof token !== "string") return null;
        const grants = metadata.grant_types_supported;
        if (Array.isArray(grants) && !grants.includes(DEVICE_CODE_GRANT)) return null;
        const scopes = Array.isArray(resourceMetadata.scopes_supported)
            ? resourceMetadata.scopes_supported.filter((s): s is string => typeof s === "string")
            : [];
        return {
            authorizationServer,
            deviceAuthorizationEndpoint: device,
            tokenEndpoint: token,
            registrationEndpoint:
                typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : null,
            scope: scopes.length ? scopes.join(" ") : null,
            resource:
                typeof resourceMetadata.resource === "string"
                    ? resourceMetadata.resource
                    : new URL(serverUrl).toString(),
        };
    } catch {
        return null;
    }
}

async function postForm(url: string, body: URLSearchParams) {
    const response = await guardedFetch(url, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
    let parsed: Record<string, unknown> = {};
    try {
        const json: unknown = await response.json();
        if (json && typeof json === "object" && !Array.isArray(json))
            parsed = json as Record<string, unknown>;
    } catch {
        // A body that is not JSON carries no OAuth answer.
    }
    return { status: response.status, ok: response.ok, body: parsed };
}

/**
 * The client the device grant runs as: the deployment's configured client
 * for a known provider, else one registered now (RFC 7591) for the device
 * grant and kept like any registration.
 */
async function deviceClient(
    connector: ConnectorRow,
    discovery: DeviceDiscovery,
    redirectUri: string,
    db: Db,
): Promise<{ clientId: string; clientSecret?: string } | null> {
    const env = oauthClientEnvFor(connector.server_url);
    if (env.clientId)
        return { clientId: env.clientId, ...(env.clientSecret ? { clientSecret: env.clientSecret } : {}) };
    const stored = await loadOAuthToken(connector.id, db);
    if (stored?.client_id && stored.token_endpoint === discovery.tokenEndpoint) {
        const secret = decryptString(
            stored.encrypted_client_secret,
            stored.client_secret_iv,
            stored.client_secret_tag,
        );
        return { clientId: stored.client_id, ...(secret ? { clientSecret: secret } : {}) };
    }
    if (!discovery.registrationEndpoint) return null;
    const response = await guardedFetch(discovery.registrationEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
            client_name: "Mike",
            grant_types: [DEVICE_CODE_GRANT, "refresh_token", "authorization_code"],
            response_types: ["code"],
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
        }),
    });
    if (!response.ok) return null;
    const info = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!info || typeof info.client_id !== "string") return null;
    const clientSecret = typeof info.client_secret === "string" ? info.client_secret : undefined;
    await new DbMcpOAuthProvider(db, connector, connector.user_id, "initiate", redirectUri).saveClientInformation({
        client_id: info.client_id,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    // Remember which token endpoint the registration is for.
    await db
        .from("user_mcp_oauth_tokens")
        .update({ token_endpoint: discovery.tokenEndpoint, authorization_server: discovery.authorizationServer })
        .eq("connector_id", connector.id);
    return { clientId: info.client_id, ...(clientSecret ? { clientSecret } : {}) };
}

type DeviceStateConfig = OAuthStateConfig & {
    deviceCode: string;
    tokenEndpoint: string;
    clientId: string;
    resource: string;
    authorizationServer: string;
};

/**
 * Starts the device grant for `connector` when its server offers one, and
 * keeps what polling needs; null when the server has no device grant (or no
 * client for it), so the caller runs the code flow instead.
 */
export async function startMcpDeviceAuthorization(
    connector: ConnectorRow,
    userId: string,
    redirectUri: string,
    db: Db,
): Promise<McpDeviceAuthorization | null> {
    const discovery = await discoverMcpDeviceGrant(connector.server_url);
    if (!discovery) return null;
    const client = await deviceClient(connector, discovery, redirectUri, db);
    if (!client) return null;
    const env = oauthClientEnvFor(connector.server_url);
    const scope = env.scope || discovery.scope;
    const body = new URLSearchParams({ client_id: client.clientId, resource: discovery.resource });
    if (scope) body.set("scope", scope);
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    const answer = await postForm(discovery.deviceAuthorizationEndpoint, body);
    const deviceCode = answer.body.device_code;
    const userCode = answer.body.user_code;
    const verificationUri = answer.body.verification_uri ?? answer.body.verification_url;
    if (!answer.ok || typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string")
        return null;
    let verification: URL;
    try {
        verification = new URL(verificationUri);
    } catch {
        return null;
    }
    if (verification.protocol !== "https:") return null;
    const complete =
        typeof answer.body.verification_uri_complete === "string" &&
        answer.body.verification_uri_complete.startsWith("https://")
            ? answer.body.verification_uri_complete
            : null;
    const interval =
        typeof answer.body.interval === "number" && answer.body.interval > 0 ? Math.min(answer.body.interval, 60) : 5;
    const expiresIn =
        typeof answer.body.expires_in === "number" && answer.body.expires_in > 0
            ? Math.min(answer.body.expires_in, OAUTH_STATE_TTL_MS / 1000)
            : OAUTH_STATE_TTL_MS / 1000;
    const state = base64Url(crypto.randomBytes(32));
    const person = currentNcPerson();
    const config: DeviceStateConfig = {
        codeVerifier: "",
        redirectUri,
        deviceCode,
        interval,
        tokenEndpoint: discovery.tokenEndpoint,
        authorizationServer: discovery.authorizationServer,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        resource: discovery.resource,
        ...(scope ? { scope } : {}),
        ...(person ? { person } : {}),
    };
    const encrypted = encryptString(JSON.stringify(config));
    const { error } = await db.from("user_mcp_oauth_states").insert({
        user_id: userId,
        connector_id: connector.id,
        state_hash: stateHash(state),
        encrypted_state_config: encrypted.encrypted,
        state_config_iv: encrypted.iv,
        state_config_tag: encrypted.tag,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
    if (error) throw error;
    return {
        state,
        userCode,
        verificationUri: verification.toString(),
        verificationUriComplete: complete,
        interval,
        expiresIn,
    };
}

export type McpDevicePoll =
    | { status: "connected" }
    | { status: "pending"; interval: number }
    | { status: "denied" | "expired" };

async function loadOwnState(userId: string, connectorId: string, state: string, db: Db) {
    const { data, error } = await db
        .from("user_mcp_oauth_states")
        .select("*")
        .eq("state_hash", stateHash(state))
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (error) throw error;
    const row = data as
        | {
              id: string;
              user_id: string;
              connector_id: string;
              encrypted_state_config: string;
              state_config_iv: string;
              state_config_tag: string;
          }
        | null;
    if (!row || row.user_id !== userId || row.connector_id !== connectorId) return null;
    const decrypted = decryptString(row.encrypted_state_config, row.state_config_iv, row.state_config_tag);
    if (!decrypted) return null;
    const config = JSON.parse(decrypted) as Partial<DeviceStateConfig>;
    if (config.person && currentNcPerson() !== config.person) return null;
    return { row, config };
}

/**
 * One poll of the device grant `state` names: asks the token endpoint once,
 * keeps the token when the person has approved, and says what the page
 * should do next.
 */
export async function pollMcpDeviceAuthorization(
    userId: string,
    connectorId: string,
    state: string,
    db: Db = createServerSupabase(),
): Promise<McpDevicePoll> {
    const found = await loadOwnState(userId, connectorId, state, db);
    if (!found) return { status: "expired" };
    const { row, config } = found;
    if (!config.deviceCode || !config.tokenEndpoint || !config.clientId) return { status: "expired" };
    const body = new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT,
        device_code: config.deviceCode,
        client_id: config.clientId,
    });
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    if (config.resource) body.set("resource", config.resource);
    const answer = await postForm(config.tokenEndpoint, body);
    if (answer.ok && typeof answer.body.access_token === "string") {
        await storeOAuthToken(
            connectorId,
            {
                authorizationServer: config.authorizationServer ?? "",
                tokenEndpoint: config.tokenEndpoint,
                clientId: config.clientId,
                ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
                resource: config.resource ?? "",
                ...(config.scope ? { scope: config.scope } : {}),
            },
            answer.body,
            db,
            { newGrant: true },
        );
        await db.from("user_mcp_oauth_states").delete().eq("id", row.id);
        return { status: "connected" };
    }
    const code = typeof answer.body.error === "string" ? answer.body.error : null;
    const interval = config.interval ?? 5;
    if (code === "authorization_pending") return { status: "pending", interval };
    if (code === "slow_down") {
        const slower = Math.min(interval + 5, 60);
        const encrypted = encryptString(JSON.stringify({ ...config, interval: slower }));
        await db
            .from("user_mcp_oauth_states")
            .update({
                encrypted_state_config: encrypted.encrypted,
                state_config_iv: encrypted.iv,
                state_config_tag: encrypted.tag,
            })
            .eq("id", row.id);
        return { status: "pending", interval: slower };
    }
    if (answer.status >= 500 || answer.status === 429) return { status: "pending", interval: interval + 5 };
    await db.from("user_mcp_oauth_states").delete().eq("id", row.id);
    return { status: code === "access_denied" ? "denied" : "expired" };
}

/**
 * Finishes the code flow from the address the person pasted: the one their
 * browser landed on after approving. The state must be one this person
 * started for this connector.
 */
export async function completeMcpConnectorOAuthFromPaste(
    userId: string,
    connectorId: string,
    pasted: unknown,
    db: Db = createServerSupabase(),
    /** The app's origin the paste came from (ncAppOrigin of the request). */
    origin: string | null = null,
): Promise<void> {
    const { code, state, error } = parsePastedAuthorization(pasted);
    if (error)
        throw new McpLinkError(
            error === "access_denied"
                ? "Access was not granted. Start again and approve it."
                : "The service did not grant access. Start again.",
            "oauth_denied",
        );
    if (!code || !state)
        throw new McpLinkError(
            "That address has no authorization in it. Paste the whole address your browser shows after you approve.",
            "oauth_paste_invalid",
        );
    const own = await loadOwnState(userId, connectorId, state, db);
    if (!own)
        throw new McpLinkError(
            "That address is for another or an expired authorization. Start again.",
            "oauth_state_invalid",
        );
    if (own.config.origin && own.config.origin !== origin)
        throw new McpLinkError(
            "That address is for Mike at another address. Start again here.",
            "oauth_state_invalid",
        );
    await loadConnector(userId, connectorId, db);
    await completeMcpConnectorOAuthAuthorization(state, code, db, { origin });
}
