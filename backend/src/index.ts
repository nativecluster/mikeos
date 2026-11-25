// Sentry must hook http/express before anything else loads (see file).
import "./instrument";
import type { Server } from "node:http";
import { Worker as ThreadWorker } from "node:worker_threads";
import path from "node:path";
import { app } from "./app";
import { enforceDocumentLifecycleMigration } from "./lib/dbq/lifecycleGuard";
import { manifestPublicKey } from "./lib/manifestSigning";
import {
  extractionLauncherWarnings,
  storagePublicEndpointWarnings,
  validateRuntimeConfiguration,
} from "./lib/runtimeConfig";
import {
  runNativeClusterTick,
  startAllWorkers,
  stopAllWorkers,
  WORKER_ROLES,
  type WorkerRole,
} from "./workerRuntime";
import { ncAppMode, setNcTickHandler } from "./lib/nc/tick";
import { reportError } from "./lib/observability/sentry";
import { drainStdout } from "./lib/log";
import { flushToolActivity } from "./lib/toolActivity";
import {
  closeHttpServer,
  createShutdown,
  failBoot,
  listenOrFail,
  removeStaleSocket,
  unixSocketPath,
} from "./lib/processLifecycle";
import { log, tpl } from "./lib/log";
import { listNativeClusterModels } from "./lib/llm/nativecluster";
import {
  internalSecretFromStdinEnabled,
  ncAppCredential,
  readLaunchSecrets,
} from "./lib/nc/launchSecrets";
import { currentNcPerson } from "./lib/nc/context";
import { startNcAppConnectors } from "./lib/mcp/ncAppStartup";
import { sweepOrphanHostSecrets } from "./lib/mcp/hostSecretSweep";
import { createServerSupabase } from "./lib/supabase";

const PORT = process.env.PORT ?? 3001;
const HOST = process.env.HOST?.trim() || undefined;

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
//
// Runs inside main() and is awaited: the fatal report has to be flushed to
// Sentry before exit, and while that flush is in flight nothing below may
// bind the port or start a worker — a process that has already decided to
// exit must not serve a request or claim a job in its last two seconds.
async function validateBootConfiguration(): Promise<void> {
  let stage = "runtime-config";
  try {
    validateRuntimeConfiguration();
    for (const warning of storagePublicEndpointWarnings()) {
      log.warn(tpl`[storage] ${warning}`);
    }
    for (const warning of extractionLauncherWarnings()) {
      log.warn(tpl`[extraction] ${warning}`);
    }
    stage = "manifest-key";
    const signingKey = manifestPublicKey();
    if (signingKey) {
      console.log(`Export manifests signed with key ${signingKey.key_id}`);
    }
  } catch (err) {
    await failBoot(err, stage);
  }
}

/**
 * Where background work runs, relative to this API process:
 *   "thread" (default) — worker_threads in this process, one per worker role:
 *            queue workers and maintenance run off the main event loop, so a
 *            CPU-heavy job can never starve HTTP requests, and upload
 *            processing has a thread of its own, so a stuck job can never
 *            stop uploads. Zero deployment changes.
 *   "inline" — on the main thread (the historical behavior; escape hatch,
 *            e.g. if a platform disallows worker_threads).
 *   "none"  — not here at all: a standalone worker process (src/worker.ts)
 *            runs them — a separate container or machine on the same
 *            Postgres/Redis.
 */
const WORKERS_MODE = (() => {
  const raw = process.env.WORKERS_MODE;
  return raw === "inline" || raw === "none" ? raw : "thread";
})();

const workerThreads = new Map<WorkerRole, ThreadWorker>();
let shuttingDown = false;

