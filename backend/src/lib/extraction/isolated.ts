// One parser slot per calling thread. Queue coordination remains responsive;
// a reusable child process keeps parsers warm behind an OS memory boundary.
// In Mike's NativeCluster app (MIKE_NC_APP=1) the parser is a worker thread
// instead (ParserThread, below): the sandbox refuses every signal to a child.
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { ExtractionOp, ExtractionOps } from "./ops";
import { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError, extractionInThread, extractionIsolated, extractionLauncher, extractionMemoryMb, extractionTimeoutMs, isAllocationFailure } from "./limits";
import { asExtractionFailure, extractionFailureFromWire, type ExtractionFailureWire } from "./failure";
import { AppError } from "../appError";
import { boundedWorkerLimits, watchWorkerMemory } from "../boundedWorker";

export { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError } from "./limits";
export { ExtractionParseError } from "./failure";

type Result<K extends ExtractionOp> = Awaited<ReturnType<ExtractionOps[K]>>;
export type ExtractInSlot = <K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options?: { fileType?: string }) => Promise<Result<K>>;
type Reply = { ok: true; result: unknown } | ({ ok: false; limited: boolean } & ExtractionFailureWire);

/** Hard OS memory boundary on Linux, including native buffers. Fail closed if
 * prlimit is unavailable. Other platforms retain process/heap and input/output
 * bounds, but do not claim the Linux OS-memory guarantee.
 */
export function extractionCommand(entry: string): { command: string; args: string[] } {
  const launcher = extractionLauncher();
  const memoryMb = extractionMemoryMb();
  const nodeArgs = [
    "--disable-wasm-trap-handler",
    `--max-old-space-size=${memoryMb}`,
    ...(entry.endsWith(".ts") ? ["--require", require.resolve("tsx/cjs")] : []),
    entry,
  ];
  if (launcher) {
    const bytes = memoryMb * 1024 * 1024;
    // Writable heap/native allocations share the data limit. V8 also reserves
    // address space for code (and the TS loader in dev); bound that separately.
    const addressBytes = bytes + 1024 ** 3;
    return { command: launcher, args: [`--data=${bytes}:${bytes}`, `--as=${addressBytes}:${addressBytes}`, "--core=0:0", "--", process.execPath, ...nodeArgs] };
  }
  return { command: process.execPath, args: nodeArgs };
}

// Server-log text for the operator (never sent to a client).
const PARSER_UNAVAILABLE_MESSAGE =
  "The document parser process could not be started, so text extraction " +
  "and DOCX validation fail. On Linux it is launched through prlimit " +
  "(util-linux) to enforce its memory limit; install util-linux (the " +
  "backend Docker image and backend/nixpacks.toml include it, see " +
  "docs/deployment.md). No restart is needed once it is on PATH.";
const PARSER_THREAD_UNAVAILABLE_MESSAGE =
  "The document parser thread could not be started, so text extraction " +
  "and DOCX validation fail.";

// child.kill() emits "error" synchronously when the signal is refused (EPERM:
// in NativeCluster's app sandbox a process may signal only itself), and that
// "error" retires the parser, which kills it again: without a guard the loop
// overflows the stack. One kill at a time per child.
const killing = new WeakSet<ChildProcess>();

function guardedKill(child: ChildProcess, kill: () => void): void {
  if (killing.has(child)) return;
  killing.add(child);
  try { kill(); } finally { killing.delete(child); }
}

function killParser(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    guardedKill(child, () => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => guardedKill(child, () => { child.kill("SIGKILL"); }));
    });
  } else {
    // Includes LibreOffice descendants, including after the parser has exited.
    guardedKill(child, () => {
      try { process.kill(-pid, "SIGKILL"); } catch {
        // Refused: closing the channel makes the parser end its own group
        // (process.ts), which a process may always do to itself.
        if (!child.kill("SIGKILL") && child.connected) child.disconnect();
      }
    });
  }
}

/** What a parse needs of its parser: the child process, or a ParserThread. */
interface ParserChild extends EventEmitter {
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  ref(): void;
  unref(): void;
  readonly stderr: Readable | null;
  readonly channel?: { ref(): void; unref(): void } | null;
}

/**
 * The parser as a worker thread, for Mike's NativeCluster app. It speaks as
 * the child does (spawn, message, error, close; send), so a parse, its
 * deadline, recycling and the idle shutdown are the same code, and it ends
 * by terminate(), which needs no signal. Its memory budget is the child's
 * (EXTRACTION_MAX_MEMORY_MB), counting buffers as well as the heap
 * (boundedWorker.ts); a parse over it ends the thread, never the backend.
 */
