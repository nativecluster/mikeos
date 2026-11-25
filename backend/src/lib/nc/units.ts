// The app's units of work, told to NativeCluster's host (POST /host/v1/units).
//
// While a unit waits or runs the host never stops the app as idle, and it
// starts the app again for work that waits, or whose pause (a retry's
// backoff) ends. The host keeps the last report, so the backend process
// has ONE reporter, on its main thread (index.ts), and every other thread
// relays to it (createNcUnitsRelay): two reporters would overwrite each
// other's last word, a thread with nothing to do saying "waiting: false"
// over another's work.
//
// What counts, in Mike (the robustness campaign's U1, 2026-11-24: the app
// said `{"waiting": false}` once, at start, and never again while uploads
// were read or a review ran):
// - what runs, counted exactly as it starts and ends (begin/asNcUnit): a
//   DB job of a person's work, in the jobs thread (lib/dbq/runner.ts); a
//   tabular review's server-owned run, on the main thread
//   (modules/tabular/tabular.syncRun.ts);
// - what waits, read from the database (lib/nc/unitsQueue.ts): DB jobs of
//   those kinds pending or running, uploads being sent or processed (the
//   uploads thread's own jobs), and a review run to resume after a stop.
// The report goes after every change of what runs, after each request that
// may have queued work, again every few seconds while it says waiting (the
// end of work another thread does is seen so), at the backend's start, on
// the host's beat and on the way out.

import { log } from "../log";
import { hostJson } from "./hostSocket";

export type NcQueued = {
  /** A job of these kinds is due now (pending, run_at passed). */
  due: boolean;
  /** The earliest pending one's run_at, when it lies ahead (a backoff). */
  pauseEnds?: string | null;
};

export type NcUnitsReport = { waiting: boolean; pause_ends?: string };

export type NcUnitsReporter = {
  /** A job started; the function it answers ends it, once. */
  begin(): () => void;
  /** What runs: this thread's units and every other thread's last count. */
  readonly running: number;
  /** Another thread of this process runs `running` units now (0 when it ends). */
  setThread(id: string, running: number): void;
  /** Report now: on the beat, at start and on the way out (`force` posts even an unchanged report). */
  refresh(options?: { force?: boolean }): Promise<void>;
  /** Stop retrying a failed post and looking again (shutdown). */
  stop(): void;
};

/** How often a report that says waiting is looked at again: work another thread does ends unseen otherwise. */
export const NC_UNITS_RECHECK_MS = 2_000;

export function createNcUnitsReporter(options: {
  post: (report: NcUnitsReport) => Promise<void>;
  queued: () => Promise<NcQueued>;
  retryMs?: number;
  recheckMs?: number;
}): NcUnitsReporter {
  let local = 0;
  const threads = new Map<string, number>();
  const running = () => {
    let total = local;
    for (const n of threads.values()) total += n;
    return total;
  };
  let last: string | null = null;
  let inFlight: Promise<void> | null = null;
  let again: { force: boolean } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const recheckMs = options.recheckMs ?? NC_UNITS_RECHECK_MS;

  const report = async (): Promise<NcUnitsReport> => {
    let queued: NcQueued = { due: false };
    try {
      queued = await options.queued();
    } catch {
      // Unknown: what runs still counts; a queued job is found next time.
    }
    const waiting = running() > 0 || queued.due;
    return {
      waiting,
      ...(!waiting && queued.pauseEnds ? { pause_ends: queued.pauseEnds } : {}),
    };
  };

  // While the report says waiting, look again shortly: the end of work
  // counted from the database (another thread's) has no event here.
  const scheduleRecheck = (waiting: boolean) => {
    if (recheck) clearTimeout(recheck);
    recheck = null;
    if (!waiting || stopped || recheckMs <= 0) return;
    recheck = setTimeout(() => {
      recheck = null;
      void refresh();
    }, recheckMs);
    recheck.unref?.();
  };

  const once = async (force: boolean): Promise<void> => {
    const next = await report();
    scheduleRecheck(next.waiting);
    const key = JSON.stringify(next);
    if (!force && key === last) return;
    try {
      await options.post(next);
      last = key;
    } catch {
      last = null;
      if (!stopped && !retry) {
        retry = setTimeout(() => {
          retry = null;
          void refresh({ force: true });
        }, options.retryMs ?? 30_000);
        retry.unref?.();
      }
    }
  };

  const refresh = (opts: { force?: boolean } = {}): Promise<void> => {
    const force = !!opts.force;
    if (inFlight) {
      // One post at a time; the change that arrived meanwhile goes next.
      again = { force: force || !!again?.force };
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await once(force);
        while (again) {
          const next = again;
          again = null;
          await once(next.force);
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    begin() {
      local += 1;
      if (running() === 1) void refresh();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        local -= 1;
        if (running() === 0) void refresh();
      };
    },
    get running() {
      return running();
    },
    setThread(id, count) {
      const before = running();
      if (count > 0) threads.set(id, count);
      else threads.delete(id);
      if ((before === 0) !== (running() === 0)) void refresh();
    },
    refresh,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (recheck) clearTimeout(recheck);
      retry = null;
      recheck = null;
    },
  };
}

