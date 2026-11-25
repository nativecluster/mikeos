// PDFs written here from nothing, byte by byte, for the reader's bounds: a
// text PDF, one whose content stream inflates far past its size, one locked
// with a password, one nested past what a parser follows, one that claims
// more pages than it has. No person's file and no download.
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";

type PdfObject = string | { dict: string; stream: Buffer };

/** Objects 1..n, a cross-reference table and a trailer. */
export function writePdf(objects: PdfObject[], trailerExtra = ""): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  const push = (data: Buffer | string) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    parts.push(buf);
    offset += buf.length;
  };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const xref: number[] = [];
  objects.forEach((object, i) => {
    xref.push(offset);
    if (typeof object === "string") {
      push(`${i + 1} 0 obj\n${object}\nendobj\n`);
      return;
    }
    push(`${i + 1} 0 obj\n<< ${object.dict} /Length ${object.stream.length} >>\nstream\n`);
    push(object.stream);
    push("\nendstream\nendobj\n");
  });
  const xrefAt = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of xref) table += `${String(at).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const page = (contents: number) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`;

/** A text PDF of `pages` pages, each with one line naming its page. */
export function textPdf(pages: number): Buffer {
  const objects: PdfObject[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", FONT];
  const kids: string[] = [];
  for (let p = 1; p <= pages; p++) {
    kids.push(`${objects.length + 1} 0 R`);
    objects.push(page(objects.length + 2));
    objects.push({ dict: "", stream: Buffer.from(`BT /F1 12 Tf 72 720 Td (Harness page ${p} of ${pages}) Tj ET`) });
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  return writePdf(objects);
}

/**
 * `pages` pages that all draw one content stream: a line of text, then
 * spaces, deflated, which inflates to `inflatedMiB` MiB.
 */
export async function bombPdf(inflatedMiB: number, pages = 1): Promise<Buffer> {
  const deflate = zlib.createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => deflate.on("end", resolve));
  deflate.write(Buffer.from("BT /F1 10 Tf 56 744 Td (Harness PDF bomb first line) Tj ET\n"));
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < inflatedMiB; i++) {
    if (!deflate.write(spaces)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await ended;
  const contents = 4 + pages;
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(" ");
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    FONT,
    ...Array.from({ length: pages }, () => page(contents)),
    { dict: "/Filter /FlateDecode", stream: Buffer.concat(chunks) },
  ]);
}

/**
 * A PDF under the standard security handler (RC4, revision 2) whose user
 * password is not empty: its /O and /U are random, so no password a reader
 * tries opens it, as for a PDF whose password nobody gave.
 */
export function passwordPdf(): Buffer {
  const hex = (bytes: Buffer) => `<${bytes.toString("hex")}>`;
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    FONT,
    page(5),
    { dict: "", stream: randomBytes(64) },
    `<< /Filter /Standard /V 1 /R 2 /O ${hex(randomBytes(32))} /U ${hex(randomBytes(32))} /P -4 >>`,
  ], `/Encrypt 6 0 R /ID [${hex(randomBytes(16))} ${hex(randomBytes(16))}]`);
}

/** A page whose resources nest `depth` dictionaries deep. */
export function nestedPdf(depth = 50_000): Buffer {
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    FONT,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /X ${"<< /A ".repeat(depth)}1${" >>".repeat(depth)} >> /Contents 5 0 R >>`,
    { dict: "", stream: Buffer.from("BT /F1 12 Tf 72 720 Td (Harness nesting first line) Tj ET") },
  ]);
}

/** One page, under a page tree that says it has `count`. */
export function claimsPagesPdf(count: number): Buffer {
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [4 0 R] /Count ${count} >>`,
    FONT,
    page(5),
    { dict: "", stream: Buffer.from("BT /F1 12 Tf 72 720 Td (Harness one real page) Tj ET") },
  ]);
}

export const arrayBufferOf = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
