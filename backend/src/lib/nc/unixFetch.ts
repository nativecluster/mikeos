// fetch over a unix socket, for a backend that may not open a TCP port.
//
// Inside NativeCluster's sandbox the app's own processes reach each other
// only through unix sockets (NC_APP_SOCKETS): PostgREST on rest.sock, GoTrue
// on auth.sock, the host on LB_HOST_SOCKET. undici dials a socket path when
// its Agent says so; its fetch keeps streaming bodies and abort signals as
// the global fetch does.

import { Agent, fetch as undiciFetch } from "undici";

const agents = new Map<string, Agent>();

/**
 * One connection pool per socket path, for the life of the process.
 * `untimed` (the host's socket): calls wait in NativeCluster's line and
 * answers stream for minutes, so no idle timeout may cut either; the
 * caller's signal ends a call. Any other socket keeps undici's timeouts.
 */
export function unixSocketAgent(socketPath: string, options: { untimed?: boolean } = {}): Agent {
  const key = `${options.untimed ? "untimed" : "timed"}\n${socketPath}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { socketPath },
      ...(options.untimed ? { headersTimeout: 0, bodyTimeout: 0 } : {}),
    });
    agents.set(key, agent);
  }
  return agent;
}

/** Test seam: close every pool (each test's server goes away with it). */
export async function closeUnixSocketAgents(): Promise<void> {
  const open = [...agents.values()];
  agents.clear();
  await Promise.allSettled(open.map((agent) => agent.close()));
}

// A Response the body of which must be null.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * One request over a socket. `url` names the path and query (its host is
 * sent as the Host header and otherwise ignored). The answer is the global
 * Response, so code that checks `instanceof Response` or builds on it sees
 * the class it knows; its body is the stream undici reads, already decoded.
 */
export async function fetchOverSocket(
  socketPath: string,
  url: string | URL,
  init: RequestInit = {},
  options: { untimed?: boolean } = {},
): Promise<Response> {
  const body = init.body ?? null;
  const streamed =
    body !== null &&
    typeof body === "object" &&
    typeof (body as ReadableStream).getReader === "function";
  const response = await undiciFetch(String(url), {
    ...(init as Record<string, unknown>),
    ...(streamed ? { duplex: "half" } : {}),
    dispatcher: unixSocketAgent(socketPath, options),
  } as Parameters<typeof undiciFetch>[1]);
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    // The body below is decoded; its wire framing no longer applies.
    if (name === "content-encoding" || name === "content-length") return;
    headers.append(name, value);
  });
  return new Response(
    NULL_BODY_STATUS.has(response.status)
      ? null
      : (response.body as ReadableStream<Uint8Array> | null),
    { status: response.status, statusText: response.statusText, headers },
  );
}

/** A fetch's input and init as one URL and one init (a Request's own fields read into it). */
export function requestParts(
  input: RequestInfo | URL,
  init?: RequestInit,
): { url: string; init: RequestInit } {
  if (typeof input === "string") return { url: input, init: init ?? {} };
  if (input instanceof URL) return { url: input.href, init: init ?? {} };
  const request = input as Request;
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      ...init,
    },
  };
}
