// A fake NativeCluster host on a unix socket: the models route, the line's
// NDJSON wait, model calls on a grant, releases and units. Each test scripts
// what the line and the engine answer. Not a test file itself.

import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { socketDir } from "./unixServer";

export const CREDENTIAL = "test-app-credential";

export type WaitScript =
  | { lines: Record<string, unknown>[]; delayMs?: number }
  | { hold: true };

export type CallScript = (res: ServerResponse, body: Record<string, unknown>, req: IncomingMessage) => void | Promise<void>;

export type FakeHost = {
  socketPath: string;
  /** Per task: the models route's answer, or a status for the task. */
  tasks: Record<string, Record<string, unknown> | number>;
  waits: Record<string, unknown>[];
  waitScripts: WaitScript[];
  /** Waits whose connection the app closed before an answer. */
  waitsGivenUp: number;
  calls: Array<{ body: Record<string, unknown>; grant: string | undefined; closedEarly: boolean }>;
  callScripts: CallScript[];
  releases: Record<string, unknown>[];
  units: Record<string, unknown>[];
  modelReads: string[];
  unauthorized: number;
  other: Array<{ method: string; url: string }>;
  close(): Promise<void>;
};

let grantCounter = 0;

export function sse(chunks: Record<string, unknown>[], options: { done?: boolean } = {}): string {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    (options.done === false ? "" : "data: [DONE]\n\n")
  );
}

/** A streamed answer: text pieces, then usage, then [DONE]. */
export function streamAnswer(text: string[], usage = { prompt_tokens: 12, completion_tokens: 5 }): CallScript {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      ...text.map((piece, i) => ({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: piece } : { content: piece }, finish_reason: null }],
      })),
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } },
    ];
    res.end(sse(chunks));
  };
}

/** A whole (not streamed) answer. */
export function wholeAnswer(text: string, usage = { prompt_tokens: 7, completion_tokens: 3 }): CallScript {
  return (res, body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "c2",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      }),
    );
  };
}

export function status(code: number, headers: Record<string, string> = {}, body: unknown = { error: { message: `status ${code}` } }): CallScript {
  return (res) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
}

/** A stream that sends its first piece and holds the rest until the app hangs up. */
export function heldStream(first = "Hel"): CallScript {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse([{ id: "c3", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: first }, finish_reason: null }] }], { done: false }));
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
}

export async function startFakeHost(): Promise<FakeHost> {
  const dir = socketDir();
  const socketPath = path.join(dir, "host.sock");
  const sockets = new Set<Socket>();
  const host: FakeHost = {
    socketPath,
    tasks: {
      assistant: { task: "assistant", kind: "chat", models: ["qwen3.8:27b", "gemma4:4b"], to_get: [], windows: { "qwen3.8:27b": 65536, "gemma4:4b": 32768 } },
      titles: { task: "titles", kind: "chat", models: ["gemma4:4b"], to_get: [], windows: { "gemma4:4b": 32768 } },
      tabular: { task: "tabular", kind: "chat", models: ["qwen3.8:27b"], to_get: [], windows: { "qwen3.8:27b": 65536 } },
      playbook: { task: "playbook", kind: "chat", models: ["qwen3.8:27b"], to_get: [], windows: { "qwen3.8:27b": 65536 } },
      memory: { task: "memory", kind: "chat", models: ["qwen3.8:27b"], to_get: [], windows: { "qwen3.8:27b": 65536 } },
    },
    waits: [],
    waitScripts: [],
    waitsGivenUp: 0,
    calls: [],
    callScripts: [],
    releases: [],
    units: [],
    modelReads: [],
    unauthorized: 0,
    other: [],
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) {
      host.unauthorized += 1;
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://host");
    if (req.method === "GET" && url.pathname === "/host/v1/models") {
      const task = url.searchParams.get("task") ?? "";
      host.modelReads.push(task);
      const answer = host.tasks[task];
      if (answer === undefined || typeof answer === "number") {
        res.writeHead(typeof answer === "number" ? answer : 404).end("no such task");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    if (req.method === "POST" && url.pathname === "/host/v1/line/wait") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      host.waits.push(body);
      const script = host.waitScripts.shift() ?? {
        lines: [{ position: 1 }, { id: `g${++grantCounter}`, cache_key: `k${grantCounter}`, model: (body.tag as Record<string, unknown>)?.Model }],
      };
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let answered = false;
      res.on("close", () => {
        if (!answered) host.waitsGivenUp += 1;
      });
      if ("hold" in script) {
        res.write(JSON.stringify({ position: 3 }) + "\n");
        return;
      }
      for (const line of script.lines) {
        if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
        if (line.id || line.refused) answered = true;
        res.write(JSON.stringify(line) + "\n");
      }
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/host/v1/line/release") {
      host.releases.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method === "POST" && url.pathname === "/host/v1/units") {
      host.units.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.writeHead(200).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const grant = req.headers["x-nc-grant"] as string | undefined;
      const call = { body, grant, closedEarly: false };
      host.calls.push(call);
      res.on("close", () => {
        if (!res.writableEnded) call.closedEarly = true;
      });
      const script = host.callScripts.shift() ?? streamAnswer(["Hello", " there"]);
      await script(res, body, req);
      return;
    }
    host.other.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" }).end('{"other":true}');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return host;
}

/** Wait until `check` passes (a release goes out after the body ends, asynchronously). */
export async function eventually(check: () => void, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

