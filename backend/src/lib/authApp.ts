import type { Request } from "express";
import { requestOriginIsTrusted } from "./origins";

/**
 * Mike packaged as a NativeCluster app (MIKE_NC_APP=1, set by the app's
 * launcher). NativeCluster runs it inside its macOS sandbox on each person's
 * own computer and shows its pages in its own app window, at an origin of the
 * app's own (`https://127.0.0.1:<port>`, a port that differs per computer).
 *
 * NativeCluster is Mike's only sign-in there. The launcher checks the host's
 * ticket on every request and names the person in `X-NC-Person` (and, with
 * the manifest's people.read, their email and name), any incoming copy
 * stripped first; the backend answers only requests carrying the launcher's
 * internal secret. Mike keeps one account per person (lib/authNcPeople.ts):
 * no Mike password, session, cookie or token, and GoTrue does not run.
 *
 * Unset, none of this applies and every deployment behaves as before.
 */
export function ncAppMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_NC_APP?.trim() === "1";
}

/** The NativeCluster person the launcher names, `p_…`, or empty for nobody. */
export const NC_PERSON_HEADER = "x-nc-person";
/** Their email and name, sent only when the manifest asks people.read. */
export const NC_PERSON_EMAIL_HEADER = "x-nc-person-email";
export const NC_PERSON_NAME_HEADER = "x-nc-person-name";

const NC_PERSON_PATTERN = /^p_[A-Za-z0-9._-]{1,128}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

type HeaderSource = Pick<Request, "get">;

/**
 * The NativeCluster person signed in to the window this request came from,
 * or "" when nobody is (or the header is not one the launcher would send).
 */
export function ncPersonOf(req: HeaderSource): string {
  const value = req.get(NC_PERSON_HEADER)?.trim() ?? "";
  return NC_PERSON_PATTERN.test(value) ? value : "";
}

/** The person's email from NativeCluster, lowercased, or "" without one. */
export function ncPersonEmailOf(req: HeaderSource): string {
  const value = req.get(NC_PERSON_EMAIL_HEADER)?.trim().toLowerCase() ?? "";
  return value.length <= 320 && EMAIL_PATTERN.test(value) ? value : "";
}

/**
 * The person's name from NativeCluster, or "" without one. The launcher
 * sends it percent-encoded (UTF-8), since a header carries no character
 * past Latin-1 and names do; a value that does not decode is read as it came.
 */
export function ncPersonNameOf(req: HeaderSource): string {
  const raw = req.get(NC_PERSON_NAME_HEADER) ?? "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded by the launcher: keep the header as it is.
  }
  return name.trim().slice(0, 200);
}

/**
 * In the app the pages are served at an origin of the app's own,
 * `https://127.0.0.1:<port>`, whose port differs per computer, so no list
 * configured in advance can name it. NativeCluster's host passes the
 * browser's own Host header on and the launcher keeps it, so the app's own
 * origin is the one whose host is the request's Host. Another app on the
 * same computer has another port and is refused. Off app mode this is
 * always false. (Kept out of lib/origins.ts, which docker/storage-cors.mjs
 * loads on its own and so imports nothing.)
 */
export function requestOriginIsAppOwn(
  origin: string | undefined,
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!ncAppMode(env) || !origin || !host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** A configured origin, or in the NativeCluster app the request's own. */
export function requestOriginIsAllowed(
  origin: string | undefined,
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    requestOriginIsTrusted(origin, env) ||
    requestOriginIsAppOwn(origin, host, env)
  );
}
