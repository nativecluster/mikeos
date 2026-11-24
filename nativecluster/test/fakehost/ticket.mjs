// The host's ticket, minted the way NativeCluster's host signs it
// (`ncdev spec hostapi`, "Requests to the app"; the Go kit's
// sdk/go/app/ticket.go, TicketKey.Sign):
//
//   X-NC-Ticket: <payload>.<signature>
//   payload   = base64url (no padding) of the ticket's JSON
//   signature = base64url (no padding) of
//               HMAC-SHA256(ticket key, "nativecluster-ticket-v1\n" + payload)
//
// The JSON's fields come in the order Go's json.Marshal writes appsdk.Ticket,
// with its omitempty rules, so a minted ticket looks like a real one byte for
// byte apart from Go's HTML escaping (which the signature does not care about:
// it covers the payload as sent).
//
// This module also builds the forged and stale tickets the contract tests
// send, from NativeCluster's own ticket vectors (`ncdev spec vectors`),
// moved onto the fake host's key and clock.

import { createHmac, randomBytes } from "node:crypto";

export const TICKET_HEADER = "x-nc-ticket";
export const TICKET_TTL_MS = 120000;
const LABEL = "nativecluster-ticket-v1\n";

export const newTicketKey = () => randomBytes(32).toString("hex");
export const newSecret = () => randomBytes(32).toString("hex");
/** A request id as the host makes one: 12 random bytes, hex. */
export const newRequestId = () => randomBytes(12).toString("hex");

/** The ticket's JSON, as Go's json.Marshal writes appsdk.Ticket. */
export function ticketJSON(t) {
  const o = { id: t.id ?? "", remote: t.remote ?? "" };
  if (t.tls) o.tls = true;
  if (t.sni) o.sni = t.sni;
  o.iat = t.iat ?? Date.now();
  if (t.host) o.host = true;
  for (const k of ["person", "email", "name", "session", "label"]) if (t[k]) o[k] = t[k];
  if (t.mcp) o.mcp = true;
  return JSON.stringify(o);
}

/** The signature over a payload (base64url text), as the host makes it. */
export function signPayload(keyHex, payload, { label = true } = {}) {
  const h = createHmac("sha256", Buffer.from(keyHex, "hex"));
  if (label) h.update(LABEL, "ascii");
  h.update(payload, "ascii");
  return h.digest().toString("base64url");
}

/** A header value for raw payload bytes (any text, valid JSON or not). */
export function signRaw(keyHex, json, opts) {
  const payload = Buffer.from(json, "utf8").toString("base64url");
  return `${payload}.${signPayload(keyHex, payload, opts)}`;
}

/** X-NC-Ticket's value for ticket t. */
export function signTicket(keyHex, t) {
  return signRaw(keyHex, ticketJSON(t));
}

// --- forged, stale and odd tickets, for the contract tests ---

/**
 * Every case of NativeCluster's ticket vectors, moved onto `keyHex` and the
 * clock `now`: each case's payload is re-signed with this key (or, for the
 * cases about the key or the label, signed the wrong way on purpose), its
 * times shifted by now - vectors.now_ms. The cases that sit exactly on the
 * two-minute edge are kept off it by ten seconds on their own side, since a
 * request over a socket takes a few milliseconds and the edge would flake.
 *
 * Returns [{ name, header, valid, person }]: `valid` is what an app's ticket
 * check must decide, `person` the person a valid one names.
 */
export function vectorCases(vectors, keyHex, now = Date.now()) {
  const shift = now - vectors.now_ms;
  const out = [];
  for (const c of vectors.cases) {
    const dot = c.header.indexOf(".");
    const payloadB64 = dot < 0 ? null : c.header.slice(0, dot);
    let text = payloadB64 === null ? null : Buffer.from(payloadB64, "base64url").toString("utf8");
    let name = c.name;
    if (text !== null) {
      text = text.replace(/("iat"\s*:\s*"?)(-?\d+)/, (m, pre, digits) => {
        let t = Number(digits) + shift;
        // Off the exact edge, on the case's own side of it.
        const age = vectors.now_ms - Number(digits);
        if (age === vectors.ttl_ms) t = now - vectors.ttl_ms + 10000;
        else if (age === vectors.ttl_ms + 1) t = now - vectors.ttl_ms - 10000;
        else if (age === -vectors.ttl_ms) t = now + vectors.ttl_ms - 10000;
        else if (age === -vectors.ttl_ms - 1) t = now + vectors.ttl_ms + 10000;
        return pre + String(t);
      });
    }
    let header;
    switch (c.name) {
      case "signed with another key":
        header = signRaw(newTicketKey(), text);
        break;
      case "signed without the label":
        header = signRaw(keyHex, text, { label: false });
        break;
      case "a tampered payload": {
        // Signed, then changed: one byte of the payload's JSON.
        const good = signRaw(keyHex, text.replace('"id:"', '"id":"'));
        const [p, s] = good.split(".");
        const tampered = Buffer.from(Buffer.from(p, "base64url").toString("utf8").replace('"id":"r1"', '"id":"r2"')).toString("base64url");
        header = `${tampered}.${s}`;
        break;
      }
      case "padding in the signature":
        header = signRaw(keyHex, text) + "=";
        break;
      case "no dot":
        header = Buffer.from(text ?? "no dot").toString("base64url");
        break;
      case "empty":
        header = "";
        break;
      default:
        header = text === null ? c.header : signRaw(keyHex, text);
    }
    if (c.name === "exactly at the end of its life") name = "ten seconds before the end of its life";
    if (c.name === "one millisecond past its life") name = "ten seconds past its life";
    if (c.name === "issued exactly its life ahead") name = "issued ten seconds less than its life ahead";
    if (c.name === "issued more than its life ahead") name = "issued ten seconds more than its life ahead";
    out.push({ name, header, valid: c.valid, person: c.valid ? (c.ticket?.person ?? "") : undefined });
  }
  return out;
}

/** A few more forgeries the vectors do not hold, under this key and clock. */
export function extraForgeries(keyHex, now = Date.now()) {
  const base = { id: newRequestId(), remote: "127.0.0.1:50000", tls: true, iat: now, person: "p_" + "a".repeat(32), label: "browser" };
  const good = signTicket(keyHex, base);
  const [p, s] = good.split(".");
  const other = signTicket(keyHex, { ...base, person: "p_" + "b".repeat(32) });
  return [
    { name: "no ticket at all", header: null, valid: false },
    { name: "a stale ticket (five minutes old)", header: signTicket(keyHex, { ...base, iat: now - 5 * 60000 }), valid: false },
    { name: "a ticket from an hour ahead", header: signTicket(keyHex, { ...base, iat: now + 3600000 }), valid: false },
    { name: "a truncated signature", header: `${p}.${s.slice(0, -2)}`, valid: false },
    { name: "another ticket's signature", header: `${p}.${other.split(".")[1]}`, valid: false },
    { name: "the signature alone", header: `.${s}`, valid: false },
    { name: "a bearer prefix", header: `Bearer ${good}`, valid: false },
    { name: "two tickets joined", header: `${good},${good}`, valid: false },
  ];
}
