// X1 (robustness campaign, 2026-11-24): a 1.9 MB PDF whose one content
// stream inflates to 1.9 GiB took the backend to 4.7-6.6 GB and kept 3.5 GB
// afterwards, and ten pages drawing that stream held an upload for 140 s.
// Every PDF read is now bounded where pdf.js allocates: a stream that would
// decode past PDF_MAX_DECODED_STREAM_BYTES is refused before its buffer
// exists, a page tree past PDF_MAX_PAGES is not walked, and a read has a
// time budget. Each ends as ExtractionLimitError, never as an empty text.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractionLimitError, PDF_MAX_PAGES } from "../extraction/limits";
import { boundedWorkerSource, PDF_MAX_DECODED_STREAM_BYTES } from "../pdfjs";
import { extractPdfText, extractPdfTextForModel, readPdfFacts } from "../pdfText";
import { arrayBufferOf, bombPdf, claimsPagesPdf, textPdf } from "./hostilePdfs";

const MiB = 1024 * 1024;

/** Runs `work`, sampling how far the process's array buffers rise above where they began. */
async function arrayBufferRise<T>(work: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; riseMiB: number }> {
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
  const [result] = await Promise.allSettled([work()]);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  return { result, riseMiB: (peak - base) / MiB };
}

afterEach(() => vi.unstubAllEnvs());

describe("X1: every PDF read is bounded", () => {
  it("fits pdf.js's worker exactly, and refuses a worker it does not fit", () => {
    const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const source = readFileSync(workerPath, "utf8");
    const bounded = boundedWorkerSource(source);
    expect(bounded.match(/Symbol\.for\("mike\.pdfjs\.decodedBytes"\)/g)).toHaveLength(2);
    // An upgrade that moves the places it allocates fails closed, never unbounded.
    expect(() => boundedWorkerSource(source.replace("const buffer2 = new Uint8Array(size);", "const b2 = new Uint8Array(size);")))
      .toThrow(/could not be bounded/);
  });

  it("refuses a PDF whose one stream inflates past the limit, without ever holding it", async () => {
    const bomb = arrayBufferOf(await bombPdf(PDF_MAX_DECODED_STREAM_BYTES / MiB + 64));
    const started = Date.now();
    const { result, riseMiB } = await arrayBufferRise(() => readPdfFacts(bomb));
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ExtractionLimitError);
    // Unbounded, pdf.js gathered all 192 MiB and then copied it into one
    // buffer (384 MiB at once); bounded, it stops at the 128 MiB limit.
    expect(riseMiB).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The lenient readers never turn it into an empty text either.
    await expect(extractPdfText(bomb)).rejects.toBeInstanceOf(ExtractionLimitError);
    await expect(extractPdfTextForModel(bomb)).rejects.toBeInstanceOf(ExtractionLimitError);
  }, 60_000);

  it("refuses ten pages drawing one such stream once, not inflating it ten times", async () => {
    const bomb = arrayBufferOf(await bombPdf(PDF_MAX_DECODED_STREAM_BYTES / MiB + 64, 10));
    const started = Date.now();
    await expect(readPdfFacts(bomb)).rejects.toBeInstanceOf(ExtractionLimitError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("still reads a stream just under the limit in full", async () => {
    const big = arrayBufferOf(await bombPdf(48));
    await expect(extractPdfText(big)).resolves.toContain("Harness PDF bomb first line");
  }, 60_000);

  it("does not read a PDF of more pages than it may have, page by page", async () => {
    const many = arrayBufferOf(textPdf(PDF_MAX_PAGES + 1));
    const started = Date.now();
    await expect(readPdfFacts(many)).rejects.toThrow(/more than 10000 pages/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A page tree that only says so is pdf.js's to correct: one real page.
    await expect(readPdfFacts(arrayBufferOf(claimsPagesPdf(2_000_000)))).resolves.toMatchObject({ pageCount: 1 });
  }, 30_000);

  it("ends a read that outlasts its time budget as too large", async () => {
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "1000"); // a budget of one second
    const long = arrayBufferOf(textPdf(9_000));
    const started = Date.now();
    await expect(readPdfFacts(long)).rejects.toThrow(/time budget/);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 60_000);

  it("reads an ordinary PDF as before: its pages, and none empty", async () => {
    await expect(readPdfFacts(arrayBufferOf(textPdf(3)))).resolves.toEqual({ text: "", pageCount: 3, textlessPageCount: 0 });
    await expect(extractPdfText(arrayBufferOf(textPdf(2)))).resolves.toBe(
      "[Page 1]\nHarness page 1 of 2\n\n[Page 2]\nHarness page 2 of 2",
    );
  });
});
