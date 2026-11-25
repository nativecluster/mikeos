// The server-owned run of a synchronous tabular generation, and what carries
// one across a stop of Mike as a NativeCluster app.
//
// POST /:reviewId/generate claims the review's generation lease, registers a
// stream run and hands it to runTabularGenerationSync, which owns everything
// from there to the lease's release: the heartbeat, the post-lease work
// snapshot, the cell claim, the extraction, the terminal frames. The same
// function resumes an interrupted run at the backend's start
// (resumeTabularRuns), with no request.
//
// Why a resume (the robustness campaign's L1, 2026-11-24): a run cut short
// by a crash, or by a SIGTERM whose drain outlived the backend's grace (a
// Quit, an update, the host's idle stop, every few seconds of a real model's
// cell), left the review `is_running` with cells stuck `generating`, and Run
// answered 409 review_running until the dead run's 300 s lease lapsed. It
// never went on by itself. In the app there is one backend per data folder,
// so at its start no run is live:
//   - recoverTabularRuns (before the backend listens) sets every
//     `generating` cell back to `pending`, clears every generation stamp and
//     releases every lease, so Run works at once;
//   - a run that was going when the app stopped left a marker in the data
//     folder (state/tabular-runs/<review>.json, written when its cells are
//     claimed, removed when it ends), and resumeTabularRuns starts it again
//     as its person's background job, filling only the cells not done
//     (done cells are never asked again: extractRowColumns skips them).
// On SIGTERM the backend stops its runs first (stopTabularRunsForShutdown):
// each aborts its model calls, puts its unfinished cells back to pending,
// releases its lease and keeps its marker, all inside the host's grace, so
// the next start resumes it; the units report that says so on the way out
// has the host start Mike again for it (lib/nc/units.ts).
//
// Outside the app nothing is marked and nothing is recovered: several
// replicas may share one database there.

import { randomUUID } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import type { UserApiKeys } from "../../lib/llm";
import { recordAudit } from "../../lib/audit";
import { log } from "../../lib/log";
import { runInNcJob } from "../../lib/nc/context";
import { ncAppMode } from "../../lib/nc/tick";
import { asNcUnit } from "../../lib/nc/units";
import { isReported, reportError } from "../../lib/observability/sentry";
import { BACKEND_REPORTING_OWNER } from "../../lib/reportedUpstreamCodes";
import {
    startStreamRun,
    stopOutcomeFrame,
    type StreamRun,
} from "../../lib/streamRuns";
import { ASSISTANT_ERROR_MESSAGE } from "../chat/chat.service";
import {
    claimTabularGeneration,
    loadTabularGenerateWork,
    prepareTabularGenerate,
} from "./tabular.generate";
import {
    claimCellsForGeneration,
    streamTabularGenerateSync,
} from "./tabular.generateStream";
import {
    finishGeneration,
    startGenerationHeartbeat,
    type Column,
    type Db,
    type Log,
} from "./tabular.shared";

/** The stream-run key a review's generation runs under: one at a time. */
export const reviewRunKey = (reviewId: string) => `review:${reviewId}`;

/** What readers get when a stopped run does not unwind in the registry's grace. */
export const REVIEW_RUN_FORCED_STOP_FRAMES: readonly string[] = [
    `data: ${JSON.stringify({ type: "cancelled" })}\n\n`,
    "data: [DONE]\n\n",
];

// ---------------------------------------------------------------------------
// Markers: a run to resume after a stop
// ---------------------------------------------------------------------------

export type TabularRunMarker = {
    reviewId: string;
    userId: string;
    generationId: string;
    startedAt: string;
    /** How many times a start has resumed it so far. */
    resumes: number;
};

/**
 * A run resumed this many times without ending or being handed over (each
 * time the app died under it) is left for its person to Run again: it may be
 * what kills the app.
 */
export const MAX_TABULAR_RUN_RESUMES = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function markersDir(): string | null {
    if (!ncAppMode() || process.env.ASYNC_TABULAR_EXTRACTION === "true") return null;
    const data = process.env.NC_APP_DATA?.trim();
    return data ? path.join(data, "state", "tabular-runs") : null;
}

function markerPath(dir: string, reviewId: string): string | null {
    return UUID_RE.test(reviewId) ? path.join(dir, `${reviewId}.json`) : null;
}

