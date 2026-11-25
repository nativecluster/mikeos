// The parser as a worker thread: Mike as a NativeCluster app (MIKE_NC_APP=1),
// whose sandbox refuses every signal to a child. The thread must keep what
// the child gives: a hung parse is ended at its deadline, a parse that blows
// its memory ends only the thread, and the backend (this test process) lives
// on; with the same replies, recycling and failures as the child.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkerOptions } from "node:worker_threads";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  EXTRACTION_MAX_BYTES,
  ExtractionLimitError,
  ExtractionParseError,
  runIsolatedExtraction,
  stopExtractionProcess,
} from "../isolated";
import type { ExtractionOp } from "../ops";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { PDF_MAX_DECODED_STREAM_BYTES } from "../../pdfjs";
import { arrayBufferOf, bombPdf, nestedPdf, passwordPdf, textPdf } from "../../__tests__/hostilePdfs";
import { isPdfPasswordError } from "../../pdfText";

const threads = vi.hoisted(() => ({
  created: [] as Array<{ entry: string; options?: WorkerOptions; exited: Promise<number> }>,
  /** The next thread runs this file instead of thread.ts. */
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
      threads.created.push({ entry: String(chosen), options, exited });
    }
  }
  return { ...actual, Worker: RecordingWorker };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let fixtures: string;
const fixture = (name: string) => path.join(fixtures, name);

beforeAll(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "mike-parser-thread-"));
  // Parsers gone wrong, each in a thread as thread.ts would run.
  writeFileSync(fixture("hang.cjs"), `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => { for (;;) {} });
  `);
  writeFileSync(fixture("heap.cjs"), `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => {
      const kept = [];
      for (;;) kept.push({ at: kept.length, text: "clause " + kept.length });
    });
  `);
  writeFileSync(fixture("buffers.cjs"), `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", () => {
      const kept = [];
      for (;;) kept.push(Buffer.alloc(4 * 1024 * 1024, 1));
    });
  `);
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  threads.created.length = 0;
  threads.nextEntry = undefined;
  vi.stubEnv("EXTRACTION_ISOLATION", "on");
  vi.stubEnv("MIKE_NC_APP", "1");
});
afterEach(async () => { await stopExtractionProcess(); vi.unstubAllEnvs(); });

function workbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item", "Amount"], ["Rent", 1200]]), "Budget");
  return Uint8Array.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).buffer;
}

function onePagePdf(line = "Case No. 24CV-1234"): ArrayBuffer {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(pdf, "binary")).buffer;
}

async function docx(): Promise<ArrayBuffer> {
  const doc = new Document({ sections: [{ children: [new Paragraph("Synthetic lease clause 721"), new Paragraph("Rent is due monthly.")] }] });
  return Uint8Array.from(await Packer.toBuffer(doc)).buffer;
}

async function pptx(slideText: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", slideText);
  return Uint8Array.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })).buffer;
}

