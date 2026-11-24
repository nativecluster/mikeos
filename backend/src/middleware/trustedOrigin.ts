import type { NextFunction, Request, Response } from "express";
import { requestOriginIsAllowed } from "../lib/authApp";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");
  if (!requestOriginIsAllowed(origin, req.get("host"))) {
    res.status(403).json({
      code: "untrusted_origin",
      detail: "The request origin is not allowed.",
    });
    return;
  }
  next();
}
