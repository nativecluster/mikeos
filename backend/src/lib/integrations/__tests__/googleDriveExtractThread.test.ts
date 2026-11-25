// Drive's file reader in Mike's NativeCluster app (MIKE_NC_APP=1), whose
// sandbox refuses every signal to a child: it reads in a worker thread,
// which terminate() ends, at its deadline or past its memory, with no signal.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import type { WorkerOptions } from "node:worker_threads";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGoogleDriveBinary } from "../googleDriveExtract";

const threads = vi.hoisted(() => ({
    created: [] as Array<{ options?: WorkerOptions; exited: Promise<number> }>,
    nextEntry: undefined as string | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:worker_threads")>();
    class RecordingWorker extends actual.Worker {
        constructor(entry: string | URL, options?: WorkerOptions) {
            const chosen = threads.nextEntry ?? entry;
            threads.nextEntry = undefined;
            super(chosen, options);
            const exited = new Promise<number>((resolve) => this.once("exit", resolve));
            threads.created.push({ options, exited });
        }
    }
    return { ...actual, Worker: RecordingWorker };
});
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, fork: vi.fn(actual.fork) };
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let fixtures: string;
const directories: string[] = [];
async function file(bytes: Buffer) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "drive-thread-test-"));
    directories.push(directory);
    const filename = path.join(directory, "file");
    await writeFile(filename, bytes);
    return filename;
}

beforeAll(() => {
    fixtures = mkdtempSync(path.join(os.tmpdir(), "drive-thread-fixtures-"));
    writeFileSync(path.join(fixtures, "hang.cjs"), `
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => { for (;;) {} });
    `);
    writeFileSync(path.join(fixtures, "heap.cjs"), `
        const { parentPort } = require("node:worker_threads");
        parentPort.once("message", () => {
            const kept = [];
            for (;;) kept.push({ at: kept.length, text: "row " + kept.length });
        });
    `);
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
beforeEach(() => {
    threads.created.length = 0;
    threads.nextEntry = undefined;
    vi.mocked(fork).mockClear();
    vi.stubEnv("MIKE_NC_APP", "1");
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Drive's file reader in Mike's NativeCluster app", () => {
    it("reads a real DOCX and PDF in a thread, with no child and no signal", async () => {
        vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "never-send-to-parser");
        const kill = vi.spyOn(process, "kill");
        try {
            const doc = new Document({ sections: [{ children: [new Paragraph("MIKE434 liability cap USD 43,210")] }] });
            await expect(extractGoogleDriveBinary(await file(await Packer.toBuffer(doc)), DOCX)).resolves.toContain("USD 43,210");
            const content = "BT /F1 12 Tf 72 720 Td (MIKE434 payment 17 days) Tj ET";
            const objects = [
                "<< /Type /Catalog /Pages 2 0 R >>",
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
                `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            ];
            let pdf = "%PDF-1.7\n";
            const offsets: number[] = [];
            objects.forEach((object, i) => {
                offsets.push(Buffer.byteLength(pdf));
                pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
            });
            const xref = Buffer.byteLength(pdf);
            pdf += `xref\n0 6\n0000000000 65535 f \n`;
            for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
            pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
            await expect(extractGoogleDriveBinary(await file(Buffer.from(pdf)), "application/pdf")).resolves.toContain("payment 17 days");
            expect(fork).not.toHaveBeenCalled();
            expect(kill).not.toHaveBeenCalled();
            expect(threads.created).toHaveLength(2);
            // Each thread is gone once its file is read.
            for (const thread of threads.created) await thread.exited;
            expect(JSON.stringify(threads.created[0].options)).not.toContain("never-send-to-parser");
        } finally {
            kill.mockRestore();
        }
    });

    it("still refuses a DOCX that expands past its budget", async () => {
        vi.stubEnv("GOOGLE_DRIVE_DOCX_EXPANDED_MB", "1");
        const zip = new JSZip();
        zip.file("word/document.xml", "x".repeat(2 * 1024 * 1024));
        const filename = await file(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
        await expect(extractGoogleDriveBinary(filename, DOCX)).rejects.toThrow(/processing limits/);
    });

    it("terminates a read that hangs, at its deadline", async () => {
        vi.stubEnv("GOOGLE_DRIVE_PARSE_TIMEOUT_SECONDS", "1");
        threads.nextEntry = path.join(fixtures, "hang.cjs");
        const started = Date.now();
        await expect(extractGoogleDriveBinary("/nonexistent", "application/pdf")).rejects.toThrow(/processing limits/);
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        await expect(threads.created[0].exited).resolves.toBe(1);
    });

    it("ends only the thread when a read blows its memory", async () => {
        vi.stubEnv("GOOGLE_DRIVE_PARSER_HEAP_MB", "32");
        vi.stubEnv("GOOGLE_DRIVE_MAX_FILE_MB", "8");
        vi.stubEnv("GOOGLE_DRIVE_DOCX_EXPANDED_MB", "16");
        threads.nextEntry = path.join(fixtures, "heap.cjs");
        await expect(extractGoogleDriveBinary("/nonexistent", "application/pdf")).rejects.toThrow(/processing limits/);
        await expect(threads.created[0].exited).resolves.toBe(1);
        // This process, the backend's stand-in, lives on, and reads on.
        vi.unstubAllEnvs();
        vi.stubEnv("MIKE_NC_APP", "1");
        const doc = new Document({ sections: [{ children: [new Paragraph("MIKE434 still reading")] }] });
        await expect(extractGoogleDriveBinary(await file(await Packer.toBuffer(doc)), DOCX)).resolves.toContain("still reading");
    });
});
