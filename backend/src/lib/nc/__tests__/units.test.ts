import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNcUnitsReporter, postNcUnits, type NcQueued, type NcUnitsReport } from "../units";
import { resetLaunchSecrets, setNcAppCredential } from "../launchSecrets";
import { closeUnixSocketAgents } from "../unixFetch";
import { CREDENTIAL, eventually, startFakeHost, type FakeHost } from "./fakeHost";

function reporter(queued: NcQueued = { due: false }) {
  const posted: NcUnitsReport[] = [];
  let state = queued;
  const post = vi.fn(async (report: NcUnitsReport) => {
    posted.push(report);
  });
  const units = createNcUnitsReporter({ post, queued: async () => state });
  return { units, posted, post, setQueued: (next: NcQueued) => (state = next) };
}

describe("the app's units of work", () => {
  it("says waiting while a job runs, and not once none does", async () => {
    const { units, posted } = reporter();
    const endA = units.begin();
    const endB = units.begin();
    await eventually(() => expect(posted).toEqual([{ waiting: true }]));
    endA();
    endA(); // ending twice ends once
    expect(units.running).toBe(1);
    endB();
    await eventually(() => expect(posted).toEqual([{ waiting: true }, { waiting: false }]));
    expect(units.running).toBe(0);
  });

  it("stays waiting while a job is queued, and names when a paused one is due", async () => {
    const { units, posted, setQueued } = reporter({ due: true });
    const end = units.begin();
    await eventually(() => expect(posted).toEqual([{ waiting: true }]));
    end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still queued: an unchanged report is not sent again.
    expect(posted).toEqual([{ waiting: true }]);
    setQueued({ due: false, pauseEnds: "2026-11-24T20:00:00.000Z" });
    await units.refresh();
    expect(posted.at(-1)).toEqual({ waiting: false, pause_ends: "2026-11-24T20:00:00.000Z" });
    // The beat says it again even unchanged.
    await units.refresh({ force: true });
    expect(posted).toHaveLength(3);
  });

  it("posts one report at a time, the latest state last", async () => {
    let release!: () => void;
    const posted: NcUnitsReport[] = [];
    const units = createNcUnitsReporter({
      post: async (report) => {
        posted.push(report);
        if (posted.length === 1) await new Promise<void>((resolve) => (release = resolve));
      },
      queued: async () => ({ due: false }),
    });
    const end = units.begin();
    await eventually(() => expect(posted).toHaveLength(1));
    end();
    units.begin()();
    release();
    await eventually(() => expect(posted.at(-1)).toEqual({ waiting: false }));
    expect(posted[0]).toEqual({ waiting: true });
  });

  it("tries a failed report again", async () => {
    const posted: NcUnitsReport[] = [];
    let fail = true;
    const units = createNcUnitsReporter({
      post: async (report) => {
        if (fail) {
          fail = false;
          throw new Error("host busy");
        }
        posted.push(report);
      },
      queued: async () => ({ due: false }),
      retryMs: 10,
    });
    units.begin();
    await eventually(() => expect(posted).toEqual([{ waiting: true }]));
    units.stop();
  });

  it("counts what runs when the queue cannot be read", async () => {
    const posted: NcUnitsReport[] = [];
    const units = createNcUnitsReporter({
      post: async (report) => void posted.push(report),
      queued: async () => {
        throw new Error("database down");
      },
    });
    units.begin();
    await eventually(() => expect(posted).toEqual([{ waiting: true }]));
  });
});

describe("POST /host/v1/units", () => {
  let host: FakeHost;
  beforeEach(async () => {
    host = await startFakeHost();
    vi.stubEnv("LB_HOST_SOCKET", host.socketPath);
    setNcAppCredential(CREDENTIAL);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetLaunchSecrets();
    await closeUnixSocketAgents();
    await host.close();
  });

  it("reaches the host with the app's credential", async () => {
    await postNcUnits({ waiting: true });
    await postNcUnits({ waiting: false, pause_ends: "2026-11-24T20:00:00.000Z" });
    expect(host.units).toEqual([{ waiting: true }, { waiting: false, pause_ends: "2026-11-24T20:00:00.000Z" }]);
    expect(host.unauthorized).toBe(0);
  });
});
