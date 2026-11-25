import path from "path";

export const STANDARD_FONT_DATA_URL = (() => {
  try {
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

import { AppError } from "./appError";
import { docxToPdf } from "./convert";
import { ExtractionParseError } from "./extraction/failure";
import {
  ExtractionLimitError,
  isAllocationFailure,
  PDF_MAX_PAGES,
  pdfReadBudgetMs,
} from "./extraction/limits";
import { legacyTextByTextutil, readLegacyTextWithTextutil } from "./extraction/textutil";
import { loadPdfjs, PDF_MAX_IMAGE_PIXELS, runWithPdfBudget } from "./pdfjs";
import { orderTextItemLines } from "./pdfTextOrder";

/** The message of a PDF pdf.js could not read (extraction/failure.ts knows it as the bytes' fault). */
export const PDF_UNREADABLE_MESSAGE = "pdf_unreadable";

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type PdfFormAnnotation = {
  fieldName?: unknown;
  fieldValue?: unknown;
  password?: boolean;
  fieldFlags?: unknown;
  radioButton?: boolean;
  buttonValue?: unknown;
  rect?: unknown;
};

type ExtractedFormField = {
  text: string;
  rect: [number, number, number, number] | null;
};

// PDF field flags are one-based in the specification; bit 14 marks a text
// field whose value must not be exposed as ordinary document text.
const PDF_FIELD_FLAG_PASSWORD = 1 << 13;

function formValueText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.replaceAll(/\s+/g, " ").trim();
    return text || null;
  }
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  ) {
    const entries = value
      .map((entry) => entry.replaceAll(/\s+/g, " ").trim())
      .filter(Boolean);
    return entries.length ? entries.join(", ") : null;
  }
  return null;
}

function formFieldRect(rect: unknown): [number, number, number, number] | null {
  if (
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }
  const [rawX1, rawY1, rawX2, rawY2] = rect as number[];
  const x1 = Math.min(rawX1, rawX2);
  const y1 = Math.min(rawY1, rawY2);
  const x2 = Math.max(rawX1, rawX2);
  const y2 = Math.max(rawY1, rawY2);
  return x1 === x2 || y1 === y2 ? null : [x1, y1, x2, y2];
}

function extractFormFields(
  annotations: PdfFormAnnotation[],
): ExtractedFormField[] {
  const fields: ExtractedFormField[] = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    const fieldName =
      typeof annotation.fieldName === "string"
        ? annotation.fieldName.trim()
        : "";
    const isPassword =
      annotation.password === true ||
      (typeof annotation.fieldFlags === "number" &&
        (annotation.fieldFlags & PDF_FIELD_FLAG_PASSWORD) !== 0);
    if (!fieldName || isPassword) continue;

    // Every widget in a radio group carries the group's selected fieldValue.
    // Only the widget representing that selected value should be emitted.
    if (
      annotation.radioButton === true &&
      (typeof annotation.fieldValue !== "string" ||
        annotation.buttonValue !== annotation.fieldValue)
    ) {
      continue;
    }

    const fieldValue = formValueText(annotation.fieldValue);
    if (fieldValue === null) continue;

    const key = JSON.stringify([fieldName, fieldValue]);
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({
      text: `${fieldName}: ${fieldValue}`,
      rect: formFieldRect(annotation.rect),
    });
  }

  return fields;
}

function positionedFormItem(field: ExtractedFormField): PdfTextItem | null {
  if (!field.rect) return null;
  const [x1, y1, , y2] = field.rect;
  const height = Math.max(8, Math.min(16, (y2 - y1) * 0.7));
  const text = `[${field.text}]`;
  return {
    str: text,
    transform: [1, 0, 0, height, x1, (y1 + y2) / 2],
    width: text.length * height * 0.5,
    height,
  };
}

/**
 * Rebuild a page's text from positioned pdfjs items, preserving the visual
 * layout: lines are reconstructed from y-coordinates, words
 * are joined (or split) based on measured x-gaps rather than a blanket
 * space, paragraph breaks become blank lines, and indentation is kept
 * relative to the page's left margin.
 */
