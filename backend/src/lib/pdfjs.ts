// Minimal typed facade over the slice of `pdfjs-dist` we actually use, and
// the one way the backend loads it: bounded.
//
// We import the library's legacy ESM build via a dynamic `import()` whose
// specifier is cast to `string` so it resolves at runtime (the legacy build
// ships no usable type declarations). Rather than repeat an
// `as unknown as { getDocument: ... }` shape at every call site, we declare
// the surface once here and load through `loadPdfjs()`.
//
// Bounded: a PDF's streams are compressed, and one small file can name a
// stream that inflates to gigabytes (a 1.9 MB PDF whose one content stream
// inflates to 1.9 GiB took the backend to 4.7-6.6 GB). pdf.js has no option
// that limits a decoded stream, and no sampling can stop one allocation that
// large between two samples. So the pdf.js worker module (which in Node runs
// in the calling thread, as pdf.js's "fake worker") is loaded from its own
// source with a check before each place it grows a decoded stream's buffer:
// DecodeStream.ensureBuffer, which every decoder in the JS path goes
// through (Flate, LZW, ASCII85/Hex, RunLength, predictors, decryption, a
// page's sequence of content streams), and the native DecompressionStream
// path that Flate and Brotli streams take first. A stream that would pass
// PDF_MAX_DECODED_STREAM_BYTES fails before its buffer is allocated, and the
// document it belongs to is refused as too large (see runWithPdfBudget).
// Each patch must match the installed pdf.js exactly once, or pdf.js is not
// loaded at all: an upgrade that moves them fails closed, and pdfjs.test.ts
// fails with it.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "./appError";

export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export interface PdfTextContent {
  items: PdfTextItem[];
}

export interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export interface PdfDocumentTask {
  promise: Promise<PdfDocument>;
  destroy?: () => Promise<void>;
}

export interface PdfjsLib {
  getDocument(opts: {
    data: Uint8Array;
    standardFontDataUrl?: string;
    maxImageSize?: number;
  }): PdfDocumentTask;
}

/**
 * The most bytes one stream of a PDF may decode to. Real content streams are
 * kilobytes to a few megabytes, font programs tens of megabytes at most; the
 * decoded buffer grows in powers of two, so a stream at this size holds at
 * most twice it while it grows, well inside the parser's 1 GB budget.
 */
export const PDF_MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;
/** pdf.js's own image limit (width x height): 8192 x 8192. Text reading
 * decodes no image; this stops one if a call ever does. */
export const PDF_MAX_IMAGE_PIXELS = 2 ** 26;

/** A decoded stream refused for its size; the document is too large to read. */
export class PdfDecodeLimitError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`a PDF stream decodes past ${limit} bytes`);
    this.name = "PdfDecodeLimitError";
  }
}

/** One document's decode budget; `exceeded` is set once a stream passes it. */
export type PdfDecodeBudget = { maxStreamBytes: number; exceeded: number | null };

const HOOK_KEY = "mike.pdfjs.decodedBytes";
const HOOK_CALL = `globalThis[Symbol.for(${JSON.stringify(HOOK_KEY)})]?.`;

/**
 * Where the worker module is changed: each anchor must occur exactly once.
 * The hook throws when a stream would pass its document's budget, so the
 * allocation that follows never happens.
 */
const WORKER_PATCHES: ReadonlyArray<{ anchor: string; patched: string }> = [
  {
    // DecodeStream.ensureBuffer: the new buffer's size is known, not yet allocated.
    anchor: "    const buffer2 = new Uint8Array(size);\n",
    patched: `    ${HOOK_CALL}(size);\n    const buffer2 = new Uint8Array(size);\n`,
  },
  {
    // asyncGetBytesFromDecompressionStream: every chunk the native inflater
    // hands back, before it is kept. Its catch falls back to the JS decoder,
    // whose first allocation then fails as well: the budget stays exceeded.
    anchor: "        totalLength += chunk.byteLength;\n",
    patched: `        totalLength += chunk.byteLength;\n        ${HOOK_CALL}(totalLength);\n`,
  },
];

/** pdf.js's worker source with the decode checks in; throws if one does not fit. */
export function boundedWorkerSource(source: string): string {
  let out = source;
  for (const { anchor, patched } of WORKER_PATCHES) {
    const first = out.indexOf(anchor);
    if (first === -1 || out.indexOf(anchor, first + anchor.length) !== -1) {
      throw new AppError("extraction.failed", "pdf.js could not be bounded: its worker source changed");
    }
    out = out.slice(0, first) + patched + out.slice(first + anchor.length);
  }
  return out;
}

