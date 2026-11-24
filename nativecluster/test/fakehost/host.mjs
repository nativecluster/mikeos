// A fake NativeCluster host for one app package: it starts the package's
// program the way NativeCluster's host does (host/host/app.go, startLocked;
// apps.go, otherAppEnv; sandbox.go), serves the host's socket the app calls
// (hostsocket.mjs), signs the tickets of the requests it passes on, and stops
// the app the way the host does.
//
// Starting, as the host starts an app beside the bundle's:
//   - the program named by nc-app.json's `program`, from the package folder,
//     in a process group of its own, working folder "/";
//   - the environment launchd gives the host (PATH=/usr/bin:/bin:/usr/sbin:
//     /sbin, USER, LOGNAME, SHELL, __CF_USER_TEXT_ENCODING), no LB_*, NC_* or
//     proxy variable of the harness's own, then LB_APP_SOCKET, LB_HOST_SOCKET,
//     LB_SECRETS_STDIN=1, LB_EXIT_WITH_PARENT=1, LB_WRAPPER_RESTART_EXIT=75,
//     NC_APP_DATA, NC_APP_BASE=/, NC_APP_SOCKETS (a short folder under /tmp,
//     emptied at each start), PYTHONDONTWRITEBYTECODE=1, and HOME and TMPDIR
//     inside the data folder (the sandbox's; set unconfined too, as every app
//     on a Mac gets them);
//   - its secrets on stdin, one JSON line, then stdin closed:
//     {"app_credential", "ticket_key"} (fresh, random, per start);
//   - started once GET /healthz, with a ticket of the host's own, answers 200
//     or 503.
// Stopping: SIGTERM, then SIGKILL after the grace (the host's is 60 s); once
// it has ended, whatever it left in its group gets SIGTERM, then SIGKILL 3 s
// later (endGroup). What was left, and what escaped the group, is reported.
//
// With `sandbox: true` the program starts under NativeCluster's own app
// profile (../../dev/sandbox/profile.mjs), through /usr/bin/sandbox-exec,
// exactly as the host confines it.

import http from "node:http";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, chmodSync, realpathSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostSocket } from "./hostsocket.mjs";
import { Ledger } from "./ledger.mjs";
import { FakeModels, RealModels } from "./models.mjs";
import { signTicket, newTicketKey, newSecret, newRequestId, TICKET_HEADER } from "./ticket.mjs";
import { treeOf, alive } from "./procs.mjs";
import { sandboxCommand, sandboxEnv, manifestSandbox, renderProfile } from "../../dev/sandbox/profile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RESTART_CODE = 75;
export const STOP_GRACE_MS = 60000; // host/host/idle.go, stopGrace
export const LEFT_GRACE_MS = 3000; // host/host/app.go, leftGrace

/** sockName: the first 6 bytes of SHA-256 of the app's id, hex (app.go). */
export const sockName = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);

/** A person's stable id for a label: p_ and 32 hex digits, as the host's are. */
export const personIdFor = (label) => "p_" + createHash("sha256").update(`nativecluster-harness-person\n${label}`).digest("hex").slice(0, 32);

export function readManifest(pkg) {
  const file = path.join(pkg, "nc-app.json");
  const raw = readFileSync(file);
  return { raw, manifest: JSON.parse(raw.toString("utf8")) };
}

/** The environment launchd gives the host, which an app starts from. */
function baseEnv() {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["USER", "LOGNAME", "SHELL", "__CF_USER_TEXT_ENCODING"]) if (process.env[k]) env[k] = process.env[k];
  env.USER ??= os.userInfo().username;
  env.LOGNAME ??= env.USER;
  env.SHELL ??= "/bin/zsh";
  return env;
}

