// Only executed in a short-lived, heap-limited child by googleDriveExtract,
// or, in Mike's NativeCluster app, a short-lived worker thread.
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { parentPort } from "node:worker_threads";
import JSZip from "jszip";
import { extractPdfText } from "../pdfText";

async function validateDocxExpansion(
    bytes: Buffer,
    maxExpandedBytes: number,
): Promise<void> {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files);
    if (entries.length > 1000) throw new Error("too many zip entries");
    let expanded = 0;
    // Stream actual decompressed bytes; central-directory size declarations
    // alone cannot establish a limit for a forged archive.
    for (const entry of entries) {
        if (entry.dir) continue;
        await new Promise<void>((resolve, reject) => {
            const stream = entry.nodeStream("nodebuffer") as Readable;
            stream.on("data", (chunk: Buffer) => {
                expanded += chunk.byteLength;
                if (expanded > maxExpandedBytes) {
                    stream.pause();
                    stream.destroy();
                    reject(new Error("expanded archive too large"));
                }
            });
            stream.on("error", reject);
            stream.on("end", resolve);
        });
    }
}

type Request = { filename: string; mimeType: string; expandedBytes: number };
const receive = (handler: (message: Request) => void) =>
    parentPort ? parentPort.once("message", handler) : process.once("message", handler);
const reply = (message: { text: string } | { failed: true }) =>
    parentPort ? parentPort.postMessage(message) : process.send?.(message);

receive(
    async (message: Request) => {
        try {
            let text: string;
            const bytes = await readFile(message.filename);
            if (message.mimeType === "application/pdf") {
                text = await extractPdfText(Uint8Array.from(bytes).buffer);
            } else {
                await validateDocxExpansion(bytes, message.expandedBytes);
                const mammoth = await import("mammoth");
                text = (await mammoth.extractRawText({ buffer: bytes })).value;
            }
            // Include one extra character so the parent can report truncation.
            reply({ text: text.slice(0, 60_001) });
        } catch {
            reply({ failed: true });
        }
    },
);
