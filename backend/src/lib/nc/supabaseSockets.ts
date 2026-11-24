// Supabase over unix sockets, inside NativeCluster's sandbox.
//
// The app's PostgREST listens on MIKE_REST_SOCKET and its GoTrue on
// MIKE_AUTH_SOCKET; SUPABASE_URL names a placeholder host
// (http://mike.internal), so every supabase-js client the backend makes still
// builds the URLs it always builds. This fetch sends SUPABASE_URL/rest/v1/* to
// PostgREST and SUPABASE_URL/auth/v1/* to GoTrue, each without its prefix,
// as Kong does in front of a Supabase stack. Any other URL goes where it
// would have gone.
//
// Off unless one of the socket variables is set.

import { fetchOverSocket, requestParts } from "./unixFetch";

export type SupabaseSockets = {
  /** SUPABASE_URL's origin and path, without a trailing slash. */
  base: string;
  rest?: string;
  auth?: string;
};

export function supabaseSockets(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseSockets | null {
  const rest = env.MIKE_REST_SOCKET?.trim() || undefined;
  const auth = env.MIKE_AUTH_SOCKET?.trim() || undefined;
  const url = env.SUPABASE_URL?.trim();
  if ((!rest && !auth) || !url) return null;
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return null;
  }
  return {
    base: `${base.origin}${base.pathname.replace(/\/+$/, "")}`,
    ...(rest ? { rest } : {}),
    ...(auth ? { auth } : {}),
  };
}

const SERVICES = [
  ["/rest/v1", "rest"],
  ["/auth/v1", "auth"],
] as const;

/**
 * Where a URL goes: the socket and the URL to send on it (the service's
 * prefix taken off), or null for a URL no socket serves.
 */
export function supabaseSocketRoute(
  url: string,
  sockets: SupabaseSockets,
): { socketPath: string; url: string } | null {
  if (!url.startsWith(sockets.base)) return null;
  const rest = url.slice(sockets.base.length);
  for (const [prefix, service] of SERVICES) {
    const socketPath = sockets[service];
    if (!socketPath || !rest.startsWith(prefix)) continue;
    const after = rest.slice(prefix.length);
    // "/rest/v1x" is no path under /rest/v1.
    if (after && !/^[/?#]/.test(after)) continue;
    const target = new URL(sockets.base);
    const tail = after.startsWith("/") ? after : `/${after}`;
    return { socketPath, url: `${target.origin}${tail}` };
  }
  return null;
}

/**
 * A fetch for supabase-js's `global.fetch`. `base` is the fetch for every
 * URL no socket serves (resolved per call, so a fetch installed later is
 * used), and undefined when the sockets are off: callers then keep their
 * own default.
 */
export function supabaseSocketFetch(
  env: NodeJS.ProcessEnv = process.env,
  base?: typeof fetch,
): typeof fetch | undefined {
  const sockets = supabaseSockets(env);
  if (!sockets) return undefined;
  return routedFetch(sockets, base);
}

function routedFetch(sockets: SupabaseSockets, base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const parts = requestParts(input, init);
    const route = supabaseSocketRoute(parts.url, sockets);
    if (!route) return (base ?? globalThis.fetch)(input, init);
    return fetchOverSocket(route.socketPath, route.url, parts.init);
  };
}

const INSTALLED = Symbol.for("mike.nc.supabaseSocketFetch");

/**
 * Route the process's global fetch the same way, for the clients the
 * backend makes without a fetch of their own (the per-request session
 * client, GoTrue's settings read). Only SUPABASE_URL's /rest/v1 and
 * /auth/v1 change; every other URL reaches the fetch that was there.
 * Idempotent; a no-op when the sockets are off. Each worker thread has a
 * global of its own and installs it at its start (src/instrument.ts).
 */
export function installSupabaseSocketFetch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sockets = supabaseSockets(env);
  if (!sockets) return false;
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return true;
  const original = current;
  const routed = routedFetch(sockets, original) as typeof fetch & { [INSTALLED]?: true };
  routed[INSTALLED] = true;
  globalThis.fetch = routed;
  return true;
}
