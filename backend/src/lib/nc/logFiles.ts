// The backend's output in rotating files (MIKE_LOG_DIR).
//
// NativeCluster keeps an app's stderr nowhere, so inside the app the backend
// writes what it prints to `<MIKE_LOG_DIR>/backend.log` as well (a standalone
// worker process to `worker.log`), each line stamped with its time. The file
// rotates at MIKE_LOG_MAX_BYTES (10 MB) and keeps MIKE_LOG_FILES (5) older
// ones: backend.log.1 is the newest. Files are 0600 in a 0700 folder.
//
// What reaches the files is exactly what the process prints, nothing more:
// the backend's logs carry no request bodies or secrets (provider errors are
// redacted before they print: installErrorLogRedaction), and dev-only
// tracing stays off whenever the files are on (lib/log.ts isDev). Worker
// threads print through the main thread's stdout and stderr, so their lines
// land here too; only the main thread installs this.
//
// Off unless MIKE_LOG_DIR is set. The process still prints as before.

import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

type Writer = typeof process.stdout.write;

export type LogFileOptions = {
  dir: string;
  name: string;
  maxBytes: number;
  files: number;
  now?: () => Date;
};

export class RotatingLogFile {
  private fd: number | null = null;
  private size = 0;
  private broken = false;
  readonly file: string;

  constructor(private readonly options: LogFileOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(options.dir, options.name);
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.file, "a", 0o600);
    try {
      this.size = statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    for (let n = this.options.files - 1; n >= 1; n--) {
      try {
        renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
      } catch {
        // No such older file yet.
      }
    }
    if (this.options.files >= 1) renameSync(this.file, `${this.file}.1`);
    this.open();
  }

  /** Append text, each line stamped; never throws (a log must not fail the work). */
  write(text: string, stream: "out" | "err"): void {
    if (this.broken || !text) return;
    try {
      const stamp = (this.options.now ?? (() => new Date()))().toISOString();
      const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      const tag = stream === "err" ? " !" : "";
      const out = Buffer.from(lines.map((line) => `${stamp}${tag} ${line}\n`).join(""), "utf8");
      if (this.size > 0 && this.size + out.length > this.options.maxBytes) this.rotate();
      writeSync(this.fd!, out);
      this.size += out.length;
    } catch {
      // A full disk or a removed folder: stop writing files, keep printing.
      this.broken = true;
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

let installed: { file: RotatingLogFile; restore: () => void } | null = null;

/**
 * Copy this process's stdout and stderr into `<MIKE_LOG_DIR>/<component>.log`.
 * Idempotent; false when MIKE_LOG_DIR is unset.
 */
export function installLogFiles(
  component: string,
  env: NodeJS.ProcessEnv = process.env,
  streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process,
): boolean {
  const dir = env.MIKE_LOG_DIR?.trim();
  if (!dir) return false;
  if (installed) return true;
  const file = new RotatingLogFile({
    dir,
    name: `${component}.log`,
    maxBytes: positive(env.MIKE_LOG_MAX_BYTES, 10 * 1024 * 1024),
    files: positive(env.MIKE_LOG_FILES, 5),
  });
  const tee = (stream: NodeJS.WriteStream, which: "out" | "err") => {
    const original = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      file.write(
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "",
        which,
      );
      return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as Writer;
    return () => {
      stream.write = original;
    };
  };
  const restoreOut = tee(streams.stdout, "out");
  const restoreErr = tee(streams.stderr, "err");
  installed = {
    file,
    restore: () => {
      restoreOut();
      restoreErr();
      file.close();
    },
  };
  return true;
}

/** Test seam. */
export function uninstallLogFiles(): void {
  installed?.restore();
  installed = null;
}
