// Legacy Word text in Mike's NativeCluster app (MIKE_NC_APP=1). Upstream
// reads a .doc by converting it to PDF with LibreOffice, which the app has
// not got (its sandbox would not run it either), so a .doc uploaded and then
// always read "Document could not be read." Here macOS's own
// /usr/bin/textutil reads it instead: a Word 97-2003 file, or an RTF saved
// with a .doc name, as plain UTF-8 text.
//
// In the app's sandbox textutil may run (Apple's /usr/bin), but may write
// nothing outside the app's data folder, so it never writes a file of its
// own: the document goes in on stdin and the text comes back on stdout. It
// runs inside the parser (thread.ts), under the parser's own bounds, and
// these of its own:
//   - a deadline, after which the read fails as too large. The sandbox lets
//     a process signal only itself, so textutil cannot be killed from here:
//   - it starts under a CPU-time limit (sh's ulimit -t), which the kernel
//     enforces by ending it, so a read that never finishes ends by itself;
//   - its output is held to the parser's text limit.
// textutil answers a file it cannot read with an error on stderr and exit
// status 0; that, an empty output with an error, or a format it was not
// given, is the bytes' fault (legacy_document_unreadable), and the upload
// refuses the file in words.
import { spawn } from "node:child_process";
import { EXTRACTION_MAX_TEXT_BYTES, ExtractionLimitError } from "./limits";

export const TEXTUTIL = "/usr/bin/textutil";
/** The message of a legacy file textutil could not read (failure.ts knows it). */
export const LEGACY_DOCUMENT_UNREADABLE = "legacy_document_unreadable";
const TEXTUTIL_TIMEOUT_MS = 30_000;
const TEXTUTIL_CPU_SECONDS = 25;
const STDERR_MAX_BYTES = 4096;

/** Whether legacy Office text is read by textutil: Mike's NativeCluster app. */
export function legacyTextByTextutil(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_NC_APP?.trim() === "1";
}

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** The format to read the bytes as: Word's binary file, or RTF. Anything else is refused. */
function textutilFormat(bytes: Buffer): "doc" | "rtf" | null {
  if (bytes.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)) return "doc";
  if (bytes.subarray(0, 5).toString("latin1") === "{\\rtf") return "rtf";
  return null;
}

export class LegacyDocumentUnreadableError extends Error {
  constructor(readonly detail: string) {
    super(LEGACY_DOCUMENT_UNREADABLE);
    this.name = "LegacyDocumentUnreadableError";
  }
}

export function readLegacyTextWithTextutil(
  raw: ArrayBuffer,
  options: { timeoutMs?: number; cpuSeconds?: number; command?: string } = {},
): Promise<string> {
  const bytes = Buffer.from(raw);
  const format = textutilFormat(bytes);
  if (!format) return Promise.reject(new LegacyDocumentUnreadableError("not a Word 97-2003 or RTF file"));
  const timeoutMs = options.timeoutMs ?? TEXTUTIL_TIMEOUT_MS;
  const cpuSeconds = options.cpuSeconds ?? TEXTUTIL_CPU_SECONDS;
  const command = options.command ?? TEXTUTIL;
  return new Promise<string>((resolve, reject) => {
    // sh sets the CPU limit and becomes textutil (exec), so the limit is its.
    const child = spawn("/bin/sh", [
      "-c",
      'ulimit -t "$1" || exit 70; exec "$2" -stdin -stdout -convert txt -encoding UTF-8 -format "$3"',
      "sh", String(cpuSeconds), command, format,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      // Only what it needs; never the backend's own environment.
      env: {
        PATH: "/usr/bin:/bin",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        LANG: "en_US.UTF-8",
      },
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (error: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // Stop reading; if textutil writes again its pipe is gone (SIGPIPE,
        // the kernel's, not ours). A refused kill is answered as an "error".
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        try { child.kill("SIGKILL"); } catch { /* refused in the sandbox */ }
        reject(error);
      } else resolve(text ?? "");
    };
    const timer = setTimeout(
      () => finish(new ExtractionLimitError("textutil did not finish within its time budget")),
      timeoutMs,
    );
    child.on("error", (error) => {
      // Before it ran (no /bin/sh, no textutil): the environment's fault.
      // After, this is a kill the sandbox refused, already handled.
      if (!settled) finish(error);
    });
    child.stdin.on("error", () => {
      // EPIPE: textutil ended without reading it all; its exit says why.
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > EXTRACTION_MAX_TEXT_BYTES) {
        finish(new ExtractionLimitError("extracted text exceeds 16 MB"));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_MAX_BYTES) err += chunk.toString("utf8").slice(0, STDERR_MAX_BYTES - err.length);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      const text = Buffer.concat(out, outBytes).toString("utf8").replace(/\u0000/g, "");
      if (signal === "SIGXCPU" || signal === "SIGKILL") {
        finish(new ExtractionLimitError("textutil ran past its CPU-time limit"));
      } else if (code === 70) {
        finish(Object.assign(new Error("textutil's CPU-time limit could not be set"), { code: "ETEXTUTILLIMIT" }));
      } else if (code !== 0 || (!text.trim() && /error|isn.t in the correct format/i.test(err))) {
        finish(new LegacyDocumentUnreadableError(err.trim().slice(0, 300) || `textutil exited with status ${code}`));
      } else finish(null, text);
    });
    child.stdin.end(bytes);
  });
}
