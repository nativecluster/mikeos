import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenOrFail,
  removeStaleSocket,
  unixSocketPath,
  type LifecycleEffects,
} from "../processLifecycle";
import { socketDir } from "../nc/__tests__/unixServer";

function fakeEffects() {
  return {
    report: vi.fn<LifecycleEffects["report"]>(() => null),
    logError: vi.fn<LifecycleEffects["logError"]>(),
    logInfo: vi.fn<LifecycleEffects["logInfo"]>(),
    flush: vi.fn<LifecycleEffects["flush"]>(async () => {}),
    exit: vi.fn<LifecycleEffects["exit"]>(),
  } satisfies LifecycleEffects;
}

function getOverSocket(socketPath: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let dir: string;
beforeEach(() => {
  dir = socketDir();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PORT=<path>", () => {
  it("reads a PORT that is not a number as a unix socket", () => {
    expect(unixSocketPath(3001)).toBeNull();
    expect(unixSocketPath("3001")).toBeNull();
    expect(unixSocketPath(" 3001 ")).toBeNull();
    expect(unixSocketPath("")).toBeNull();
    expect(unixSocketPath("/tmp/nc/api.sock")).toBe("/tmp/nc/api.sock");
  });

  it("listens on the socket, mode 0600, before saying it listens", async () => {
    const socketPath = path.join(dir, "api.sock");
    const app = express();
    app.get("/health", (_req, res) => res.json({ ok: true }));
    const effects = fakeEffects();
    let modeWhenListening = -1;
    const onListening = vi.fn(() => {
      modeWhenListening = statSync(socketPath).mode & 0o777;
    });
    // HOST is ignored for a socket.
    const server = listenOrFail(app, socketPath, onListening, effects, "127.0.0.1");
    try {
      await vi.waitFor(() => expect(onListening).toHaveBeenCalledOnce());
      expect(effects.exit).not.toHaveBeenCalled();
      expect(statSync(socketPath).isSocket()).toBe(true);
      expect(modeWhenListening).toBe(0o600);
      expect(await getOverSocket(socketPath, "/health")).toEqual({ status: 200, body: '{"ok":true}' });
      // The process's own umask is as it was.
      const umask = process.umask(0o022);
      process.umask(umask);
      expect(umask).not.toBe(0o177);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("fails the boot when a live server holds the socket", async () => {
    const socketPath = path.join(dir, "api.sock");
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(socketPath, resolve));
    try {
      expect(await removeStaleSocket(socketPath)).toBe("live");
      expect(existsSync(socketPath)).toBe(true);
      const effects = fakeEffects();
      const onListening = vi.fn();
      listenOrFail(express(), socketPath, onListening, effects);
      await vi.waitFor(() => expect(effects.exit).toHaveBeenCalledWith(1));
      expect(onListening).not.toHaveBeenCalled();
      expect(effects.report).toHaveBeenCalledWith(
        expect.objectContaining({ code: "EADDRINUSE" }),
        { tags: { component: "boot", stage: "listen" }, level: "fatal" },
      );
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it("removes a socket a killed backend left behind, and nothing else", async () => {
    const socketPath = path.join(dir, "api.sock");
    // A process that is killed while it listens leaves its socket file.
    const child = spawn(
      process.execPath,
      ["-e", `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => child.on("exit", resolve));
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(await removeStaleSocket(socketPath)).toBe("removed");
    expect(existsSync(socketPath)).toBe(false);
    expect(await removeStaleSocket(socketPath)).toBe("absent");

    const file = path.join(dir, "not-a-socket");
    writeFileSync(file, "keep me");
    expect(await removeStaleSocket(file)).toBe("not-a-socket");
    expect(existsSync(file)).toBe(true);
  });

  it("then listens where the stale socket was", async () => {
    const socketPath = path.join(dir, "api.sock");
    const child = spawn(
      process.execPath,
      ["-e", `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => child.on("exit", resolve));
    await removeStaleSocket(socketPath);
    const effects = fakeEffects();
    const onListening = vi.fn();
    const server = listenOrFail(express().get("/x", (_q, r) => void r.send("x")), socketPath, onListening, effects);
    try {
      await vi.waitFor(() => expect(onListening).toHaveBeenCalledOnce());
      expect((await getOverSocket(socketPath, "/x")).body).toBe("x");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