function layoutPageText(items: PdfTextItem[]): string {
  type Item = {
    str: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const clean: Item[] = [];
  for (const it of items) {
    const str = it.str ?? "";
    if (!str) continue;
    const t = Array.isArray(it.transform) ? it.transform : [];
    clean.push({
      str,
      x: typeof t[4] === "number" ? t[4] : 0,
      y: typeof t[5] === "number" ? t[5] : 0,
      w: typeof it.width === "number" ? it.width : 0,
      h:
        Math.abs(typeof t[3] === "number" ? t[3] : 0) ||
        (typeof it.height === "number" ? it.height : 0) ||
        10,
    });
  }
  if (!clean.length) return "";

  const lines: Item[][] = orderTextItemLines(clean).map((line) =>
    line.map((index) => clean[index]),
  );

  const marginX = Math.min(...lines.map((line) => line[0]?.x ?? 0));

  const out: string[] = [];
  let prevY: number | null = null;
  let prevLineH: number | null = null;
  for (const line of lines) {
    const lineH = Math.max(...line.map((c) => c.h));

    // Paragraph break: a vertical gap well above the line height.
    if (prevY !== null && prevLineH !== null) {
      const vGap = Math.abs((line[0]?.y ?? 0) - prevY);
      if (vGap > prevLineH * 1.7) out.push("");
    }

    // Indentation relative to the page's left margin.
    const charW = Math.max(1, lineH * 0.5);
    const indent = Math.min(
      24,
      Math.max(0, Math.round(((line[0]?.x ?? 0) - marginX) / charW)),
    );

    let s = "";
    let prevEnd: number | null = null;
    for (const it of line) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        // Only insert a space for a real word gap — small kerning gaps
        // (e.g. "constitut" + "e") are joined without one.
        if (gap > lineH * 2.5) {
          // Preserve obvious columns (signature blocks and simple tables)
          // without exaggerating ordinary word spacing in justified text.
          s += " ".repeat(Math.min(16, Math.max(4, Math.round(gap / charW))));
        } else if (gap > lineH * 0.15) {
          // Common spaces are about 0.25em; leave room below that while
          // keeping zero/tiny kerning gaps joined.
          s += " ";
        }
      }
      s += it.str;
      prevEnd = it.x + it.w;
    }
    const trimmed = s.trimEnd();
    if (trimmed) out.push(" ".repeat(indent) + trimmed);
    prevY = line[0]?.y ?? prevY;
    prevLineH = lineH;
  }
  return out.join("\n");
}

type PdfLoadingTask = {
  promise: Promise<{
    numPages: number;
    getPage: (n: number) => Promise<{
      getTextContent: () => Promise<{
        items: PdfTextItem[];
      }>;
      getAnnotations: () => Promise<PdfFormAnnotation[]>;
    }>;
  }>;
  destroy?: () => Promise<void>;
};

type PdfPageText = {
  /** The page's section of extractPdfText output, "[Page N]" marker included. */
  text: string;
  /** No text layer and no form field values: nothing the model could read. */
  empty: boolean;
};

type PdfReadResult =
  | { pages: PdfPageText[] }
  /**
   * pdf.js rejected the bytes, or could not be loaded; `cause` is its error,
   * for the one report. `stage` says which: "load" (pdf.js itself, never the
   * bytes), "open" (getDocument: corrupt, encrypted, not a PDF) or "page"
   * (it opened, then a page failed; `raw` is pdf.js's own error, unwrapped).
   */
  | { pages: null; cause: unknown; stage: "load" | "open" | "page"; raw: unknown };

/**
 * The warning for a PDF pdf.js could not open, filed by the callers that
 * swallow the failure (an empty string or a null count is their contract).
 * Without it a corrupt or encrypted PDF was indistinguishable from a blank
 * one: readPdfPages returned null and nothing anywhere recorded why. The
 * strict index path throws instead, so its job runner reports it.
 */
function reportUnreadablePdf(cause: unknown): void {
  // Logged, not reported: an unreadable PDF is the user's file (encrypted,
  // truncated), and the strict index path throws once per document with
  // the kind, which its job reports. Reporting here filed the same file on
  // every lenient read, upload count, row and regenerate.
  // console.warn, not the central logger, which would forward it with SENTRY_LOGS=on.
  console.warn("[pdf-text] pdf.js could not read the document", {
    error: new AppError("extraction.pdf_parse_failed", "pdf.js could not read the document", { cause }),
  });
}

/**
 * Read every page of a PDF, or the failure when pdfjs cannot open it. Whether
 * a page is empty is decided here, from the extracted items, rather than by
 * parsing the joined text afterwards: a PDF line that happens to read
 * "[Page 2]" is content, not a page boundary.
 *
 * Bounded wherever it runs (the parser thread, or in-process): pdf.js is the
 * bounded build (lib/pdfjs.ts), so a stream that would decode past
 * PDF_MAX_DECODED_STREAM_BYTES is never allocated; a document with more
 * than PDF_MAX_PAGES pages is not read page by page; and the whole read has
 * pdfReadBudgetMs(). Each of these throws ExtractionLimitError, which no
 * caller turns into an empty text: the document is too large to read.
 */