export class FakeHost {
  /**
   * opts: pkg (the package folder), data (NC_APP_DATA; default a new one in
   * the state folder), state (the harness's own folder: ledger, logs,
   * secrets; default a new temporary one), models ("fake" or
   * "nativecluster"), sandbox (bool), appId (default the manifest's id),
   * people ({label: role}), lineDelayMs, log (a function), healthTimeoutMs.
   */
  constructor(opts) {
    this.pkg = realpathSync(path.resolve(opts.pkg));
    const { raw, manifest } = readManifest(this.pkg);
    this.manifestRaw = raw;
    this.manifest = manifest;
    this.appId = opts.appId ?? manifest.id;
    this.state = opts.state ? path.resolve(opts.state) : mkdtempSync(path.join(os.tmpdir(), "mike-harness-"));
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    this.data = path.resolve(opts.data ?? path.join(this.state, "Data", manifest.name ?? this.appId));
    this.sandbox = !!opts.sandbox;
    // Record every write a Node process of the app attempts outside the
    // folders it may write (fswatch.mjs); for the contract test alone.
    this.watchWrites = !!opts.watchWrites;
    this.log = opts.log ?? ((...a) => process.stderr.write(`fakehost: ${a.join(" ")}\n`));
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 240000;
    this.lineDelayMs = opts.lineDelayMs ?? 0;
    this.models = opts.models === "nativecluster" ? new RealModels() : new FakeModels();
    this.ledger = new Ledger(path.join(this.state, "ledger.json"));
    this.issued = new Map(); // request id -> {person, at}
    this.firings = new Map();
    this.people = new Map(); // id -> {id, label, role, email, name}
    this.secrets = new Map();
    this.loadState();
    for (const [label, role] of Object.entries(opts.people ?? { alice: "admin", bob: "member" })) this.person(label, role);
    this.starts = 0;
    this.proc = null;
    this.seen = new Map(); // pid -> {pid, comm, ppid, pgid}, this start's
    this.allSeen = new Map(); // every start's
    this._lineOpen = Promise.resolve();
    this._openLine = null;
    this.peopleRead = (manifest.permissions ?? []).some((p) => p.id === "people.read");

    // The host's two folders of sockets: one of its own in TMPDIR (the
    // app's socket and the host's), and the short one under /tmp for the
    // app's own sockets (newSocketsRoot, ownSocketsDir).
    this.sockDir = mkdtempSync(path.join(os.tmpdir(), "nc-"));
    chmodSync(this.sockDir, 0o700);
    this.socketsRoot = mkdtempSync("/tmp/nc-");
    chmodSync(this.socketsRoot, 0o700);
    this.socketsDir = path.join(this.socketsRoot, sockName(this.appId));
    this.hostSocket = path.join(this.sockDir, `host-${sockName(this.appId)}.sock`);
    this.appSocket = null;
    this.outFile = path.join(this.state, "app-output.log");
  }

  // --- people and tickets ---

  /** The person for a label (made on first use, a stable id). */
  person(label, role) {
    const id = personIdFor(label);
    let p = this.people.get(id);
    if (!p) {
      p = { id, label, role: role ?? "member", email: `${label}@harness.local`, name: label[0].toUpperCase() + label.slice(1) };
      this.people.set(id, p);
    } else if (role) p.role = role;
    return p;
  }

  personById(id) {
    return this.people.get(id) ?? null;
  }

  /**
   * A ticket for a request, as the host's front signs one: `who` is a label,
   * a person, or null for nobody signed in. Its id is noted as passed to this
   * app now, for the line's checks.
   */
  mint(who = null, { host = false, iat = Date.now(), remote } = {}) {
    const p = who === null ? null : typeof who === "string" ? this.person(who) : who;
    const id = newRequestId();
    const t = { id, remote: remote ?? `127.0.0.1:${40000 + Math.floor(Math.random() * 20000)}`, tls: true, iat, host };
    if (p) {
      t.person = p.id;
      t.session = "s_" + createHash("sha256").update(p.id).digest("hex").slice(0, 24);
      t.label = "browser";
      if (this.peopleRead) {
        t.email = p.email;
        t.name = p.name;
      }
    }
    if (host) {
      t.id = "host-" + id.slice(0, 8);
      t.remote = "127.0.0.1:0";
    }
    if (!host) this.issued.set(id, { person: p?.id ?? "", at: Date.now() });
    return { header: signTicket(this.ticketKey, t), ticket: t, person: p };
  }

  // --- the line, held for tests ---

