// The robustness campaign's L1 (2026-11-24): a tabular review cut short by a
// crash, or by a stop whose drain outlived the backend's grace, stayed
// `is_running` with cells stuck `generating`, Run answered 409
// review_running until the dead run's 300 s lease lapsed, and it never went
// on by itself. In the app (one backend per data folder) the next start lets
// go of everything the last one held and resumes the run; the backend's own
// stop hands its runs over cleanly. Every cell fills, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { model } = vi.hoisted(() => ({
    model: {
        /** Each call: the row's label and the columns asked. */
        asked: [] as Array<{ row: string; columns: number[]; origin: unknown }>,
        /** Rows whose answer waits until the run is stopped. */
        hold: new Set<string>(),
        heldAsked: null as null | (() => void),
    },
}));

vi.mock("../tabular.extract", async (importOriginal) => {
    const { ncOriginFor } = await vi.importActual<typeof import("../../../lib/nc/context")>("../../../lib/nc/context");
    return {
        ...(await importOriginal<typeof import("../tabular.extract")>()),
        queryTabularAllColumns: async (
            _model: string,
            label: string,
            _text: string,
            columns: Array<{ index: number }>,
            onResult: (columnIndex: number, result: unknown) => Promise<void>,
            _apiKeys: unknown,
            abortSignal?: AbortSignal,
        ) => {
            model.asked.push({ row: label, columns: columns.map((c) => c.index), origin: ncOriginFor() });
            if (model.hold.has(label)) {
                model.heldAsked?.();
                await new Promise<void>((_resolve, reject) => {
                    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                    if (abortSignal?.aborted) abort();
                    abortSignal?.addEventListener("abort", abort);
                });
            }
            for (const column of columns)
                await onResult(column.index, { summary: `${label} ${column.index}`, flag: "grey", reasoning: "" });
        },
    };
});
vi.mock("../tabular.rows", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.rows")>()),
    loadRowDocumentText: async () => "document text",
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: async () => {} }));
// The pre-lease guards and the work snapshot read access and models that are
// not what this test is about: from the tables, as the owner sees them.
vi.mock("../tabular.generate", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../tabular.generate")>();
    return {
        ...actual,
        prepareTabularGenerate: async (db: { from: (t: string) => any }, args: { reviewId: string }) => {
            const { data: review } = await db.from("tabular_reviews").select("*").eq("id", args.reviewId).maybeSingle();
            if (!review) return { ok: false, kind: "not_found" };
            return { ok: true, data: { review, columns: review.columns_config, tabular_model: "m", api_keys: {} } };
        },
        loadTabularGenerateWork: async (db: { from: (t: string) => any }, args: { reviewId: string }) => {
            const { data: rows } = await db.from("tabular_rows").select("*").eq("review_id", args.reviewId);
            const { data: cells } = await db.from("tabular_cells").select("*").eq("review_id", args.reviewId);
            const cellMap = new Map<string, Row>();
            for (const cell of cells as Row[]) cellMap.set(`${cell.row_id}:${cell.column_index}`, cell);
            return { ok: true, data: { rows, cellMap } };
        },
    };
});

import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { resetStreamRunsForTests, startStreamRun } from "../../../lib/streamRuns";
import { createNcUnitsReporter, setNcUnitsReporter, type NcUnitsReport } from "../../../lib/nc/units";
import { claimTabularGeneration } from "../tabular.generate";
import {
    MAX_TABULAR_RUN_RESUMES,
    REVIEW_RUN_FORCED_STOP_FRAMES,
    recoverTabularRuns,
    resetTabularRunsForTests,
    resumeTabularRuns,
    reviewRunKey,
    runTabularGenerationSync,
    stopTabularRunsForShutdown,
    tabularRunMarkers,
} from "../tabular.syncRun";

const REVIEW = "0b8f6f0e-6f7e-4b47-9a1a-6d1c2f9a0b01";
const USER = "5e0c2a8e-1b1a-4a51-8d0e-4b7f9c3b2a11";
const COLUMNS = [
    { index: 0, name: "A", prompt: "a" },
    { index: 1, name: "B", prompt: "b" },
];