function readMarker(file: string): TabularRunMarker | null {
    try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TabularRunMarker>;
        if (
            typeof raw.reviewId !== "string" ||
            !UUID_RE.test(raw.reviewId) ||
            typeof raw.userId !== "string" ||
            typeof raw.generationId !== "string"
        )
            return null;
        return {
            reviewId: raw.reviewId,
            userId: raw.userId,
            generationId: raw.generationId,
            startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
            resumes: typeof raw.resumes === "number" && raw.resumes >= 0 ? raw.resumes : 0,
        };
    } catch {
        return null;
    }
}

/** A run's cells are claimed: until it ends, a stop of the app leaves it to resume. */
export function markTabularRunStarted(marker: Omit<TabularRunMarker, "startedAt">): void {
    const dir = markersDir();
    const file = dir && markerPath(dir, marker.reviewId);
    if (!dir || !file) return;
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify({ ...marker, startedAt: new Date().toISOString() }), { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch (error) {
        log.warn("tabular-run", "could not mark a run to resume after a stop", { error });
    }
}

/** A run ended (done, stopped by its person, failed, or another took its lease): nothing to resume. */
export function markTabularRunEnded(reviewId: string, generationId: string): void {
    const dir = markersDir();
    const file = dir && markerPath(dir, reviewId);
    if (!dir || !file) return;
    const marker = readMarker(file);
    if (marker && marker.generationId !== generationId) return; // a successor's
    rmSync(file, { force: true });
}

/** The runs a stop interrupted, as their markers say. */
export function tabularRunMarkers(): TabularRunMarker[] {
    const dir = markersDir();
    if (!dir) return [];
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const markers: TabularRunMarker[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const marker = readMarker(path.join(dir, name));
        if (marker) markers.push(marker);
        else rmSync(path.join(dir, name), { force: true });
    }
    return markers;
}

// ---------------------------------------------------------------------------
// The runs this process owns, and the stop
// ---------------------------------------------------------------------------

const active = new Set<StreamRun>();
let shuttingDown = false;

/**
 * The backend is stopping: end every run now, its cells back to pending and
 * its lease released, keeping its marker so the next start resumes it.
 * Answers how many were stopped.
 */
export function stopTabularRunsForShutdown(): number {
    shuttingDown = true;
    const runs = [...active];
    for (const run of runs) run.stop();
    return runs.length;
}

/** Test seam. */
export function resetTabularRunsForTests(): void {
    shuttingDown = false;
    active.clear();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type TabularSyncRunOutcome = "completed" | "stopped" | "handed_over" | "failed";

/**
 * A synchronous generation's run, from the claimed lease to its release.
 * The caller has claimed the lease for `generationId` and registered `run`.
 * `attach` makes the run's stream a response's (the route); a failure
 * before any frame goes to `failBeforeStream` ("internal": a lookup or the
 * cell claim failed; "prepare": anything else that threw).
 */
export async function runTabularGenerationSync(args: {
    db: Db;
    reviewId: string;
    userId: string;
    userEmail: string | undefined;
    generationId: string;
    run: StreamRun;
    columns: Column[];
    model: string;
    apiKeys: UserApiKeys;
    attach?: () => void;
    failBeforeStream?: (error: unknown, kind: "internal" | "prepare") => void;
    /** How many times a start has resumed this run (its marker keeps it). */
    resumes?: number;
    log?: Log;
}): Promise<TabularSyncRunOutcome> {
    const { db, reviewId, userId, userEmail, generationId, run } = args;
    const logger = args.log ?? console;
    const handedOver = () => shuttingDown && run.signal.aborted;
    active.add(run);
    let streamed = false;
    let outcome: TabularSyncRunOutcome = "failed";
    // Losing the lease means a successor now owns these cells, so the only
    // safe response is to stop writing: abort, and let `finally` end the run.
    const heartbeat = startGenerationHeartbeat({
        db,
        reviewId,
        generationId,
        skip: () => run.signal.aborted,
        onLost: () => run.stop(),
    });
    try {
        // Everything used to decide which cells need work is loaded only
        // after the atomic lease claim. Otherwise, a request can snapshot
        // pending cells while another run is finishing, acquire the newly
        // released lease, and regenerate results that were completed after
        // its stale snapshot.
        const work = await loadTabularGenerateWork(db, { reviewId, userId, userEmail });
        if (!work.ok) {
            args.failBeforeStream?.(work.error, "internal");
            return outcome;
        }
        const { rows, cellMap } = work.data;
        if (run.signal.aborted) {
            outcome = handedOver() ? "handed_over" : "stopped";
            return outcome;
        }

        // Claim the cells this run intends to fill by stamping them with the
        // generation id. Every write extractRowColumns then performs is
        // guarded on that stamp, so a run that loses the lease mid-flight (a
        // wedged process, a renew that failed) can no longer blank or
        // overwrite the cells its successor has already filled. Doing it
        // here, right after the atomic lease claim, is the only window in
        // which no other generation can be running.
        try {
            await claimCellsForGeneration({ db, reviewId, generationId, columns: args.columns, rows, cellMap });
        } catch (claimErr) {
            args.failBeforeStream?.(claimErr, "internal");
            return outcome;
        }
        markTabularRunStarted({ reviewId, userId, generationId, resumes: args.resumes ?? 0 });

        // Only now does the response become a stream: everything above can
        // still answer with a status code, and attaching earlier would make
        // an internal error unreportable.
        args.attach?.();
        streamed = true;

        // The run is one of the app's units while it goes: the host never
        // stops Mike as idle under it (lib/nc/units.ts).
        const completed = await asNcUnit(() =>
            streamTabularGenerateSync({
                onActivity: run.touch,
                write: run.write,
                db,
                reviewId,
                columns: args.columns,
                rows,
                cellMap,
                model: args.model,
                apiKeys: args.apiKeys,
                generationId,
                abortSignal: run.signal,
            }),
        );

        if (completed) {
            outcome = "completed";
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
                model: args.model,
            });
            run.write("data: [DONE]\n\n");
        } else if (handedOver()) {
            // The backend is stopping: the next start resumes the run, and a
            // reader reconnects to it then. No terminal frame: it did not end.
            outcome = "handed_over";
        } else {
            // Stopped. The cells are already back to "pending"; tell every
            // attached reader how the run ended, the way a chat turn does,
            // so a second tab does not sit on a spinner.
            outcome = "stopped";
            run.write(stopOutcomeFrame(run));
            run.write("data: [DONE]\n\n");
        }
        return outcome;
    } catch (err) {
        if (handedOver()) {
            outcome = "handed_over";
        } else if (!run.signal.aborted) {
            if (!isReported(err))
                reportError(err, { tags: { operation: "tabular.generate", stage: "generation-stream" } });
            logger.error("[tabular/generate] stream error", err);
            if (streamed) {
                try {
                    run.write(
                        `data: ${JSON.stringify({ type: "error", message: ASSISTANT_ERROR_MESSAGE, reporting_owner: BACKEND_REPORTING_OWNER })}\n\ndata: [DONE]\n\n`,
                    );
                } catch {
                    /* ignore */
                }
            } else {
                args.failBeforeStream?.(err, "prepare");
            }
        } else {
            outcome = "stopped";
        }
        return outcome;
    } finally {
        clearInterval(heartbeat);
        active.delete(run);
        await finishGeneration(db, reviewId, generationId, logger, "[tabular/generate]");
        // Handed over by a clean stop, the run is resumed afresh at the next
        // start (its count of resumes starts again: only a stop that never
        // reached here, a crash, counts toward MAX_TABULAR_RUN_RESUMES).
        if (outcome === "handed_over") markTabularRunStarted({ reviewId, userId, generationId, resumes: 0 });
        else markTabularRunEnded(reviewId, generationId);
        // Ending the run ends every response attached to it (this one, a
        // reload, a second tab) and starts its retention window, so a client
        // reconnecting a moment later still gets the last frames.
        run.finish();
    }
}

