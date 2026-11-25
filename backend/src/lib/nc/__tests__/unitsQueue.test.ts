// The robustness campaign's U1 (2026-11-24): while 30 uploads were read the
// app's units said `{"waiting": false}` in 20 of 20 samples. Uploads are read
// by the uploads thread's own loop, outside the DB-job runner: what waits of
// them is read from their tables.
import { describe, expect, it } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { combineNcQueued, queuedNcWork, queuedUploads } from "../unitsQueue";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

function db(tables: Record<string, Record<string, unknown>[]>) {
  return tableDb({ upload_processing_jobs: [], upload_sessions: [], db_jobs: [], ...tables }).db;
}

describe("uploads that wait", () => {
  it("are due while a file's processing job is queued or running", async () => {
    expect(await queuedUploads(db({ upload_processing_jobs: [{ status: "queued", available_at: at(-1000) }] }), NOW)).toEqual({ due: true });
    expect(await queuedUploads(db({ upload_processing_jobs: [{ status: "running", available_at: at(60_000) }] }), NOW)).toEqual({ due: true });
  });

  it("name when a retry's pause ends", async () => {
    expect(await queuedUploads(db({ upload_processing_jobs: [{ status: "queued", available_at: at(30_000) }] }), NOW)).toEqual({
      due: false,
      pauseEnds: at(30_000),
    });
  });

  it("are due while a session is still open, its files on their way, until it expires", async () => {
    expect(await queuedUploads(db({ upload_sessions: [{ id: "s", status: "pending_upload", expires_at: at(60_000) }] }), NOW)).toEqual({ due: true });
    expect(await queuedUploads(db({ upload_sessions: [{ id: "s", status: "pending_upload", expires_at: at(-1) }] }), NOW)).toEqual({ due: false });
    expect(await queuedUploads(db({ upload_sessions: [{ id: "s", status: "completed", expires_at: at(60_000) }] }), NOW)).toEqual({ due: false });
  });

  it("are nothing once every file is read", async () => {
    expect(
      await queuedUploads(db({ upload_processing_jobs: [{ status: "completed", available_at: at(-1) }, { status: "error", available_at: at(-1) }] }), NOW),
    ).toEqual({ due: false });
  });
});

describe("everything that waits", () => {
  it("is due when any part is, else names the earliest pause", () => {
    expect(combineNcQueued([{ due: false }, { due: true }])).toEqual({ due: true });
    expect(combineNcQueued([{ due: false, pauseEnds: at(9000) }, { due: false, pauseEnds: at(3000) }, { due: false }])).toEqual({
      due: false,
      pauseEnds: at(3000),
    });
    expect(combineNcQueued([{ due: false }])).toEqual({ due: false });
  });

  it("reads a person's DB jobs, the uploads and what the caller names (a review to resume)", async () => {
    const tables = db({ db_jobs: [{ kind: "document.extract_text", status: "pending", run_at: at(-5) }] });
    expect(await queuedNcWork(tables, { now: NOW })).toEqual({ due: true });
    expect(await queuedNcWork(db({}), { now: NOW })).toEqual({ due: false });
    expect(await queuedNcWork(db({}), { now: NOW, extra: () => ({ due: true }) })).toEqual({ due: true });
    // Housekeeping does not keep the app awake.
    expect(await queuedNcWork(db({ db_jobs: [{ kind: "storage.cleanup", status: "pending", run_at: at(-5) }] }), { now: NOW })).toEqual({ due: false });
  });

  it("counts a part it cannot read as nothing", async () => {
    const failing = tableDb({ db_jobs: [] }, { failSelects: ["upload_processing_jobs", "db_jobs"] }).db;
    expect(await queuedNcWork(failing, { now: NOW, extra: () => ({ due: true }) })).toEqual({ due: true });
    expect(await queuedNcWork(failing, { now: NOW })).toEqual({ due: false });
  });
});