  holdLine() {
    if (this._openLine) return;
    this._lineOpen = new Promise((r) => (this._openLine = r));
  }

  openLine() {
    this._openLine?.();
    this._openLine = null;
    this._lineOpen = Promise.resolve();
  }

  lineGate() {
    return this._lineOpen;
  }

  // --- state kept across starts (as nc.db keeps it for the real host) ---

  loadState() {
    try {
      const s = JSON.parse(readFileSync(path.join(this.state, "host-state.json"), "utf8"));
      for (const [k, v] of Object.entries(s.secrets ?? {})) this.secrets.set(k, v);
      for (const p of s.people ?? []) this.people.set(p.id, p);
    } catch {}
  }

  saveState() {
    const file = path.join(this.state, "host-state.json");
    writeFileSync(file, JSON.stringify({ secrets: Object.fromEntries(this.secrets), people: [...this.people.values()] }), { mode: 0o600 });
  }

  // --- the app's process ---

  env() {
    const env = baseEnv();
    Object.assign(env, {
      LB_SECRETS_STDIN: "1",
      LB_EXIT_WITH_PARENT: "1",
      LB_APP_SOCKET: this.appSocket,
      LB_HOST_SOCKET: this.hostSocket,
      LB_WRAPPER_RESTART_EXIT: String(RESTART_CODE),
      NC_APP_DATA: this.data,
      NC_APP_BASE: "/",
      NC_APP_SOCKETS: this.socketsDir,
      PYTHONDONTWRITEBYTECODE: "1",
    });
    Object.assign(env, sandboxEnv(this.data));
    if (this.watchWrites) env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(this.data, ".harness", "fswatch.mjs")).href}`;
    return env;
  }

  async startHostSocket() {
    if (this.hostServer) return;
    try {
      rmSync(this.hostSocket, { force: true });
    } catch {}
    this.hostServer = createHostSocket(this);
    await new Promise((resolve, reject) => {
      this.hostServer.once("error", reject);
      this.hostServer.listen(this.hostSocket, resolve);
    });
    chmodSync(this.hostSocket, 0o600);
  }

  async start() {
    if (this.proc) throw new Error("the app is running");
    mkdirSync(this.data, { recursive: true, mode: 0o700 });
    await this.startHostSocket();
    this.starts++;
    this.credential = newSecret();
    this.ticketKey = newTicketKey();
    this.appSocket = path.join(this.sockDir, `app-${sockName(this.appId)}-${this.starts}.sock`);
    rmSync(this.appSocket, { force: true });
    rmSync(this.socketsDir, { recursive: true, force: true });
    mkdirSync(this.socketsDir, { mode: 0o700 });
    if (this.watchWrites) this.setUpWriteWatch();
    const program = path.join(this.pkg, this.manifest.program);
    let file = program;
    let argv = [];
    if (this.sandbox) {
      const opts = { pkg: this.pkg, data: this.data, hostSocket: this.hostSocket, appSocket: this.appSocket, sockets: this.socketsDir, net: true };
      [file, argv] = sandboxCommand(opts, program);
      writeFileSync(path.join(this.state, "sandbox.sb"), renderProfile(opts));
    }
    const out = openSync(this.outFile, "a");
    writeFileSync(out, `--- start ${this.starts} at ${new Date().toISOString()}${this.sandbox ? " (sandboxed)" : ""}\n`);
    const proc = spawn(file, argv, { cwd: "/", env: this.env(), stdio: ["pipe", out, out], detached: true });
    closeSync(out);
    this.proc = proc;
    this.exit = null;
    this.startedAt = new Date();
    proc.exited = new Promise((resolve) => {
      proc.on("exit", (code, signal) => {
        this.exit = { code, signal, at: new Date().toISOString() };
        resolve(this.exit);
      });
      proc.on("error", (e) => {
        this.exit = { code: null, signal: null, error: e.message };
        resolve(this.exit);
      });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(JSON.stringify({ app_credential: this.credential, ticket_key: this.ticketKey }) + "\n");
    this.ledger.note(`started ${this.manifest.program} (pid ${proc.pid}, start ${this.starts}${this.sandbox ? ", sandboxed" : ""})`);
    this._watch = setInterval(() => this.sample().catch(() => {}), 500);
    this._watch.unref();
    await this.waitHealthy();
    await this.sample();
    return this;
  }

  /** Notes every process of the app's tree and group, for the end. */
  async sample() {
    if (!this.proc?.pid) return [];
    const procs = await treeOf(this.proc.pid);
    for (const p of procs) {
      if (!this.seen.has(p.pid)) this.seen.set(p.pid, p);
      if (!this.allSeen.has(p.pid)) this.allSeen.set(p.pid, p);
    }
    return procs;
  }

  setUpWriteWatch() {
    const dir = path.join(this.data, ".harness");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(path.join(here, "fswatch.mjs"), path.join(dir, "fswatch.mjs"));
    const real = (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const allowed = [this.data, real(this.data), this.socketsDir, real(this.socketsDir), this.appSocket, path.join(real(path.dirname(this.appSocket)), path.basename(this.appSocket)), "/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];
    writeFileSync(path.join(dir, "fswatch.json"), JSON.stringify({ allowed: [...new Set(allowed)] }));
  }

  /** The writes outside its folders that a Node process of the app attempted. */
  writesOutside() {
    try {
      return readFileSync(path.join(this.data, ".harness", "fswatch.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async waitHealthy() {
    const deadline = Date.now() + this.healthTimeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      if (this.exit) throw new Error(`the app ended before it answered /healthz (${JSON.stringify(this.exit)}); its output: ${this.outFile}`);
      try {
        const r = await this.request("GET", "/healthz", { host: true, timeoutMs: 5000 });
        if (r.status === 200 || r.status === 503) {
          this.healthy = { status: r.status, ms: Date.now() - this.startedAt.getTime(), body: r.text };
          this.ledger.note(`the app answered /healthz ${r.status} after ${this.healthy.ms} ms`);
          return this.healthy;
        }
        last = `status ${r.status}`;
      } catch (e) {
        last = e.code ?? e.message;
      }
      await sleep(100);
    }
    throw new Error(`the app did not answer /healthz within ${this.healthTimeoutMs} ms (last: ${last}); its output: ${this.outFile}`);
  }

  /**
   * Stops the app as the host does. Returns {exit, ms, killed, leftAfterExit,
   * escaped}: `leftAfterExit` the app's processes still running LEFT_GRACE_MS
   * after it ended (which the host would then end, its group with it), and
   * `escaped` those still running after that too (outside its group).
   */
  async stop({ grace = STOP_GRACE_MS } = {}) {
    const proc = this.proc;
    if (!proc) return null;
    clearInterval(this._watch);
    await this.sample().catch(() => {});
    const pid = proc.pid;
    const t0 = Date.now();
    let killed = false;
    if (!this.exit) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      const timer = new Promise((r) => setTimeout(r, grace, "timeout"));
      if ((await Promise.race([proc.exited, timer])) === "timeout") {
        killed = true;
        this.log(`the app did not stop within ${grace} ms of SIGTERM; killing it`);
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        await proc.exited;
      }
    }
    const ms = Date.now() - t0;
    const known = [...this.seen.values()].filter((p) => p.pid !== pid);
    // Left to end by themselves: the time the host gives them.
    let left = await alive(known);
    for (const end = Date.now() + LEFT_GRACE_MS; left.length && Date.now() < end; ) {
      await sleep(100);
      left = await alive(known);
    }
    const leftAfterExit = left;
    // Then the host's endGroup: SIGTERM to the group, SIGKILL 3 s later.
    if (left.length) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      for (const end = Date.now() + LEFT_GRACE_MS; Date.now() < end; ) {
        await sleep(100);
        if (!(await alive(left)).length) break;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      await sleep(200);
    }
    const escaped = await alive(known);
    for (const p of escaped) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
    const result = { exit: this.exit, ms, killed, leftAfterExit, escaped };
    this.ledger.note(`stopped the app: ${JSON.stringify({ exit: this.exit, ms, killed, left: leftAfterExit.map((p) => p.comm), escaped: escaped.map((p) => p.comm) })}`);
    this.lastStop = result;
    this.proc = null;
    this.seen = new Map();
    this.ledger.flush();
    return result;
  }

  async restart(opts) {
    const stopped = await this.stop(opts);
    await this.start();
    return stopped;
  }

  /** Ends everything: the app, the host's socket, its folders of sockets. */
  async close() {
    if (this.proc) await this.stop({ grace: 30000 }).catch(() => {});
    await new Promise((r) => (this.hostServer ? this.hostServer.close(() => r()) : r()));
    this.hostServer = null;
    rmSync(this.sockDir, { recursive: true, force: true });
    rmSync(this.socketsRoot, { recursive: true, force: true });
    this.ledger.flush();
  }

  // --- talking to the app ---

  /**
   * A request on the app's socket. ticket: "valid" (default), "none", or a
   * header value of the caller's own; as: a person's label or null for
   * nobody; host: a ticket of the host's own. Answers {status, headers, text, json}.
   */
  request(method, p, { as = null, host = false, ticket = "valid", headers = {}, body, timeoutMs = 60000 } = {}) {
    const h = { ...headers };
    if (ticket === "valid") h[TICKET_HEADER] = this.mint(host ? null : as, { host }).header;
    else if (typeof ticket === "string" && ticket !== "none") h[TICKET_HEADER] = ticket;
    let data = null;
    if (body !== undefined) {
      data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      h["content-length"] = data.length;
      if (!h["content-type"] && typeof body === "object" && !Buffer.isBuffer(body)) h["content-type"] = "application/json";
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.appSocket, path: p, method, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const t = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(t);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: t, json });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no answer to ${method} ${p} in ${timeoutMs} ms`), { code: "ETIMEDOUT" })));
      if (data) req.write(data);
      req.end();
    });
  }

  /** An upgrade (WebSocket handshake) on the app's socket: the status line it answers. */
  upgrade(p, { ticket = "valid", as = null } = {}) {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.appSocket);
      let buf = "";
      const t = setTimeout(() => {
        s.destroy();
        resolve({ status: null, line: "(no answer in 10 s)" });
      }, 10000);
      s.on("data", (c) => {
        buf += c.toString("latin1");
        const i = buf.indexOf("\r\n");
        if (i >= 0) {
          clearTimeout(t);
          s.destroy();
          const line = buf.slice(0, i);
          resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1] ?? 0), line });
        }
      });
      s.on("end", () => {
        clearTimeout(t);
        resolve({ status: null, line: buf || "(closed with no answer)" });
      });
      s.on("error", reject);
      const lines = [`GET ${p} HTTP/1.1`, "Host: app", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`];
      if (ticket === "valid") lines.push(`X-NC-Ticket: ${this.mint(as).header}`);
      else if (typeof ticket === "string" && ticket !== "none") lines.push(`X-NC-Ticket: ${ticket}`);
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
  }

  /** The host's beat: POST /nc/v1/tick with a ticket of the host's own. */
  tick() {
    return this.request("POST", "/nc/v1/tick", { host: true, body: {} });
  }

  /**
   * `<program> manifest`'s output, as the host runs it at install: in the
   * manifest sandbox (no network, no socket, a data folder for that one
   * run) when `sandbox`, else as a plain process. {stdout (Buffer), code, stderr}.
   */
  manifestOutput({ sandbox = this.sandbox } = {}) {
    const program = path.join(this.pkg, this.manifest.program);
    const data = mkdtempSync(path.join(os.tmpdir(), "nc-manifest-"));
    let file = program;
    let argv = ["manifest"];
    const env = baseEnv();
    if (sandbox) {
      [file, argv] = sandboxCommand(manifestSandbox(this.pkg, data), program, ["manifest"]);
      Object.assign(env, sandboxEnv(data));
    }
    return new Promise((resolve) => {
      execFile(file, argv, { env, cwd: "/", encoding: "buffer", timeout: 30000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        rmSync(data, { recursive: true, force: true });
        resolve({ stdout, stderr: String(stderr), code: err ? (err.code ?? -1) : 0 });
      });
    });
  }
}

export const HARNESS_DIR = path.resolve(here, "..");
export { existsSync };