// ---------------------------------------------------------------------------
// At the backend's start (a NativeCluster app)
// ---------------------------------------------------------------------------

type HeldLease = { id: string; active_generation_id: string | null };

/**
 * Before the backend listens: no run of the previous process lives on, so
 * every `generating` cell goes back to `pending`, every generation stamp is
 * cleared and every lease released. Answers the runs to resume, by their
 * markers (resumeTabularRuns starts them once the backend listens). A no-op
 * outside the app, or with the asynchronous path (its queue owns its runs).
 */
export async function recoverTabularRuns(db: Db): Promise<TabularRunMarker[]> {
    if (!markersDir()) return [];
    const { data: held, error: heldError } = await db
        .from("tabular_reviews")
        .select("id, active_generation_id")
        .not("active_generation_id", "is", null);
    if (heldError) throw heldError;
    const { error: cellsError } = await db
        .from("tabular_cells")
        .update({ status: "pending", content: null, generation_id: null })
        .eq("status", "generating");
    if (cellsError) throw cellsError;
    const { error: stampsError } = await db
        .from("tabular_cells")
        .update({ generation_id: null })
        .not("generation_id", "is", null);
    if (stampsError) throw stampsError;
    for (const review of (held ?? []) as HeldLease[]) {
        if (review.active_generation_id)
            await finishGeneration(db, review.id, review.active_generation_id, console, "[tabular/recover]");
    }

    const markers = tabularRunMarkers();
    const resumable: TabularRunMarker[] = [];
    for (const marker of markers) {
        if (marker.resumes >= MAX_TABULAR_RUN_RESUMES) {
            // Resumed, and the app died under it again, more than once: it
            // may be what kills the app. Its cells stay pending for Run.
            log.warn("tabular-run", "a review's run was resumed twice and died each time; it is left for Run", {
                reviewId: marker.reviewId,
            });
            markTabularRunEnded(marker.reviewId, marker.generationId);
            continue;
        }
        resumable.push(marker);
    }
    if ((held ?? []).length || resumable.length)
        log.info("tabular-run", "recovered the runs of the last start", {
            leases: (held ?? []).length,
            resuming: resumable.length,
        });
    return resumable;
}

