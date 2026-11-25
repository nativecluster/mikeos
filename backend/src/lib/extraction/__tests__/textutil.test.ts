// D2 (robustness campaign, 2026-11-24): a .doc uploaded into Mike's
// NativeCluster app always read "Document could not be read.": its reader is
// LibreOffice, which the app has not got. In the app macOS's own textutil
// reads it, document in on stdin, text out on stdout (the sandbox lets it
// write no file of its own), within a deadline and a CPU-time limit the
// kernel enforces, since the sandbox lets the app signal no child.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asExtractionFailure, ExtractionParseError } from "../failure";
import { ExtractionLimitError } from "../limits";
import { EXTRACTION_OPS } from "../ops";
import { extractDocumentText } from "../documentText";
import { extractDocumentMarkdown } from "../documentMarkdown";
import { LEGACY_DOCUMENT_UNREADABLE, readLegacyTextWithTextutil, TEXTUTIL } from "../textutil";

const onMac = process.platform === "darwin" && existsSync(TEXTUTIL);
let dir: string;
const arrayBufferOf = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A Word 97-2003 .doc, written by textutil itself from plain text. */
function wordDoc(text: string): ArrayBuffer {
  const source = path.join(dir, "source.txt");
  writeFileSync(source, text);
  const doc = path.join(dir, "source.doc");
  execFileSync(TEXTUTIL, ["-convert", "doc", "-output", doc, source]);
  return arrayBufferOf(readFileSync(doc));
}

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "mike-textutil-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!onMac)("D2: a .doc is read by textutil in the app", () => {
  it("reads a Word 97-2003 file's text", async () => {
    const text = await readLegacyTextWithTextutil(wordDoc("LEGACY WORD 97 LEASE\n\nThe rent is 1200 a month."));
    expect(text).toContain("LEGACY WORD 97 LEASE");
    expect(text).toContain("The rent is 1200 a month.");
  });

  it("reads an RTF saved with a .doc name", async () => {
    const rtf = arrayBufferOf(Buffer.from("{\\rtf1\\ansi Harness {\\b RTF} notice.}"));
    await expect(readLegacyTextWithTextutil(rtf)).resolves.toBe("Harness RTF notice.");
  });

  it.each([
    ["plain text", Buffer.from("not a Word file")],
    ["a Word signature then garbage", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096, 0x5a)])],
  ])("refuses %s as the bytes' fault", async (_label, bytes) => {
    const error = await readLegacyTextWithTextutil(arrayBufferOf(bytes)).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(LEGACY_DOCUMENT_UNREADABLE);
    expect(asExtractionFailure(error)).toBeInstanceOf(ExtractionParseError);
  });

  it("gives up on a reader that never answers, at its deadline", async () => {
    const started = Date.now();
    await expect(readLegacyTextWithTextutil(wordDoc("x"), { command: script("sleeps", "exec /bin/sleep 30"), timeoutMs: 300 }))
      .rejects.toBeInstanceOf(ExtractionLimitError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("is ended by the kernel past its CPU-time limit, needing no signal of ours", async () => {
    await expect(readLegacyTextWithTextutil(wordDoc("x"), { command: script("spins", "while :; do :; done"), cpuSeconds: 1, timeoutMs: 20_000 }))
      .rejects.toThrow(/CPU-time limit/);
  }, 30_000);

  it("holds its output to the reader's text limit", async () => {
    await expect(readLegacyTextWithTextutil(wordDoc("x"), { command: "/usr/bin/yes" }))
      .rejects.toThrow(/exceeds 16 MB/);
  }, 30_000);

  it("is what the app's readers use for a .doc, and a .ppt has none", async () => {
    vi.stubEnv("MIKE_NC_APP", "1");
    const doc = wordDoc("APP MODE LEASE");
    await expect(EXTRACTION_OPS.legacyOfficeText(doc)).resolves.toContain("APP MODE LEASE");
    await expect(extractDocumentText(doc, "doc")).resolves.toMatchObject({ text: expect.stringContaining("APP MODE LEASE") });
    await expect(extractDocumentMarkdown(doc, "doc")).resolves.toContain("APP MODE LEASE");
    await expect(extractDocumentText(doc, "ppt")).rejects.toThrow("document_text_unsupported_format");
  });
});