async function readPdfPages(buf: ArrayBuffer): Promise<PdfReadResult> {
  // A pdf.js that cannot be loaded is a broken install, not an unreadable
  // document: it carries its own kind so the two never share an issue.
  let pdfjsLib: Awaited<ReturnType<typeof loadPdfjs>>;
  try {
    pdfjsLib = await loadPdfjs();
  } catch (cause) {
    return {
      pages: null,
      stage: "load",
      raw: cause,
      cause: new AppError("extraction.failed", "pdf.js could not be loaded", { cause }),
    };
  }
  return runWithPdfBudget(async (budget) => {
    let opened = false;
    let timedOut = false;
    let loadingTask: PdfLoadingTask | undefined;
    // pdf.js's worker runs in this thread on promises alone, so no timer
    // fires while it reads: the clock is checked after each step. The timer
    // ends what waits on anything else (the native inflater): pdf.js
    // rejects whatever waits once its task is destroyed.
    const deadline = Date.now() + pdfReadBudgetMs();
    const timer = setTimeout(() => {
      timedOut = true;
      void loadingTask?.destroy?.().catch(() => {});
    }, pdfReadBudgetMs());
    // pdf.js swallows most errors inside a page (its text is then cut
    // short), so a refused stream is read from the budget, after each step.
    const overLimit = (): ExtractionLimitError | null =>
      budget.exceeded !== null
        ? new ExtractionLimitError(`a PDF stream decodes past ${budget.maxStreamBytes} bytes`)
        : timedOut || Date.now() > deadline
          ? new ExtractionLimitError("the PDF was not read within its time budget")
          : null;
    try {
      loadingTask = (pdfjsLib as unknown as {
        getDocument: (opts: unknown) => PdfLoadingTask;
      }).getDocument({
        // A copy: pdf.js takes the bytes it is given for its worker, which
        // detaches the buffer. Callers keep using theirs, for example to store
        // the file once its text has been read.
        data: new Uint8Array(buf).slice(),
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        maxImageSize: PDF_MAX_IMAGE_PIXELS,
        disableFontFace: true,
        useSystemFonts: false,
      });
      const pdf = await loadingTask.promise;
      opened = true;
      const limited = overLimit();
      if (limited) throw limited;
      if (pdf.numPages > PDF_MAX_PAGES) {
        throw new ExtractionLimitError(`the PDF has more than ${PDF_MAX_PAGES} pages`);
      }
      const pages: PdfPageText[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        let fields: ExtractedFormField[] = [];
        try {
          fields = extractFormFields(await page.getAnnotations());
        } catch {
          // Keep the page's content-stream text if its annotations are malformed.
        }
        const pageLimited = overLimit();
        if (pageLimited) throw pageLimited;
        const positionedFields = fields
          .map(positionedFormItem)
          .filter((item): item is PdfTextItem => item !== null);
        const layout = layoutPageText([
          ...textContent.items,
          ...positionedFields,
        ]);
        let pageText = `[Page ${i}]\n${layout}`;
        const unpositionedFields = fields.filter((field) => !field.rect);
        if (unpositionedFields.length) {
          pageText += `\n[Page ${i} form fields]\n${unpositionedFields
            .map((field) => field.text)
            .join("\n")}`;
        }
        pages.push({
          text: pageText,
          empty: !layout.trim() && unpositionedFields.length === 0,
        });
      }
      return { pages };
    } catch (cause) {
      if (cause instanceof ExtractionLimitError) throw cause;
      const limited = overLimit();
      if (limited) throw limited;
      if (isAllocationFailure(cause)) throw new ExtractionLimitError("the PDF could not be held in memory");
      // A document that opened successfully but failed during page/text
      // processing is an extraction failure, not an invalid-input verdict.
      return opened
        ? {
            pages: null,
            stage: "page",
            raw: cause,
            cause: new AppError("extraction.failed", "PDF text processing failed", { cause }),
          }
        : { pages: null, stage: "open", raw: cause, cause };
    } finally {
      clearTimeout(timer);
      // Releases the pdfjs worker-side document; resolving the promise does not.
      await loadingTask?.destroy?.().catch(() => {});
    }
  });
}

/**
 * The verdict on a PDF pdf.js read but could not use: it would not open
 * (corrupt, truncated, encrypted, not a PDF), or a page of it failed (a
 * structure nested past what a parser can follow). The same bytes fail the
 * same way every time. pdf.js's own error stays the cause, so a password is
 * still told apart (isPdfPasswordError).
 */
function unreadablePdf(raw: unknown): ExtractionParseError {
  return new ExtractionParseError("extraction.pdf_unreadable", PDF_UNREADABLE_MESSAGE, { cause: raw });
}

