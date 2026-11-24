// The internet Mike reaches as a NativeCluster app, by plane: each
// `net.<plane>` permission in nativecluster/nc-app.json, with its off switch.
//
// NativeCluster sets a plane's switch to "0" in the app's environment when
// the plane is off for everyone: an operator set that name to 0 for the host,
// or the group turned the plane off (`ncdev spec hostapi`, "Reaching the
// internet"). The launcher passes the switches on to the backend as they came
// (nativecluster/launcher/lib/stack.mjs). With its switch at 0 a plane's
// connectors are off for every person: the pages hide them, and the server
// refuses them in words, in routes, chat tools and jobs alike, and sends
// nothing to its hosts. A switch that is on is left unset. Outside the app
// no switch is set, and every plane is on.

import { AppError } from "../appError";

export const NET_PLANES = ["courtlistener", "websearch", "mcp"] as const;
export type NetPlane = (typeof NET_PLANES)[number];

/** Each plane's off switch, as nc-app.json declares it. */
export const NET_PLANE_SWITCHES: Readonly<Record<NetPlane, string>> = {
    courtlistener: "LB_MIKE_COURTLISTENER",
    websearch: "LB_MIKE_WEBSEARCH",
    mcp: "LB_MIKE_MCP",
};

/** Repo-authored, safe to show the user as written. */
export const NET_PLANE_OFF_MESSAGES: Readonly<Record<NetPlane, string>> = {
    courtlistener:
        "CourtListener is turned off for everyone using Mike on this NativeCluster.",
    websearch:
        "Web search is turned off for everyone using Mike on this NativeCluster.",
    mcp: "MCP connectors are turned off for everyone using Mike on this NativeCluster.",
};

/** Read at each call: the switch is the app's environment, set as it starts. */
export function isNetPlaneOff(
    plane: NetPlane,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return env[NET_PLANE_SWITCHES[plane]]?.trim() === "0";
}

export function netPlanesOff(env: NodeJS.ProcessEnv = process.env): NetPlane[] {
    return NET_PLANES.filter((plane) => isNetPlaneOff(plane, env));
}

/** A send for a plane that is off for everyone. `code` as Drive's off switch says it. */
export class NetPlaneOffError extends AppError {
    readonly code = "connector_unavailable";
    constructor(readonly plane: NetPlane) {
        super("nc.net_plane_off", NET_PLANE_OFF_MESSAGES[plane]);
    }
}

/** Throws NetPlaneOffError, in words, before anything is sent for an off plane. */
export function assertNetPlaneOn(plane: NetPlane): void {
    if (isNetPlaneOff(plane)) throw new NetPlaneOffError(plane);
}

const COURTLISTENER_TOOL_PREFIX = "courtlistener_";
const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "read_webpage"]);
const MCP_TOOL_PREFIX = "mcp_";

/** The plane an assistant tool sends through, or null for one that sends nothing out. */
export function netPlaneOfTool(name: string): NetPlane | null {
    if (name.startsWith(COURTLISTENER_TOOL_PREFIX)) return "courtlistener";
    if (WEB_TOOLS.has(name)) return "websearch";
    if (name.startsWith(MCP_TOOL_PREFIX)) return "mcp";
    return null;
}

/**
 * The tool result for a call the model made on an off plane (a model can name
 * a tool from memory, advertised or not), or null when the tool may run.
 */
export function offNetPlaneToolResult(name: string): string | null {
    const plane = netPlaneOfTool(name);
    if (!plane || !isNetPlaneOff(plane)) return null;
    return JSON.stringify({ ok: false, error: NET_PLANE_OFF_MESSAGES[plane] });
}
