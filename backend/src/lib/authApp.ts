import type { Request } from "express";

/**
 * Mike packaged as a NativeCluster app (MIKE_NC_APP=1, set by the app's
 * launcher). NativeCluster runs it inside its macOS sandbox on each person's
 * own computer and shows its pages in its own app window, at an origin of the
 * app's own (`https://127.0.0.1:<port>`, a port that differs per computer).
 *
 * Three facts of that host shape every rule here:
 * - it drops every Set-Cookie the app sends, so a Mike session cannot live
 *   in a cookie: the pages keep it in localStorage and present it on every
 *   request;
 * - it reads `Authorization: Bearer` as a NativeCluster session of its own
 *   and removes it before the request reaches the app, so the pages present
 *   Mike's access token in `X-Mike-Session` instead;
 * - the launcher names the NativeCluster person signed in to the window in
 *   `X-NC-Person` (after its ticket check, any incoming copy stripped), and
 *   each Mike account is bound to the person who first signed in with it.
 *
 * Unset, none of this applies and every deployment behaves as before.
 */
export function ncAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_NC_APP?.trim() === "1";
}

/** The NativeCluster person the launcher names, `p_…`, or empty for nobody. */
export const NC_PERSON_HEADER = "x-nc-person";

/** Where the app's pages present Mike's access token (see above). */
export const APP_SESSION_HEADER = "x-mike-session";

const NC_PERSON_PATTERN = /^p_[A-Za-z0-9._-]{1,128}$/;

type HeaderSource = Pick<Request, "get">;

/**
 * The NativeCluster person signed in to the window this request came from,
 * or "" when nobody is (or the header is not one the launcher would send).
 */
export function ncPersonOf(req: HeaderSource): string {
  const value = req.get(NC_PERSON_HEADER)?.trim() ?? "";
  return NC_PERSON_PATTERN.test(value) ? value : "";
}

/**
 * The Mike access token an app-mode request presents: `X-Mike-Session`
 * first (the app's pages), else a Bearer Authorization (an API client the
 * launcher lets through, or a test). Empty when there is none.
 */
export function appAccessToken(req: HeaderSource): string {
  const presented = req.get(APP_SESSION_HEADER)?.trim();
  if (presented) return presented.replace(/^Bearer\s+/i, "").trim();
  const authorization = req.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}
