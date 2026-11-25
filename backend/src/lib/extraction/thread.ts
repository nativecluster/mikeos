// The parser thread of Mike's NativeCluster app (MIKE_NC_APP=1; see
// isolated.ts): the requests and replies of process.ts, over the worker's
// port instead of a child's IPC channel. Keep the two alike. The thread ends
// when its parent terminates it, or with its parent.
import { parentPort } from "node:worker_threads";
import { EXTRACTION_OPS, type ExtractionOp } from "./ops";
import { EXTRACTION_MAX_TEXT_BYTES, ExtractionLimitError, isAllocationFailure } from "./limits";
import { extractionFailureToWire } from "./failure";

parentPort?.on("message", (request: { op: ExtractionOp; bytes: ArrayBuffer; fileType: string }) => {
  void (async () => {
    try {
      const result = await EXTRACTION_OPS[request.op](request.bytes, request.fileType);
      const text = typeof result === "string" ? result : result.text;
      // Bound the reply before it can allocate a large string in the parent.
      if (Buffer.byteLength(text) > EXTRACTION_MAX_TEXT_BYTES) {
        throw new ExtractionLimitError("extracted text exceeds 16 MB");
      }
      parentPort?.postMessage({ ok: true, result });
    } catch (error) {
      const limited = error instanceof ExtractionLimitError || isAllocationFailure(error);
      // A thrown Error does not cross the port as itself; send its labels, as
      // process.ts does, so the parent rebuilds the same kind and code.
      parentPort?.postMessage(limited
        ? { ok: false, limited, message: "parser resource budget exceeded" }
        : { ok: false, limited, ...extractionFailureToWire(error) });
    }
  })();
});
