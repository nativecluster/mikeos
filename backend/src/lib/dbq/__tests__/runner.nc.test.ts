// The DB-job runner inside a NativeCluster app (NATIVECLUSTER_TRANSPORT=host):
// each job runs in a job scope (its model calls wait in the host's line as a
// job, lane B), long model work counts as one of the app's units, and a job
// queued during a request keeps that request's person and id.
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentNcScope, ncOriginFor, runInNcJob, runInNcRequest } from "../../nc/context";
import { createNcUnitsReporter, setNcUnitsReporter, type NcUnitsReport } from "../../nc/units";
import { enqueueDbJob } from "../enqueue";
import { processClaimedJob, queuedNcJobs, startDbJobRunner, stopDbJobRunner } from "../runner";
import type { DbJob } from "../types";

function makeDb(rows: unknown[] = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  const inserts: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["update", "delete", "select", "eq", "neq", "lt", "in", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.insert = (row: Record<string, unknown>) => {
    inserts.push(row);
    return builder;
  };
  builder.single = () => Promise.resolve({ data: { id: "new-job" }, error: null });
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
  return { db: { from: () => builder, rpc: async () => ({ data: [], error: null }) }, calls, inserts };
}

const JOB = (over: Partial<DbJob> = {}): DbJob => ({
  id: "job-1",
  kind: "extraction.extract",
  payload: {},
  status: "running",
  attempts: 1,
  max_attempts: 3,
  run_at: "2026-08-21T00:00:00Z",
  claimed_at: "2026-08-21T00:00:01Z",
  finished_at: null,
  last_error: null,
  dedupe_key: null,
  result: null,
  created_at: "2026-08-21T00:00:00Z",
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
  setNcUnitsReporter(null);
});

describe("a job in a NativeCluster app", () => {
  it("runs in a job scope from its request, and counts as a unit while it runs", async () => {
    vi.stubEnv("NATIVECLUSTER_TRANSPORT", "host");
    const posted: NcUnitsReport[] = [];
    setNcUnitsReporter(
      createNcUnitsReporter({ post: async (r) => void posted.push(r), queued: async () => ({ due: false }) }),
    );
    const seen: unknown[] = [];
    const { db } = makeDb();
    await processClaimedJob(db as never, {
      "extraction.extract": async () => {
        seen.push(ncOriginFor());
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    }, JOB({ payload: { reviewId: "r", _nc: { person: "p_ann", request: "req_7", at: Date.now() } } }));
    expect(seen).toEqual([
      expect.objectContaining({
        task: "tabular",
        lane: "B",
        job: true,
        person: "p_ann",
        ticket: { origin: "job", from: "request", person: "p_ann", request: "req_7" },
      }),
    ]);
    await vi.waitFor(() => expect(posted).toEqual([{ waiting: true }, { waiting: false }]));
  });

  it("waits as resumed without a request, and counts no unit for work that calls no model", async () => {
    vi.stubEnv("NATIVECLUSTER_TRANSPORT", "host");
    const posted: NcUnitsReport[] = [];
    setNcUnitsReporter(
      createNcUnitsReporter({ post: async (r) => void posted.push(r), queued: async () => ({ due: false }) }),
    );
    const seen: unknown[] = [];
    const { db } = makeDb();
    await processClaimedJob(db as never, {
      "export.build": async () => void seen.push(ncOriginFor()),
    }, JOB({ kind: "export.build" }));
    expect(seen).toEqual([
      expect.objectContaining({ task: "assistant", lane: "B", ticket: { origin: "job", from: "resume" } }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);
  });

  it("changes nothing outside the app", async () => {
    const seen: unknown[] = [];
    const { db } = makeDb();
    await processClaimedJob(db as never, {
      "memory.consolidate": async () => void seen.push(currentNcScope()),
    }, JOB({ kind: "memory.consolidate", payload: { _nc: { person: "p" } } }));
    expect(seen).toEqual([undefined]);
  });
});

describe("what waits in the queue", () => {
  it("is due when the earliest pending model job's time has come", async () => {
    const { db, calls } = makeDb([{ run_at: "2026-11-24T10:00:00.000Z" }]);
    expect(await queuedNcJobs(db as never, Date.parse("2026-11-24T11:00:00Z"))).toEqual({ due: true });
    expect(calls).toContainEqual(["eq", "status", "pending"]);
    expect(calls).toContainEqual(["in", "kind", ["extraction.extract", "playbook.review", "playbook.import", "memory.consolidate"]]);
    expect(calls).toContainEqual(["order", "run_at", { ascending: true }]);
  });

  it("names when a paused one is due, and nothing for none", async () => {
    const { db } = makeDb([{ run_at: "2026-11-24T12:00:00.000Z" }]);
    expect(await queuedNcJobs(db as never, Date.parse("2026-11-24T11:00:00Z"))).toEqual({
      due: false,
      pauseEnds: "2026-11-24T12:00:00.000Z",
    });
    expect(await queuedNcJobs(makeDb([]).db as never)).toEqual({ due: false });
  });
});

describe("a job queued during a request", () => {
  it("keeps the request's person and id, for long model work, inside the app", async () => {
    vi.stubEnv("NATIVECLUSTER_TRANSPORT", "host");
    const { db, inserts } = makeDb();
    const at = Date.now();
    await runInNcRequest({ person: "p_ann", request: "req_7", at, task: "playbook" }, () =>
      enqueueDbJob(db as never, { kind: "playbook.review", payload: { runId: "run-1" } }),
    );
    expect(inserts[0].payload).toEqual({ runId: "run-1", _nc: { person: "p_ann", request: "req_7", at } });

    await runInNcRequest({ person: "p_ann", request: "req_8", at, task: "assistant" }, () =>
      enqueueDbJob(db as never, { kind: "export.build", payload: { a: 1 } }),
    );
    expect(inserts[1].payload).toEqual({ a: 1 });

    // Queued by another job: its person, no request.
    await runInNcJob({ task: "assistant", person: "p_ann", request: "req_7", at }, () =>
      enqueueDbJob(db as never, { kind: "memory.consolidate", payload: {} }),
    );
    expect(inserts[2].payload).toEqual({ _nc: { person: "p_ann" } });
  });

  it("keeps nothing outside the app", async () => {
    const { db, inserts } = makeDb();
    await runInNcRequest({ person: "p_ann", request: "req_7", at: Date.now(), task: "tabular" }, () =>
      enqueueDbJob(db as never, { kind: "extraction.extract", payload: { x: 1 } }),
    );
    expect(inserts[0].payload).toEqual({ x: 1 });
  });
});

describe("the runner's own timers", () => {
  afterEach(async () => {
    await stopDbJobRunner();
    vi.useRealTimers();
  });

  async function timersAfterStart(): Promise<number> {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("SUPABASE_SECRET_KEY", "not-a-real-key");
    vi.stubEnv("QUEUE_DRIVER", "postgres");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    startDbJobRunner({});
    return vi.getTimerCount();
  }

  it("keeps the poll and drops the retention sweep's timers in a NativeCluster app", async () => {
    vi.stubEnv("MIKE_NC_APP", "1");
    // The poll interval and its first tick.
    expect(await timersAfterStart()).toBe(2);
  });

  it("keeps the retention sweep's timers outside the app", async () => {
    expect(await timersAfterStart()).toBe(4);
  });
});
