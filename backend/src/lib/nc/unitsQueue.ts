// What waits of a person's work, read from the database, for the app's one
// units reporter (lib/nc/units.ts, on the backend's main thread). What runs
// is counted as it starts and ends; this is the rest:
//   - DB jobs of a person's work, pending or running (lib/dbq/runner.ts
//     NC_UNIT_JOB_KINDS): due now, or the earliest backoff's end;
//   - uploads: a file's processing job queued or running (the uploads
//     thread's own loop, whose end this reporter learns of only here), and
//     an upload session still open, its files on their way (bounded by the
//     session's own 30-minute expiry);
//   - anything else the caller names (a tabular run to resume after a stop).
// Each part that cannot be read counts as nothing: what runs still counts.

import { asReportableError } from "../httpError";
import type { Db } from "../supabase";
import { NC_JOB_KINDS } from "./context";
import type { NcQueued } from "./units";

/**
 * The DB job kinds that are a person's work, each one waiting or running one
 * of the app's units: long model work (NC_JOB_KINDS), and reading a
 * document's text, converting it, an export and an account's deletion. Not
 * the housekeeping (storage and document cleanup, which retry until they
 * succeed, the MCP token refresh, a turn's audit row): a cleanup's backoff
 * would wake the app every half hour for ever.
 */
export const NC_UNIT_JOB_KINDS: readonly string[] = [
  ...NC_JOB_KINDS,
  "document.extract_text",
  "document.precompute_text",
  "conversion.convert",
  "export.build",
  "account.delete",
];

export function isNcUnitJobKind(kind: string): boolean {
  return NC_UNIT_JOB_KINDS.includes(kind);
}

/**
 * Whether a person's work waits in the queue: a job due now or running (a
 * running one a crash left behind waits for the runner to claim it again),
 * or the earliest pending one's run_at when it lies ahead (a retry's
 * backoff, the memory curator's quiet period).
 */
export async function queuedNcJobs(db: Db, now = Date.now()): Promise<NcQueued> {
  const { data, error } = await db
    .from("db_jobs")
    .select("run_at")
    .in("status", ["pending", "running"])
    .in("kind", [...NC_UNIT_JOB_KINDS])
    .order("run_at", { ascending: true })
    .limit(1);
  if (error) throw asReportableError(error, queuedNcJobs);
  const first = (data as { run_at?: string }[] | null)?.[0]?.run_at;
  const at = first ? Date.parse(first) : Number.NaN;
  if (!Number.isFinite(at)) return { due: false };
  return at <= now ? { due: true } : { due: false, pauseEnds: new Date(at).toISOString() };
}

const OPEN_UPLOAD_SESSION = ["pending_upload", "verifying", "uploaded", "processing"];
const UPLOAD_JOB_ROWS = 50;

/** The parts combined: due if any is, else the earliest pause's end. */
export function combineNcQueued(parts: NcQueued[]): NcQueued {
  if (parts.some((part) => part.due)) return { due: true };
  const ends = parts
    .map((part) => part.pauseEnds)
    .filter((end): end is string => typeof end === "string" && Number.isFinite(Date.parse(end)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return ends.length ? { due: false, pauseEnds: ends[0] } : { due: false };
}

/** Uploads being sent or processed. */
export async function queuedUploads(db: Db, now = Date.now()): Promise<NcQueued> {
  const { data: jobs, error: jobsError } = await db
    .from("upload_processing_jobs")
    .select("status, available_at")
    .in("status", ["queued", "running"])
    .order("available_at", { ascending: true })
    .limit(UPLOAD_JOB_ROWS);
  if (jobsError) throw jobsError;
  let pauseEnds: number | null = null;
  for (const job of (jobs ?? []) as Array<{ status?: string; available_at?: string }>) {
    const at = Date.parse(String(job.available_at ?? ""));
    if (job.status === "running" || !Number.isFinite(at) || at <= now) return { due: true };
    pauseEnds = pauseEnds === null ? at : Math.min(pauseEnds, at);
  }
  const { data: sessions, error: sessionsError } = await db
    .from("upload_sessions")
    .select("id")
    .in("status", OPEN_UPLOAD_SESSION)
    .gt("expires_at", new Date(now).toISOString())
    .limit(1);
  if (sessionsError) throw sessionsError;
  if ((sessions ?? []).length) return { due: true };
  return pauseEnds === null ? { due: false } : { due: false, pauseEnds: new Date(pauseEnds).toISOString() };
}

/** Everything of a person's work that waits, for the units report. */
export async function queuedNcWork(
  db: Db,
  options: { now?: number; extra?: () => NcQueued } = {},
): Promise<NcQueued> {
  const now = options.now ?? Date.now();
  const parts = await Promise.all([
    queuedNcJobs(db, now).catch((): NcQueued => ({ due: false })),
    queuedUploads(db, now).catch((): NcQueued => ({ due: false })),
  ]);
  if (options.extra) {
    try {
      parts.push(options.extra());
    } catch {
      // Unreadable: counts as nothing.
    }
  }
  return combineNcQueued(parts);
}
