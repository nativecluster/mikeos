// The host's ticket (`ncdev spec hostapi`, "Requests to the app"; the Go
// kit's ticket.go and the Python kit's _ticket.py are the reference).
//
// The host passes every request to the app's socket with X-NC-Ticket:
// <payload>.<signature>, both base64url without padding, the signature
// HMAC-SHA256(ticket key, "nativecluster-ticket-v1\n" + payload as received).
// The payload is a JSON object: id, remote, sni, person, email, name,
// session, label strings; iat an integer (Unix ms); tls, host, mcp booleans.
// A field of the wrong type refuses the ticket, an unknown field is fine,
// null reads as empty; remote must be non-empty and iat within two minutes
// of now, either way. Anything else: no ticket (the caller answers 403).
//
// `ncdev spec vectors | node test/ticket-vectors.mjs` holds this file to
// every case NativeCluster publishes.

import { createHmac, timingSafeEqual } from "node:crypto";

export const TICKET_HEADER = "x-nc-ticket";
export const TICKET_TTL_MS = 120000;

const LABEL = "nativecluster-ticket-v1\n";
const B64URL = /^[A-Za-z0-9_-]*$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const STRINGS = ["id", "remote", "sni", "person", "email", "name", "session", "label"];
const BOOLS = ["tls", "host", "mcp"];
const FIELDS = [...STRINGS, ...BOOLS, "iat"];
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// A JSON number with the text it was written as, where the runtime gives
// it (JSON.parse source text access): iat must be written as an integer,
// as Go's decoder holds it, never 1791000000000.0 or 1.791e12.
class RawNumber {
  constructor(value, source) {
    this.value = value;
    this.source = source;
  }
}

function b64decode(s) {
  if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1) return null;
  return Buffer.from(s, "base64url");
}

// The ticket field a JSON key sets, as Go's decoder matches it: the exact
// name, else the same name in another case.
function fieldOf(key) {
  if (FIELDS.includes(key)) return key;
  const folded = key.toLowerCase();
  return FIELDS.find((f) => f === folded) ?? null;
}

function parsePayload(bytes) {
  let root;
  try {
    root = JSON.parse(new TextDecoder("utf-8").decode(bytes), (key, value, context) =>
      typeof value === "number" && context && typeof context.source === "string" ? new RawNumber(value, context.source) : value,
    );
  } catch {
    return null;
  }
  if (root === null || typeof root !== "object" || Array.isArray(root) || root instanceof RawNumber) return null;
  const out = {};
  for (const [key, raw] of Object.entries(root)) {
    const f = fieldOf(key);
    if (f === null || raw === null) continue;
    if (STRINGS.includes(f)) {
      if (typeof raw !== "string") return null;
      out[f] = raw;
    } else if (BOOLS.includes(f)) {
      if (typeof raw !== "boolean") return null;
      out[f] = raw;
    } else {
      // iat
      let n;
      if (raw instanceof RawNumber) {
        if (!INTEGER.test(raw.source)) return null;
        n = BigInt(raw.source);
      } else if (typeof raw === "number" && Number.isSafeInteger(raw)) {
        n = BigInt(raw);
      } else {
        return null;
      }
      if (n < INT64_MIN || n > INT64_MAX) return null;
      out[f] = n;
    }
  }
  return out;
}

// ticketCheck returns verify(header, nowMs?): the ticket the header carries,
// or null. keyHex is the ticket_key the host sent on stdin (64 hex digits);
// keep it in memory only.
export function ticketCheck(keyHex) {
  const hex = String(keyHex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("the ticket key is not 32 bytes of hex");
  const key = Buffer.from(hex, "hex");

  const mac = (payload) => createHmac("sha256", key).update(LABEL, "ascii").update(payload, "ascii").digest();

  return function verify(header, nowMs = Date.now()) {
    if (typeof header !== "string" || header === "") return null;
    const dot = header.indexOf(".");
    if (dot < 0) return null;
    const payload = header.slice(0, dot);
    const sig = b64decode(header.slice(dot + 1));
    if (sig === null || sig.length !== 32 || !B64URL.test(payload)) return null;
    if (!timingSafeEqual(sig, mac(payload))) return null;
    const body = b64decode(payload);
    if (body === null) return null;
    const f = parsePayload(body);
    if (f === null) return null;
    const t = {
      id: f.id ?? "",
      remote: f.remote ?? "",
      tls: f.tls ?? false,
      sni: f.sni ?? "",
      iat: f.iat ?? 0n,
      host: f.host ?? false,
      person: f.person ?? "",
      email: f.email ?? "",
      name: f.name ?? "",
      session: f.session ?? "",
      label: f.label ?? "",
      mcp: f.mcp ?? false,
    };
    if (t.remote === "") return null;
    const age = BigInt(Math.trunc(nowMs)) - t.iat;
    if (age > BigInt(TICKET_TTL_MS) || age < -BigInt(TICKET_TTL_MS)) return null;
    t.iat = Number(t.iat);
    return t;
  };
}
