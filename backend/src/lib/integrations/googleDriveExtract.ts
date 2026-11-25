import { fork } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { boundedWorkerLimits, watchWorkerMemory } from "../boundedWorker";
import { extractionInThread } from "../extraction/limits";
import { googleDriveLimits } from "./googleDriveLimits";
import { GoogleDriveUserError } from "./googleDriveHttp";

let activeParsers = 0;

type Limits = ReturnType<typeof googleDriveLimits>;
type Request = { filename: string; mimeType: string; expandedBytes: number };

const unreadable = () =>
    new GoogleDriveUserError(
        "This Drive file could not be read within the processing limits. Open it in Google Drive.",
    );

/** Parse untrusted binaries off the API event loop, with bounded concurrency,
 * a V8 heap limit and a wall-clock kill. Download and DOCX expansion limits are
 * enforced separately; V8's heap limit is not a total process RSS limit. */
export async function extractGoogleDriveBinary(
    filename: string,
    mimeType: string,
): Promise<string> {
    if (activeParsers >= 2) {
        throw new GoogleDriveUserError(
            "Google Drive file readers are busy. Please try again.",
        );
    }
    activeParsers++;
    const limits = googleDriveLimits();
    const request = { filename, mimeType, expandedBytes: limits.expandedBytes };
    try {
        // Mike's NativeCluster app: its sandbox refuses every signal to a
        // child, so the child could never be killed; a thread ends without one.
        return await (extractionInThread()
            ? parseInThread(request, limits)
            : parseInChild(request, limits));
    } finally {
        activeParsers--;
    }
}

function parseInChild(request: Request, limits: Limits): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const extension = __filename.endsWith(".ts") ? "ts" : "js";
        const child = fork(
            path.join(__dirname, `googleDriveExtractChild.${extension}`),
            [],
            {
                execArgv: [
                    ...(extension === "ts" ? ["--import", "tsx"] : []),
                    `--max-old-space-size=${limits.parserHeapMb}`,
                ],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                serialization: "advanced",
                // Parsers never need deployment secrets or network credentials.
                env: {
                    NODE_ENV: process.env.NODE_ENV,
                    PATH: process.env.PATH,
                },
            },
        );
        let settled = false;
        const finish = (text?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // A refused kill (EPERM) is an "error" event inside this call;
            // the listener below takes it, and finish() runs once.
            child.kill("SIGKILL");
            if (text !== undefined) resolve(text);
            else reject(unreadable());
        };
        const timer = setTimeout(() => finish(), limits.parseMs);
        // on, not once: no later "error" may find the child without a listener.
        child.on("error", () => finish());
        child.once("exit", () => finish());
        child.once("message", (message: unknown) => {
            const text = (message as { text?: unknown } | null)?.text;
            finish(typeof text === "string" ? text : undefined);
        });
        child.send(request, (error) => {
            if (error) finish();
        });
    });
}

/** The child's work in a worker thread, ended by terminate() (no signal). */
function parseInThread(request: Request, limits: Limits): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const isTs = __filename.endsWith(".ts");
        const env: NodeJS.ProcessEnv = {};
        for (const name of ["NODE_ENV", "PATH"]) {
            if (process.env[name] !== undefined) env[name] = process.env[name];
        }
        // The child's limit was its heap; the file and its expansion,
        // bounded on their own, are allowed on top, as buffers.
        const memoryMb =
            limits.parserHeapMb +
            Math.ceil((2 * limits.downloadBytes + limits.expandedBytes) / (1024 * 1024));
        let worker: Worker;
        try {
            worker = new Worker(
                path.join(__dirname, `googleDriveExtractChild.${isTs ? "ts" : "js"}`),
                {
                    ...(isTs ? { execArgv: ["--require", require.resolve("tsx/cjs")] } : {}),
                    resourceLimits: boundedWorkerLimits(memoryMb),
                    // Parsers never need deployment secrets or network credentials.
                    env,
                    stdout: true,
                    stderr: true,
                },
            );
        } catch {
            reject(unreadable());
            return;
        }
        worker.stdout.resume();
        worker.stderr.resume();
        let settled = false;
        const finish = (text?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unwatch();
            void worker.terminate().catch(() => {});
            if (text !== undefined) resolve(text);
            else reject(unreadable());
        };
        const timer = setTimeout(() => finish(), limits.parseMs);
        const unwatch = watchWorkerMemory(worker, memoryMb, () => finish());
        worker.on("error", () => finish());
        worker.once("exit", () => finish());
        worker.once("message", (message: unknown) => {
            const text = (message as { text?: unknown } | null)?.text;
            finish(typeof text === "string" ? text : undefined);
        });
        worker.postMessage(request);
    });
}
