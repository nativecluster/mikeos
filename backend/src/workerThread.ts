// worker_threads bootstrap: the default home for background work in a
// single-process deployment. index.ts spawns one of these per worker role
// (uploads, jobs) so queue workers, upload processing, the DB-job runner, and
// maintenance sweeps run OFF the main event loop, and off each other's —
// an HTTP request can never be starved by a CPU-heavy job (zip building,
// export serialization, pdf parsing), and the seam to a fully separate
// worker process/machine (src/worker.ts) stays identical.

// Own Sentry client: worker_threads share no JS state with the parent, so
// the API process's init does not cover errors thrown in here.
import "./instrument";
import { parentPort, workerData } from "node:worker_threads";
import { startAllWorkers, stopAllWorkers, WORKER_ROLES, type WorkerRole } from "./workerRuntime";
import { flushSentry, reportError } from "./lib/observability/sentry";
import { log, tpl } from "./lib/log";
import { setNcAppCredential } from "./lib/nc/launchSecrets";
import { refreshNcUnits } from "./lib/nc/units";

// index.ts starts one thread per role; with no role, this thread runs them all.
const data = workerData as { role?: WorkerRole; ncAppCredential?: string } | null;
const role = data?.role;
// A NativeCluster app's credential for the host's socket, in memory only.
if (data?.ncAppCredential) setNcAppCredential(data.ncAppCredential);
startAllWorkers(role ? [role] : WORKER_ROLES);
log.info(tpl`[worker-thread] background workers started (${role ?? "all"})`);

parentPort?.on("message", (message: unknown) => {
    // The host's beat (a NativeCluster app): report this thread's units.
    if (message === "nc-tick") {
        void refreshNcUnits({ force: true });
        return;
    }
    if (message === "shutdown") {
        void stopAllWorkers()
            .catch((err) => {
                reportError(err, { tags: { component: "worker-thread" } });
                console.error("[worker-thread] shutdown error", err);
            })
            .then(() => flushSentry())
            .finally(() => process.exit(0));
    }
});
