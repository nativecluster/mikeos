/**
 * Documents parsed in the app. Mike parses untrusted files apart from the
 * backend; in NativeCluster's sandbox (run-all's step 4) a process may signal
 * only itself, so a parser child could never be stopped, and a refused kill
 * once overflowed the jobs thread's stack ("RangeError: Maximum call stack
 * size exceeded", Pablo's install, 2026-11-24). In the app the parsers are
 * worker threads. A PDF and a DOCX uploaded through the door are checked by
 * the uploads thread's parser, indexed by the jobs thread's, and found by
 * the assistant's find_documents; no parser child runs; and once the parsers
 * have shut down for being idle, the backend's log shows no RangeError and no
 * worker thread that died.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../shim/fixtures";
import { PDF_FIXTURE } from "../../../../e2e/helpers";
import { createProject } from "../lib/projects";
import { door, expectLineSettled } from "../lib/door";

const DOCX_FIXTURE = path.resolve(__dirname, "../../../../frontend/public/preset-templates/Common Paper/Letter of Intent.docx");
/** The fake host's chat model (fakehost/models.mjs), as Mike names it. */
const FAKE_MODEL = "nativecluster/fake:harness";
const PDF_PHRASE = "Test PDF Document";
const DOCX_PHRASE = "non-binding letter of intent";

type DocSearch = {
    type: "doc_search";
    query: string;
    match_count?: number;
    error_code?: string;
    coverage?: { total_versions: number; indexed_versions: number; pending_versions: number; failed_versions: number };
};

test.beforeAll(async () => {
    const s = await door.state();
    test.skip(s.models !== "fake", "the search is steered on the fake models (run with --models fake)");
});

/** The backend's log, every rotated file of it. */
async function backendLog(): Promise<string> {
    const { data } = (await door.state()) as unknown as { data: string };
    const dir = path.join(data, "logs");
    return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("backend"))
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
        .join("\n");
}

/**
 * One find_documents call, in a new chat of the project, as its event says.
 * Through the API, whose answer Playwright reads whole once the turn ends
 * (a page's own event stream it cannot read back).
 */
async function findInProject(page: Page, projectId: string, query: string): Promise<DocSearch | undefined> {
    const r = await page.request.post(`/api/projects/${projectId}/chat`, {
        headers: { Accept: "text/event-stream" },
        data: {
            model: FAKE_MODEL,
            messages: [{ role: "user", content: `[[fake:tool find_documents {"scope":"project","query":"${query}"}]]` }],
        },
        timeout: 120_000,
    });
    const body = await r.text();
    expect(r.status(), `the project chat's answer: ${body.slice(0, 300)}`).toBe(200);
    return body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => {
            try {
                return JSON.parse(line.slice(6)) as { type?: string };
            } catch {
                return {};
            }
        })
        .find((event): event is DocSearch => event.type === "doc_search");
}

/** Asks until the project's index has nothing pending, then answers as find_documents last did. */
async function indexedSearch(page: Page, projectId: string, query: string): Promise<DocSearch | undefined> {
    const deadline = Date.now() + 180_000;
    for (;;) {
        const search = await findInProject(page, projectId, query);
        if ((search?.coverage && search.coverage.pending_versions === 0) || Date.now() > deadline) return search;
        await page.waitForTimeout(3_000);
    }
}

async function newProject(page: Page, name: string, files: string[]): Promise<string> {
    await createProject(page, name, files);
    const projectUrl = page.url().split("?")[0];
    // The uploads finished: each DOCX's package check ran in the uploads
    // thread's parser, and the project lists every file.
    await page.goto(projectUrl);
    for (const file of files) await expect(page.getByText(path.basename(file)).first()).toBeVisible({ timeout: 60_000 });
    return new URL(projectUrl).pathname.split("/").filter(Boolean)[1];
}

test("a PDF and a DOCX are parsed in the app's parser threads, and nothing crashes", async ({ page }) => {
    test.setTimeout(420_000);
    const projectId = await newProject(page, `Parsed in a thread ${Date.now()}`, [PDF_FIXTURE, DOCX_FIXTURE]);
    // The search index: each file's text extracted by the jobs thread's parser.
    const search = await indexedSearch(page, projectId, PDF_PHRASE);
    expect(search?.coverage, "the project's search coverage").toMatchObject({ total_versions: 2, indexed_versions: 2, pending_versions: 0, failed_versions: 0 });
    expect(search?.match_count, `"${PDF_PHRASE}" found in the PDF's extracted text`).toBeGreaterThan(0);
    const inDocx = await findInProject(page, projectId, DOCX_PHRASE);
    expect(inDocx?.match_count, `"${DOCX_PHRASE}" found in the DOCX's extracted text`).toBeGreaterThan(0);
    await expectLineSettled();

    // No parser child process: the parsers are threads of the backend.
    const pkg = process.env.HARNESS_PKG;
    if (pkg) {
        const parserChild = path.join(fs.realpathSync(pkg), "backend", "dist", "lib", "extraction", "process.js");
        const ps = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
        expect.soft(ps.split("\n").filter((line) => line.includes(parserChild)), "parser child processes").toEqual([]);
    }

    // The parsers rest, then shut down when idle for IDLE_SHUTDOWN_MS (60 s,
    // backend/src/lib/extraction/isolated.ts): where a refused kill used to
    // recurse. Waited out, so that shutdown happens inside this test.
    await page.waitForTimeout(65_000);

    // And nothing died on the way: no stack overflow, no RangeError, no
    // worker thread's error or exit (index.ts logs each, then respawns it).
    const log = await backendLog();
    expect.soft(log, "the backend's log").not.toContain("RangeError");
    expect.soft(log, "the backend's log").not.toContain("Maximum call stack size exceeded");
    expect.soft(log.split("\n").filter((line) => /\[worker-thread:[^\]]+\] (error|exited with code)/.test(line)), "worker threads that died").toEqual([]);

    // New parsers start after that shutdown: another DOCX is checked and indexed.
    const after = await newProject(page, `Parsed after the parsers rested ${Date.now()}`, [DOCX_FIXTURE]);
    const again = await indexedSearch(page, after, DOCX_PHRASE);
    expect(again?.coverage, "the second project's search coverage").toMatchObject({ total_versions: 1, indexed_versions: 1, failed_versions: 0 });
    expect(again?.match_count, `"${DOCX_PHRASE}" found after the parsers' idle shutdown`).toBeGreaterThan(0);
    expect.soft((await backendLog()).split("\n").filter((line) => /RangeError|\[worker-thread:[^\]]+\] (error|exited with code)/.test(line)), "the backend's log, after").toEqual([]);
});