describe("the parser as a worker thread (MIKE_NC_APP=1)", () => {
  it("parses on a thread, with no child process and no signal", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("| 2 | Rent | 1200 |");
      await stopExtractionProcess();
      expect(spawn).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(threads.created).toHaveLength(1);
      expect(threads.created[0].entry).toMatch(/thread\.ts$/);
      // Ended by terminate(): the thread is gone.
      await expect(threads.created[0].exited).resolves.toBe(1);
    } finally {
      kill.mockRestore();
    }
  });

  it("gives the thread no credentials, and a memory budget from EXTRACTION_MAX_MEMORY_MB", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key-must-not-reach-parser");
    vi.stubEnv("NODE_OPTIONS", "--invalid-parser-option");
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "768");
    await expect(runIsolatedExtraction("pdfForModel", async () => onePagePdf())).resolves.toContain("24CV-1234");
    const options = threads.created[0].options!;
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.env).toMatchObject({ MIKE_NC_APP: "1" });
    expect(options.resourceLimits?.maxOldGenerationSizeMb).toBeGreaterThan(768);
  });

  // The same request and reply protocol as the child: every op answers the
  // same thing on both.
  it("returns exactly what the parser process returns", async () => {
    const sources: Array<[ExtractionOp, () => Promise<ArrayBuffer>, string?]> = [
      ["documentText", async () => onePagePdf(), "pdf"],
      ["documentText", docx, "docx"],
      ["documentMarkdown", async () => onePagePdf(), "pdf"],
      ["documentMarkdown", docx, "docx"],
      ["pdfForModel", async () => onePagePdf()],
      ["docxText", docx],
      ["rawText", docx],
      ["validateDocxPackage", docx],
      ["spreadsheet", async () => workbook()],
      ["presentation", () => pptx("<p:sld><a:t>Quarterly &amp; annual</a:t><a:t>Second</a:t></p:sld>")],
    ];
    const run = () => Promise.all(sources.map(([op, load, fileType]) => runIsolatedExtraction(op, load, { fileType })));
    const inThread = await run();
    await stopExtractionProcess();
    vi.stubEnv("MIKE_NC_APP", "");
    const inProcess = await run();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(inThread).toEqual(inProcess);
    expect(JSON.stringify(inThread)).toContain("Synthetic lease clause 721");
  });

  it("rebuilds a parser's typed failure, with its kind", async () => {
    const corrupt = Uint8Array.from(Buffer.from("%PDF-1.7\nnot really a pdf")).buffer;
    const error = await runIsolatedExtraction("documentText", async () => corrupt, { fileType: "pdf" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExtractionParseError);
    expect(diagnosticErrorTags(error)).toMatchObject({ error_kind: "extraction.pdf_parse_failed" });
    await expect(runIsolatedExtraction("documentText", async () => workbook(), { fileType: "exe" })).rejects.toThrow("document_text_unsupported_format");
  });

  it("terminates a parse that hangs, at its deadline, and recovers on a fresh thread", async () => {
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "1500");
    threads.nextEntry = fixture("hang.cjs");
    const started = Date.now();
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).rejects.toThrow("parser deadline exceeded");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(6000);
    // The busy loop never yields; terminate() ends it all the same.
    await expect(threads.created[0].exited).resolves.toBe(1);
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
    expect(threads.created).toHaveLength(2);
  });

  it.each([
    ["its heap", "heap.cjs"],
    ["buffers, which V8's heap limit does not count", "buffers.cjs"],
  ])("ends only the thread when a parse blows its memory budget with %s", async (_what, file) => {
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "96");
    threads.nextEntry = fixture(file);
    const error = await runIsolatedExtraction("spreadsheet", async () => workbook()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExtractionLimitError);
    expect(String(error)).toContain("parser memory budget exceeded");
    await expect(threads.created[0].exited).resolves.toBe(1);
    // This process, the backend's stand-in, lives on, and so does extraction.
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });

  it("stops a hostile file that inflates past the budget, then recovers", async () => {
    // A few hundred kilobytes that inflate to 64 MB of slide text, each run
    // of it a separate string for the parser to keep.
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "128");
    const bomb = await pptx(`<p:sld>${"<a:t>x</a:t>".repeat(64 * 1024 * 1024 / 12)}</p:sld>`);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    await expect(runIsolatedExtraction("presentation", async () => bomb)).rejects.toBeInstanceOf(ExtractionLimitError);
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });

  it("refuses a budget too small to load the parsers, then recovers", async () => {
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "16");
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).rejects.toBeInstanceOf(ExtractionLimitError);
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });

  it("reuses a warm thread and recycles it after 200 files", async () => {
    const source = workbook();
    for (let index = 0; index < 200; index++) {
      await expect(runIsolatedExtraction("spreadsheet", async () => source)).resolves.toContain("Rent");
    }
    expect(threads.created).toHaveLength(1);
    await expect(threads.created[0].exited).resolves.toBe(1);
    await expect(runIsolatedExtraction("spreadsheet", async () => source)).resolves.toContain("Rent");
    expect(threads.created).toHaveLength(2);
  });

  it("bounds the reply, and the source, as the child does", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", `<a:t>${"€".repeat(6 * 1024 * 1024)}</a:t>`);
    const compressed = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await expect(runIsolatedExtraction("presentation", async () => Uint8Array.from(compressed).buffer)).rejects.toBeInstanceOf(ExtractionLimitError);
    await expect(runIsolatedExtraction("spreadsheet", async () => new ArrayBuffer(EXTRACTION_MAX_BYTES + 1))).rejects.toBeInstanceOf(ExtractionLimitError);
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });

  // X1: pdf.js runs bounded inside the thread too, not only in-process: the
  // bomb is refused there as too large, and the thread reads on.
  it("refuses a PDF that inflates past its limit inside the thread, then reads the next one", async () => {
    const bomb = arrayBufferOf(await bombPdf(PDF_MAX_DECODED_STREAM_BYTES / (1024 * 1024) + 64));
    await expect(runIsolatedExtraction("pdfFacts", async () => bomb)).rejects.toBeInstanceOf(ExtractionLimitError);
    await expect(runIsolatedExtraction("pdfFacts", async () => arrayBufferOf(textPdf(2))))
      .resolves.toEqual({ text: "", pageCount: 2, textlessPageCount: 0 });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  }, 60_000);

  // D1: across the thread's port a PDF that cannot be read stays the bytes'
  // fault (no retry), and a locked one keeps pdf.js's PasswordException.
  it("brings an unreadable PDF's verdict back from the thread, the password kept", async () => {
    const nested = await runIsolatedExtraction("pdfFacts", async () => arrayBufferOf(nestedPdf())).catch((caught: unknown) => caught);
    expect(nested).toBeInstanceOf(ExtractionParseError);
    expect(isPdfPasswordError(nested)).toBe(false);
    const locked = await runIsolatedExtraction("pdfFacts", async () => arrayBufferOf(passwordPdf())).catch((caught: unknown) => caught);
    expect(locked).toBeInstanceOf(ExtractionParseError);
    expect(isPdfPasswordError(locked)).toBe(true);
  }, 30_000);

  // As a child whose parsers fail to load exits without a result.
  it("reports a thread that ended without a reply as the child's exit, and starts the next one", async () => {
    threads.nextEntry = fixture("missing.cjs");
    const error = await runIsolatedExtraction("spreadsheet", async () => workbook()).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ExtractionParseError);
    expect(error).not.toBeInstanceOf(ExtractionLimitError);
    expect(diagnosticErrorTags(error)).toMatchObject({ error_kind: "extraction.process_exited" });
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });
});
