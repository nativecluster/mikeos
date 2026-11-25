// D1 (robustness campaign, 2026-11-24): a corrupt, a password-protected and a
// deeply nested PDF uploaded as `completed`, listed `ready`, and read as an
// empty body: no word for the person or the model. The reader now gives a
// verdict on each: it cannot be read (ExtractionParseError), with pdf.js's
// PasswordException kept for one locked with a password.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExtractionParseError } from "../extraction/failure";
import { extractPdfTextForModel, isPdfPasswordError, readPdfFacts, readPdfTextForModel } from "../pdfText";
import { arrayBufferOf, nestedPdf, passwordPdf, textPdf } from "./hostilePdfs";

const garbage = () => arrayBufferOf(Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(48 * 1024)]));
const truncated = () => {
  const whole = textPdf(6);
  return arrayBufferOf(whole.subarray(0, Math.floor(whole.length * 0.55)));
};

describe("D1: a PDF the reader cannot read is refused, never read as empty", () => {
  it.each([
    ["a header then garbage", garbage],
    ["a PDF cut off before its cross-references", truncated],
    ["a page nested past what a parser follows", () => arrayBufferOf(nestedPdf())],
  ])("refuses %s as unreadable, not as a password", async (_label, pdf) => {
    const error = await readPdfFacts(pdf()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExtractionParseError);
    expect(isPdfPasswordError(error)).toBe(false);
    await expect(readPdfTextForModel(pdf())).rejects.toBeInstanceOf(ExtractionParseError);
  });

  it("refuses a PDF locked with a password, and says it is the password", async () => {
    const error = await readPdfFacts(arrayBufferOf(passwordPdf())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExtractionParseError);
    expect(isPdfPasswordError(error)).toBe(true);
    const read = await readPdfTextForModel(arrayBufferOf(passwordPdf())).catch((caught: unknown) => caught);
    expect(isPdfPasswordError(read)).toBe(true);
  });

  it("keeps the lenient reader's contract: an unreadable PDF reads as empty there", async () => {
    await expect(extractPdfTextForModel(garbage())).resolves.toBe("");
  });

  it("reads a readable PDF as before", async () => {
    await expect(readPdfTextForModel(arrayBufferOf(textPdf(1)))).resolves.toBe("[Page 1]\nHarness page 1 of 1");
  });
});
