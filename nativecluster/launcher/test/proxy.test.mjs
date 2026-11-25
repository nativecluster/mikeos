// The proxy to the backend's socket: the request and its headers arrive as
// the launcher set them, the answer streams back, and a browser that leaves
// ends the backend's request.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { BACKEND_MAX_SOCKETS, backendAgent, proxyRequest } from "../lib/proxy.mjs";
import { backendHeaders } from "../lib/front.mjs";

const ticket = { id: "r9", remote: "127.0.0.1:6000", tls: true, host: false, person: "p_ann", email: "ann@example.com", name: "Ann" };

async function serve(handler) {
  const dir = mkdtempSync(path.join(tmpdir(), "mkp-"));
  const socketPath = path.join(dir, "api.sock");
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(socketPath, r));
  return { socketPath, close: () => new Promise((r) => server.close(() => (rmSync(dir, { recursive: true, force: true }), r()))) };
}

async function front(socketPath, backendPath, extra = {}) {
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, { socketPath, path: backendPath, headers: backendHeaders(req.headers, ticket, "s".repeat(64)), ...extra });
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

// The robustness campaign's P1 (2026-11-24): a connection a request, so 400
// at once overflowed api.sock's listen backlog (macOS caps it at 128) and
// 3.7-7.6% answered 502 (ECONNREFUSED). Through the pool the backend sees
// at most BACKEND_MAX_SOCKETS connections, reused.
test("a burst reaches the backend over a pool of kept connections, never one a request", async () => {
  let open = 0;
  let most = 0;
  let made = 0;
  const dir = mkdtempSync(path.join(tmpdir(), "mkb-"));
  const socketPath = path.join(dir, "api.sock");
  const server = http.createServer((req, res) => setTimeout(() => res.end("ok"), 30));
  server.on("connection", (socket) => {
    made += 1;
    open += 1;
    most = Math.max(most, open);
    socket.on("close", () => (open -= 1));
  });
  await new Promise((r) => server.listen(socketPath, r));
  const pool = backendAgent();
  const f = await front(socketPath, "/projects", { agent: pool });
  // More requests at once than the pool holds, fewer than the front's own
  // TCP backlog (the test's side, not the launcher's).
  const n = 2 * BACKEND_MAX_SOCKETS - 20;
  const client = new http.Agent({ keepAlive: false, maxSockets: Infinity });
  const one = () =>
    new Promise((resolve) => {
      const url = new URL(`${f.url}/api/projects`);
      http
        .get({ host: url.hostname, port: url.port, path: url.pathname, agent: client }, (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode));
        })
        .on("error", (e) => resolve(e.code));
    });
  try {
    const statuses = await Promise.all(Array.from({ length: n }, one));
    assert.deepEqual([...new Set(statuses)], [200]);
    assert.ok(most <= BACKEND_MAX_SOCKETS, `at most ${BACKEND_MAX_SOCKETS} connections to the backend at once (${most} for ${n} requests)`);
    assert.ok(made <= BACKEND_MAX_SOCKETS, `connections are kept and reused (${made} made for ${n} requests)`);
    assert.equal(await one(), 200);
    assert.ok(made <= BACKEND_MAX_SOCKETS, `the next request made no new connection (${made})`);
  } finally {
    client.destroy();
    pool.destroy();
    await f.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request with no body whose connection was refused is sent once more, never one with a body", async () => {
  const seen = [];
  const backend = await serve((req, res) => {
    seen.push(req.method);
    res.end("ok");
  });
  // An agent whose first connection is refused, as an overflowing backlog refuses one.
  class RefusingOnce extends http.Agent {
    refused = 0;
    createConnection(options, cb) {
      if (this.refused === 0 || (this.refuseAll ?? false)) {
        this.refused += 1;
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
        return socket;
      }
      return super.createConnection(options, cb);
    }
  }
  const agent = new RefusingOnce({ keepAlive: false });
  const failed = [];
  const f = await front(backend.socketPath, "/projects", { agent, onError: (e) => failed.push(e.code) });
  const r = await fetch(`${f.url}/api/projects`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
  assert.equal(agent.refused, 1);
  assert.deepEqual(seen, ["GET"]);
  assert.deepEqual(failed, [], "the refusal was not the request's answer");

  // A body is never sent twice: its refusal answers 502.
  agent.refused = 0;
  const posted = await fetch(`${f.url}/api/projects`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(posted.status, 502);
  assert.deepEqual(failed, ["ECONNREFUSED"]);
  assert.deepEqual(seen, ["GET"]);

  // Sent once more only: a second refusal answers 502.
  agent.refuseAll = true;
  const again = await fetch(`${f.url}/api/projects`);
  assert.equal(again.status, 502);
  assert.equal(agent.refused, 3);
  await f.close();
  await backend.close();
});
