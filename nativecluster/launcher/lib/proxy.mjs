// Passing a request on to the backend's unix socket and its answer back,
// streamed both ways (an assistant's answer is a long SSE stream), with no
// time limit of the launcher's own: the backend keeps its own deadlines.
// A browser that goes away ends the backend's request too.

import http from "node:http";
import net from "node:net";

export function proxyRequest(req, res, { socketPath, path, headers, onError }) {
  const upstream = http.request({ socketPath, method: req.method, path, headers });
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
  req.pipe(upstream);
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
