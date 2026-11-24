// The app answers nothing without a valid ticket (`ncdev spec hostapi`,
// "Requests to the app"), and /healthz and /.nc/whoami answer as the
// contract says ("Starting an app").

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, started, hooks } from "./harness.mjs";
import { vectorCases, extraForgeries } from "../fakehost/ticket.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(path.join(here, "../fakehost/ticket-vectors.v1.json"), "utf8"));

// Routes a request may name: the contract's own, pages, the API, Next's
// files, the host's calls to the app, and nothing at all.
const ROUTES = [
  ["GET", "/healthz"],
  ["GET", "/.nc/whoami"],
  ["GET", "/"],
  ["GET", "/login"],
  ["GET", "/assistant"],
  ["GET", "/api/health"],
  ["GET", "/api/projects"],
  ["POST", "/api/chat"],
  ["GET", "/_next/static/chunks/main.js"],
  ["GET", "/favicon.ico"],
  ["POST", "/nc/v1/tick"],
  ["POST", "/nc/v1/wake"],
  ["GET", "/no/such/route"],
  ["OPTIONS", "/api/projects"],
];

describe("tickets", () => {
  let host;
  before(async () => {
    host = await startApp("tickets");
  });
  after(() => host?.close());

  test("the app serves on LB_APP_SOCKET, 0600", () => {
    const mode = statSync(host.appSocket).mode & 0o777;
    assert.equal(mode & 0o077, 0, `LB_APP_SOCKET is ${mode.toString(8)}: only its owner may reach it`);
  });

  test("/healthz answers 200 or 503 to the host's own ticket", async (t) => {
    t.diagnostic(started(host));
    const r = await host.request("GET", "/healthz", { host: true });
    assert.ok(r.status === 200 || r.status === 503, `GET /healthz answered ${r.status}`);
    t.diagnostic(`/healthz: ${r.status} ${r.text.slice(0, 120)}`);
  });

  test("/.nc/whoami names the ticket's person by id, and never an email or a name", async () => {
    const alice = host.person("alice");
    const r = await host.request("GET", "/.nc/whoami", { as: "alice" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { person: alice.id });
    assert.ok(!r.text.includes(alice.email) && !r.text.includes(alice.name), "whoami must not answer the person's email or name");
  });

  test("/.nc/whoami answers an empty person for a ticket that names nobody", async () => {
    const r = await host.request("GET", "/.nc/whoami", { as: null });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { person: "" });
  });

  test("every case of NativeCluster's ticket vectors, over the socket", async () => {
    const bad = [];
    for (const c of vectorCases(VECTORS, host.ticketKey)) {
      const r = await host.request("GET", "/.nc/whoami", { ticket: c.header === "" ? "" : c.header });
      if (c.valid) {
        if (r.status !== 200 || r.json?.person !== (c.person ?? "")) bad.push(`${c.name}: a valid ticket got ${r.status} ${r.text.slice(0, 80)}`);
      } else if (r.status !== 403) bad.push(`${c.name}: an invalid ticket got ${r.status}, not 403`);
    }
    assert.deepEqual(bad, []);
  });

  test("no ticket, a bad ticket or a stale ticket gets 403 on every route", async () => {
    const forged = [...extraForgeries(host.ticketKey), ...vectorCases(VECTORS, host.ticketKey).filter((c) => !c.valid)];
    const bad = [];
    for (const [method, p] of ROUTES) {
      for (const f of forged) {
        const r = await host.request(method, p, { ticket: f.header === null ? "none" : f.header, body: method === "POST" ? {} : undefined });
        if (r.status !== 403) bad.push(`${method} ${p} with ${f.name}: ${r.status}`);
      }
    }
    assert.deepEqual(bad, [], `${bad.length} of ${ROUTES.length * forged.length} requests were not refused`);
  });

  test("an upgrade without a valid ticket is refused 403", async () => {
    const results = [];
    for (const [name, ticket] of [["no ticket", "none"], ["a bad ticket", extraForgeries(host.ticketKey)[3].header], ["a stale ticket", extraForgeries(host.ticketKey)[1].header]]) {
      for (const p of ["/", "/_next/webpack-hmr", "/api/ws"]) {
        const r = await host.upgrade(p, { ticket });
        if (r.status !== 403) results.push(`${p} with ${name}: ${r.line}`);
      }
    }
    assert.deepEqual(results, []);
  });

  test("headers a browser forges in NativeCluster's name change nothing", async (t) => {
    // The real host drops only X-NC-Ticket, every Cookie and a Bearer
    // Authorization (origin.go's rewriteFor, people.DropCredential): any
    // other X-NC-* a browser sends reaches the app, which takes the person
    // from the ticket alone (the launcher strips its own headers' copies).
    const alice = host.person("alice");
    const bob = host.person("bob");
    const forged = { "x-nc-person": bob.id, "x-nc-internal": "forged", "x-nc-request": "forged", "x-nc-person-email": bob.email, "x-nc-person-name": bob.name, "x-nc-grant": "forged" };
    const r = await host.request("GET", "/.nc/whoami", { as: "alice", headers: forged });
    assert.deepEqual(r.json, { person: alice.id });
    const nobody = await host.request("GET", "/.nc/whoami", { as: null, headers: forged });
    assert.deepEqual(nobody.json, { person: "" });
    const app = await hooks();
    if (app.forgedHeaders) await app.forgedHeaders(host, forged, t);
  });

  test("the host's calls to the app answer nothing to a person's ticket", async () => {
    // /nc/v1/tick and /nc/v1/wake are the host's alone (appsdk.FromHost): a
    // person's ticket gets them as a route that does not exist.
    for (const p of ["/nc/v1/tick", "/nc/v1/wake"]) {
      const r = await host.request("POST", p, { as: "alice", body: {} });
      assert.ok(r.status === 404 || r.status === 403, `POST ${p} with a person's ticket answered ${r.status}`);
    }
  });
});
