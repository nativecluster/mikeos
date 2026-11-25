// The parsers the isolated extraction process may run, by name. Everything here
// does CPU-bound work on the whole file, so it runs outside the calling process (see
// isolated.ts). Keep imports parser-only: this module is all the parser process loads.

import { validateDocxPackage } from "../docxpackagevalidation";
import { extractDocxBodyAndReview, extractDocxBodyText } from "../docxTrackedChanges";
import { extractPresentationText } from "../officeText";
import { extractLegacyOfficeText, extractPdfText, readPdfFacts, readPdfTextForModel } from "../pdfText";
import { spreadsheetToLLMText } from "../spreadsheet";
import { extractDocumentMarkdown } from "./documentMarkdown";
import { extractDocumentText } from "./documentText";

async function mammothRawText(bytes: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

/**
 * A .docx as the model reads it: what its tracked changes mean, when it has
 * any; the accepted view; then its review notes.
 */
export async function docxTextForModel(bytes: ArrayBuffer): Promise<string> {
  const { body, review, lead } = await extractDocxBodyAndReview(Buffer.from(bytes));
  const text = body || await mammothRawText(bytes);
  const withReview = review ? `${text}\n\n${review}` : text;
  return lead ? `${lead}\n\n${withReview}` : withReview;
}

export const EXTRACTION_OPS = {
  validateDocxPackage: async (bytes: ArrayBuffer) => ({ text: "", valid: await validateDocxPackage(bytes) }),
  /** Search index text (document.extract_text). */
  documentText: (bytes: ArrayBuffer, fileType: string) =>
    extractDocumentText(bytes, fileType),
  /** Tabular review source markdown. */
  documentMarkdown: (bytes: ArrayBuffer, fileType: string) =>
    extractDocumentMarkdown(bytes, fileType),
  /** An uploaded PDF's page count and textless pages, read in full; unreadable throws. */
  pdfFacts: (bytes: ArrayBuffer) => readPdfFacts(bytes),
  /** read_document views, one per file type. A PDF that cannot be read throws. */
  pdfForModel: (bytes: ArrayBuffer) => readPdfTextForModel(bytes),
  /** A PDF's page text, "" when it cannot be read (a playbook's import). */
  pdfText: (bytes: ArrayBuffer) => extractPdfText(bytes),
  // The same accepted view the edit_document matcher anchors against, with
  // mammoth as the fallback when it comes back empty, then the tracked
  // changes and comments that view cannot show.
  docxText: (bytes: ArrayBuffer) => docxTextForModel(bytes),
  /**
   * A .docx's tracked changes and comments alone, as docxText adds them:
   * `text` after its body, `lead` before it.
   */
  docxReview: async (bytes: ArrayBuffer) => {
    const { review, lead } = await extractDocxBodyAndReview(Buffer.from(bytes));
    return { text: review, lead };
  },
  /** The accepted view alone (a playbook's source). */
  docxBodyText: (bytes: ArrayBuffer) => extractDocxBodyText(Buffer.from(bytes)),
  spreadsheet: async (bytes: ArrayBuffer) =>
    spreadsheetToLLMText(Buffer.from(bytes)),
  presentation: (bytes: ArrayBuffer) =>
    extractPresentationText(Buffer.from(bytes)),
  legacyOfficeText: (bytes: ArrayBuffer) => extractLegacyOfficeText(bytes),
  rawText: (bytes: ArrayBuffer) => mammothRawText(bytes),
};

export type ExtractionOps = typeof EXTRACTION_OPS;
export type ExtractionOp = keyof ExtractionOps;
