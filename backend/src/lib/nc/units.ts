// The app's units of work, told to NativeCluster's host (POST /host/v1/units).
//
// While a job waits or runs the host never stops the app as idle, and it
// starts the app again for work that waits, or whose pause (a retry's
// backoff) ends. Mike's long model work (tabular cells and rows, playbook
// reviews and imports, the memory curator) runs on the DB-job runner, which
// counts each such job here as it runs and says what is still queued
// (lib/dbq/runner.ts). The report goes after every change, at the runner's
// start, on the host's beat and on the way out; the host keeps the last one.
//
// One reporter per process: the runner's thread.

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
  readonly running: number;
  /** Report now: on the beat, at start and on the way out (`force` posts even an unchanged report). */
  refresh(options?: { force?: boolean }): Promise<void>;
  /** Stop retrying a failed post (shutdown). */
  stop(): void;
};

export function createNcUnitsReporter(options: {
  post: (report: NcUnitsReport) => Promise<void>;
  queued: () => Promise<NcQueued>;
  retryMs?: number;
}): NcUnitsReporter {
  let running = 0;
  let last: string | null = null;
  let inFlight: Promise<void> | null = null;
  let again: { force: boolean } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const report = async (): Promise<NcUnitsReport> => {
    let queued: NcQueued = { due: false };
    try {
      queued = await options.queued();
    } catch {
      // Unknown: what runs still counts; a queued job is found next time.
    }
    const waiting = running > 0 || queued.due;
    return {
      waiting,
      ...(!waiting && queued.pauseEnds ? { pause_ends: queued.pauseEnds } : {}),
    };
  };

  const once = async (force: boolean): Promise<void> => {
    const next = await report();
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
      running += 1;
      if (running === 1) void refresh();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        running -= 1;
        if (running === 0) void refresh();
      };
    },
    get running() {
      return running;
    },
    refresh,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
    },
  };
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
