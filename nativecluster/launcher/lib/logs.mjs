// Mike's logs inside NativeCluster: the host keeps no app's stderr, so every
// part of the app writes to a file of its own in $NC_APP_DATA/logs (0700),
// each file 0600. A file over its cap is moved aside to <name>.1 (one older
// copy kept) when it is opened, and the launcher's own log also as it grows.
//
// Never write a secret here: not the app credential, the ticket key, the
// internal secret or any key the host keeps for Mike.

import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync, chmodSync } from "node:fs";
import path from "node:path";

export const LOG_CAP_BYTES = 8 * 1024 * 1024;

export function logsDir(dataDir) {
  const dir = path.join(dataDir, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Moves <file> to <file>.1 when it is over the cap. */
export function rotateIfLarge(file, cap = LOG_CAP_BYTES) {
  if (sizeOf(file) <= cap) return false;
  try {
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** An append-only descriptor for a child's stdout and stderr (0600). */
export function openLogFd(dir, name) {
  const file = path.join(dir, `${name}.log`);
  rotateIfLarge(file);
  const fd = openSync(file, "a", 0o600);
  try {
    chmodSync(file, 0o600);
  } catch {}
  return fd;
}

/**
 * The launcher's own log: one line per call, timestamped, rotated as it
 * grows. Writes are synchronous so the last lines before an exit are kept.
 */
export function createLog(dir, name = "launcher", cap = LOG_CAP_BYTES) {
  const file = path.join(dir, `${name}.log`);
  let fd = openLogFd(dir, name);
  let written = sizeOf(file);
  const write = (level, parts) => {
    const text = parts
      .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === "string" ? p : safeJson(p)))
      .join(" ");
    const line = `${new Date().toISOString()} ${level} ${text}\n`;
    try {
      if (written + line.length > cap) {
        closeSync(fd);
        rotateIfLarge(file, 0);
        fd = openLogFd(dir, name);
        written = 0;
      }
      writeSync(fd, line);
      written += Buffer.byteLength(line);
    } catch {
      // A full disk must not take the app down with it.
    }
  };
  return {
    file,
    info: (...parts) => write("info", parts),
    warn: (...parts) => write("warn", parts),
    error: (...parts) => write("error", parts),
    close: () => {
      try {
        closeSync(fd);
      } catch {}
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Sends console.* (Next's own output among it) to the log. */
export function captureConsole(log) {
  console.log = (...a) => log.info(...a);
  console.info = (...a) => log.info(...a);
  console.debug = () => {};
  console.warn = (...a) => log.warn(...a);
  console.error = (...a) => log.error(...a);
}
