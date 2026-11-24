// The fake host's front door: an HTTP server on 127.0.0.1 (43900 by
// default) for a browser or a test, standing where NativeCluster's app origin
// (https://127.0.0.1:849x) stands. Each request it passes to the app's
// LB_APP_SOCKET, upgrades included, carries an X-NC-Ticket it mints for the
// person chosen, signed with the fake host's ticket key, `iat` now.
//
// It does to a request what the real origin does (host/host/origin.go,
// handler and rewriteFor; front.go, appProxy; origin/main):
//   - any X-NC-Ticket the client sent is dropped;
//   - every Cookie is dropped, and an `Authorization: Bearer ...` too
//     (people.DropCredential): an app gets no credential through the host;
//   - every Set-Cookie the app answers is dropped;
//   - /nativecluster, /host and /.nc/ paths never reach the app (404), nor
//     TRACE or TRACK (405);
//   - nobody signed in reaches no app: the host answers 401 itself (0.4.15);
//     X-Harness-Pass-Nobody: 1 passes such a request on with a ticket that
//     names nobody, to test the app's own answer to it.
// `keepCredentials` turns the second off, to tell a harness difference from
// an app's own fault; nothing else is optional.
//
// Choosing the person, per request: the X-Harness-Person header, else the
// nc_harness_person cookie (both read here and never passed on), else the
// door's default. A value is a label ("alice", "bob"): the fake host gives
// each label one stable person id. "nobody" is no one signed in.
//
// Negative tests: X-Harness-Ticket (or the nc_harness_ticket cookie, or the
// door's default) set to "none" sends no ticket, "bad" one signed with
// another key, "stale" one five minutes old.
//
// Control routes, the door's own, never passed on: /.harness/... (README).

import http from "node:http";
import net from "node:net";
import { signTicket, newTicketKey, TICKET_HEADER } from "./ticket.mjs";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);

function cookieOf(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

async function readJSON(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function send(res, status, body) {
  const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "content-length": b.length, "cache-control": "no-store" });
  res.end(b);
}