function spawnWorkerThread(role: WorkerRole): void {
  // In dev (tsx) this file is .ts and the thread entry must be too, loaded
  // through tsx's CJS require hook; in prod both are compiled .js in dist.
  const isTs = __filename.endsWith(".ts");
  const entry = path.join(
    __dirname,
    isTs ? "workerThread.ts" : "workerThread.js",
  );
  // Compiled mode inherits the parent's flags, including --enable-source-maps.
  // Explicit process.execArgv would reject V8 flags such as --max-old-space-size.
  // A NativeCluster app's credential for the host's socket reaches the
  // thread in memory (workerData), never through its environment.
  const credential = ncAppCredential();
  const workerThread = new ThreadWorker(entry, {
    ...(isTs ? { execArgv: ["--require", "tsx/cjs"] } : {}),
    workerData: { role, ...(credential ? { ncAppCredential: credential } : {}) },
  });
  workerThreads.set(role, workerThread);
  workerThread.on("error", (err) => {
    // An uncaught throw inside the thread. The thread's own Sentry client
    // reports it with the real stack and job context; what arrives here is
    // a structured clone. Sentry groups, it does not deduplicate, so this
    // supervisor view is fingerprinted as its own issue ("a worker thread
    // crashed", with a count) rather than doubling every thread issue.
    reportError(err, {
      tags: { component: "worker-thread-supervisor", worker_role: role },
      fingerprint: ["worker-thread-supervisor-error"],
    });
    console.error(`[worker-thread:${role}] error`, err);
  });
  workerThread.on("exit", (code) => {
    if (workerThreads.get(role) === workerThread) workerThreads.delete(role);
    if (shuttingDown || code === 0) return;
    // A crashed worker thread must not silently kill all background
    // processing — respawn after a short pause. Durable state (db_jobs,
    // Redis) means nothing is lost across the gap.
    reportError(
      new Error(`Background worker thread exited with code ${code}`),
      {
        tags: { component: "worker-thread-supervisor", worker_role: role },
        extra: { exit_code: code },
        fingerprint: ["worker-thread-exit"],
      },
    );
    console.error(
      `[worker-thread:${role}] exited with code ${code}; respawning in 5s`,
    );
    setTimeout(() => spawnWorkerThread(role), 5_000).unref();
  });
}

let server: Server | null = null;

/**
 * A NativeCluster app (MIKE_NC_APP=1): its sweeps run now, once, and then on
 * the host's beat, which the launcher forwards to POST /nc/v1/tick. Each beat
 * also reaches the worker threads, whose job runner reports its units.
 */
function startNativeClusterBeat(): void {
  setNcTickHandler(async () => {
    const ran = await runNativeClusterTick();
    for (const thread of workerThreads.values()) thread.postMessage("nc-tick");
    return ran;
  });
  void runNativeClusterTick();
}

/**
 * A NativeCluster app (MIKE_NC_APP=1): connect the connectors to the host's
 * secrets store, which keeps their tokens and the two keys Mike encrypts its
 * connector columns and pasted API keys with. The API keys' key is the one
 * lib/providerCredentials reads from USER_API_KEYS_ENCRYPTION_SECRET: the
 * host's copy is the one source (the launcher passes the same value), set
 * here before the configuration check and before any worker thread starts,
 * so every thread reads it from its environment.
 */
async function startNativeClusterConnectors(): Promise<void> {
  const socketPath = process.env.LB_HOST_SOCKET?.trim();
  const credential = ncAppCredential();
  if (!socketPath || !credential) {
    throw new Error("a NativeCluster app needs LB_HOST_SOCKET and the launcher's app credential");
  }
  const { apiKeysEncryptionSecret } = await startNcAppConnectors({
    socketPath,
    credential,
    currentPerson: currentNcPerson,
  });
  const configured = process.env.USER_API_KEYS_ENCRYPTION_SECRET?.trim();
  if (configured && configured !== apiKeysEncryptionSecret) {
    log.warn("startup", "USER_API_KEYS_ENCRYPTION_SECRET differs from the host's key; the host's is used");
  }
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = apiKeysEncryptionSecret;
}

