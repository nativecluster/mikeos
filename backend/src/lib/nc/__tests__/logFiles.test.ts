import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLogFiles, RotatingLogFile, uninstallLogFiles } from "../logFiles";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mike-logs-"));
});
afterEach(() => {
  uninstallLogFiles();
  rmSync(dir, { recursive: true, force: true });
});

const AT = new Date("2026-11-24T12:00:00.000Z");

describe("RotatingLogFile", () => {
  it("stamps each line, in a 0600 file in a 0700 folder", () => {
    const logs = path.join(dir, "logs");
    const file = new RotatingLogFile({ dir: logs, name: "backend.log", maxBytes: 1_000_000, files: 3, now: () => AT });
    file.write("[dbq] runner started\nsecond line\n", "out");
    file.write("[sentry] disabled", "err");
    file.close();
    expect(readFileSync(path.join(logs, "backend.log"), "utf8")).toBe(
      "2026-11-24T12:00:00.000Z [dbq] runner started\n" +
        "2026-11-24T12:00:00.000Z second line\n" +
        "2026-11-24T12:00:00.000Z ! [sentry] disabled\n",
    );
    expect(statSync(path.join(logs, "backend.log")).mode & 0o777).toBe(0o600);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
  });

  it("rotates at its size and keeps the newest older files", () => {
    const file = new RotatingLogFile({ dir, name: "backend.log", maxBytes: 100, files: 2, now: () => AT });
    // Each line is 25 (stamp and space) + 49 + 1 = 75 bytes: one fits a file.
    for (let i = 1; i <= 4; i++) file.write(`line ${i} ${"x".repeat(42)}\n`, "out");
    file.close();
    expect(readFileSync(path.join(dir, "backend.log"), "utf8")).toContain("line 4");
    expect(readFileSync(path.join(dir, "backend.log.1"), "utf8")).toContain("line 3");
    expect(readFileSync(path.join(dir, "backend.log.2"), "utf8")).toContain("line 2");
    expect(existsSync(path.join(dir, "backend.log.3"))).toBe(false);
  });

  it("appends to the file a previous run left", () => {
    const first = new RotatingLogFile({ dir, name: "backend.log", maxBytes: 1_000_000, files: 2, now: () => AT });
    first.write("before\n", "out");
    first.close();
    const second = new RotatingLogFile({ dir, name: "backend.log", maxBytes: 1_000_000, files: 2, now: () => AT });
    second.write("after\n", "out");
    second.close();
    expect(readFileSync(path.join(dir, "backend.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("installLogFiles", () => {
  function streams() {
    const out = new PassThrough();
    const err = new PassThrough();
    const printed: string[] = [];
    out.on("data", (chunk) => printed.push(String(chunk)));
    err.on("data", (chunk) => printed.push(String(chunk)));
    return {
      printed,
      streams: { stdout: out as unknown as NodeJS.WriteStream, stderr: err as unknown as NodeJS.WriteStream },
    };
  }

  it("is off without MIKE_LOG_DIR", () => {
    const { streams: s } = streams();
    const write = s.stdout.write;
    expect(installLogFiles("backend", {}, s)).toBe(false);
    expect(s.stdout.write).toBe(write);
  });

  it("copies what the process prints into <MIKE_LOG_DIR>/<component>.log and still prints it", async () => {
    const { printed, streams: s } = streams();
    expect(installLogFiles("backend", { MIKE_LOG_DIR: dir }, s)).toBe(true);
    s.stdout.write("Mike backend running\n");
    s.stderr.write(Buffer.from("[dbq] claim failed\n"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(printed).toEqual(["Mike backend running\n", "[dbq] claim failed\n"]);
    const text = readFileSync(path.join(dir, "backend.log"), "utf8");
    expect(text).toMatch(/^\S+Z Mike backend running\n\S+Z ! \[dbq\] claim failed\n$/);
    uninstallLogFiles();
    s.stdout.write("after uninstall\n");
    expect(readFileSync(path.join(dir, "backend.log"), "utf8")).not.toContain("after uninstall");
  });
});

describe("dev tracing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("stays off whenever the output is kept in files", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MIKE_LOG_DIR", "");
    vi.resetModules();
    expect((await import("../../log.js")).isDev).toBe(true);
    vi.stubEnv("MIKE_LOG_DIR", dir);
    vi.resetModules();
    expect((await import("../../log.js")).isDev).toBe(false);
  });
});