class ParserThread extends EventEmitter implements ParserChild {
  readonly stderr = null;
  /** Ended for its memory: its parse fails as over the memory budget. */
  outOfMemory = false;
  private readonly worker: Worker;
  private unwatch?: () => void;

  constructor(entry: string, options: WorkerOptions, private readonly memoryMb: number) {
    super();
    this.worker = new Worker(entry, { ...options, stdout: true, stderr: true });
    // What the parsers print is dropped, as the child's stdout is.
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    let online = false;
    this.worker.once("online", () => { online = true; this.emit("spawn"); });
    this.worker.on("message", (message: unknown) => { this.unwatch?.(); this.emit("message", message); });
    this.worker.on("error", (error: Error) => {
      // V8's own heap limit (the backstop), or an allocation it refused.
      if ((error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" || isAllocationFailure(error)) this.outOfMemory = true;
      // A thread that never started is a parser that could not be started.
      // Anything later is a crash, which its exit reports, as a child's.
      else if (!online) this.emit("error", error);
    });
    this.worker.once("exit", (code: number) => { this.unwatch?.(); this.emit("close", code, null); });
  }

  send(message: unknown, callback: (error: Error | null) => void): boolean {
    try {
      // Copied, not transferred: the caller keeps its bytes, as with the child.
      this.worker.postMessage(message);
    } catch (error) {
      callback(error as Error);
      return false;
    }
    this.unwatch?.();
    this.unwatch = watchWorkerMemory(this.worker, this.memoryMb, () => {
      this.outOfMemory = true;
      this.terminate();
    });
    callback(null);
    return true;
  }

  terminate(): void {
    this.unwatch?.();
    void this.worker.terminate().catch(() => {});
  }

  ref(): void { this.worker.ref(); }
  unref(): void { this.worker.unref(); }
}

type Parser = {
  child: ParserChild;
  /** Kill the child (its group), or terminate the thread. */
  stop: () => void;
  /** Whether it ended for its memory, beyond what its exit says. */
  outOfMemory: () => boolean;
  closed: Promise<void>;
  memoryMb: number;
  started: boolean;
  files: number;
  idle?: ReturnType<typeof setTimeout>;
  retiring?: boolean;
};
let parser: Parser | null = null;
const RECYCLE_AFTER_FILES = 200;
const IDLE_SHUTDOWN_MS = 60_000;

function retire(p: Parser): void {
  // A refused kill's "error" event lands here again, inside the kill.
  if (p.retiring) return;
  p.retiring = true;
  try {
    if (parser === p) parser = null;
    clearTimeout(p.idle);
    p.stop();
  } finally {
    p.retiring = false;
  }
}

/** Also used at test boundaries so no warm process outlives its configuration. */
export async function stopExtractionProcess(): Promise<void> {
  const p = parser;
  if (p) { retire(p); await p.closed; }
}

function reference(p: Parser, active: boolean): void {
  if (active) {
    p.child.ref(); p.child.channel?.ref();
    (p.child.stderr as Socket | null)?.ref();
  } else {
    p.child.unref(); p.child.channel?.unref();
    (p.child.stderr as Socket | null)?.unref();
  }
}

async function startParser(): Promise<Parser> {
  if (extractionInThread()) return startParserThread();
  const entry = path.join(__dirname, __filename.endsWith(".ts") ? "process.ts" : "process.js");
  const { command, args } = extractionCommand(entry);
  const scratch = await mkdtemp(path.join(tmpdir(), "mike-extraction-"));
  // No application credentials or inherited NODE_OPTIONS in the parser.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "HOME", "LANG", "SOFFICE_BINARY_PATH", "LIBREOFFICE_BINARY_PATH", "LIBRE_OFFICE_EXE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // Packaged desktop backends run under Electron's Node mode. Its executable
  // starts the GUI app again unless each parser child explicitly keeps Node mode.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  env.TMPDIR = env.TMP = env.TEMP = scratch;
  // Avoid glibc arena reservations exhausting RLIMIT_AS at low actual usage.
  env.MALLOC_ARENA_MAX = "2";
  const child = spawn(command, args, {
    env, detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
  });
  const p: Parser = { child, stop: () => killParser(child), outOfMemory: () => false, closed: Promise.resolve(), memoryMb: extractionMemoryMb(), started: false, files: 0 };
  const onParentExit = () => killParser(child);
  process.once("exit", onParentExit);
  child.once("spawn", () => { p.started = true; });
  // Idle child errors must still retire the process even without a parse listener.
  child.on("error", () => retire(p));
  p.closed = new Promise<void>((resolve, reject) => child.once("close", () => {
    retire(p);
    process.removeListener("exit", onParentExit);
    void rm(scratch, { recursive: true, force: true }).then(resolve, reject);
  }));
  // Idle retirement has no caller awaiting cleanup; active parses do await it.
  void p.closed.catch(() => {});
  return p;
}

/** The parser as a thread (Mike's NativeCluster app): see ParserThread. */
async function startParserThread(): Promise<Parser> {
  const isTs = __filename.endsWith(".ts");
  const entry = path.join(__dirname, isTs ? "thread.ts" : "thread.js");
  const scratch = await mkdtemp(path.join(tmpdir(), "mike-extraction-"));
  // A thread's process.env is its own copy: no application credentials in it.
  // MIKE_NC_APP keeps LibreOffice off inside it too (convert.ts).
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "MIKE_NC_APP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.TMPDIR = env.TMP = env.TEMP = scratch;
  const memoryMb = extractionMemoryMb();
  let thread: ParserThread;
  try {
    thread = new ParserThread(entry, {
      env,
      resourceLimits: boundedWorkerLimits(memoryMb),
      // Compiled, a thread inherits the parent's flags; from source it needs
      // the TypeScript loader, as the child does.
      ...(isTs ? { execArgv: ["--require", require.resolve("tsx/cjs")] } : {}),
    }, memoryMb);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw new AppError("extraction.parser_unavailable", PARSER_THREAD_UNAVAILABLE_MESSAGE, { cause: error });
  }
  const p: Parser = { child: thread, stop: () => thread.terminate(), outOfMemory: () => thread.outOfMemory, closed: Promise.resolve(), memoryMb, started: false, files: 0 };
  thread.once("spawn", () => { p.started = true; });
  thread.on("error", () => retire(p));
  // A thread ends with the thread that started it: no exit hook is needed.
  p.closed = new Promise<void>((resolve, reject) => thread.once("close", () => {
    retire(p);
    void rm(scratch, { recursive: true, force: true }).then(resolve, reject);
  }));
  void p.closed.catch(() => {});
  return p;
}

async function extractInChild<K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options: { fileType?: string } = {}): Promise<Result<K>> {
  if (bytes.byteLength > EXTRACTION_MAX_BYTES) throw new ExtractionLimitError("source exceeds 150 MB");
  if (!extractionIsolated()) {
    const { EXTRACTION_OPS } = await import("./ops.js");
    try {
      return await EXTRACTION_OPS[op](bytes, options.fileType ?? "") as Result<K>;
    } catch (error) {
      // Classified as the isolated path is, so callers treat both alike.
      throw error instanceof ExtractionLimitError ? error : asExtractionFailure(error);
    }
  }
  if (parser && parser.memoryMb !== extractionMemoryMb()) await stopExtractionProcess();
  const p = parser ?? (parser = await startParser());
  clearTimeout(p.idle);
  reference(p, true);
  const { child } = p;
  return new Promise<Result<K>>((resolve, reject) => {
    let reply: Reply | undefined;
    let failure: Error | undefined;
    let diagnostics = "";
    const timeout = setTimeout(() => {
      failure = new ExtractionLimitError("parser deadline exceeded");
      retire(p);
    }, extractionTimeoutMs());
    const onDiagnostics = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.removeListener("spawn", send);
      child.stderr?.removeListener("data", onDiagnostics);
    };
    const onMessage = (message: Reply) => {
      if (failure) return;
      reply = message;
      if (!reply.ok || ++p.files >= RECYCLE_AFTER_FILES) { retire(p); return; }
      cleanup();
      p.idle = setTimeout(() => retire(p), IDLE_SHUTDOWN_MS);
      p.idle.unref();
      reference(p, false);
      resolve(reply.result as Result<K>);
    };
    // Before "spawn" the launcher itself failed; its errno stays on the cause.
    // The first failure names the outcome: a deadline stays a deadline when
    // the kill it ordered is refused and reported as an "error".
    const onError = (error: Error) => {
      failure ??= p.started ? error : new AppError("extraction.parser_unavailable", PARSER_UNAVAILABLE_MESSAGE, { cause: error });
      retire(p);
    };
    const onClose = (_code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      void p.closed.then(() => {
        if (failure instanceof ExtractionLimitError) reject(failure);
        else if (reply?.ok) resolve(reply.result as Result<K>);
        else if (reply) reject(reply.limited ? new ExtractionLimitError(reply.message) : extractionFailureFromWire(reply));
        else if (p.outOfMemory() || signal === "SIGABRT" || /out of memory|allocation failed|cannot allocate memory|failed to map segment|ENOMEM/i.test(diagnostics)) {
          reject(new ExtractionLimitError("parser memory budget exceeded"));
        } else if (failure) reject(failure);
        else {
          // The signal separates an OOM-killer SIGKILL from a native crash.
          const exited = new AppError("extraction.process_exited", "extraction process exited without a result");
          reject(signal ? Object.assign(exited, { code: signal }) : exited);
        }
      }, reject);
    };
    const send = () => child.send({ op, bytes, fileType: options.fileType ?? "" }, (error) => {
      if (error && !reply && !failure) onError(error);
    });
    child.stderr?.on("data", onDiagnostics);
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
    if (p.started) send(); else child.once("spawn", send);
  });
}

