// A worker_threads Worker held to a memory budget, for parsing untrusted
// files where a child process could not be stopped: in NativeCluster's app
// sandbox a process may signal only itself, so an app's kill of its own child
// is refused (EPERM), while worker.terminate() needs no signal at all.
//
// V8's heap limit (resourceLimits) cannot be the budget by itself. Measured
// on Node 24.22, the app's runtime: a worker that reaches
// maxOldGenerationSizeMb sometimes aborts the whole process ("FATAL ERROR:
// Reached heap limit") instead of ending only the worker with
// ERR_WORKER_OUT_OF_MEMORY, and buffers and array buffers (external memory)
// are not counted at all. So the budget is kept here: while the worker
// works, its heap and external memory are read every WORKER_MEMORY_POLL_MS
// (worker.getHeapStatistics() is answered between two JavaScript steps, so a
// busy loop answers too) and the worker is terminated once they pass the
// budget. V8's limit stays, well above the budget, as the backstop.
import type { ResourceLimits, Worker } from "node:worker_threads";

export const WORKER_MEMORY_POLL_MS = 50;

/** V8's limits for a worker whose memory budget is `memoryMb`. */
export function boundedWorkerLimits(memoryMb: number): ResourceLimits {
  return {
    // The backstop, reached only by a burst the watch misses.
    maxOldGenerationSizeMb: memoryMb * 2 + 256,
    // Uncollected young garbage counts against the budget too: keep it small.
    maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.floor(memoryMb / 16))),
    // Node's default stack. codeRangeSizeMb stays V8's own: running out of
    // code space is a fatal error for the whole process, never the worker's.
    stackSizeMb: 4,
  };
}

/**
 * Terminate-worthy memory: calls `onExceeded` once the worker's heap and
 * external memory together pass `memoryMb`. Returns the function that stops
 * the watch; it also stops itself when it fires.
 */
export function watchWorkerMemory(
  worker: Worker,
  memoryMb: number,
  onExceeded: () => void,
): () => void {
  const budget = memoryMb * 1024 * 1024;
  let stopped = false;
  let reading = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || reading) return;
    reading = true;
    worker.getHeapStatistics().then(
      (stats) => {
        reading = false;
        if (stopped || stats.used_heap_size + stats.external_memory <= budget) return;
        stop();
        onExceeded();
      },
      // A worker that has already ended has nothing left to measure.
      () => { reading = false; },
    );
  }, WORKER_MEMORY_POLL_MS);
  timer.unref();
  return stop;
}
