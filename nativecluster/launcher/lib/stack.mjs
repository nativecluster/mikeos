// Mike's stack inside NativeCluster's sandbox, started and watched by the
// launcher, every part on a unix socket in NC_APP_SOCKETS:
//
//   .s.PGSQL.5432  PGlite (pglite-server.mjs, a child Node process)
//   rest.sock      PostgREST, one connection, no prepared statements
//   api.sock       the backend (backend/dist/index.js on the package's Node)
//
// On the first start, and whenever the package's schema version changes,
// the schema step runs first: the roles, `gotrue migrate` (GoTrue never runs
// as a service: NativeCluster is Mike's only sign-in), Mike's schema.sql or
// its new migrations with their ledger, and the bundled workflows
// (desktop/src/local's schema.js and workflows.js, staged in launcher/local).
//
// Every child leaves by itself when the launcher goes, since the sandbox
// lets an app signal no process but itself: the backend and PGlite when
// their stdin pipe from the launcher ends (the launcher closing it, or the
// launcher dying), and PostgREST when PGlite goes. PostgREST holds its
// listener connection on the notification channel, and with automatic
// recovery off it exits as soon as that connection is lost, instead of
// retrying for ever (measured on PGlite: 31 ms after PGlite closed; with the
// channel off it never left, a request after included). The host's ending
// of the app's process group is then only the last resort.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { openLogFd } from "./logs.mjs";
import { socketCall } from "./proxy.mjs";
import { API_PREFIX } from "./front.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stackPaths(pkgDir, dataDir, socketsDir) {
  return {
    node: path.join(pkgDir, "runtime", "bin", "node"),
    pgliteServer: path.join(pkgDir, "launcher", "pglite-server.mjs"),
    local: path.join(pkgDir, "launcher", "local"),
    launcherDir: path.join(pkgDir, "launcher"),
    backendDir: path.join(pkgDir, "backend"),
    stackDir: path.join(pkgDir, "stack"),
    postgrest: path.join(pkgDir, "stack", "postgrest"),
    gotrue: path.join(pkgDir, "stack", "gotrue"),
    gotrueMigrations: path.join(pkgDir, "stack", "gotrue-migrations"),
    schemaVersionFile: path.join(pkgDir, "launcher", "schema-version"),
    pgliteDir: path.join(dataDir, "pglite"),
    storage: path.join(dataDir, "storage"),
    stateDir: path.join(dataDir, "state"),
    schemaMarker: path.join(dataDir, "state", "schema-version"),
    pgSocket: path.join(socketsDir, ".s.PGSQL.5432"),
    restSocket: path.join(socketsDir, "rest.sock"),
    apiSocket: path.join(socketsDir, "api.sock"),
  };
}

