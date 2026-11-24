// The backend as a NativeCluster app, booted for real: src/index.ts in a
// child process with the environment Mike's launcher gives it, against fake
// PostgREST, GoTrue and host sockets. It proves the pieces together: the
// secrets on stdin, the socket at 0600, the door, Supabase over sockets in
// the API thread and the worker threads, the credential reaching the jobs
// thread, the sweeps at startup and on the beat, the log file, Sentry off,
// and the exit when the launcher goes.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDENTIAL, startFakeHost, type FakeHost } from "../lib/nc/__tests__/fakeHost";
import { socketDir, startUnixServer, type UnixServer } from "../lib/nc/__tests__/unixServer";

const backendRoot = path.resolve(__dirname, "../..");
const SECRET = "f".repeat(64);

function overSocket(
  socketPath: string,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the backend booted as a NativeCluster app", () => {
  let dir: string;
  let rest: UnixServer;
  let auth: UnixServer;
  let host: FakeHost;
  let child: ChildProcess;
  let output = "";
  let exited: Promise<number | null>;
  let apiSocket: string;
  let logDir: string;

  beforeAll(async () => {
    dir = socketDir();
    rest = await startUnixServer(
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        // The document-lifecycle probe; every other read finds nothing.
        res.end(req.url?.startsWith("/rpc/document_lifecycle_version") ? "2" : "[]");
      },
      { dir, name: "rest.sock" },
    );
    auth = await startUnixServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      },
      { dir, name: "auth.sock" },
    );
    host = await startFakeHost();
    apiSocket = path.join(dir, "api.sock");
    logDir = path.join(dir, "logs");

    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith("VITEST") || name === "HOST" || name === "PORT" || name === "NODE_OPTIONS") continue;
      env[name] = value;
    }
    Object.assign(env, {
      NODE_ENV: "production",
      PORT: apiSocket,
      MIKE_INTERNAL_SECRET_STDIN: "1",
      MIKE_NC_APP: "1",
      MIKE_REST_SOCKET: rest.socketPath,
      MIKE_AUTH_SOCKET: auth.socketPath,
      SUPABASE_URL: "http://mike.internal",
      SUPABASE_PUBLISHABLE_KEY: "app-publishable-key-not-a-demo-key",
      SUPABASE_SECRET_KEY: "app-secret-key-not-a-demo-key",
      DOWNLOAD_SIGNING_SECRET: "d".repeat(64),
      USER_API_KEYS_ENCRYPTION_SECRET: "u".repeat(64),
      AUTH_HANDOFF_ENCRYPTION_SECRET: "a".repeat(64),
      MCP_CONNECTORS_ENCRYPTION_SECRET: "m".repeat(64),
      STORAGE_DRIVER: "fs",
      STORAGE_FS_ROOT: path.join(dir, "storage"),
      MIKE_INFERENCE_PROVIDER: "nativecluster",
      NATIVECLUSTER_TRANSPORT: "host",
      LB_HOST_SOCKET: host.socketPath,
      MIKE_LOG_DIR: logDir,
      SENTRY_DISABLED: "true",
      QUEUE_DRIVER: "postgres",
      DB_JOBS_POLL_MS: "60000",
      EXTRACTION_ISOLATION: "off",
    });
    child = spawn(
      process.execPath,
      ["--import", path.join(backendRoot, "node_modules/tsx/dist/loader.mjs"), path.join(backendRoot, "src/index.ts")],
      { cwd: backendRoot, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    child.stdin!.write(JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET }) + "\n");
    await until(() => existsSync(apiSocket) || child.exitCode !== null, 60_000, "the backend's socket");
    if (child.exitCode !== null) throw new Error(`the backend exited at boot:\n${output}`);
    await until(() => output.includes("Mike backend running"), 30_000, "the backend to say it runs");
  }, 90_000);

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rest?.close();
    await auth?.close();
    await host?.close();
  });

  it("listens on its unix socket, readable and writable by this user alone", () => {
    expect(statSync(apiSocket).isSocket()).toBe(true);
    expect(statSync(apiSocket).mode & 0o777).toBe(0o600);
  });

  it("answers nothing without the launcher's secret, /health included", async () => {
    expect((await overSocket(apiSocket, "GET", "/health")).status).toBe(403);
    expect((await overSocket(apiSocket, "GET", "/health", { "X-NC-Internal": "nope" })).status).toBe(403);
    const ok = await overSocket(apiSocket, "GET", "/health", { "X-NC-Internal": SECRET });
    expect(ok).toEqual({ status: 200, body: '{"ok":true}' });
    // A socket has no peer address: the rate limiters still find a key.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).not.toContain("ERR_ERL_UNDEFINED_IP_ADDRESS");
  });

  it("reached PostgREST over its socket, from the worker threads too", async () => {
    await until(() => rest.seen.some((r) => r.url.startsWith("/rpc/claim_db_jobs")), 20_000, "the job runner's claim");
    expect(rest.seen.some((r) => r.url.startsWith("/rpc/document_lifecycle_version"))).toBe(true);
    expect(rest.seen.every((r) => r.headers.apikey === "app-secret-key-not-a-demo-key")).toBe(true);
  });

  it("gave the jobs thread the app's credential: it told the host its units", async () => {
    await until(() => host.units.length > 0, 20_000, "a units report");
    expect(host.units[0]).toEqual({ waiting: false });
    expect(host.unauthorized).toBe(0);
    // The model menu was read from the host for the assistant task.
    expect(host.modelReads).toContain("assistant");
  });

  it("keeps the connectors' keys in the host's secrets store", () => {
    // Made on the first start; the API keys' key is the one the launcher
    // passes, so pasted CourtListener, Brave and Tavily keys stay readable.
    expect(host.secrets.get("mike:app:connectors-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(host.secrets.get("mike:app:api-keys-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(output).toContain("USER_API_KEYS_ENCRYPTION_SECRET differs from the host's key");
  });

  it("ran its sweeps at startup, so the host's next beat finds none due", async () => {
    const beat = await overSocket(apiSocket, "POST", "/nc/v1/tick", { "X-NC-Internal": SECRET });
    expect(beat.status).toBe(200);
    expect(JSON.parse(beat.body)).toEqual({ ok: true, ran: [] });
    // The stale-work sweep read the database at startup.
    expect(rest.seen.length).toBeGreaterThan(2);
  });

  it("keeps its output in the log file, worker threads included, with Sentry off", async () => {
    await until(
      () => existsSync(path.join(logDir, "backend.log")) &&
        readFileSync(path.join(logDir, "backend.log"), "utf8").includes("[worker-thread] background workers started"),
      20_000,
      "the worker threads' line in the log file",
    );
    const text = readFileSync(path.join(logDir, "backend.log"), "utf8");
    expect(text).toContain("Mike backend running on port");
    expect(text).toContain("[sentry] disabled for api (SENTRY_DISABLED=true)");
    expect(text).toContain("[sentry] disabled for worker-thread (SENTRY_DISABLED=true)");
    expect(statSync(path.join(logDir, "backend.log")).mode & 0o777).toBe(0o600);
    // Never the secrets.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(CREDENTIAL);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(CREDENTIAL);
  });

  it("shuts down by itself when the launcher's stdin ends", async () => {
    child.stdin!.end();
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 20_000))]);
    expect(code).toBe(0);
    expect(output).toContain("Shutting down gracefully (stdin closed)");
  }, 30_000);
});