const MAX_WAITERS = 8;

// Separate download concurrency from parser concurrency. A slow storage read
// must not stop another already-downloaded tabular row from being parsed.
type AdmissionOptions = { waitMs?: number; interactive?: boolean };

function admission(limit: number, maxWaiters = MAX_WAITERS) {
  const queue: Array<{ grant: () => void; interactive?: boolean }> = [];
  let active = 0;
  return async <T>(options: AdmissionOptions, work: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      if (options.waitMs === 0 || queue.length >= maxWaiters) throw new ExtractionBusyError();
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grant = () => { clearTimeout(timer); resolve(); };
        const waiter = { grant, interactive: options.interactive };
        const background = options.interactive ? queue.findIndex((item) => !item.interactive) : -1;
        queue.splice(background < 0 ? queue.length : background, 0, waiter);
        if (options.waitMs !== undefined) timer = setTimeout(() => {
          queue.splice(queue.indexOf(waiter), 1);
          reject(new ExtractionBusyError());
        }, options.waitMs);
      });
    } else active++;
    try { return await work(); }
    finally {
      const next = queue.shift();
      if (next) next.grant();
      else active--;
    }
  };
}
const parserAdmission = admission(1);
const requestAdmission = admission(3);
// Only one background source is loaded at a time. Waiting jobs hold no buffers;
// durable jobs time out, while inline jobs must wait because no runner retries them.
const backgroundAdmission = admission(1, Infinity);

