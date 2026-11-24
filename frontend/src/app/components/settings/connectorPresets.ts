export type ConnectorPreset = {
    name: string;
    serverUrl: string;
    /**
     * The backend's provider id (backend/src/lib/mcp/providers.ts) for a
     * server that offers no dynamic client registration: it links only with
     * a client a company registered with the provider.
     */
    provider?: string;
};

export const CONNECTOR_PRESETS: ReadonlyArray<ConnectorPreset> = [
    { name: "Slack", serverUrl: "https://mcp.slack.com/mcp", provider: "slack" },
    { name: "Notion", serverUrl: "https://mcp.notion.com/mcp" },
    { name: "Airtable", serverUrl: "https://mcp.airtable.com/mcp" },
    { name: "Linear", serverUrl: "https://mcp.linear.app/mcp" },
    { name: "Lawve", serverUrl: "https://mcp.lawve.ai" },
    { name: "Legal Data Hunter", serverUrl: "https://legaldatahunter.com/mcp" },
];

/**
 * Preset URLs and stored connector URLs differ in trailing slashes and
 * fragments, so every comparison between the two goes through this.
 */
export function normalizedServerUrl(serverUrl: string) {
    try {
        const url = new URL(serverUrl);
        url.hash = "";
        url.pathname = url.pathname.replace(/\/$/, "") || "/";
        return url.toString();
    } catch {
        return serverUrl.trim();
    }
}

/**
 * The preset a connector was installed from, or undefined when its URL matches
 * none of them — which is what makes a connector "custom".
 */
export function findConnectorPreset(serverUrl: string) {
    return CONNECTOR_PRESETS.find(
        (candidate) =>
            normalizedServerUrl(candidate.serverUrl) ===
            normalizedServerUrl(serverUrl),
    );
}

/**
 * The presets that can be added here: none whose provider the profile names
 * as needing a client this deployment has not configured (Mike's
 * NativeCluster app; the list is empty elsewhere), since adding it could
 * only fail.
 */
export function offeredConnectorPresets(
    setupRequired: readonly string[],
): ReadonlyArray<ConnectorPreset> {
    return CONNECTOR_PRESETS.filter(
        (preset) => !preset.provider || !setupRequired.includes(preset.provider),
    );
}
