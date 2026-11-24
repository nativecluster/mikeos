// Mike's launcher: the one process NativeCluster's host starts (through the
// package's program, `mike`), on the Node the package carries.
//
// It reads the host's secrets on stdin, then serves LB_APP_SOCKET (0600)
// at once, with ONE ticket check in front of every route and every protocol
// switch:
//
//   GET  /healthz        answered at once, even while the stack starts
//   GET  /.nc/whoami     {"person"}, for `ncdev check`
//   POST /nc/v1/tick     the host's beat (its own ticket only): to the backend
//   POST /nc/v1/wake     the upkeep schedule's firing (its own ticket only)
//   /api, /api/*         the backend on api.sock, the prefix taken off, with
//                        the headers lib/front.mjs names
//   anything else        Next.js, in this process (pages show "Starting
//                        Mike…" until the stack and Next are ready)
//
// Meanwhile it starts the stack (lib/stack.mjs) and Next.js. Its log, with
// Next's output, is $NC_APP_DATA/logs/launcher.log (the host keeps no app's
// stderr); each request is a line in logs/requests.log, ids masked.

import http from "node:http";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeSync, openSync, closeSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, listenOnSocket, exitWithParent } from "./lib/launch.mjs";
import { ticketCheck, TICKET_HEADER } from "./lib/ticket.mjs";
import { routeOf, backendHeaders, dropHeaders, isForgeable } from "./lib/front.mjs";
import { proxyRequest, proxyUpgrade } from "./lib/proxy.mjs";
import { createLog, captureConsole, logsDir, rotateIfLarge } from "./lib/logs.mjs";
import { hostSecrets, setUpkeepSchedule } from "./lib/host.mjs";
import { loadStackSecrets } from "./lib/stackSecrets.mjs";
import { createStack } from "./lib/stack.mjs";
import { startingPage, failedPage } from "./lib/pages.mjs";

const bootStarted = Date.now();
const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.dirname(launcherDir);
const manifest = JSON.parse(readFileSync(path.join(pkgDir, "nc-app.json"), "utf8"));
const peopleRead = (manifest.permissions ?? []).some((p) => p.id === "people.read");

let L;
try {
  L = await launch();
} catch (e) {
  // Nowhere to log yet but stderr, which the host may keep.
  process.stderr.write(`mike: ${e.message}\n`);
  process.exit(1);
}
const logDir = logsDir(L.dataDir);
const log = createLog(logDir, "launcher");
captureConsole(log);
log.info(`Mike ${manifest.version ?? ""} starting (pid ${process.pid}${L.woken ? ", woken" : ""})`);

