// What the launcher does with each request, once the ticket check passed:
// where it goes, and the headers it carries to the backend. Pure functions,
// so test/front.test.mjs holds them to the brief (STAGE2-BRIEF.md, "What the
// finished branches require from the launcher").

import { isIP } from "node:net";
import path from "node:path";

/** The browser's prefix for the backend; the backend's routes are at its root. */
export const API_PREFIX = "/api";

// Hop-by-hop headers (RFC 9110 §7.6.1), never passed on by a proxy.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * Where a request goes:
 *   healthz   the host's readiness check, answered at once
 *   whoami    `{"person"}`, for `ncdev check`
 *   tick      the host's beat (host ticket only), forwarded to the backend
 *   wake      a firing of Mike's upkeep schedule (host ticket only)
 *   api       the backend on api.sock, at `backendPath`
 *   next      Next.js, in this process
 *   notfound  answered 404 here and passed to nothing
 *   bad       answered 400 here (a path that does not decode)
 */
export function routeOf(method, rawUrl, ticket) {
  let url;
  try {
    url = new URL(rawUrl || "/", "http://app.invalid");
  } catch {
    return { kind: "bad" };
  }
  const p = url.pathname;
  if (p === "/healthz") return method === "GET" || method === "HEAD" ? { kind: "healthz" } : { kind: "notfound" };
  if (p === "/.nc/whoami") return method === "GET" ? { kind: "whoami" } : { kind: "notfound" };
  // Every other /.nc/ path is the host's (its window's hand-off): never ours.
  if (p === "/.nc" || p.startsWith("/.nc/")) return { kind: "notfound" };
  // The host's calls, for its own ticket only: the beat, and the firing of
  // Mike's one schedule (upkeep). Hand and warm are routes that do not
  // exist; for a browser's ticket every /nc/ path is one.
  if (p === "/nc" || p.startsWith("/nc/")) {
    if (ticket.host && method === "POST" && p === "/nc/v1/tick") return { kind: "tick" };
    if (ticket.host && method === "POST" && p === "/nc/v1/wake") return { kind: "wake" };
    return { kind: "notfound" };
  }
  if (p === API_PREFIX || p.startsWith(`${API_PREFIX}/`)) {
    const rest = p.slice(API_PREFIX.length) || "/";
    let decoded;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return { kind: "bad" };
    }
    // Never a browser path to the backend's /nc/ (the beat), however it is
    // spelled: /api/nc/v1/tick, /api/%6Ec/..., /api/x/../nc/....
    const normal = path.posix.normalize(decoded.replace(/\\/g, "/"));
    if (normal === "/nc" || normal.startsWith("/nc/")) return { kind: "notfound" };
    return { kind: "api", backendPath: `${rest}${url.search}` };
  }
  return { kind: "next" };
}

/** The client's address for the backend's per-IP limits: the ticket's `remote` without its port. */
export function clientAddress(remote) {
  if (typeof remote !== "string" || !remote) return "";
  if (isIP(remote)) return remote;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(remote);
  if (bracketed && isIP(bracketed[1])) return bracketed[1];
  const colon = remote.lastIndexOf(":");
  if (colon > 0 && isIP(remote.slice(0, colon)) === 4) return remote.slice(0, colon);
  return "";
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * The headers a request carries to the backend. Every incoming `X-NC-*`,
 * `X-Forwarded-*` and `Forwarded` is dropped first, with the hop-by-hop
 * headers (and those `Connection` names); then the launcher sets its own,
 * from the ticket alone:
 *   X-NC-Internal       the secret the backend took on stdin
 *   X-NC-Person         the ticket's person, "" for nobody
 *   X-NC-Request        the ticket's id
 *   X-NC-Person-Email   people.read: the email, when it is plain ASCII
 *   X-NC-Person-Name    people.read: the name, percent-encoded (UTF-8), since
 *                       a header holds no character past Latin-1; read it with
 *                       decodeURIComponent
 *   X-Forwarded-For     the ticket's remote address (the backend trusts one hop)
 *   X-Forwarded-Proto   https when the host's listener had TLS
 * Host and Origin are the browser's, as they came. `upgrade` keeps the
 * Connection and Upgrade headers of a protocol switch.
 */
export function backendHeaders(incoming, ticket, internalSecret, { peopleRead = true, upgrade = false } = {}) {
  const named = new Set();
  const connection = incoming.connection;
  for (const token of (Array.isArray(connection) ? connection.join(",") : (connection ?? "")).split(",")) {
    const t = token.trim().toLowerCase();
    if (t) named.add(t);
  }
  const out = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (name.startsWith("x-nc-") || name.startsWith("x-forwarded-") || name === "forwarded") continue;
    if (upgrade && (name === "connection" || name === "upgrade")) {
      out[name] = value;
      continue;
    }
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  out["x-nc-internal"] = internalSecret;
  out["x-nc-person"] = ticket.person ?? "";
  out["x-nc-request"] = ticket.id ?? "";
  if (peopleRead) {
    if (ticket.email && PRINTABLE_ASCII.test(ticket.email)) out["x-nc-person-email"] = ticket.email;
    if (ticket.name) out["x-nc-person-name"] = encodeURIComponent(ticket.name);
  }
  const ip = clientAddress(ticket.remote);
  if (ip) out["x-forwarded-for"] = ip;
  out["x-forwarded-proto"] = ticket.tls ? "https" : "http";
  return out;
}

/** The headers the host's beat carries to the backend: the internal secret alone. */
export function tickHeaders(internalSecret) {
  return { "x-nc-internal": internalSecret, "content-type": "application/json", "content-length": "0" };
}

/** Whether a browser could have set this header for the backend's or a proxy's eyes. */
export function isForgeable(name) {
  const n = name.toLowerCase();
  return n.startsWith("x-nc-") || n.startsWith("x-forwarded-") || n === "forwarded";
}

/**
 * Drops headers from a request in place, from `headers` and `rawHeaders`
 * alike (Next reads both): the ticket once checked, and before Next.js
 * every `X-NC-*` and `X-Forwarded-*` a browser sent (pages learn the
 * person only through the backend).
 */
export function dropHeaders(req, drop) {
  for (const name of Object.keys(req.headers)) if (drop(name)) delete req.headers[name];
  const raw = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (!drop(req.rawHeaders[i])) raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  req.rawHeaders = raw;
}