// What a child starts from: the sandbox's own HOME and TMPDIR (both the
// data folder), Apple's tools on the PATH, nothing of the launcher's.
function baseEnv() {
  return {
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG || "en_US.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  };
}

/**
 * The net planes' off switches (nc-app.json), which the host sets to "0" in
 * the app's environment when a plane is off for everyone: passed on to the
 * backend as they came.
 */
export const OFF_SWITCHES = ["LB_MIKE_COURTLISTENER", "LB_MIKE_WEBSEARCH", "LB_MIKE_MCP"];

/** The backend's environment (STAGE2-BRIEF.md, "What the finished branches require from the launcher"). */
export function backendEnv({ paths, dataDir, socketsDir, hostSocket, secrets, logDir, version }) {
  const switches = Object.fromEntries(OFF_SWITCHES.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
  return {
    ...baseEnv(),
    ...switches,
    NODE_ENV: "production",
    PORT: paths.apiSocket,
    MIKE_INTERNAL_SECRET_STDIN: "1",
    MIKE_NC_APP: "1",
    NC_APP_DATA: dataDir,
    NC_APP_SOCKETS: socketsDir,
    LB_HOST_SOCKET: hostSocket,
    MIKE_REST_SOCKET: paths.restSocket,
    SUPABASE_URL: "http://mike.internal",
    SUPABASE_PUBLISHABLE_KEY: secrets.anonKey,
    SUPABASE_SECRET_KEY: secrets.serviceRoleKey,
    DOWNLOAD_SIGNING_SECRET: secrets.downloadSigningSecret,
    USER_API_KEYS_ENCRYPTION_SECRET: secrets.userApiKeysEncryptionSecret,
    STORAGE_DRIVER: "fs",
    STORAGE_FS_ROOT: paths.storage,
    // The filesystem driver's upload and download links (/download/signed/
    // <token>) start with this, and only a browser follows them: the API's
    // own path on the app's origin, whatever its port on this computer.
    // Unset, they would name a loopback address and the socket's path.
    BACKEND_PUBLIC_URL: API_PREFIX,
    MIKE_INFERENCE_PROVIDER: "nativecluster",
    NATIVECLUSTER_TRANSPORT: "host",
    SENTRY_DISABLED: "true",
    NEXT_PUBLIC_SENTRY_DISABLED: "true",
    MIKE_LOG_DIR: logDir,
    QUEUE_DRIVER: "postgres",
    ...(version ? { MIKE_VERSION: version } : {}),
    // One person per computer, every request from this computer's window:
    // the server's per-IP defaults are sized for a shared server, and
    // ordinary browsing hits them (desktop/src/local/supervisor.js).
    RATE_LIMIT_GENERAL_MAX: "100000",
    RATE_LIMIT_BLOB_UPLOAD_MAX: "100000",
    RATE_LIMIT_TOOL_RESULT_MAX: "100000",
    RATE_LIMIT_CHAT_MAX: "600",
    RATE_LIMIT_CHAT_CREATE_MAX: "600",
    RATE_LIMIT_EXPORT_MAX: "100",
    RATE_LIMIT_UPLOAD_MAX: "500",
  };
}

export function createStack({ pkgDir, dataDir, socketsDir, hostSocket, credential, secrets, internalSecret, log, logDir, version, onFatal }) {
  const paths = stackPaths(pkgDir, dataDir, socketsDir);
  const children = new Map(); // name -> {proc, exit}
  const state = { phase: "starting", step: "Starting", error: null, timings: {}, ready: false };
  let wasReady = false;
  let stopping = false;
  let backendRestarts = [];

  const requireLocal = createRequire(path.join(paths.launcherDir, "package.json"));
  const pg = () => requireLocal("pg");

  function step(name) {
    state.step = name;
    log.info(`stack: ${name}`);
  }

  async function timed(name, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      state.timings[name] = Math.round(performance.now() - t0);
      log.info(`stack: ${name} took ${state.timings[name]} ms`);
    }
  }

  function startChild(name, file, args, { env, cwd, stdin = "ignore", onExit, oneShot = false } = {}) {
    const fd = openLogFd(logDir, name);
    let proc;
    try {
      proc = spawn(file, args, { env, cwd, stdio: [stdin, fd, fd] });
    } finally {
      closeSync(fd);
    }
    const c = { name, proc, exit: null };
    children.set(name, c);
    proc.on("error", (e) => {
      c.exit = { error: e.message };
      log.error(`${name} could not start: ${e.message}`);
    });
    proc.on("exit", (code, signal) => {
      c.exit = { code, signal };
      if (!stopping && !(oneShot && code === 0)) log.warn(`${name} exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
      onExit?.(code, signal);
    });
    if (proc.stdin) proc.stdin.on("error", () => {}); // a child gone mid-write
    return c;
  }

  function runToEnd(name, file, args, { env, cwd, timeoutMs = 300000 }) {
    return new Promise((resolve, reject) => {
      const c = startChild(name, file, args, {
        env,
        cwd,
        oneShot: true,
        onExit: (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${name} exited ${signal ? `on ${signal}` : `with code ${code}`} (its log: logs/${name}.log)`));
        },
      });
      const timer = setTimeout(() => reject(new Error(`${name} did not finish in ${timeoutMs / 1000} s`)), timeoutMs);
      c.proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async function waitFor(what, c, probe, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (c?.exit) throw new Error(`${what} exited while starting (its log: logs/${c.name}.log)`);
      try {
        if (await probe()) return;
      } catch (e) {
        last = e;
      }
      await sleep(150);
    }
    throw new Error(`${what} was not ready in ${timeoutMs / 1000} s${last ? `: ${last.message}` : ""}`);
  }

  // A pg client on PGlite's socket. PGlite takes any user and no password:
  // every connection is its one superuser session.
  async function withPg(fn) {
    const client = new (pg().Client)({ host: socketsDir, port: 5432, user: "postgres", database: "postgres" });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  function packageSchemaVersion() {
    try {
      return readFileSync(paths.schemaVersionFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  async function schemaStep(fresh) {
    const wanted = packageSchemaVersion();
    let have = "";
    try {
      have = readFileSync(paths.schemaMarker, "utf8").trim();
    } catch {}
    if (!fresh && wanted && have === wanted) {
      log.info(`stack: schema ${wanted.slice(0, 12)} already in place`);
      return false;
    }
    log.info(`stack: schema step (${fresh ? "a new database" : `version ${have.slice(0, 12) || "none"} -> ${wanted.slice(0, 12)}`})`);
    const requireFromLocal = createRequire(path.join(paths.local, "schema.js"));
    const schema = requireFromLocal("./schema.js");
    const { installBundledWorkflows } = requireFromLocal("./workflows.js");
    const say = (s) => step(s);

    // The roles PostgREST switches between; their passwords mean nothing to
    // PGlite, which asks for none.
    await timed("roles", () => schema.bootstrapRoles(withPg, randomBytes(24).toString("hex")));

    // GoTrue names its tables unqualified and finds auth through its role's
    // search_path, which PGlite's one session never reads: the session's own
    // search_path puts auth first for the migrate, then goes back. The
    // migrator's prepared statements outlive its connection in the one
    // session, so they are dropped after it.
    step("Preparing accounts");
    await withPg((c) => c.query("set search_path to auth, public"));
    try {
      await timed("gotrue_migrate", () =>
        runToEnd("gotrue-migrate", paths.gotrue, ["migrate"], {
          cwd: paths.stackDir,
          env: {
            ...baseEnv(),
            GOTRUE_DB_DRIVER: "postgres",
            GOTRUE_DB_NAMESPACE: "auth",
            GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin@/postgres?host=${encodeURIComponent(socketsDir)}&sslmode=disable`,
            GOTRUE_DB_MIGRATIONS_PATH: paths.gotrueMigrations,
            // Migrate serves nothing; its configuration still wants these.
            API_EXTERNAL_URL: "https://mike.invalid",
            GOTRUE_SITE_URL: "https://mike.invalid",
            GOTRUE_JWT_SECRET: secrets.jwtSecret,
            GOTRUE_JWT_EXP: "3600",
            GOTRUE_JWT_AUD: "authenticated",
            GOTRUE_JWT_ADMIN_ROLES: "service_role",
            GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
            GOTRUE_LOG_LEVEL: "info",
          },
        }),
      );
    } finally {
      await withPg(async (c) => {
        await c.query("deallocate all");
        await c.query("reset search_path");
      });
    }

    step("Setting up Mike's database");
    await timed("schema", () => schema.applySchema(withPg, paths.backendDir, say));
    step("Preparing workflows");
    mkdirSync(paths.storage, { recursive: true, mode: 0o700 });
    await timed("workflows", () => withPg((client) => installBundledWorkflows({ client, backendDir: paths.backendDir, storageRoot: paths.storage })));

    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.schemaMarker, `${wanted}\n`, { mode: 0o600 });
    return true;
  }

  let restRestarts = [];
  function startPostgrest() {
    rmSync(paths.restSocket, { force: true });
    return startChild("postgrest", paths.postgrest, [], {
      cwd: dataDir,
      onExit: () => {
        if (stopping || !state.ready) return;
        const now = Date.now();
        restRestarts = restRestarts.filter((t) => now - t < 300000);
        if (restRestarts.length >= 3) {
          fail(new Error("Mike's data service stopped three times in five minutes (logs/postgrest.log)"));
          return;
        }
        restRestarts.push(now);
        log.warn("starting Mike's data service again");
        void waitForPostgrest(startPostgrest()).catch(fail);
      },
      env: {
        ...baseEnv(),
        PGRST_DB_URI: `postgres://authenticator@/postgres?host=${encodeURIComponent(socketsDir)}&sslmode=disable`,
        PGRST_DB_SCHEMAS: "public",
        PGRST_DB_ANON_ROLE: "anon",
        PGRST_JWT_SECRET: secrets.jwtSecret,
        PGRST_SERVER_UNIX_SOCKET: paths.restSocket,
        PGRST_SERVER_UNIX_SOCKET_MODE: "600",
        // Every pooled connection would be PGlite's same session: one
        // connection, and no prepared statements (they collide by name).
        PGRST_DB_POOL: "1",
        PGRST_DB_PREPARED_STATEMENTS: "false",
        // The listener's connection is how PostgREST learns PGlite is gone:
        // it then exits (automatic recovery off) rather than outlive the
        // launcher. Mike sends NOTIFY only from migrations, which run before
        // PostgREST starts, so no notification reaches the shared session
        // while it runs. A PostgREST that exits while Mike runs is started
        // again (startPostgrest's onExit).
        PGRST_DB_CHANNEL_ENABLED: "true",
        PGRST_DB_POOL_AUTOMATIC_RECOVERY: "false",
        PGRST_LOG_LEVEL: "warn",
      },
    });
  }

  function startBackend() {
    const env = backendEnv({ paths, dataDir, socketsDir, hostSocket, secrets, logDir, version });
    const c = startChild("backend-stdio", paths.node, [path.join(paths.backendDir, "dist", "index.js")], {
      cwd: paths.backendDir,
      env,
      stdin: "pipe",
      onExit: () => {
        if (stopping || !state.ready) return;
        // A backend that dies while Mike runs is started again, at most
        // three times in five minutes; then Mike says it stopped.
        const now = Date.now();
        backendRestarts = backendRestarts.filter((t) => now - t < 300000);
        if (backendRestarts.length >= 3) {
          fail(new Error("Mike's service stopped three times in five minutes (logs/backend.log)"));
          return;
        }
        backendRestarts.push(now);
        state.ready = false;
        state.phase = "starting";
        step("Starting Mike's service again");
        void bootBackend().catch(fail);
      },
    });
    // The secrets line; stdin stays open for the backend's life (its end
    // shuts the backend down).
    c.proc.stdin.write(`${JSON.stringify({ app_credential: credential, internal_secret: internalSecret })}\n`);
    return c;
  }

  function waitForPostgrest(rest) {
    return waitFor("Mike's data service", rest, async () => {
      if (!existsSync(paths.restSocket)) return false;
      const r = await socketCall(paths.restSocket, "GET", "/", {}, 3000);
      return r.status === 200 || r.status === 401;
    }, 60000);
  }

  async function bootBackend() {
    rmSync(paths.apiSocket, { force: true });
    const c = startBackend();
    await waitFor("Mike's service", c, async () => {
      if (!existsSync(paths.apiSocket)) return false;
      const r = await socketCall(paths.apiSocket, "GET", "/health", { "x-nc-internal": internalSecret }, 3000);
      return r.status === 200;
    }, 120000);
    try {
      chmodSync(paths.apiSocket, 0o600);
    } catch {}
    state.ready = true;
    wasReady = true;
    state.phase = "ready";
    step("Ready");
  }

  function fail(e) {
    if (stopping) return;
    state.phase = "failed";
    state.ready = false;
    state.error = e?.message ?? String(e);
    log.error(`stack failed: ${e?.stack ?? e}`);
    // Failing while Mike ran (not while it started): the launcher leaves, so
    // the host starts Mike afresh on the next request. A start that fails
    // stays up to say why, instead of failing again on every request.
    if (wasReady) onFatal?.(state.error);
  }

  async function start() {
    const t0 = performance.now();
    try {
      mkdirSync(paths.storage, { recursive: true, mode: 0o700 });
      step("Opening Mike's database");
      const fresh = !existsSync(path.join(paths.pgliteDir, "PG_VERSION"));
      const db = startChild("pglite", paths.node, [paths.pgliteServer, paths.pgliteDir, paths.pgSocket], {
        cwd: paths.launcherDir,
        env: baseEnv(),
        stdin: "pipe",
        onExit: () => {
          if (!stopping) fail(new Error("Mike's database stopped (logs/pglite.log)"));
        },
      });
      await timed("pglite_open", () => waitFor("Mike's database", db, async () => existsSync(paths.pgSocket) && (await withPg((c) => c.query("select 1"))), 180000));
      await schemaStep(fresh);

      step("Starting Mike's data service");
      await timed("postgrest", () => waitForPostgrest(startPostgrest()));

      step("Starting Mike's service");
      await timed("backend", () => bootBackend());
      state.timings.total = Math.round(performance.now() - t0);
      log.info(`stack: ready in ${state.timings.total} ms`, state.timings);
    } catch (e) {
      fail(e);
    }
  }

  /** The host's beat, passed on to the backend: `{status, body}`. */
  async function tick() {
    if (!state.ready) return { status: 200, body: JSON.stringify({ ok: true, ran: [] }) };
    return socketCall(paths.apiSocket, "POST", "/nc/v1/tick", { "x-nc-internal": internalSecret, "content-length": "0" }, 50000);
  }

  // Stopping: the backend first (its stdin ends: it drains and leaves),
  // then PGlite (the same: it closes the database cleanly), then PostgREST
  // leaves by itself, having lost PGlite. Nothing is signalled.
  async function stopAll(graceMs = 20000) {
    stopping = true;
    const deadline = Date.now() + graceMs;
    for (const name of ["backend-stdio", "pglite", "postgrest"]) {
      const c = children.get(name);
      if (!c || c.exit) continue;
      try {
        c.proc.stdin?.end();
      } catch {}
      while (!c.exit && Date.now() < deadline) await sleep(50);
      log.info(`stop: ${name} ${c.exit ? "left" : "still running"}`);
    }
  }

  return { paths, state, start, tick, stopAll, withPg };
}
