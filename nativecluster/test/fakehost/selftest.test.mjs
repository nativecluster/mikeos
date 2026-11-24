// The fake host held to what it stands in for, with no app running: its
// tickets sign as NativeCluster's do, its socket refuses what NativeCluster's
// refuses, its ledger sees a missed or a double release, and its fake models
// answer Mike's protocols. HARNESS_REAL_CALL=1 adds one tiny real call
// through --models nativecluster (this Mac's NativeCluster, a few tokens).
//
//   node --test nativecluster/test/fakehost/

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHost } from "./host.mjs";
import { signPayload, newTicketKey } from "./ticket.mjs";
import { fakeAnswer } from "./models.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function tinyPackage() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nc-selftest-pkg-"));
  writeFileSync(
    path.join(dir, "nc-app.json"),
    JSON.stringify({
      format: "nc-app.v1", id: "selftest", name: "Selftest", program: "run",
      tasks: [{ id: "chat", name: "Chat" }, { id: "cells", name: "Cells" }],
      permissions: [{ id: "models.use", tasks: ["chat", "cells"] }, { id: "people.read" }],
      triggers: [], storage: [{ kind: "x", label: "x", place: "cluster" }], review: null,
    }),
  );
  return dir;
}

function call(host, method, p, { body, headers = {}, credential = host.credential } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({ socketPath: host.hostSocket, path: p, method, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, lines: text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } }) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const grantOf = (r) => r.lines.at(-1)?.id;

test("the ticket signer reproduces every valid vector's signature", () => {
  const v = JSON.parse(readFileSync(path.join(here, "ticket-vectors.v1.json"), "utf8"));
  for (const c of v.cases.filter((c) => c.valid)) {
    const [payload, sig] = c.header.split(".");
    assert.equal(signPayload(v.key, payload), sig, c.name);
  }
});

