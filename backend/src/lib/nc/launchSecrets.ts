// The secrets Mike's launcher hands the backend, on stdin, when it runs as a
// NativeCluster app (MIKE_INTERNAL_SECRET_STDIN=1).
//
// One JSON line, `{"app_credential": "...", "internal_secret": "..."}`, read
// once at start and kept in this process's memory only: never in the
// environment, argv, a file or a log. `app_credential` is the app's key to
// the host's socket (every model call carries it); `internal_secret` is what
// the launcher puts in X-NC-Internal on each request it passes on, and the
// backend answers nothing without it (lib/nc/ingress.ts).
//
// The same line carries the stack's keys (the 2026-11-24 security review,
// M3): the anon and service-role keys, DOWNLOAD_SIGNING_SECRET and
// USER_API_KEYS_ENCRYPTION_SECRET. A process's environment as it started is
// readable by any other program of the same macOS user (sysctl
// KERN_PROCARGS2, `ps -E`), so the launcher puts none of them there. The
// backend sets them into its own process.env (applyLaunchConfigSecrets)
// before its configuration loads: that changes only this process's memory,
// never what it started with, and the code that reads them reads them as
// on any other deployment. Its children are given environments of their
// own that hold none of them (the parsers', lib/extraction and
// integrations/googleDriveExtract).
//
// Worker threads share no memory with the API thread: index.ts hands them
// the app credential in workerData (an in-memory copy), never the
// environment; their process.env is a copy of this thread's, in memory.
//
// The launcher keeps stdin open for the backend's life. Its end means the
// launcher is gone: the backend shuts down by itself (an app cannot signal
// its own children inside the sandbox; the host ends the process group).

import { createHash, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";

export type LaunchSecrets = {
  appCredential: string;
  internalSecret: string;
  /** The stack's keys the line carried, by the variable each configures. */
  config?: Partial<Record<LaunchConfigSecret, string>>;
};

/** The line's keys for the stack's secrets, and the variable each configures. */
export const LAUNCH_CONFIG_SECRETS = {
  supabase_publishable_key: "SUPABASE_PUBLISHABLE_KEY",
  supabase_secret_key: "SUPABASE_SECRET_KEY",
  download_signing_secret: "DOWNLOAD_SIGNING_SECRET",
  user_api_keys_encryption_secret: "USER_API_KEYS_ENCRYPTION_SECRET",
} as const;

export type LaunchConfigSecret = (typeof LAUNCH_CONFIG_SECRETS)[keyof typeof LAUNCH_CONFIG_SECRETS];

let secrets: LaunchSecrets | null = null;
let hostCredential: string | null = null;

export function internalSecretFromStdinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_INTERNAL_SECRET_STDIN?.trim() === "1";
}

/** The launcher's secrets, once read; null before (or outside the app). */
export function launchSecrets(): LaunchSecrets | null {
  return secrets;
}

/** The app's credential for the host's socket, in this process or thread. */
export function ncAppCredential(): string | null {
  return hostCredential ?? secrets?.appCredential ?? null;
}

/** A worker thread's copy of the credential (from workerData), or a test's. */
export function setNcAppCredential(credential: string | null): void {
  hostCredential = credential;
}

/** Test seam. */
export function resetLaunchSecrets(): void {
  secrets = null;
  hostCredential = null;
}

/** The secrets line, checked: both values present, non-empty strings. */
export function parseLaunchSecrets(line: string): LaunchSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Never echo the line: it holds the secrets.
    throw new Error("the launcher's secrets line is not JSON");
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const appCredential = record.app_credential;
  const internalSecret = record.internal_secret;
  if (typeof appCredential !== "string" || !appCredential) {
    throw new Error("the launcher's secrets line has no app_credential");
  }
  if (typeof internalSecret !== "string" || internalSecret.length < 32) {
    throw new Error("the launcher's secrets line has no internal_secret of at least 32 characters");
  }
  const config: Partial<Record<LaunchConfigSecret, string>> = {};
  for (const [key, name] of Object.entries(LAUNCH_CONFIG_SECRETS) as Array<[string, LaunchConfigSecret]>) {
    const value = record[key];
    if (value === undefined) continue;
    // Never echo the value: it is a secret.
    if (typeof value !== "string" || !value) throw new Error(`the launcher's secrets line has an empty or non-string ${key}`);
    config[name] = value;
  }
  return Object.keys(config).length ? { appCredential, internalSecret, config } : { appCredential, internalSecret };
}

/**
 * Puts the stack's keys the launcher's line carried into this process's
 * own environment, in memory, over anything there, before the configuration
 * loads. Answers the names it set. Nothing before the line is read.
 */
export function applyLaunchConfigSecrets(env: NodeJS.ProcessEnv = process.env): LaunchConfigSecret[] {
  const config = secrets?.config ?? {};
  const set: LaunchConfigSecret[] = [];
  for (const [name, value] of Object.entries(config) as Array<[LaunchConfigSecret, string]>) {
    env[name] = value;
    set.push(name);
  }
  return set;
}

const MAX_LINE_BYTES = 64 * 1024;

/**
 * Read the secrets line from `input` (process.stdin) and keep it. Resolves
 * once the line is read; rejects when the input ends first, or holds no
 * valid line. `onEnd` runs once when the input later ends (the launcher
 * went away). What follows the line is read and dropped.
 */
export function readLaunchSecrets(
  input: Readable = process.stdin,
  onEnd?: () => void,
): Promise<LaunchSecrets> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const settle = (error: Error | null, value?: LaunchSecrets) => {
      if (settled) return;
      settled = true;
      buffered = "";
      if (error) reject(error);
      else resolve(value!);
    };
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        if (buffered.length > MAX_LINE_BYTES) settle(new Error("the launcher's secrets line is too long"));
        return;
      }
      const line = buffered.slice(0, newline).trim();
      try {
        const read = parseLaunchSecrets(line);
        secrets = read;
        settle(null, read);
      } catch (error) {
        settle(error as Error);
      }
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (!settled) {
        settle(new Error("stdin ended before the launcher's secrets line"));
        return;
      }
      onEnd?.();
    };
    input.on("end", end);
    input.on("close", end);
    input.on("error", (error) => {
      if (!settled) settle(error);
      else end();
    });
    input.resume();
  });
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time: the comparison takes as long whatever the header holds. */
export function internalSecretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}
