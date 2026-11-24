import type { NextFunction, Request, Response } from "express";
import { ncAppMode } from "../lib/authApp";

export const NC_APP_UNAVAILABLE_DETAIL =
  "NativeCluster manages your account in the NativeCluster app, so this isn't available here.";

/**
 * Refuse, in the NativeCluster app (lib/authApp.ts), a route for something
 * NativeCluster owns there: signing in or out, passwords, email, MFA,
 * deleting the account. Elsewhere it passes every request on.
 */
export function unavailableInNcApp(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!ncAppMode()) {
    next();
    return;
  }
  res.status(403).json({ code: "nc_app_unavailable", detail: NC_APP_UNAVAILABLE_DETAIL });
}