let leaving = false;
let stack = null;
async function leave(why, code = 0) {
  if (leaving) return;
  leaving = true;
  log.info(`leaving: ${why}`);
  const hardStop = setTimeout(() => process.exit(code), 30000);
  hardStop.unref();
  try {
    server.close();
  } catch {}
  if (stack) await stack.stopAll(25000).catch((e) => log.error("stop failed", e));
  try {
    unlinkSync(L.appSocket);
  } catch {}
  log.info("left");
  log.close();
  process.exit(code);
}
process.on("SIGTERM", () => void leave("SIGTERM"));
process.on("SIGINT", () => void leave("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));
process.on("uncaughtException", (e) => {
  log.error("uncaught exception", e);
  void leave("an uncaught exception", 1);
});
exitWithParent(() => void leave("the host is gone"));

const verify = ticketCheck(L.ticketKey);
// Between the launcher and the backend, made at each start, held in memory
// and handed over on the backend's stdin only.
const internalSecret = randomBytes(32).toString("hex");

// --- requests.log: one line a request, path segments that are not plain
// words masked (ids, tokens), never a query ---
const requestsFile = path.join(logDir, "requests.log");
rotateIfLarge(requestsFile);
const requestsFd = openSync(requestsFile, "a", 0o600);
try {
  chmodSync(requestsFile, 0o600);
} catch {}
function maskPath(rawUrl) {
  const p = (rawUrl ?? "").split("?")[0];
  return p
    .split("/")
    .map((seg) => (seg === "" || /^[A-Za-z][A-Za-z_-]{0,40}$/.test(seg) || /^[A-Za-z0-9_-]+\.(js|css|woff2?|png|svg|ico|json|txt|map|ttf|webp)$/.test(seg) ? seg : ":id"))
    .join("/");
}
function noteRequest(req, res, kind, ticket, t0) {
  const who = !ticket ? "no-ticket" : ticket.host ? "host" : ticket.person ? "person" : "nobody";
  const line = `${new Date().toISOString()} ${req.method} ${maskPath(req.url)} ${res.statusCode} ${Math.round(performance.now() - t0)}ms ${kind} ${who}\n`;
  try {
    writeSync(requestsFd, line);
  } catch {}
}

function send(res, status, body, type = "application/json", extra = {}) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-store", ...extra });
  res.end(buf);
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > max) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --- Next.js, in this process. Next attaches its upgrade listener to
// `httpServer` (else to the request's own server, behind no ticket check):
// an emitter of ours, fed only after the check. ---
const nextUpgrades = new EventEmitter();
const nextState = { handle: null, error: null, ms: null };
async function startNext() {
  const t0 = performance.now();
  try {
    const webDir = path.join(pkgDir, "web", "frontend");
    const conf = JSON.parse(readFileSync(path.join(webDir, ".next", "required-server-files.json"), "utf8")).config;
    // The package is read-only: Next keeps its ISR and fetch caches in memory.
    conf.experimental = { ...(conf.experimental ?? {}), isrFlushToDisk: false };
    process.env.NODE_ENV = "production";
    process.env.NEXT_TELEMETRY_DISABLED = "1";
    process.env.SENTRY_DISABLED = "true";
    process.env.NEXT_PUBLIC_SENTRY_DISABLED = "true";
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
    process.chdir(webDir);
    const requireFromWeb = createRequire(path.join(webDir, "package.json"));
    const next = requireFromWeb("next");
    const app = next({ dev: false, dir: webDir, hostname: "localhost", port: 3000, quiet: true, httpServer: nextUpgrades });
    await app.prepare();
    nextState.handle = app.getRequestHandler();
  } catch (e) {
    nextState.error = e?.message ?? String(e);
    log.error("Next.js did not start", e);
  }
  nextState.ms = Math.round(performance.now() - t0);
  log.info(`Next.js ${nextState.handle ? "ready" : "failed"} in ${nextState.ms} ms`);
}

const stackReady = () => stack?.state.ready === true;
const appReady = () => stackReady() && nextState.handle !== null;
const failure = () => stack?.state.error ?? (nextState.error ? "Mike's pages could not start." : null);

function waitReady(ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => (stackReady() || stack?.state.phase === "failed" || Date.now() > deadline ? resolve(stackReady()) : setTimeout(check, 200));
    check();
  });
}

