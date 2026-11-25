// In NativeCluster's app sandbox a process may signal only itself, so every
// kill of the parser child is refused. Node reports a refused child.kill() by
// emitting "error" on the child at once, inside the call; the parser's error
// handler retired it, which killed it again, until the jobs thread died with
// "RangeError: Maximum call stack size exceeded" (Pablo's install,
// 2026-11-24). The child here is a stand-in that refuses as the sandbox does.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { ExtractionLimitError, runIsolatedExtraction, stopExtractionProcess } from "../isolated";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const PID = 2_147_000_123;

/** A parser child that may not be signalled, as under the app sandbox. */
class RefusingChild extends EventEmitter {
  pid = PID;
  connected = true;
  channel = { ref() {}, unref() {} };
  stderr = null;
  replies = childrenReply;
  exited = false;
  // Node's ChildProcess.kill: a refused signal is an "error" event, emitted
  // synchronously, and the call returns false; once the child has exited
  // there is no handle left to signal, and no event.
  kill = vi.fn(() => {
    if (!this.exited) this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" }));
    return false;
  });
  // The parser ends its own group once its channel closes (process.ts).
  disconnect = vi.fn(() => {
    this.connected = false;
    setImmediate(() => { this.exited = true; this.emit("exit", null, "SIGKILL"); this.emit("close", null, "SIGKILL"); });
  });
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    callback?.(null);
    if (this.replies) setImmediate(() => this.emit("message", { ok: true, result: "parsed text" }));
    return true;
  });
  ref() {}
  unref() {}
}

let children: RefusingChild[] = [];
let childrenReply = true;
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("EXTRACTION_ISOLATION", "on");
  children = [];
  childrenReply = true;
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation((() => {
    const child = new RefusingChild();
    children.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn);
  const kill = process.kill.bind(process);
  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (Math.abs(pid) === PID) throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
    return kill(pid, signal);
  }) as typeof process.kill);
});

afterEach(async () => {
  await stopExtractionProcess();
  killSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32")("a parser whose kill is refused (EPERM)", () => {
  it("retires an idle parser without recursing, and the parser ends itself", async () => {
    await expect(runIsolatedExtraction("rawText", async () => new ArrayBuffer(8))).resolves.toBe("parsed text");
    // Before the guard this threw RangeError: Maximum call stack size exceeded.
    await expect(stopExtractionProcess()).resolves.toBeUndefined();
    const [child] = children;
    // Once while it ran (refused), once more for its group after it closed.
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.disconnect).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGKILL");
  });

  it("keeps a deadline a deadline when the kill it orders is refused", async () => {
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "50");
    childrenReply = false;
    // The timeout's kill used to recurse inside the timer, an uncaught
    // RangeError that ended the thread.
    await expect(runIsolatedExtraction("rawText", async () => new ArrayBuffer(8))).rejects.toBeInstanceOf(ExtractionLimitError);
    expect(children[0].kill).toHaveBeenCalledTimes(2);
    expect(children[0].disconnect).toHaveBeenCalledTimes(1);
    // The next parse gets a parser of its own.
    childrenReply = true;
    await expect(runIsolatedExtraction("rawText", async () => new ArrayBuffer(8))).resolves.toBe("parsed text");
    expect(children).toHaveLength(2);
  });

  it("recycles after a refused kill without recursing", async () => {
    for (let index = 0; index < 200; index++) {
      await expect(runIsolatedExtraction("rawText", async () => new ArrayBuffer(8))).resolves.toBe("parsed text");
    }
    await vi.waitFor(() => expect(children[0].disconnect).toHaveBeenCalled());
    await expect(runIsolatedExtraction("rawText", async () => new ArrayBuffer(8))).resolves.toBe("parsed text");
    expect(children).toHaveLength(2);
  });
});