describe("the fake host's socket", () => {
  let host;
  before(async () => {
    host = new FakeHost({ pkg: tinyPackage(), log: () => {} });
    host.credential = "c".repeat(64);
    host.ticketKey = newTicketKey();
    await host.startHostSocket();
  });
  after(() => host.close());

  test("answers only the app's credential", async () => {
    assert.equal((await call(host, "GET", "/host/v1/models?task=chat&kind=chat", { credential: "wrong" })).status, 401);
    assert.equal((await call(host, "GET", "/host/v1/models?task=chat&kind=chat", { credential: null })).status, 401);
  });

  test("the models route answers its manifest's tasks only", async () => {
    const r = await call(host, "GET", "/host/v1/models?task=chat&kind=chat");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text).models, ["fake:harness"]);
    assert.equal((await call(host, "GET", "/host/v1/models?task=nope&kind=chat")).status, 404);
    assert.equal((await call(host, "GET", "/host/v1/models?task=chat&kind=nope")).status, 400);
  });

  test("a wait's fields of the wrong type are a 400 naming the field", async () => {
    const r = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: { Job: "yes" }, ticket: { origin: "resume" } } });
    assert.equal(r.status, 400);
    assert.match(r.text, /tag\.Job is a boolean, not a string/);
  });

  test("lane P only for a request the front passed, as its own person", async () => {
    const unknown = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "P", tag: {}, ticket: { origin: "request", request: "deadbeef" } } });
    assert.ok(unknown.lines.at(-1).refused, "an unknown request waits in lane P");
    const { ticket } = host.mint("alice");
    const other = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "P", tag: {}, ticket: { origin: "request", request: ticket.id, person: host.person("bob").id } } });
    assert.equal(other.lines.at(-1).refused, "this request is someone else's");
    const ok = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "P", tag: { Model: "fake:harness" }, ticket: { origin: "request", request: ticket.id, person: ticket.person } } });
    assert.ok(grantOf(ok), JSON.stringify(ok.lines));
    assert.equal(ok.lines[0].position, 1);
    await call(host, "POST", "/host/v1/line/release", { body: { grant: grantOf(ok) } });
  });

  test("an app cannot wait on a key's or a main's ticket, nor in lane A", async () => {
    for (const origin of ["key", "main", ""]) {
      const r = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: {}, ticket: { origin } } });
      assert.ok(r.lines.at(-1).refused, origin);
    }
    const a = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "A", tag: {}, ticket: { origin: "resume" } } });
    assert.ok(a.lines.at(-1).refused);
  });

  test("a model call needs a live grant, on its own model", async () => {
    const chat = { model: "fake:harness", messages: [{ role: "user", content: "Reply with exactly: hi" }] };
    assert.equal((await call(host, "POST", "/v1/chat/completions", { body: chat })).status, 403);
    const w = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: { Model: "fake:harness", Job: true }, ticket: { origin: "job", from: "resume" } } });
    const g = grantOf(w);
    const r = await call(host, "POST", "/v1/chat/completions", { body: chat, headers: { "x-nc-grant": g } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).choices[0].message.content, "hi");
    const other = await call(host, "POST", "/v1/chat/completions", { body: { ...chat, model: "another:model" }, headers: { "x-nc-grant": g } });
    assert.equal(other.status, 403);
    await call(host, "POST", "/host/v1/line/release", { body: { grant: g } });
    assert.equal((await call(host, "POST", "/v1/chat/completions", { body: chat, headers: { "x-nc-grant": g } })).status, 403, "a released grant carries no call");
  });

  test("an admitted call is held to its max_tokens", async () => {
    const w = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "begin", lane: "B", tag: {}, ticket: { origin: "resume" } } });
    const work = grantOf(w);
    const a = await call(host, "POST", "/host/v1/line/admit", { body: { work, call: { Model: "fake:harness", MaxOut: 50 } } });
    const g = JSON.parse(a.text).grant;
    const over = await call(host, "POST", "/v1/chat/completions", { body: { model: "fake:harness", max_tokens: 500, messages: [{ role: "user", content: "x" }] }, headers: { "x-nc-grant": g } });
    assert.equal(over.status, 400);
    assert.match(over.text, /over_admitted/);
    await call(host, "POST", "/host/v1/line/release", { body: { grant: g } });
    await call(host, "POST", "/host/v1/line/end", { body: { work } });
    assert.equal((await call(host, "POST", "/host/v1/line/admit", { body: { work, call: {} } })).status, 410);
  });

  test("the ledger sees a grant never released, and one released twice", async () => {
    host.ledger.reset();
    const w1 = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: {}, ticket: { origin: "resume" } } });
    const w2 = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: {}, ticket: { origin: "resume" } } });
    await call(host, "POST", "/host/v1/line/release", { body: { grant: grantOf(w2) } });
    await call(host, "POST", "/host/v1/line/release", { body: { grant: grantOf(w2) } });
    await call(host, "POST", "/host/v1/line/release", { body: { grant: "g_none" } });
    const problems = host.ledger.problems({ final: true });
    assert.ok(problems.some((p) => p.includes(grantOf(w1)) && p.includes("never released")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes(grantOf(w2)) && p.includes("2 times")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("g_none")), problems.join("\n"));
    await call(host, "POST", "/host/v1/line/release", { body: { grant: grantOf(w1) } });
    host.ledger.reset();
  });

  test("secrets are kept by name, 64 KiB at most", async () => {
    assert.equal((await call(host, "PUT", "/host/v1/secrets/drive.token", { body: { value: "abc" } })).status, 204);
    assert.equal(JSON.parse((await call(host, "GET", "/host/v1/secrets/drive.token")).text).value, "abc");
    assert.equal((await call(host, "PUT", "/host/v1/secrets/big", { body: { value: "x".repeat(70000) } })).status, 413);
    assert.equal((await call(host, "PUT", "/host/v1/secrets/bad%20name", { body: { value: "x" } })).status, 400);
    assert.equal((await call(host, "DELETE", "/host/v1/secrets/drive.token")).status, 204);
    assert.equal((await call(host, "GET", "/host/v1/secrets/drive.token")).status, 404);
  });

  test("a person's role, for its own people only", async () => {
    const alice = host.person("alice");
    assert.deepEqual(JSON.parse((await call(host, "GET", `/host/v1/people/${alice.id}/role`)).text), { person: alice.id, role: "admin" });
    assert.equal((await call(host, "GET", "/host/v1/people/p_unknown/role")).status, 404);
  });

  test("a ticket carries email and name only when the manifest asks people.read", () => {
    const { ticket } = host.mint("alice");
    assert.equal(ticket.email, "alice@harness.local");
    assert.equal(ticket.name, "Alice");
  });
});