/** The NativeCluster person and email of a Mike account, for a run with no request. */
async function ownerOf(db: Db, userId: string): Promise<{ person: string; email: string | undefined }> {
    const [{ data: person }, { data: profile }] = await Promise.all([
        db.from("nativecluster_people").select("nc_person").eq("user_id", userId).maybeSingle(),
        db.from("user_profiles").select("email").eq("user_id", userId).maybeSingle(),
    ]);
    return {
        person: typeof person?.nc_person === "string" ? person.nc_person : "",
        email: typeof profile?.email === "string" ? profile.email : undefined,
    };
}

/**
 * Start one interrupted run again, as its person's background job (its model
 * calls wait in lane B as a job resumed), under a new generation. Answers how
 * it ended, or why it did not start.
 */
export async function resumeTabularRun(
    db: Db,
    marker: TabularRunMarker,
): Promise<TabularSyncRunOutcome | "not_started"> {
    const { reviewId, userId } = marker;
    const owner = await ownerOf(db, userId);
    return runInNcJob({ task: "tabular", person: owner.person }, async () => {
        const prepared = await prepareTabularGenerate(db, { reviewId, userId, userEmail: owner.email });
        if (!prepared.ok) {
            // Gone, no longer theirs to edit, no columns, or no model: there
            // is nothing to resume, and Run says why.
            markTabularRunEnded(reviewId, marker.generationId);
            return "not_started";
        }
        const generationId = randomUUID();
        const claim = await claimTabularGeneration(db, {
            reviewId,
            expectedUpdatedAt: String(prepared.data.review.updated_at),
            generationId,
        });
        if (!claim.ok) {
            // Someone's Run got there first (it marks its own run), or the
            // review changed meanwhile: theirs stands.
            markTabularRunEnded(reviewId, marker.generationId);
            return "not_started";
        }
        const run = startStreamRun({
            id: generationId,
            key: reviewRunKey(reviewId),
            userId,
            forcedStopFrames: REVIEW_RUN_FORCED_STOP_FRAMES,
        });
        if (!run) {
            await finishGeneration(db, reviewId, generationId, console, "[tabular/resume]");
            return "not_started";
        }
        markTabularRunEnded(reviewId, marker.generationId);
        log.info("tabular-run", "resuming a review's run", { reviewId, resumes: marker.resumes + 1 });
        return runTabularGenerationSync({
            db,
            reviewId,
            userId,
            userEmail: owner.email,
            generationId,
            run,
            columns: prepared.data.columns,
            model: prepared.data.tabular_model,
            apiKeys: prepared.data.api_keys,
            resumes: marker.resumes + 1,
            failBeforeStream: (error) => console.error("[tabular/resume] the run could not start", error),
        });
    });
}

/** Once the backend listens: every interrupted run, started again; failures are logged. */
export function resumeTabularRuns(db: Db, markers: TabularRunMarker[]): Promise<void> {
    return Promise.all(
        markers.map((marker) =>
            resumeTabularRun(db, marker).catch((error) => {
                reportError(error, { tags: { operation: "tabular.resume" } });
                console.error("[tabular/resume] failed", error);
            }),
        ),
    ).then(() => undefined);
}
