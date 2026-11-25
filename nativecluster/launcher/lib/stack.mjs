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
// That step has a PGlite process of its own, which leaves once it is done
// (for its memory: start()); a second one serves Mike.
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
//
// No secret is in any child's environment or arguments, where another
// program of the same macOS user reads it (sysctl KERN_PROCARGS2, `ps -E`;
// the app sandbox allows sysctl-read; the 2026-11-24 security review, M3):
// the backend takes its keys on its stdin line (backendLaunchLine),
// PostgREST its JWT secret in a config file on a pipe it reads once
// (postgrestConfig, `postgrest /dev/fd/3`), and `gotrue migrate`, which
// signs nothing, a throwaway secret of its own.

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

// PGlite's child, on the package's Node: its flags and its environment, for
// its memory (measured on Node 24, 2026-11-24; pglite-server.mjs has
// Postgres's own settings):
// - MallocLargeCache=0 (libmalloc's, read as the process starts; not in
//   malloc(3)). V8's optimizing compiler takes about 600 MB at once for one
//   of Postgres's largest functions (one of 107 KB, compiled in 80 ms), and
//   frees it. macOS's allocator kept the freed blocks resident in its large
//   cache: 547 MB of a restarted PGlite's 906 MB footprint, there until
//   later allocations evicted them (seconds to minutes, or never while
//   idle). Off, they go back at once; the compile still peaks, for those
//   80 ms. (Compiling with Liftoff alone avoids the peak, but Mike's reads
//   then took 21-24 ms in place of 14-15.)
// - --max-semi-space-size=2 (MB). Under a burst of Mike's work (200 writes,
//   uploads) V8's young generation grew this process's JS heap from 57 MB
//   to 157 MB and kept it; at 2 MB it stays near 34 MB, at the same speed.
export const PGLITE_NODE_FLAGS = ["--max-semi-space-size=2"];

export function pgliteEnv() {
  return { ...baseEnv(), MallocLargeCache: "0" };
}

/**
 * The net planes' off switches (nc-app.json), which the host sets to "0" in
 * the app's environment when a plane is off for everyone: passed on to the
 * backend as they came.
 */
export const OFF_SWITCHES = ["LB_MIKE_COURTLISTENER", "LB_MIKE_WEBSEARCH", "LB_MIKE_MCP"];

/** The backend's environment (STAGE2-BRIEF.md, "What the finished branches require from the launcher"). */
export function backendEnv({ paths, dataDir, socketsDir, hostSocket, logDir, version }) {
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
    // The anon and service-role keys, DOWNLOAD_SIGNING_SECRET and
    // USER_API_KEYS_ENCRYPTION_SECRET come on stdin (backendLaunchLine).
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
    // The backend's allocator, as PGlite's (pgliteEnv): freed large blocks
    // go back to macOS at once instead of staying resident in libmalloc's
    // large cache (a document read or a long answer frees hundreds of MB).
    MallocLargeCache: "0",
    ...APP_RATE_LIMITS,
    // MIKE_CONTEXT_WINDOW_TOKENS is not passed on, even when set: the
    // window is the host's, from the catalog for this Mac's hardware
    // (/host/v1/models windows), never one the app is told otherwise.
  };
}

/**
 * The backend's request limits in the app. One person on their own
 * computer, every request from its window: the server's per-IP and
 * per-person defaults are sized for a shared server (an office behind one
 * address), and ordinary work meets them (desktop/src/local/supervisor.js):
 * the 51st upload session in an hour, or a bulk import's 295th file in 15
 * minutes, each file's complete being a mutation (the robustness campaign's
 * R2). Each stays a guard against a runaway loop, well past what a person
 * does: 10,000 upload sessions of up to 50 files an hour, 100,000 requests
 * a lane in 15 minutes. Every limit the backend reads is here or in
 * KEPT_RATE_LIMITS (test/stack.test.mjs reads the backend's own).
 */
export const APP_RATE_LIMITS = {
  RATE_LIMIT_GENERAL_MAX: "100000",
  RATE_LIMIT_BLOB_UPLOAD_MAX: "100000",
  RATE_LIMIT_TOOL_RESULT_MAX: "100000",
  RATE_LIMIT_CHAT_MAX: "600",
  RATE_LIMIT_CHAT_CREATE_MAX: "600",
  RATE_LIMIT_EXPORT_MAX: "100",
  RATE_LIMIT_UPLOAD_MAX: "500",
  RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR: "10000",
  RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX: "100000",
  RATE_LIMIT_UPLOAD_SESSION_POLL_MAX: "100000",
};

/**
 * The limits the app leaves at the backend's default, and why: none fits
 * a shared server better than one person's computer.
 */
export const KEPT_RATE_LIMITS = {
  RATE_LIMIT_DATA_DELETE_MAX: "deleting all of one's chats, projects, reviews or the account: 20 an hour is a guard, not a limit on work",
  RATE_LIMIT_AUTH_LOGIN_MAX: "Mike's own sign-in, which the app does not have (NativeCluster is its only login)",
  RATE_LIMIT_AUTH_ACCOUNT_MAX: "Mike's own sign-in, which the app does not have",
  RATE_LIMIT_AUTH_EMAIL_MAX: "Mike's own sign-up and password emails, which the app does not have",
  RATE_LIMIT_AUTH_FLOW_MAX: "Mike's own sign-in flows, which the app does not have",
  RATE_LIMIT_AUTH_MFA_MAX: "Mike's own MFA, which the app does not have",
};