/** What a thread tells the main thread's reporter (createNcUnitsRelay). */
export type NcUnitsMessage = { type: "nc-units"; running: number; refresh?: { force: boolean } };

export function isNcUnitsMessage(value: unknown): value is NcUnitsMessage {
  const m = value as Partial<NcUnitsMessage> | null;
  return !!m && m.type === "nc-units" && typeof m.running === "number" && Number.isFinite(m.running) && m.running >= 0;
}

/**
 * A worker thread's reporter: it counts its own units and tells the main
 * thread (`send`, its parentPort's postMessage), whose reporter is the one
 * that reports to the host.
 */
export function createNcUnitsRelay(send: (message: NcUnitsMessage) => void): NcUnitsReporter {
  let running = 0;
  const tell = (refresh?: { force: boolean }) => {
    try {
      send({ type: "nc-units", running, ...(refresh ? { refresh } : {}) });
    } catch {
      // The main thread is gone: nothing to tell.
    }
  };
  return {
    begin() {
      running += 1;
      tell();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        running -= 1;
        tell();
      };
    },
    get running() {
      return running;
    },
    setThread() {},
    async refresh(opts = {}) {
      tell({ force: !!opts.force });
    },
    stop() {},
  };
}

/** The main thread: a thread's message about its units, applied; false for any other message. */
export function applyNcUnitsMessage(threadId: string, message: unknown): boolean {
  if (!isNcUnitsMessage(message)) return false;
  reporter?.setThread(threadId, Math.floor(message.running));
  if (message.refresh) void refreshNcUnits({ force: message.refresh.force });
  return true;
}

/** The main thread: a thread ended, and its units with it. */
export function ncUnitsThreadEnded(threadId: string): void {
  reporter?.setThread(threadId, 0);
}

/** The report, posted to the host. */
export async function postNcUnits(report: NcUnitsReport): Promise<void> {
  await hostJson("POST", "/host/v1/units", report);
}

let reporter: NcUnitsReporter | null = null;
let failureSaid = false;

export function setNcUnitsReporter(next: NcUnitsReporter | null): void {
  reporter?.stop();
  reporter = next;
}

export function ncUnitsReporter(): NcUnitsReporter | null {
  return reporter;
}

/** Count one job of long model work while fn runs (a no-op with no reporter). */
export async function asNcUnit<T>(fn: () => Promise<T>): Promise<T> {
  const end = reporter?.begin();
  try {
    return await fn();
  } finally {
    end?.();
  }
}

/** Report now, never throwing (the beat, the way out). */
export async function refreshNcUnits(options: { force?: boolean } = {}): Promise<void> {
  if (!reporter) return;
  try {
    await reporter.refresh(options);
  } catch {
    if (!failureSaid) {
      failureSaid = true;
      log.warn("nc-units", "could not tell the host about queued work");
    }
  }
}

/**
 * Express middleware, in the app: once a request that may have queued work
 * (any but GET, HEAD and OPTIONS: an upload's complete, a Run, a playbook)
 * is answered, report again. Unchanged reports are not sent.
 */
export function refreshNcUnitsAfterWrites(
  req: { method?: string },
  res: { once(event: "finish", listener: () => void): unknown },
  next: () => void,
): void {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    res.once("finish", () => void refreshNcUnits());
  }
  next();
}
