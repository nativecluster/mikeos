// Routes for linking connectors from inside Mike's NativeCluster app
// (MIKE_NC_APP=1); see lib/mcp/appLinking.ts. Outside app mode none of these
// routes exist, so a normal deployment is unchanged.

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import { isNcAppMode, ncAppOrigin, ncPersonContext } from "../../lib/mcp/ncApp";
import {
    completeGooglePaste,
    completeMcpPaste,
    GOOGLE_PASTE_PROVIDERS,
    pollMcpDevice,
} from "./user.mcpApp";

// Outside app mode the router steps aside: none of its routes exist.
function appModeOnly(_req: Request, _res: Response, next: NextFunction) {
    if (!isNcAppMode()) return next("router");
    next();
}

export const mcpAppRouter = Router();
mcpAppRouter.use(appModeOnly, ncPersonContext);

// POST /user/mcp-connectors/:connectorId/oauth/device/poll — { state }
// One poll of the device grant: { status: "connected" | "pending" |
// "denied" | "expired", interval?, connector? }.
mcpAppRouter.post(
    "/mcp-connectors/:connectorId/oauth/device/poll",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        res.set("Cache-Control", "no-store");
        const result = await pollMcpDevice(
            res.locals.userId as string,
            String(req.params.connectorId),
            req.body?.state,
        );
        if (!result.ok)
            return void res
                .status(result.status)
                .json({ ...(result.code ? { code: result.code } : {}), detail: result.detail });
        res.json({ ...result.poll, ...(result.connector ? { connector: result.connector } : {}) });
    }),
);

// POST /user/mcp-connectors/:connectorId/oauth/complete — { address }
// The address the person's browser landed on after approving; its code and
// state finish the authorization this person started.
mcpAppRouter.post(
    "/mcp-connectors/:connectorId/oauth/complete",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        res.set("Cache-Control", "no-store");
        const result = await completeMcpPaste(
            res.locals.userId as string,
            String(req.params.connectorId),
            req.body?.address,
            ncAppOrigin(req),
        );
        if (!result.ok) return void res.status(400).json({ code: result.code, detail: result.detail });
        res.json({ connector: result.connector });
    }),
);

// POST /user/integrations/{google-drive,gmail,google-calendar}/oauth/complete
// — { address }: the address the person's browser landed on after approving
// at Google. The page then reads the connector's status as before.
for (const provider of GOOGLE_PASTE_PROVIDERS) {
    mcpAppRouter.post(
        `/integrations/${provider}/oauth/complete`,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            res.set("Cache-Control", "no-store");
            const result = await completeGooglePaste(
                res.locals.userId as string,
                provider,
                req.body?.address,
                ncAppOrigin(req),
            );
            if (!result.ok) return void res.status(400).json({ code: result.code, detail: result.detail });
            res.status(204).end();
        }),
    );
}