function world(seed: { cells?: Row[]; review?: Row } = {}) {
    const tables: Record<string, Row[]> = {
        tabular_reviews: [
            {
                id: REVIEW,
                user_id: USER,
                columns_config: COLUMNS,
                updated_at: "2026-11-24T10:00:00.000Z",
                active_generation_id: null,
                generation_lease_expires_at: null,
                ...seed.review,
            },
        ],
        tabular_rows: ["r1", "r2", "r3"].map((id, i) => ({
            id,
            review_id: REVIEW,
            label: `Row ${i + 1}`,
            row_type: "document",
            document_id: `doc-${id}`,
            sort_index: i,
        })),
        tabular_cells: seed.cells ?? [],
        nativecluster_people: [{ nc_person: "p_ann", user_id: USER }],
        user_profiles: [{ user_id: USER, email: "ann@example.com" }],
    };
    const t = tableDb(tables);
    let clock = 0;
    const stamp = () => new Date(Date.parse("2026-11-24T11:00:00.000Z") + ++clock).toISOString();
    const review = () => tables.tabular_reviews[0];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
        const r = review();
        if (fn === "begin_tabular_review_generation") {
            if (r.active_generation_id && Date.parse(String(r.generation_lease_expires_at)) > Date.now())
                return { data: "running", error: null };
            if (r.updated_at !== args.expected_updated_at) return { data: "stale", error: null };
            Object.assign(r, {
                active_generation_id: args.target_generation_id,
                generation_lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
                updated_at: stamp(),
            });
            return { data: "started", error: null };
        }
        if (fn === "renew_tabular_review_generation")
            return { data: r.active_generation_id === args.target_generation_id ? true : null, error: null };
        if (fn === "finish_tabular_review_generation") {
            if (r.active_generation_id !== args.target_generation_id) return { data: null, error: null };
            Object.assign(r, { active_generation_id: null, generation_lease_expires_at: null, updated_at: stamp() });
            return { data: true, error: null };
        }
        return { data: null, error: null };
    };
    const db = { from: (t.db as unknown as { from: unknown }).from, rpc } as never;
    const cells = () =>
        Object.fromEntries(
            tables.tabular_cells.map((c) => [`${c.row_id}:${c.column_index}`, { status: c.status, stamped: !!c.generation_id }]),
        );
    return { db, tables, review, cells };
}

let data: string;
beforeEach(() => {
    data = mkdtempSync(path.join(tmpdir(), "mike-tabular-runs-"));
    vi.stubEnv("MIKE_NC_APP", "1");
    vi.stubEnv("NC_APP_DATA", data);
    model.asked.length = 0;
    model.hold.clear();
    model.heldAsked = null;
    resetTabularRunsForTests();
    resetStreamRunsForTests();
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
});

async function startRun(w: ReturnType<typeof world>) {
    const generationId = crypto.randomUUID();
    const claimed = await claimTabularGeneration(w.db, {
        reviewId: REVIEW,
        expectedUpdatedAt: String(w.review().updated_at),
        generationId,
    });
    expect(claimed.ok).toBe(true);
    const run = startStreamRun({ id: generationId, key: reviewRunKey(REVIEW), userId: USER, forcedStopFrames: REVIEW_RUN_FORCED_STOP_FRAMES })!;
    const frames: string[] = [];
    run.subscribe(1, { write: (chunk) => frames.push(chunk), end: () => {} });
    const done = runTabularGenerationSync({
        db: w.db,
        reviewId: REVIEW,
        userId: USER,
        userEmail: "ann@example.com",
        generationId,
        run,
        columns: COLUMNS,
        model: "m",
        apiKeys: {},
    });
    return { run, frames, done };
}

describe("a review's run, when the backend stops under it", () => {
    it("is handed over: its unfinished cells back to pending, its lease released, and a marker kept to resume it", async () => {
        const w = world();
        model.hold.add("Row 2");
        const asked = new Promise<void>((resolve) => (model.heldAsked = resolve));
        const { frames, done } = await startRun(w);
        await asked;
        expect(stopTabularRunsForShutdown()).toBe(1);
        expect(await done).toBe("handed_over");

        expect(w.cells()).toMatchObject({
            "r1:0": { status: "done" },
            "r1:1": { status: "done" },
            "r2:0": { status: "pending" },
            "r2:1": { status: "pending" },
        });
        expect(Object.values(w.cells()).filter((c) => c.status === "generating")).toEqual([]);
        expect(w.review().active_generation_id, "the lease is released at once").toBeNull();
        expect(tabularRunMarkers()).toEqual([expect.objectContaining({ reviewId: REVIEW, userId: USER, resumes: 0 })]);
        expect(frames.join(""), "no reader is told it was cancelled: it goes on at the next start").not.toContain("cancelled");
    });
});

