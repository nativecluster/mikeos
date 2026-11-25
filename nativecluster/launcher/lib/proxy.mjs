// Passing a request on to the backend's unix socket and its answer back,
// streamed both ways (an assistant's answer is a long SSE stream), with no
// time limit of the launcher's own: the backend keeps its own deadlines.
// A browser that goes away ends the backend's request too.
//
// The connections to api.sock are a pool (backendAgent): at most
// BACKEND_MAX_SOCKETS at once, kept open between requests. With a new
// connection a request (Node's global agent, no cap), a burst overflowed the
// backend's listen backlog, which macOS caps at 128 (kern.ipc.somaxconn):
// 400 requests at once answered 136 of 2,000 with 502, every one
// ECONNREFUSED (the robustness campaign's P1, 2026-11-24). Pooled, 0 of
// 4,000 at 400 and 0 of 6,000 at 600, and faster (p50 1,007 ms in place of
// 1,737 at 400): a request past the pool waits in the launcher, not in the
// kernel's backlog. A request with no body that still meets a refused
// connection, or a kept connection the backend closed as it was reused, is
// sent once more before it answers 502: it never reached the backend.

import http from "node:http";
import net from "node:net";

/** Connections to the backend's socket at once (well inside macOS's backlog of 128). */
export const BACKEND_MAX_SOCKETS = 64;

export function backendAgent() {
  return new http.Agent({ keepAlive: true, maxSockets: BACKEND_MAX_SOCKETS, maxFreeSockets: BACKEND_MAX_SOCKETS });
}

const sharedAgent = backendAgent();

/** Whether a request carries no body, so sending it again sends nothing twice. */
function bodiless(req) {
  const length = req.headers["content-length"];
  return req.headers["transfer-encoding"] === undefined && (length === undefined || Number(length) === 0);
}

/** A failure that means the request never reached the backend. */
function neverReached(err, upstream) {
  return err?.code === "ECONNREFUSED" || err?.code === "EAGAIN" || (upstream.reusedSocket && err?.code === "ECONNRESET");
}

export function proxyRequest(req, res, { socketPath, path, headers, onError, agent = sharedAgent, retried = false }) {
  const upstream = http.request({ socketPath, method: req.method, path, headers, agent });
  let answered = false;
  upstream.on("response", (up) => {
    answered = true;
    // rawHeaders keep repeated headers as they came.
    const out = [];
    for (let i = 0; i < up.rawHeaders.length; i += 2) {
      const name = up.rawHeaders[i].toLowerCase();
      if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") continue;
      out.push(up.rawHeaders[i], up.rawHeaders[i + 1]);
    }
    res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    up.pipe(res);
    up.on("error", () => res.destroy());
  });
  upstream.on("error", (err) => {
    if (!answered && !retried && !res.headersSent && !res.destroyed && bodiless(req) && neverReached(err, upstream)) {
      setTimeout(() => proxyRequest(req, res, { socketPath, path, headers, onError, agent, retried: true }), 25);
      return;
    }
    onError?.(err);
    if (!answered && !res.headersSent) {
      const body = JSON.stringify({ code: "upstream_unavailable", detail: "Mike's service did not answer. Try again in a moment." });
      res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "retry-after": "2" });
      res.end(body);
    } else {
      res.destroy();
    }
  });
  // The browser left before the answer ended: end the backend's request.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.on("aborted", () => upstream.destroy());
  // A request sent again had no body, and its stream has ended already.
  if (retried) upstream.end();
  else req.pipe(upstream);
}

/** A protocol switch (WebSocket) passed to the backend's socket as bytes. */
export function proxyUpgrade(req, socket, head, { socketPath, path, headers }) {
  const lines = [`${req.method} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  const upstream = net.connect(socketPath);
  upstream.on("connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const end = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", end);
  socket.on("error", end);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

/** One whole request to a unix socket, for the launcher's own calls (health, the beat). */
export function socketCall(socketPath, method, path, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on("error", reject);
    req.end();
  });
}
