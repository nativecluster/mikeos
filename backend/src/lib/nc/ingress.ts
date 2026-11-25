// The backend's one door when Mike runs as a NativeCluster app
// (MIKE_INTERNAL_SECRET_STDIN=1).
//
// The launcher is the only client: it checks the host's ticket on every
// request, strips any copy a browser sent of its own headers, and passes the
// request on with
//   X-NC-Internal  the internal secret it gave the backend on stdin,
//   X-NC-Person    the ticket's person ("p_…", or empty for nobody),
//   X-NC-Request   the ticket's id.
// Anything without the right X-NC-Internal is answered 403, /health
// included. The person and request id go into the request's scope
// (lib/nc/context.ts), where the model layer reads a call's origin.
//
// It also answers the launcher's forward of the host's clock beat,
// `POST /nc/v1/tick` (MIKE_NC_APP=1), with no X-NC-Person or X-NC-Request:
// a browser's request always carries them, so none can reach it.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ncTaskForPath, runInNcRequest } from "./context";
import { internalSecretFromStdinEnabled, internalSecretMatches, launchSecrets } from "./launchSecrets";
import { ncPersonIdOf } from "./personId";
import { ncAppMode, ncTickPath, runNcTick } from "./tick";

export const NC_INTERNAL_HEADER = "x-nc-internal";
export const NC_PERSON_HEADER = "x-nc-person";
export const NC_REQUEST_HEADER = "x-nc-request";

/** Whether app.ts mounts the door (the launcher's secret comes on stdin). */
export function ncIngressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return internalSecretFromStdinEnabled(env);
}

// A request id the host made: letters, digits and a few separators, never words.
const ID = /^[A-Za-z0-9._:~-]{1,200}$/;

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function headerId(value: string | string[] | undefined): string {
  const trimmed = headerValue(value);
  return ID.test(trimmed) ? trimmed : "";
}

/** The person by the one rule (lib/nc/personId.ts), or "" for nobody. */
function headerPerson(value: string | string[] | undefined): string {
  return ncPersonIdOf(headerValue(value)) ?? "";
}

function forbidden(res: Response): void {
  res.status(403).json({ code: "forbidden", detail: "Forbidden" });
}

export function ncIngress(
  options: { secret?: () => string | null | undefined } = {},
): RequestHandler {
  const expected = options.secret ?? (() => launchSecrets()?.internalSecret);
  return (req: Request, res: Response, next: NextFunction) => {
    const secret = expected();
    const presented = req.headers[NC_INTERNAL_HEADER];
    // Before the launcher's line is read nothing can be right.
    if (!secret || !internalSecretMatches(presented, secret)) return forbidden(res);
    // Nothing downstream needs it, and nothing may log or forward it.
    delete req.headers[NC_INTERNAL_HEADER];

    const fromBrowser =
      req.headers[NC_PERSON_HEADER] !== undefined || req.headers[NC_REQUEST_HEADER] !== undefined;
    if (!fromBrowser && ncAppMode() && req.method === "POST" && req.path === ncTickPath()) {
      void runNcTick().then(
        (ran) => res.status(200).json({ ok: true, ran }),
        () => res.status(500).json({ ok: false }),
      );
      return;
    }

    // A unix socket has no peer address, so req.ip (the rate limiters' key)
    // would be undefined. The launcher should send the client's address in
    // X-Forwarded-For (app.ts trusts one proxy hop); when it sends none, the
    // client is this computer, the only place the socket is reached from.
    if (!req.socket.remoteAddress && !req.headers["x-forwarded-for"]) {
      req.headers["x-forwarded-for"] = "127.0.0.1";
    }

    const person = headerPerson(req.headers[NC_PERSON_HEADER]);
    const request = headerId(req.headers[NC_REQUEST_HEADER]);
    runInNcRequest({ person, request, at: Date.now(), task: ncTaskForPath(req.path) }, () => next());
  };
}