/**
 * A NativeCluster app: before Mike serves anything, delete what the host's
 * secrets store keeps for it that no row points to (lib/mcp/hostSecretSweep.ts).
 * A failure is logged and the start goes on: the values stay until the next.
 */
async function sweepNativeClusterSecrets(): Promise<void> {
  try {
    await sweepOrphanHostSecrets(createServerSupabase());
  } catch (err) {
    log.warn("startup", "the sweep of unused connector secrets did not finish", { error: err });
  }
}

async function main(): Promise<void> {
  // A NativeCluster app's launcher hands its secrets over on stdin before
  // anything else, and keeps stdin open: its end means the launcher is gone.
  if (internalSecretFromStdinEnabled()) {
    try {
      await readLaunchSecrets(process.stdin, () => void shutdown("stdin closed"));
    } catch (err) {
      await failBoot(err, "launch-secrets");
      return;
    }
  }
  if (ncAppMode()) {
    try {
      await startNativeClusterConnectors();
    } catch (err) {
      await failBoot(err, "nc-connectors");
      return;
    }
  }
  await validateBootConfiguration();
  // Deploying this code against a database that has not run the
  // document-lifecycle migrations leaks storage silently and fails every
  // upload — see lifecycleGuard. The probe is AWAITED before the port is
  // bound and before any worker starts: a destructive request that arrives
  // while the check is still in flight would otherwise be served by code the
  // database cannot back. The guard exits the process when the migration is
  // provably absent and only warns when the answer is unavailable, so the
  // cost of gating is one round trip of boot latency, never a crash loop.
  await enforceDocumentLifecycleMigration();
  if (ncAppMode()) await sweepNativeClusterSecrets();
  // Read NativeCluster's model list before the first request, so a chat
  // turn knows its model's window (contextWindowFor). A no-op unless
  // NativeCluster is configured; it never delays or fails the boot.
  void listNativeClusterModels();

  // PORT=<path>: a unix socket (NativeCluster's sandbox allows no TCP port).
  // A socket a killed backend left behind is cleared first.
  const socketPath = unixSocketPath(PORT);
  if (socketPath && (await removeStaleSocket(socketPath)) === "removed") {
    log.info("startup", "removed a stale socket before listening");
  }

  server = listenOrFail(
    app,
    PORT,
    () => {
      console.log(
        `Mike backend running on port ${PORT} (workers: ${WORKERS_MODE})`,
      );
      if (WORKERS_MODE === "thread") {
        for (const role of WORKER_ROLES) spawnWorkerThread(role);
      } else if (WORKERS_MODE === "inline") {
        startAllWorkers();
      }
      // WORKERS_MODE === "none": a standalone worker process owns background
      // work (node dist/worker.js).
      if (ncAppMode()) startNativeClusterBeat();
    },
    undefined,
    HOST,
  );
}

void main();

// Graceful shutdown: on SIGTERM/SIGINT (orchestrator rollout, Ctrl-C), stop
// accepting new connections, let in-flight requests/streams drain, stop the
// background workers wherever they run, then exit 0. A hard timeout guards
// against a connection or job that never drains.
async function stopBackgroundWork(): Promise<void> {
  // In-flight turns have drained by now: log what they counted.
  flushToolActivity();
  if (WORKERS_MODE === "inline") {
    await stopAllWorkers();
    // Inline jobs make tool calls too; log what they counted while stopping.
    flushToolActivity();
    await drainStdout();
    return;
  }
  await drainStdout();
  await Promise.all(
    [...workerThreads.values()].map(
      (thread) =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => resolve(), 10_000);
          timeout.unref();
          thread.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
          thread.postMessage("shutdown");
        }),
    ),
  );
}

const shutdown = createShutdown({
  // Set before anything stops so the worker threads' exits are not respawned.
  onStart: () => {
    shuttingDown = true;
  },
  closeServer: () => closeHttpServer(server),
  stopBackgroundWork,
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