describe("the next start", () => {
    function crashed() {
        // As a SIGKILL leaves it: the dead run's lease still live, one row
        // done, one mid-answer, one claimed and not begun.
        const w = world({
            review: { active_generation_id: "dead-gen", generation_lease_expires_at: new Date(Date.now() + 250_000).toISOString() },
            cells: [
                { id: "c10", review_id: REVIEW, row_id: "r1", column_index: 0, status: "done", content: '{"summary":"kept"}', generation_id: null },
                { id: "c11", review_id: REVIEW, row_id: "r1", column_index: 1, status: "done", content: '{"summary":"kept"}', generation_id: null },
                { id: "c20", review_id: REVIEW, row_id: "r2", column_index: 0, status: "generating", content: null, generation_id: "dead-gen" },
                { id: "c21", review_id: REVIEW, row_id: "r2", column_index: 1, status: "generating", content: null, generation_id: "dead-gen" },
                { id: "c30", review_id: REVIEW, row_id: "r3", column_index: 0, status: "pending", content: null, generation_id: "dead-gen" },
                { id: "c31", review_id: REVIEW, row_id: "r3", column_index: 1, status: "pending", content: null, generation_id: "dead-gen" },
            ],
        });
        mkdirSync(path.join(data, "state", "tabular-runs"), { recursive: true });
        writeFileSync(
            path.join(data, "state", "tabular-runs", `${REVIEW}.json`),
            JSON.stringify({ reviewId: REVIEW, userId: USER, generationId: "dead-gen", startedAt: "", resumes: 0 }),
        );
        return w;
    }

    it("lets go of the last start's leases and cells, so Run works at once", async () => {
        const w = crashed();
        const markers = await recoverTabularRuns(w.db);
        expect(markers).toEqual([expect.objectContaining({ reviewId: REVIEW, generationId: "dead-gen" })]);
        expect(w.review().active_generation_id).toBeNull();
        expect(Object.values(w.cells()).filter((c) => c.status === "generating" || c.stamped)).toEqual([]);
        expect(w.cells()).toMatchObject({ "r1:0": { status: "done" }, "r2:0": { status: "pending" }, "r3:1": { status: "pending" } });
        // Run, at once: no 409 review_running.
        const claimed = await claimTabularGeneration(w.db, {
            reviewId: REVIEW,
            expectedUpdatedAt: String(w.review().updated_at),
            generationId: crypto.randomUUID(),
        });
        expect(claimed).toEqual({ ok: true, data: null });
    });

    it("resumes the run as its person's background job: every cell fills, the done ones never asked again, none twice", async () => {
        const w = crashed();
        await resumeTabularRuns(w.db, await recoverTabularRuns(w.db));

        expect(Object.values(w.cells()).map((c) => c.status)).toEqual(Array(6).fill("done"));
        expect(w.tables.tabular_cells.filter((c) => c.row_id === "r1").map((c) => c.content)).toEqual(['{"summary":"kept"}', '{"summary":"kept"}']);
        const asked = model.asked.flatMap((a) => a.columns.map((c) => `${a.row}:${c}`)).sort();
        expect(asked).toEqual(["Row 2:0", "Row 2:1", "Row 3:0", "Row 3:1"]);
        for (const call of model.asked)
            expect(call.origin).toMatchObject({
                lane: "B",
                task: "tabular",
                job: true,
                person: "p_ann",
                ticket: { origin: "job", from: "resume", person: "p_ann" },
            });
        expect(w.review().active_generation_id).toBeNull();
        expect(tabularRunMarkers(), "nothing left to resume").toEqual([]);
    });

    it("does not resume a run the app died under twice, leaving it for Run", async () => {
        const w = crashed();
        writeFileSync(
            path.join(data, "state", "tabular-runs", `${REVIEW}.json`),
            JSON.stringify({ reviewId: REVIEW, userId: USER, generationId: "dead-gen", resumes: MAX_TABULAR_RUN_RESUMES }),
        );
        expect(await recoverTabularRuns(w.db)).toEqual([]);
        expect(readdirSync(path.join(data, "state", "tabular-runs"))).toEqual([]);
        expect(w.review().active_generation_id).toBeNull();
    });

    it("recovers nothing outside the app, where several backends may share the database", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        const w = crashed();
        expect(await recoverTabularRuns(w.db)).toEqual([]);
        expect(w.review().active_generation_id).toBe("dead-gen");
        expect(w.cells()["r2:0"]).toEqual({ status: "generating", stamped: true });
    });
});

// The robustness campaign's U1 and the models campaign's bug 3: a review ran
// on the main thread, outside the DB-job runner, and the host was never told:
// only a cell waiting in line kept Mike from looking idle.
describe("a review's run, to the host", () => {
    afterEach(() => setNcUnitsReporter(null));

    it("is one of the app's units from its first cell to its last", async () => {
        const posted: NcUnitsReport[] = [];
        setNcUnitsReporter(createNcUnitsReporter({ post: async (r) => void posted.push(r), queued: async () => ({ due: false }), recheckMs: 0 }));
        const w = world();
        model.hold.add("Row 2");
        const asked = new Promise<void>((resolve) => (model.heldAsked = resolve));
        const { run, done } = await startRun(w);
        await asked;
        expect(posted).toEqual([{ waiting: true }]);
        run.stop();
        await done;
        await vi.waitFor(() => expect(posted).toEqual([{ waiting: true }, { waiting: false }]));
    });
});

describe("a run that ends", () => {
    it("leaves nothing to resume once it is done", async () => {
        const w = world();
        const { done, frames } = await startRun(w);
        expect(await done).toBe("completed");
        expect(Object.values(w.cells()).map((c) => c.status)).toEqual(Array(6).fill("done"));
        expect(frames.join("")).toContain("[DONE]");
        expect(tabularRunMarkers()).toEqual([]);
        expect(w.review().active_generation_id).toBeNull();
    });

    it("leaves nothing to resume when its person stops it", async () => {
        const w = world();
        model.hold.add("Row 1");
        const asked = new Promise<void>((resolve) => (model.heldAsked = resolve));
        const { run, done, frames } = await startRun(w);
        await asked;
        expect(tabularRunMarkers()).toHaveLength(1);
        run.stop();
        expect(await done).toBe("stopped");
        expect(frames.join("")).toContain('"cancelled"');
        expect(tabularRunMarkers()).toEqual([]);
    });
});