/** Reserve only the parser; source I/O belongs outside this slot. */
export function withExtractionSlot<T>(
  options: AdmissionOptions,
  work: (extract: ExtractInSlot) => Promise<T>,
): Promise<T> {
  return parserAdmission(options, () => work(extractInChild));
}

function queuedExtraction<K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options?: { fileType?: string }): Promise<Result<K>> {
  return withExtractionSlot<Result<K>>({ interactive: true }, (extract) => extract(op, bytes, options));
}

/** Background I/O cannot block interactive parsing or fill its admission queue. */
export function withBackgroundExtraction<T>(
  options: { waitMs?: number },
  work: (extract: ExtractInSlot) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  return backgroundAdmission(options, () => {
    const waitMs = options.waitMs === undefined ? undefined : Math.max(0, options.waitMs - (Date.now() - started));
    const extract: ExtractInSlot = (op, bytes, parseOptions) =>
      withExtractionSlot({ waitMs }, (parse) => parse(op, bytes, parseOptions));
    return work(extract);
  });
}

/** Three interactive sources may download/parse concurrently, matching tabular
 * row concurrency. Only the actual parser call takes the single parser slot. */
export function withExtractionRequest<T>(work: (extract: ExtractInSlot) => Promise<T>): Promise<T> {
  return requestAdmission({}, () => work(queuedExtraction));
}

export function runIsolatedExtraction<K extends ExtractionOp>(
  op: K,
  loadSource: () => Promise<ArrayBuffer | null>,
  options: { fileType?: string } = {},
): Promise<Result<K>> {
  return withExtractionRequest<Result<K>>(async (extract): Promise<Result<K>> => {
    const source = await loadSource();
    if (!source) throw new Error("document_text_source_unavailable");
    return extract(op, source, options);
  });
}