async function route(req, res, ticket, r) {
  switch (r.kind) {
    case "healthz":
      return send(res, 200, { status: "ok" });
    case "whoami":
      return send(res, 200, { person: ticket.person });
    case "bad":
      return send(res, 400, "bad request\n", "text/plain; charset=utf-8");
    case "notfound":
      return send(res, 404, "not found\n", "text/plain; charset=utf-8");
    case "tick": {
      const out = await stack.tick().catch((e) => {
        log.warn("the beat did not reach the backend", e.message);
        return { status: 503, body: JSON.stringify({ ok: false }) };
      });
      return send(res, out.status, out.body);
    }
    case "wake": {
      let firing = {};
      try {
        firing = JSON.parse(await readBody(req));
      } catch {}
      log.info(`firing ${String(firing.id ?? "").slice(0, 64)} of ${String(firing.trigger_id ?? firing.trigger ?? "").slice(0, 64)}`);
      // The sweeps run at the backend's start anyway; a firing that finds the
      // stack ready runs them now. Answered within the host's minute.
      if (await waitReady(40000)) await stack.tick().catch((e) => log.warn("the firing's sweeps did not run", e.message));
      return send(res, 200, { jobs: [] });
    }
    case "api": {
      // While the stack starts, a request waits for it, as the host holds a
      // request until the app answers its health check (two minutes at most).
      if (!stackReady() && stack?.state.phase === "starting") await waitReady(120000);
      if (!stackReady()) {
        const failed = stack?.state.phase === "failed";
        return send(res, 503, { code: failed ? "app_failed" : "starting", detail: failed ? "Mike could not start. Quit Mike and open it again." : "Mike is still starting. Try again in a moment." }, "application/json", failed ? {} : { "retry-after": "2" });
      }
      const headers = backendHeaders(req.headers, ticket, internalSecret, { peopleRead });
      return proxyRequest(req, res, { socketPath: stack.paths.apiSocket, path: r.backendPath, headers, onError: (e) => log.warn(`api request failed: ${e.code ?? e.message}`) });
    }
    case "next": {
      if (!appReady()) {
        const why = failure();
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 503, why ? "Mike could not start.\n" : "Mike is starting.\n", "text/plain; charset=utf-8", why ? {} : { "retry-after": "2" });
        return why ? send(res, 500, failedPage(why), "text/html; charset=utf-8") : send(res, 200, startingPage(stack?.state.step), "text/html; charset=utf-8");
      }
      // Pages learn the person only through the backend.
      dropHeaders(req, isForgeable);
      return nextState.handle(req, res);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const ticket = verify(req.headers[TICKET_HEADER]);
  let kind = "refused";
  res.on("finish", () => noteRequest(req, res, kind, ticket, t0));
  if (!ticket) return send(res, 403, "no valid ticket from NativeCluster\n", "text/plain; charset=utf-8");
  dropHeaders(req, (n) => n.toLowerCase() === TICKET_HEADER);
  const r = routeOf(req.method, req.url, ticket);
  kind = r.kind;
  try {
    await route(req, res, ticket, r);
  } catch (e) {
    log.error(`${r.kind} request failed`, e);
    if (!res.headersSent) send(res, 500, "internal error\n", "text/plain; charset=utf-8");
    else res.destroy();
  }
});
// No timeout of the launcher's own on a request: an answer may stream for
// as long as the backend's deadlines allow.
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.on("upgrade", (req, socket, head) => {
  const ticket = verify(req.headers[TICKET_HEADER]);
  const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  if (!ticket) return refuse("403 Forbidden");
  dropHeaders(req, (n) => n.toLowerCase() === TICKET_HEADER);
  const r = routeOf(req.method, req.url, ticket);
  if (r.kind === "api" && stackReady()) {
    return proxyUpgrade(req, socket, head, { socketPath: stack.paths.apiSocket, path: r.backendPath, headers: backendHeaders(req.headers, ticket, internalSecret, { peopleRead, upgrade: true }) });
  }
  if (r.kind === "next" && appReady() && nextUpgrades.listenerCount("upgrade") > 0) {
    dropHeaders(req, isForgeable);
    return nextUpgrades.emit("upgrade", req, socket, head);
  }
  return refuse(r.kind === "next" || r.kind === "api" ? "503 Service Unavailable" : "404 Not Found");
});

await listenOnSocket(server, L.appSocket);
log.info(`serving on its socket ${Date.now() - bootStarted} ms after start`);

// --- the stack and Next, side by side ---
const store = hostSecrets(L.hostSocket, L.credential);
let secrets;
try {
  secrets = await loadStackSecrets(store, log);
} catch (e) {
  log.error("the host's secrets store did not answer", e);
  stack = { state: { phase: "failed", ready: false, error: "Mike could not read its keys from NativeCluster.", step: "" }, stopAll: async () => {}, tick: async () => ({ status: 200, body: "{}" }) };
}
if (secrets) {
  stack = createStack({ pkgDir, dataDir: L.dataDir, socketsDir: L.socketsDir, hostSocket: L.hostSocket, credential: L.credential, secrets, internalSecret, log, logDir, version: manifest.version, onFatal: (why) => void leave(`the stack failed while running: ${why}`, 1) });
  const stackStarted = stack.start();
  const nextStarted = startNext();
  setUpkeepSchedule(L.hostSocket, L.credential).catch((e) => log.warn("the upkeep schedule was not set", e.message));
  await Promise.all([stackStarted, nextStarted]);
  log.info(`boot: ${appReady() ? "ready" : "not ready"} ${Date.now() - bootStarted} ms after start`, { stack: stack.state.timings, next_ms: nextState.ms });
}