/**
 * The backend's one stdin line: the host's credential and the launcher's
 * internal secret, and the stack's keys, which the backend reads into its
 * own memory before its configuration loads
 * (backend/src/lib/nc/launchSecrets.ts). Never in its environment or argv.
 */
export function backendLaunchLine({ credential, internalSecret, secrets }) {
  return {
    app_credential: credential,
    internal_secret: internalSecret,
    supabase_publishable_key: secrets.anonKey,
    supabase_secret_key: secrets.serviceRoleKey,
    download_signing_secret: secrets.downloadSigningSecret,
    user_api_keys_encryption_secret: secrets.userApiKeysEncryptionSecret,
  };
}

/**
 * PostgREST's configuration file, written to a pipe it opens as
 * /dev/fd/3 (measured on PostgREST 14.12 and PGlite, 2026-11-24, plain and
 * under the app sandbox): its JWT secret alone; every other setting stays
 * in its environment. The pipe is read once, at start, and nothing is on
 * disk. In-database configuration is off (PGRST_DB_CONFIG=false; Mike sets
 * none): with it on PostgREST reads the file again after the database
 * answers, and a pipe read twice is empty. With it off a `reload config`
 * notification reads nothing, and the secret stays the one it started with.
 */
export function postgrestConfig(jwtSecret) {
  if (!/^[0-9a-f]{64,}$/.test(jwtSecret)) throw new Error("the stack's JWT secret is not one the launcher made");
  return `jwt-secret = "${jwtSecret}"\n`;
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

  // `fd3`: what a child reads once on its fd 3, a pipe (PostgREST's
  // configuration), written and closed as it starts.
  function startChild(name, file, args, { env, cwd, stdin = "ignore", fd3 = null, onExit, oneShot = false } = {}) {
    const fd = openLogFd(logDir, name);
    let proc;
    try {
      proc = spawn(file, args, { env, cwd, stdio: [stdin, fd, fd, ...(fd3 === null ? [] : ["pipe"])] });
    } finally {
      closeSync(fd);
    }
    if (fd3 !== null) {
      proc.stdio[3].on("error", () => {}); // a child gone before it read
      proc.stdio[3].end(fd3);
    }
    const c = { name, proc, exit: null };
    children.set(name, c);
    proc.on("error", (e) => {
      c.exit = { error: e.message };
      log.error(`${name} could not start: ${e.message}`);
    });
    proc.on("exit", (code, signal) => {
      c.exit = { code, signal };
      if (!stopping && !((oneShot || c.retired) && code === 0)) log.warn(`${name} exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
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
            // It signs nothing either, so its JWT secret is a throwaway, never
            // the stack's (review M3).
            API_EXTERNAL_URL: "https://mike.invalid",
            GOTRUE_SITE_URL: "https://mike.invalid",
            GOTRUE_JWT_SECRET: randomBytes(32).toString("hex"),
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
    return startChild("postgrest", paths.postgrest, ["/dev/fd/3"], {
      cwd: dataDir,
      fd3: postgrestConfig(secrets.jwtSecret),
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
        // The JWT secret is in the configuration on fd 3 (postgrestConfig).
        PGRST_DB_CONFIG: "false",
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
    const env = backendEnv({ paths, dataDir, socketsDir, hostSocket, logDir, version });
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
    c.proc.stdin.write(`${JSON.stringify(backendLaunchLine({ credential, internalSecret, secrets }))}\n`);
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

  async function openPglite() {
    const c = startChild("pglite", paths.node, [...PGLITE_NODE_FLAGS, paths.pgliteServer, paths.pgliteDir, paths.pgSocket], {
      cwd: paths.launcherDir,
      env: pgliteEnv(),
      stdin: "pipe",
      onExit: () => {
        if (!stopping && !c.retired) fail(new Error("Mike's database stopped (logs/pglite.log)"));
      },
    });
    await waitFor("Mike's database", c, async () => existsSync(paths.pgSocket) && (await withPg((pc) => pc.query("select 1"))), 180000);
    return c;
  }

  // A PGlite process ends as stopAll ends it: its stdin closed, it closes the
  // database and leaves. Another may open the folder only once it has left.
  async function retirePglite(c, timeoutMs = 60000) {
    c.retired = true;
    try {
      c.proc.stdin?.end();
    } catch {}
    const deadline = Date.now() + timeoutMs;
    while (!c.exit && Date.now() < deadline) await sleep(50);
    if (!c.exit) throw new Error(`Mike's database did not close in ${timeoutMs / 1000} s (logs/pglite.log)`);
    if (c.exit.code !== 0) log.warn(`stack: the database closed with code ${c.exit.code} after the schema step (logs/pglite.log)`);
  }

  async function start() {
    const t0 = performance.now();
    try {
      mkdirSync(paths.storage, { recursive: true, mode: 0o700 });
      step("Opening Mike's database");
      const fresh = !existsSync(path.join(paths.pgliteDir, "PG_VERSION"));
      const db = await timed("pglite_open", () => openPglite());
      // Creating the database and loading the schema grow PGlite's process
      // once and for good (its WebAssembly memory never shrinks, and the
      // code compiled for the schema's statements stays). Measured: a
      // 158 MB footprint for the rest of its life, where a restarted one
      // holds 138 MB, and a 1.0 GB peak against 0.67 GB. So that process
      // leaves once the step is done and a fresh one serves Mike, as after
      // any restart (about 0.2 s more, on a first start or a new schema).
      if (await schemaStep(fresh)) {
        step("Opening Mike's database");
        await timed("pglite_reopen", async () => {
          await retirePglite(db);
          await openPglite();
        });
      }

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