/** Whether a PDF failed for its password: pdf.js's PasswordException, anywhere on the chain. */
export function isPdfPasswordError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let link: unknown = error;
  while (link && typeof link === "object" && !seen.has(link) && seen.size < 12) {
    seen.add(link);
    if ((link as { name?: unknown }).name === "PasswordException") return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * What an upload records of a PDF, read in full as the reader would: its
 * page count and how many pages have no text layer. Strict: a PDF that cannot
 * be read throws (ExtractionParseError, with pdf.js's PasswordException kept
 * as its cause for an encrypted one), so it is never kept as a ready document
 * with an empty body; one past the reader's bounds throws
 * ExtractionLimitError.
 */
export async function readPdfFacts(
  buf: ArrayBuffer,
): Promise<{ text: ""; pageCount: number; textlessPageCount: number }> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    if (read.stage === "load") throw read.cause;
    throw unreadablePdf(read.raw);
  }
  return {
    text: "",
    pageCount: read.pages.length,
    textlessPageCount: read.pages.filter((page) => page.empty).length,
  };
}

/** Strict extraction for persisted search: unreadable is not a successful blank. */
export async function extractPdfTextForIndex(buf: ArrayBuffer): Promise<{ text: string; textlessPageCount: number }> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    throw new AppError("extraction.pdf_parse_failed", "document_text_pdf_unreadable", {
      cause: read.cause,
    });
  }
  const { pages } = read;
  const textlessPageCount = pages.filter((page) => page.empty).length;
  return {
    text: textlessPageCount === pages.length ? "" : pages.map((page) => page.text).join("\n\n"),
    textlessPageCount,
  };
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    reportUnreadablePdf(read.cause);
    return "";
  }
  return read.pages.map((page) => page.text).join("\n\n");
}

/**
 * How many pages of a PDF have no text layer, or null when the PDF cannot be
 * read (so "unreadable" is never reported as "fully readable").
 */
export async function countPagesWithoutText(
  buf: ArrayBuffer,
): Promise<number | null> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    reportUnreadablePdf(read.cause);
    return null;
  }
  return read.pages.filter((page) => page.empty).length;
}

function formatPageRanges(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const first = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    ranges.push(first === pages[i] ? `${first}` : `${first}–${pages[i]}`);
  }
  return ranges.join(", ");
}

/**
 * The notice for a PDF whose listed pages (1-based) have no text layer, or
 * null when every page has text.
 */
export function textLayerNotice(
  emptyPages: number[],
  pageCount: number,
): string | null {
  if (!emptyPages.length) return null;
  if (emptyPages.length === pageCount) {
    return "[This PDF has no text layer, so its content cannot be read. It is most likely a scanned document that needs OCR.]";
  }
  return emptyPages.length === 1
    ? `[Page ${emptyPages[0]} of this PDF has no text layer, so its content cannot be read. It is most likely scanned and needs OCR.]`
    : `[Pages ${formatPageRanges(emptyPages)} of this PDF have no text layer, so their content cannot be read. They are most likely scanned and need OCR.]`;
}

function textForModel(pages: PdfPageText[]): string {
  const text = pages.map((page) => page.text).join("\n\n");
  const emptyPages = pages.flatMap((page, i) => (page.empty ? [i + 1] : []));
  const notice = textLayerNotice(emptyPages, pages.length);
  if (!notice) return text;
  return emptyPages.length === pages.length ? notice : `${notice}\n\n${text}`;
}

/**
 * The text read_document returns for a PDF. Without a notice, a scanned PDF
 * reaches the model as empty page markers and nothing that says why, so the
 * model may report the document as blank or guess at its content. A fully
 * scanned PDF is replaced by the notice; a partly scanned one keeps its text
 * with the notice in front. Lenient: an unreadable PDF reads as "".
 */
export async function extractPdfTextForModel(buf: ArrayBuffer): Promise<string> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    reportUnreadablePdf(read.cause);
    return "";
  }
  return textForModel(read.pages);
}

/**
 * The same text, strict: a PDF pdf.js cannot read throws
 * ExtractionParseError (pdf.js's PasswordException kept as its cause), so
 * read_document says the document could not be read instead of handing the
 * model an empty body as if the document were blank.
 */
export async function readPdfTextForModel(buf: ArrayBuffer): Promise<string> {
  const read = await readPdfPages(buf);
  if (!read.pages) {
    if (read.stage === "load") throw read.cause;
    throw unreadablePdf(read.raw);
  }
  return textForModel(read.pages);
}

/**
 * The text read_document derives for the legacy Office types (.doc/.ppt):
 * LibreOffice → PDF → pdfjs. Exported so the document.precompute_text job
 * produces byte-identical text to the inline read path — a cache that can
 * drift from what it caches is worse than no cache. In Mike's NativeCluster
 * app, which has no LibreOffice, a .doc (or an RTF saved as .doc) is read by
 * macOS's own textutil instead (extraction/textutil.ts), and a .ppt cannot
 * be read.
 */
export async function extractLegacyOfficeText(
  raw: ArrayBuffer,
): Promise<string> {
  if (legacyTextByTextutil()) return readLegacyTextWithTextutil(raw);
  const pdfBuf = await docxToPdf(Buffer.from(raw));
  return extractPdfText(
    pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer,
  );
}