export function createFront(host, { person = "alice", ticket = "valid", keepCredentials = false } = {}) {
  const state = { person, ticket, keepCredentials };

  const choice = (req) => ({
    person: req.headers["x-harness-person"] ?? cookieOf(req, "nc_harness_person") ?? state.person,
    ticket: req.headers["x-harness-ticket"] ?? cookieOf(req, "nc_harness_ticket") ?? state.ticket,
    passNobody: (req.headers["x-harness-pass-nobody"] ?? cookieOf(req, "nc_harness_pass_nobody")) === "1",
  });

  /** The ticket header for a request, or null for none. */
  function ticketFor(req, c) {
    const who = c.person === "nobody" || c.person === "" ? null : c.person;
    const remote = `127.0.0.1:${req.socket.remotePort ?? 0}`;
    switch (c.ticket) {
      case "none":
        return null;
      case "bad":
        return signTicket(newTicketKey(), { id: "forged", remote, tls: true, iat: Date.now(), person: who ? host.person(who).id : "" });
      case "stale":
        return host.mint(who, { iat: Date.now() - 5 * 60000, remote }).header;
      default:
        return host.mint(who, { remote }).header;
    }
  }

  /** The request's headers as the host passes them on. */
  function rewrite(req, c) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || k === TICKET_HEADER || k.startsWith("x-harness-")) continue;
      if (k === "cookie" && !state.keepCredentials) continue;
      if (k === "authorization" && !state.keepCredentials && String(v).startsWith("Bearer ")) continue;
      h[k] = v;
    }
    const t = ticketFor(req, c);
    if (t) h[TICKET_HEADER] = t;
    return h;
  }

  function refused(req, res) {
    const p = (req.url ?? "/").split("?")[0];
    const m = (req.method ?? "GET").toUpperCase();
    if (m === "TRACE" || m === "TRACK") {
      send(res, 405, "Method not allowed.\n");
      return true;
    }
    if (p === "/nativecluster" || p.startsWith("/nativecluster/") || p === "/host" || p.startsWith("/host/") || p.startsWith("/.nc/")) {
      send(res, 404, "404 page not found\n");
      return true;
    }
    return false;
  }

  async function control(req, res, p) {
    const c = choice(req);
    switch (`${req.method} ${p}`) {
      case "GET /.harness/ready":
        return host.healthy && host.proc ? send(res, 200, { ready: true }) : send(res, 503, { ready: false });
      case "GET /.harness/state":
        return send(res, 200, {
          app: { id: host.appId, pid: host.proc?.pid ?? null, starts: host.starts, sandbox: host.sandbox, healthy: host.healthy ?? null, exit: host.exit ?? null },
          models: host.models.kind,
          door: state,
          people: [...host.people.values()].map(({ id, label, role }) => ({ id, label, role })),
          data: host.data,
          state: host.state,
        });
      case "GET /.harness/whoami": {
        const who = c.person === "nobody" ? null : host.person(c.person);
        return send(res, 200, { person: who?.id ?? "", label: who?.label ?? "nobody", ticket: c.ticket });
      }
      case "POST /.harness/person": {
        const b = await readJSON(req);
        if (typeof b.person !== "string") return send(res, 400, "person: a label, or \"nobody\"\n");
        state.person = b.person;
        if (b.person !== "nobody") host.person(b.person, b.role);
        return send(res, 200, { person: state.person });
      }
      case "POST /.harness/people": {
        const b = await readJSON(req);
        const p = host.person(b.label, b.role);
        host.saveState();
        return send(res, 200, { id: p.id, label: p.label, role: p.role });
      }
      case "POST /.harness/ticket": {
        const b = await readJSON(req);
        if (!["valid", "none", "bad", "stale"].includes(b.mode)) return send(res, 400, "mode: valid, none, bad or stale\n");
        state.ticket = b.mode;
        return send(res, 200, { ticket: state.ticket });
      }
      case "GET /.harness/ledger":
        return send(res, 200, host.ledger.toJSON());
      case "GET /.harness/ledger/problems": {
        const final = new URL(req.url, "http://x").searchParams.get("final") === "1";
        return send(res, 200, { problems: host.ledger.problems({ final }), summary: host.ledger.summary() });
      }
      case "POST /.harness/ledger/reset":
        host.ledger.reset();
        return send(res, 200, { reset: true });
      case "POST /.harness/models/script": {
        const b = await readJSON(req);
        host.models.script.push(...(Array.isArray(b) ? b : [b]));
        return send(res, 200, { queued: host.models.script.length });
      }
      case "POST /.harness/line/hold":
        host.holdLine();
        return send(res, 200, { line: "held" });
      case "POST /.harness/line/open":
        host.openLine();
        return send(res, 200, { line: "open" });
      case "POST /.harness/tick": {
        const r = await host.tick();
        return send(res, 200, { status: r.status });
      }
      case "POST /.harness/restart": {
        const stopped = await host.restart();
        return send(res, 200, { stopped, healthy: host.healthy });
      }
      default:
        return send(res, 404, "the harness's door has no such control route\n");
    }
  }

  const server = http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    try {
      if (p.startsWith("/.harness/")) return await control(req, res, p);
    } catch (e) {
      return send(res, 500, `the harness's door failed: ${e.message}\n`);
    }
    if (refused(req, res)) return;
    const c = choice(req);
    if ((c.person === "nobody" || c.person === "") && c.ticket === "valid" && !c.passNobody) {
      return send(res, 401, "Sign in to NativeCluster to open this app. (The harness's door has no person chosen: set X-Harness-Person.)\n");
    }
    if (!host.proc || !host.appSocket) return send(res, 502, "The app is not running (the harness's door).\n");
    const up = http.request({ socketPath: host.appSocket, path: req.url, method: req.method, headers: rewrite(req, c), agent: false }, (ur) => {
      const headers = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (HOP.has(k) || k === "set-cookie") continue;
        headers[k] = v;
      }
      res.writeHead(ur.statusCode ?? 502, headers);
      res.flushHeaders?.();
      ur.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) send(res, 502, `The app did not answer (the harness's door): ${e.code ?? e.message}\n`);
      else res.destroy();
    });
    // The person leaving (a closed page) reaches the app as a hang-up.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  });

  server.on("upgrade", (req, socket, head) => {
    const p = (req.url ?? "/").split("?")[0];
    const c = choice(req);
    const fail = (status, words) => socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(words)}\r\nConnection: close\r\n\r\n${words}`);
    if (p.startsWith("/nativecluster") || p.startsWith("/host/") || p.startsWith("/.nc/") || p.startsWith("/.harness/")) return fail("404 Not Found", "404 page not found\n");
    if ((c.person === "nobody" || c.person === "") && c.ticket === "valid" && !c.passNobody) return fail("401 Unauthorized", "Sign in to NativeCluster to open this app.\n");
    if (!host.proc) return fail("502 Bad Gateway", "The app is not running.\n");
    const h = rewrite(req, c);
    h.connection = "Upgrade";
    h.upgrade = req.headers.upgrade;
    const up = net.connect(host.appSocket, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  server.state = state;
  return server;
}

/** Starts the door on 127.0.0.1:<port>; resolves with the server and its URL. */
export function listenFront(host, port = 43900, opts = {}) {
  const server = createFront(host, opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 alone, never a wider address: the door signs anyone in.
    // Its URL names 127.0.0.1 too, as the app's real origin does
    // (https://127.0.0.1:849x), so a browser's localStorage is that origin's.
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
