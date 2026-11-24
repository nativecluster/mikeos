import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A NativeCluster app (MIKE_NC_APP=1) keeps no sweep timers of its own: its
// sweeps run at startup and on the host's beat, and the MCP token refresh is
// left to the lazy one.
const mocks = vi.hoisted(() => ({
  startDbJobRunner: vi.fn(),
  stopDbJobRunner: vi.fn(async () => {}),
  runDbJobRetentionSweep: vi.fn(async () => {}),
  runStaleWorkSweep: vi.fn(async () => ({ documents: 0, cells: 0 })),
  createServerSupabase: vi.fn(() => ({ marker: "db" })),
}));
vi.mock("../workers", () => ({
  anyWorkerEnabled: () => false,
  startWorkers: vi.fn(),
  stopWorkers: vi.fn(async () => {}),
}));
vi.mock("../lib/dbq/runner", () => ({
  startDbJobRunner: mocks.startDbJobRunner,
  stopDbJobRunner: mocks.stopDbJobRunner,
  runDbJobRetentionSweep: mocks.runDbJobRetentionSweep,
  DB_JOB_RETENTION_SWEEP_EVERY_MS: 60 * 60 * 1000,
}));
vi.mock("../jobs/registry", () => ({
  DB_JOB_HANDLERS: {},
  DB_JOB_FAILURE_HOOKS: {},
  MCP_TOKEN_REFRESH_WINDOW_MS: 0,
}));
vi.mock("../lib/dbq/enqueue", () => ({ enqueueDbJob: vi.fn() }));
vi.mock("../jobs/maintenance", () => ({ runStaleWorkSweep: mocks.runStaleWorkSweep }));
vi.mock("../modules/uploads/uploads.service", () => ({ startUploadProcessingWorkers: vi.fn(() => vi.fn()) }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: mocks.createServerSupabase }));
vi.mock("../lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { resetNativeClusterTick, runNativeClusterTick, startAllWorkers, stopAllWorkers } from "../workerRuntime";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetNativeClusterTick();
});
afterEach(async () => {
  vi.useRealTimers();
  await stopAllWorkers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("timers in a NativeCluster app", () => {
  it("starts the DB-job runner but no sweep or MCP refresh timer", async () => {
    vi.stubEnv("MIKE_NC_APP", "1");
    vi.useFakeTimers();
    startAllWorkers(["jobs"]);
    expect(mocks.startDbJobRunner).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mocks.runStaleWorkSweep).not.toHaveBeenCalled();
    // The MCP refresh sweep would have read the database.
    expect(mocks.createServerSupabase).not.toHaveBeenCalled();
  });

  it("keeps its timers outside the app", () => {
    vi.useFakeTimers();
    startAllWorkers(["jobs"]);
    // The first stale sweep, the stale interval and the MCP refresh interval.
    expect(vi.getTimerCount()).toBe(3);
  });
});

describe("runNativeClusterTick", () => {
  it("runs every sweep on the first beat, then each when its interval has passed", async () => {
    let now = 1_000_000;
    const tick = () => runNativeClusterTick({ now: () => now });
    expect(await tick()).toEqual(["stale-work", "retention"]);
    expect(mocks.runStaleWorkSweep).toHaveBeenCalledTimes(1);
    expect(mocks.runDbJobRetentionSweep).toHaveBeenCalledWith({ marker: "db" });

    now += 60_000;
    expect(await tick()).toEqual([]);
    now += 10 * 60 * 1000;
    expect(await tick()).toEqual(["stale-work"]);
    now += 60 * 60 * 1000;
    expect(await tick()).toEqual(["stale-work", "retention"]);
    expect(mocks.runStaleWorkSweep).toHaveBeenCalledTimes(3);
    expect(mocks.runDbJobRetentionSweep).toHaveBeenCalledTimes(2);
  });

  it("joins a beat that is still running", async () => {
    let finish!: () => void;
    mocks.runStaleWorkSweep.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ documents: 0, cells: 0 }))),
    );
    const first = runNativeClusterTick();
    const second = runNativeClusterTick();
    expect(second).toBe(first);
    finish();
    expect(await first).toEqual(["stale-work", "retention"]);
    expect(mocks.runStaleWorkSweep).toHaveBeenCalledTimes(1);
  });

  it("contains a failed sweep and runs the next", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runStaleWorkSweep.mockRejectedValueOnce(new Error("database down"));
    expect(await runNativeClusterTick()).toEqual(["stale-work", "retention"]);
    expect(mocks.runDbJobRetentionSweep).toHaveBeenCalledOnce();
  });
});