describe("the fake models", () => {
  test("a tool call when tools are offered, then words from its result", () => {
    const tools = [{ type: "function", function: { name: "list_workflows", parameters: { type: "object", properties: {} } } }];
    const first = fakeAnswer({ model: "m", tools, messages: [{ role: "user", content: "Hello" }] });
    assert.equal(first.calls[0].name, "list_workflows");
    const after = fakeAnswer({ model: "m", tools, messages: [{ role: "user", content: "Hello" }, { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name: "list_workflows", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: "[]" }] });
    assert.match(after.text, /after the list_workflows tool/);
  });

  test("a tabular row: one JSON line a column, in the shape its instruction asks", () => {
    const sys = 'For each column ... {"column_index": <N>, ...}';
    const user = 'Document: x\n\nColumn 0 — "Parties": Who? If not found, state "Not Found".\nColumn 1 — "Signed": The "summary" field in your JSON response must be [[Yes]] or [[No]] only.';
    const lines = fakeAnswer({ model: "m", messages: [{ role: "system", content: sys }, { role: "user", content: user }] }).text.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.column_index, l.summary]), [[0, "Harness value for Parties"], [1, "[[Yes]]"]]);
  });

  test("a cell: one JSON object", () => {
    const r = fakeAnswer({ model: "m", messages: [{ role: "system", content: 'Return ONLY valid JSON:\n{"summary": string}' }, { role: "user", content: "Instruction: the date, DD Month YYYY format" }] });
    assert.equal(JSON.parse(r.text).summary, "1 January 2024");
  });
});

describe("--models nativecluster", { skip: process.env.HARNESS_REAL_CALL !== "1" && "set HARNESS_REAL_CALL=1 for one tiny real call" }, () => {
  let host;
  before(async () => {
    host = new FakeHost({ pkg: tinyPackage(), models: "nativecluster", log: () => {} });
    host.credential = "c".repeat(64);
    await host.startHostSocket();
  });
  after(() => host.close());

  test("one tiny chat call reaches this Mac's NativeCluster, streamed through", async (t) => {
    const route = JSON.parse((await call(host, "GET", "/host/v1/models?task=chat&kind=chat")).text);
    const model = route.models[0];
    t.diagnostic(`NativeCluster's chat models: ${route.models.join(", ")}; calling ${model}`);
    const w = await call(host, "POST", "/host/v1/line/wait", { body: { kind: "acquire", lane: "B", tag: { Model: model }, ticket: { origin: "resume" } } });
    const g = grantOf(w);
    const r = await call(host, "POST", "/v1/chat/completions", { body: { model, stream: true, max_tokens: 16, think: false, messages: [{ role: "user", content: "Say ok." }] }, headers: { "x-nc-grant": g } });
    await call(host, "POST", "/host/v1/line/release", { body: { grant: g } });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.match(r.headers["content-type"], /event-stream/);
    const text = r.text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "").join("");
    t.diagnostic(`it answered: ${JSON.stringify(text)}`);
    assert.ok(text.trim().length > 0, "an answer in words");
    assert.deepEqual(host.ledger.problems({ final: true }), []);
  });
});

describe("the front door", () => {
  // A stand-in app on a socket that answers with the headers it was given,
  // and a Location on the app's origin.
  const sockets = mkdtempSync(path.join(os.tmpdir(), "nc-door-"));
  const appSocket = path.join(sockets, "app.sock");
  const app = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", location: "https://127.0.0.1:8494/next?x=1" });
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null }));
  });
  const host = { proc: {}, appSocket, person: (label) => ({ id: `p_${label}` }), mint: () => ({ header: "t" }) };
  let door;
  let url;
  before(async () => {
    await new Promise((resolve) => app.listen(appSocket, resolve));
    const { createFront } = await import("./front.mjs");
    door = createFront(host);
    await new Promise((resolve) => door.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${door.address().port}`;
  });
  after(() => {
    door?.close();
    app.close();
  });

  test("passes the door's own Host unless asked to stand in for an app origin", async () => {
    const plain = await (await fetch(`${url}/x`, { headers: { origin: url } })).json();
    assert.equal(plain.host, new URL(url).host);
    assert.equal(plain.origin, url);
  });

  test("stands in for https://127.0.0.1:849x as the real origin would, Host, Origin, Referer and Location", async () => {
    const r = await fetch(`${url}/x`, { redirect: "manual", headers: { origin: url, referer: `${url}/settings/connectors`, "x-harness-app-origin": "https://127.0.0.1:8494" } });
    assert.deepEqual(await r.json(), { host: "127.0.0.1:8494", origin: "https://127.0.0.1:8494", referer: "https://127.0.0.1:8494/settings/connectors" });
    assert.equal(r.headers.get("location"), `${url}/next?x=1`);
  });

  test("refuses an app origin that is not one of NativeCluster's", async () => {
    const r = await fetch(`${url}/x`, { headers: { "x-harness-app-origin": "https://example.com" } });
    assert.equal(r.status, 400);
  });
});
