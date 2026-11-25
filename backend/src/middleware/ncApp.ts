import type { NextFunction, Request, Response } from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { ncAppMode, NC_APP_SHARING_OFF_DETAIL } from "../lib/authApp";
import { requireAuth } from "./auth";

export const NC_APP_UNAVAILABLE_DETAIL =
  "NativeCluster manages your account in the NativeCluster app, so this isn't available here.";

export { NC_APP_SHARING_OFF_DETAIL };

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * A route the NativeCluster app (lib/authApp.ts) refuses, saying `detail`:
 * 403 `nc_app_unavailable` there, before it reads or changes anything.
 * Elsewhere it passes every request on.
 */
export function unavailableInNcAppSaying(detail: string): Middleware {
  return (_req, res, next) => {
    if (!ncAppMode()) {
      next();
      return;
    }
    res.status(403).json({ code: "nc_app_unavailable", detail });
  };
}

/**
 * Refuse, in the NativeCluster app, a route for something NativeCluster owns
 * there: signing in or out, passwords, email, MFA, deleting the account.
 */
export const unavailableInNcApp: Middleware = unavailableInNcAppSaying(NC_APP_UNAVAILABLE_DETAIL);

/**
 * Refuse, in the NativeCluster app, every route that shares something, gives
 * someone access, makes an organization or invites to one. One copy of Mike
 * there serves everyone who opens it on that computer (and from a joined
 * computer's window): a grant would put one person's documents and prompts
 * in another's lists, next to that person's own connectors (the 2026-11-24
 * security review, M1). The pages hide these; this is the server's refusal.
 * Each person's own organization, made with their account, stays.
 */
export const sharingOffInNcApp: Middleware = unavailableInNcAppSaying(NC_APP_SHARING_OFF_DETAIL);

/**
 * sharingOffInNcApp for every request but a read: for a router whose every
 * write makes, joins or changes an organization or what someone may reach
 * there (/orgs).
 */
export const sharingWritesOffInNcApp: Middleware = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  sharingOffInNcApp(req, res, next);
};

/**
 * requireAuth in the NativeCluster app, and nothing elsewhere: for a route
 * a capability link alone opens on other deployments, which the app also
 * holds to its person (a download link, lib/downloadTokens.ts; the
 * 2026-11-24 security review, L2).
 */
export function requireAuthInNcApp(
  req: Request<ParamsFlatDictionary>,
  res: Response,
  next: NextFunction,
): void | Promise<void> {
  if (!ncAppMode()) return next();
  return requireAuth(req, res, next);
}
