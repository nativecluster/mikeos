// The user routes of the connectors whose plane NativeCluster turned off for
// everyone (lib/nc/netPlanes.ts): each is refused in words, before it reads
// or changes anything, so no request of a person's can reach the plane's
// hosts, link an account there or save a key for it. What only reads Mike's
// own rows answers as if nothing were set up: the MCP list is empty, and
// CourtListener's status says it is unavailable.

import type { NextFunction, Request, Response } from "express";
import {
    isNetPlaneOff,
    NET_PLANE_OFF_MESSAGES,
    type NetPlane,
} from "../../lib/nc/netPlanes";
import { isWebSearchBackend } from "../../lib/webSearch";

function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The plane a user route sends for or configures, or null. Exported for its
 * test. Express matches routes whatever the case of the path
 * (`/MCP-Connectors` reaches `/mcp-connectors`), so the path is read the
 * same way here: in lower case (the 2026-11-24 security review, L1).
 */
export function netPlaneOfUserRoute(method: string, rawPath: string): NetPlane | null {
    const path = rawPath.toLowerCase();
    if (under(path, "/mcp-connectors")) return "mcp";
    if (under(path, "/integrations/courtlistener")) return "courtlistener";
    if (under(path, "/web-search") && method !== "GET") return "websearch";
    const key = /^\/api-keys\/([^/]+)\/?$/.exec(path);
    if (key && method !== "GET" && isWebSearchBackend(key[1])) return "websearch";
    return null;
}

export function refuseOffNetPlaneRoutes(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const plane = netPlaneOfUserRoute(req.method, req.path);
    if (!plane || !isNetPlaneOff(plane)) return next();
    res.setHeader("Cache-Control", "private, no-store");
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    if (req.method === "GET" && path === "/mcp-connectors") {
        return void res.json([]);
    }
    if (req.method === "GET" && path === "/integrations/courtlistener") {
        return void res.json({
            enabled: false,
            installed: false,
            ownToken: false,
            tokenSource: null,
            bulkData: false,
            available: false,
        });
    }
    res.status(404).json({
        code: "connector_unavailable",
        detail: NET_PLANE_OFF_MESSAGES[plane],
    });
}
