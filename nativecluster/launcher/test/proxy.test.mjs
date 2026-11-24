// The proxy to the backend's socket: the request and its headers arrive as
// the launcher set them, the answer streams back, and a browser that leaves
// ends the backend's request.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxyRequest } from "../lib/proxy.mjs";
import { backendHeaders } from "../lib/front.mjs";

const ticket = { id: "r9", remote: "127.0.0.1:6000", tls: true, host: false, person: "p_ann", email: "ann@example.com", name: "Ann" };

async function serve(handler) {
  const dir = mkdtempSync(path.join(tmpdir(), "mkp-"));
  const socketPath = path.join(dir, "api.sock");
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(socketPath, r));
  return { socketPath, close: () => new Promise((r) => server.close(() => (rmSync(dir, { recursive: true, force: true }), r()))) };
}

async function front(socketPath, backendPath) {
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, { socketPath, path: backendPath, headers: backendHeaders(req.headers, ticket, "s".repeat(64)) });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("a request reaches the backend with the launcher's headers, the body and the answer whole", async () => {
  let seen;
  const backend = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(201, { "content-type": "application/json", "x-request-id": "abc" });
      res.end('{"ok":true}');
    });
  });
  const f = await front(backend.socketPath, "/projects?x=1");
  const r = await fetch(`${f.url}/api/projects?x=1`, { method: "POST", body: '{"name":"n"}', headers: { "content-type": "application/json", "x-nc-person": "p_mallory", origin: "https://127.0.0.1:8493" } });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), '{"ok":true}');
  assert.equal(r.headers.get("x-request-id"), "abc");
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/projects?x=1");
  assert.equal(seen.body, '{"name":"n"}');
  assert.equal(seen.headers["x-nc-person"], "p_ann");
  assert.equal(seen.headers["x-nc-internal"], "s".repeat(64));
  assert.equal(seen.headers.origin, "https://127.0.0.1:8493");
  assert.match(seen.headers.host, /^127\.0\.0\.1:\d+$/);
  await f.close();
  await backend.close();
});

test("an answer streams as the backend writes it", async () => {
  let release;
  const backend = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    release = () => res.end("data: two\n\n");
  });
  const f = await front(backend.socketPath, "/chat");
  const r = await fetch(`${f.url}/api/chat`);
  const reader = r.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, "data: one\n\n");
  release();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.equal(rest, "data: two\n\n");
  await f.close();
  await backend.close();
});

test("a browser that leaves ends the backend's request", async () => {
  let closed;
  const gone = new Promise((r) => (closed = r));
  const backend = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: start\n\n");
    res.on("close", () => closed());
  });
  const f = await front(backend.socketPath, "/chat");
  const ac = new AbortController();
  const r = await fetch(`${f.url}/api/chat`, { signal: ac.signal });
  await r.body.getReader().read();
  ac.abort();
  await Promise.race([gone, new Promise((_, no) => setTimeout(() => no(new Error("the backend's request was not ended")), 3000))]);
  await f.close();
  await backend.close();
});

test("a backend that is not there is a 502 in words", async () => {
  const f = await front(path.join(tmpdir(), "no-such-dir-mike", "api.sock"), "/x");
  const r = await fetch(`${f.url}/api/x`);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, "upstream_unavailable");
  await f.close();
});
