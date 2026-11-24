// Where each request goes, and the headers it carries to the backend
// (STAGE2-BRIEF.md, "What the finished branches require from the launcher").

import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOf, backendHeaders, clientAddress, dropHeaders, isForgeable } from "../lib/front.mjs";

const person = { id: "r1", remote: "192.168.1.20:52144", tls: true, host: false, person: "p_7f3a", email: "ann@example.com", name: "Ann Smith" };
const host = { id: "h1", remote: "host", tls: false, host: true, person: "" };
const nobody = { id: "r2", remote: "127.0.0.1:5000", tls: true, host: false, person: "" };

test("the host's readiness check and whoami", () => {
  assert.deepEqual(routeOf("GET", "/healthz", host), { kind: "healthz" });
  assert.deepEqual(routeOf("GET", "/healthz", person), { kind: "healthz" });
  assert.deepEqual(routeOf("GET", "/.nc/whoami", person), { kind: "whoami" });
  assert.deepEqual(routeOf("POST", "/.nc/whoami", person), { kind: "notfound" });
  assert.deepEqual(routeOf("GET", "/.nc/handoff", person), { kind: "notfound" });
});

test("the beat and the upkeep firing come only with the host's own ticket", () => {
  assert.deepEqual(routeOf("POST", "/nc/v1/tick", host), { kind: "tick" });
  assert.deepEqual(routeOf("POST", "/nc/v1/wake", host), { kind: "wake" });
  for (const t of [person, nobody]) {
    assert.deepEqual(routeOf("POST", "/nc/v1/tick", t), { kind: "notfound" });
    assert.deepEqual(routeOf("POST", "/nc/v1/wake", t), { kind: "notfound" });
  }
  assert.deepEqual(routeOf("GET", "/nc/v1/tick", host), { kind: "notfound" });
  assert.deepEqual(routeOf("POST", "/nc/v1/hand", host), { kind: "notfound" });
});

test("the API goes to the backend with /api taken off, the query kept", () => {
  assert.deepEqual(routeOf("GET", "/api/projects?limit=5", person), { kind: "api", backendPath: "/projects?limit=5" });
  assert.deepEqual(routeOf("GET", "/api", person), { kind: "api", backendPath: "/" });
  assert.deepEqual(routeOf("POST", "/api/", person), { kind: "api", backendPath: "/" });
  assert.deepEqual(routeOf("GET", "/apix", person), { kind: "next" });
  assert.deepEqual(routeOf("GET", "/assistant", person), { kind: "next" });
  assert.deepEqual(routeOf("GET", "/", person), { kind: "next" });
});

test("no browser path reaches the backend's /nc/, however it is spelled", () => {
  for (const p of ["/api/nc/v1/tick", "/api/nc", "/api/%6Ec/v1/tick", "/api/x/../nc/v1/tick", "/api/x/%2e%2e/nc/v1/tick", "/api/x\\..\\nc/v1/tick", "/api//nc/v1/tick"]) {
    assert.equal(routeOf("POST", p, person).kind === "api" && /^\/+nc(\/|$)/.test(decodeURIComponent(routeOf("POST", p, person).backendPath)) ? "leak" : "ok", "ok", p);
  }
  assert.deepEqual(routeOf("POST", "/api/nc/v1/tick", host), { kind: "notfound" });
  assert.deepEqual(routeOf("GET", "/api/%E0%A4%A", person), { kind: "bad" });
});

test("a browser's /nc/ paths go nowhere", () => {
  assert.deepEqual(routeOf("GET", "/nc/v1/anything", person), { kind: "notfound" });
});

test("the client's address is the ticket's remote without its port", () => {
  assert.equal(clientAddress("192.168.1.20:52144"), "192.168.1.20");
  assert.equal(clientAddress("[::1]:443"), "::1");
  assert.equal(clientAddress("::1"), "::1");
  assert.equal(clientAddress("10.0.0.2"), "10.0.0.2");
  assert.equal(clientAddress("host"), "");
  assert.equal(clientAddress(""), "");
});

test("the launcher's headers replace whatever a browser sent", () => {
  const incoming = {
    host: "127.0.0.1:8493",
    origin: "https://127.0.0.1:8493",
    "content-type": "application/json",
    "x-nc-internal": "forged",
    "x-nc-person": "p_someone_else",
    "x-nc-person-email": "mallory@example.com",
    "x-nc-request": "forged",
    "x-nc-anything": "forged",
    "x-forwarded-for": "6.6.6.6",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
    forwarded: "for=6.6.6.6",
    connection: "keep-alive, x-drop-me",
    "x-drop-me": "1",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
  };
  const h = backendHeaders(incoming, person, "s".repeat(64));
  assert.equal(h.host, "127.0.0.1:8493");
  assert.equal(h.origin, "https://127.0.0.1:8493");
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["x-nc-internal"], "s".repeat(64));
  assert.equal(h["x-nc-person"], "p_7f3a");
  assert.equal(h["x-nc-request"], "r1");
  assert.equal(h["x-nc-person-email"], "ann@example.com");
  assert.equal(h["x-nc-person-name"], "Ann%20Smith");
  assert.equal(h["x-forwarded-for"], "192.168.1.20");
  assert.equal(h["x-forwarded-proto"], "https");
  for (const gone of ["x-nc-anything", "x-forwarded-host", "forwarded", "connection", "x-drop-me", "keep-alive", "transfer-encoding"]) assert.equal(h[gone], undefined, gone);
});

test("nobody signed in still names no one, explicitly", () => {
  const h = backendHeaders({ "x-nc-person": "p_forged" }, nobody, "s".repeat(64));
  assert.equal(h["x-nc-person"], "");
  assert.equal(h["x-nc-person-email"], undefined);
  assert.equal(h["x-nc-person-name"], undefined);
});

test("a name in any script travels percent-encoded; email and name only with people.read", () => {
  const h = backendHeaders({}, { ...person, name: "Zoë 李" }, "s".repeat(64));
  assert.equal(decodeURIComponent(h["x-nc-person-name"]), "Zoë 李");
  assert.match(h["x-nc-person-name"], /^[\x20-\x7e]+$/);
  const without = backendHeaders({}, person, "s".repeat(64), { peopleRead: false });
  assert.equal(without["x-nc-person-email"], undefined);
  assert.equal(without["x-nc-person-name"], undefined);
});

test("a protocol switch keeps its Connection and Upgrade", () => {
  const h = backendHeaders({ connection: "Upgrade", upgrade: "websocket" }, person, "s".repeat(64), { upgrade: true });
  assert.equal(h.connection, "Upgrade");
  assert.equal(h.upgrade, "websocket");
});

test("pages get no X-NC-* or X-Forwarded-* a browser sent", () => {
  const req = {
    headers: { "x-nc-person": "p_forged", "x-forwarded-host": "evil", accept: "text/html" },
    rawHeaders: ["X-NC-Person", "p_forged", "X-Forwarded-Host", "evil", "Accept", "text/html"],
  };
  dropHeaders(req, isForgeable);
  assert.deepEqual(req.headers, { accept: "text/html" });
  assert.deepEqual(req.rawHeaders, ["Accept", "text/html"]);
});
