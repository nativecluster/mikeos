// NativeCluster's host socket (LB_HOST_SOCKET), as the app reaches it.
//
// Every call carries `Authorization: Bearer <app_credential>` (the host
// answers anything else 401): the credential the launcher passed on stdin
// (lib/nc/launchSecrets.ts). The URL's host is a placeholder, never an
// address of this Mac: the socket is the destination.

import { ncAppCredential } from "./launchSecrets";
import { fetchOverSocket } from "./unixFetch";

/** The placeholder origin every URL to the host names. */
export const HOST_ORIGIN = "http://host";

/** NATIVECLUSTER_TRANSPORT=host: model calls go through the host's line. */
export function hostTransportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NATIVECLUSTER_TRANSPORT?.trim().toLowerCase() === "host";
}

export function hostSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LB_HOST_SOCKET?.trim() || null;
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

/** One request to the host, with the app's credential (whatever the caller's headers said). */
export async function hostFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const socketPath = hostSocketPath();
  if (!socketPath) throw new HostUnavailableError("LB_HOST_SOCKET is not set");
  const credential = ncAppCredential();
  if (!credential) throw new HostUnavailableError("the app's credential for the host is not known");
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.set("authorization", `Bearer ${credential}`);
  return fetchOverSocket(socketPath, `${HOST_ORIGIN}${path}`, { ...init, headers });
}

export class HostCallError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    // The host's words, never a credential: none is ever in an answer.
    super(`NativeCluster's host: ${method} ${path}: ${status} ${body.trim().slice(0, 512)}`);
    this.name = "HostCallError";
    this.status = status;
    this.body = body;
  }
}

/** One call with a JSON body (none: undefined), its JSON answer, or HostCallError. */
export async function hostJson<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T | null> {
  const signals = [options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)].filter(
    (signal): signal is AbortSignal => !!signal,
  );
  const response = await hostFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    signal: AbortSignal.any(signals),
  });
  const text = await response.text();
  if (response.status >= 300) throw new HostCallError(method, path, response.status, text);
  if (!text.trim()) return null;
  return JSON.parse(text) as T;
}