type ThreadState = {
  budgets: AsyncLocalStorage<PdfDecodeBudget>;
  handler?: unknown;
  installing?: Promise<unknown>;
};

// Per thread, on globalThis: pdf.js (and the hook it calls) is one per
// thread, while this module may be evaluated more than once in a thread
// (test runners re-evaluate modules per file).
const STATE_KEY = Symbol.for("mike.pdfjs.state");

function threadState(): ThreadState {
  const g = globalThis as unknown as Record<symbol, ThreadState | undefined>;
  return (g[STATE_KEY] ??= { budgets: new AsyncLocalStorage<PdfDecodeBudget>() });
}

function checkDecodedBytes(bytes: number): void {
  const budget = threadState().budgets.getStore();
  const limit = budget?.maxStreamBytes ?? PDF_MAX_DECODED_STREAM_BYTES;
  if (bytes <= limit && (budget?.exceeded ?? null) === null) return;
  if (budget) budget.exceeded ??= bytes;
  throw new PdfDecodeLimitError(bytes, limit);
}

/**
 * Evaluate the bounded worker as the ES module it is: written to a file of
 * this thread's own in the temporary folder (in the app, inside its data
 * folder), loaded with Node's own require (which loads an ES module with no
 * top-level await, as pdf.js's worker is, past any bundler or test
 * transform), then removed: the module stays loaded.
 */
function loadModuleSource(source: string): Record<string, unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "mike-pdfjs-"));
  const file = path.join(dir, "pdf.worker.bounded.mjs");
  try {
    writeFileSync(file, source, { mode: 0o600 });
    // Not a source dependency (the scanner's rule for require): pdf.js's
    // own worker, rewritten above, loaded once per thread.
    return createRequire(__filename)(file) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function installBoundedWorker(): Promise<unknown> {
  const state = threadState();
  if (state.handler) return state.handler;
  state.installing ??= (async () => {
    const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const source = boundedWorkerSource(readFileSync(workerPath, "utf8"));
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(HOOK_KEY)] = checkDecodedBytes;
    const worker = loadModuleSource(source);
    if (typeof worker.WorkerMessageHandler !== "function") {
      throw new AppError("extraction.failed", "pdf.js could not be bounded: no WorkerMessageHandler");
    }
    // pdf.js's main thread takes this in place of loading its own worker.
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    state.handler = worker.WorkerMessageHandler;
    return state.handler;
  })();
  try {
    return await state.installing;
  } finally {
    // A failed install is tried again by the next load, never kept.
    state.installing = undefined;
  }
}

/**
 * Load the pdfjs legacy build, typed as the {@link PdfjsLib} facade, with
 * the bounded worker in place in this thread.
 *
 * The specifier is cast to `string` so TypeScript treats it as a dynamic
 * runtime import (the legacy `.mjs` build has no bundled types); the awaited
 * module is therefore `any`, which we narrow to the facade here in one place.
 */
export async function loadPdfjs(): Promise<PdfjsLib> {
  const handler = await installBoundedWorker();
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  // pdf.js keeps the worker it set up first in a thread for good: if
  // anything loaded it before the bounded worker was in place, refuse.
  // (A test's stand-in for pdf.js has no PDFWorker, and may throw on the read.)
  let worker: { _setupFakeWorkerGlobal?: Promise<unknown> } | undefined;
  try {
    worker = (mod as { PDFWorker?: { _setupFakeWorkerGlobal?: Promise<unknown> } }).PDFWorker;
  } catch {
    worker = undefined;
  }
  if (worker && (await worker._setupFakeWorkerGlobal) !== handler) {
    throw new AppError("extraction.failed", "pdf.js was loaded without its bounds in this thread");
  }
  return mod as PdfjsLib;
}

/**
 * Run one document's pdf.js work under a decode budget. Every allocation of
 * a decoded stream inside `work` (pdf.js's worker side follows the caller's
 * async context) is checked against it. pdf.js swallows most errors while it
 * reads a page (its text is then cut short), so callers check
 * `budget.exceeded` after each step rather than rely on the error.
 */
export function runWithPdfBudget<T>(
  work: (budget: PdfDecodeBudget) => Promise<T>,
  maxStreamBytes = PDF_MAX_DECODED_STREAM_BYTES,
): Promise<T> {
  const budget: PdfDecodeBudget = { maxStreamBytes, exceeded: null };
  return threadState().budgets.run(budget, () => work(budget));
}
