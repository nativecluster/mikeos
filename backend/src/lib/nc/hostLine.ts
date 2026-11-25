// Model calls through NativeCluster's line (NATIVECLUSTER_TRANSPORT=host).
//
// Inside the app, Mike reaches no engine and no local address: every model
// call waits its turn in the host's one line on LB_HOST_SOCKET, as whatever
// started it, runs on the grant the line gave it, and gives the grant back
// once its answer ends (ncdev spec hostapi, "The waiting line"; the Python
// kit's transport.py is the reference). This is a fetch for the AI SDK's
// OpenAI-compatible client, passed as aiSdkFetch's base fetch:
//
//   POST /host/v1/line/wait      NDJSON: {"position"}…, {"away"}, then
//                                {"id","cache_key","model"} or {"refused"}
//   POST /v1/chat/completions    X-NC-Grant: <id>, the body's cache_key
//   POST /host/v1/line/release   {grant, notes:{model,calls,read,written}},
//                                exactly once, when the answer's body ends,
//                                is cancelled, or fails
//
// A 409 with X-NC-Stopped or X-NC-Lost is a call the line stopped: given
// back and run again, up to three more times. A 503 with Retry-After is the
// engine restarting or a model being checked: given back, waited out, run
// again. A 410 is an ending (stopped by an administrator, the person left):
// passed on, never run again.
//
// The call's origin, lane and task come from the request or job in hand
// (lib/nc/context.ts). Its model is the person's pick when the host names it
// for the task, else the task's first (GET /host/v1/models?task=…&kind=chat).

import { log, tpl } from "../log";
import { ncOriginFor, type NcOrigin, type NcTask } from "./context";
import { HostCallError, hostFetch, hostJson, HOST_ORIGIN } from "./hostSocket";
import { requestParts } from "./unixFetch";

/** The base URL the OpenAI-compatible client is given: the socket is the destination. */
export const HOST_LINE_BASE_URL = `${HOST_ORIGIN}/v1`;

/** The engine routes a model call uses, with the kind the models route reads for each. */
const MODEL_ROUTES: Record<string, "chat" | "embedding"> = {
  "/v1/chat/completions": "chat",
  "/v1/embeddings": "embedding",
};

/** A call stopped before its answer began is run this many times in all. */
export const MAX_TRIES = 4;
/** How many times a 503 with Retry-After is waited out, and the longest wait. */
const MAX_UNAVAILABLE_WAITS = 20;
const MAX_RETRY_AFTER_MS = 300_000;

const MODELS_KEPT_MS = 60_000;

// ---------------------------------------------------------------------------
// Which models may do a task
// ---------------------------------------------------------------------------

export type HostTaskModels = {
  task: string;
  models: string[];
  windows: Record<string, number>;
  /** The host's words when none may: this computer is off, or none fits. */
  words?: string;
};

const taskModels = new Map<string, { at: number; answer: HostTaskModels }>();

export function forgetHostTaskModels(): void {
  taskModels.clear();
}

/** GET /host/v1/models for one task (chat), kept a minute. */
export async function hostTaskModels(
  task: string,
  options: { fresh?: boolean; kind?: string } = {},
): Promise<HostTaskModels> {
  const kind = options.kind ?? "chat";
  const key = `${task}\n${kind}`;
  const kept = taskModels.get(key);
  if (!options.fresh && kept && Date.now() - kept.at < MODELS_KEPT_MS) return kept.answer;
  const query = new URLSearchParams({ task, kind });
  const raw = (await hostJson<Record<string, unknown>>("GET", `/host/v1/models?${query}`)) ?? {};
  const models = Array.isArray(raw.models)
    ? raw.models.filter((m): m is string => typeof m === "string" && !!m)
    : [];
  const windows: Record<string, number> = {};
  if (raw.windows && typeof raw.windows === "object") {
    for (const [name, value] of Object.entries(raw.windows as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) windows[name] = value;
    }
  }
  const words =
    (typeof raw.off === "string" && raw.off) || (typeof raw.why === "string" && raw.why) || undefined;
  const answer: HostTaskModels = { task, models, windows, ...(words ? { words } : {}) };
  taskModels.set(key, { at: Date.now(), answer });
  return answer;
}

/**
 * The task's models, or the assistant's when the manifest lists no such task
 * (the models route answers 404 for a task the manifest does not name).
 */
async function modelsForTask(task: NcTask, kind: string, fresh = false): Promise<HostTaskModels> {
  try {
    return await hostTaskModels(task, { fresh, kind });
  } catch (error) {
    if (error instanceof HostCallError && error.status === 404 && task !== "assistant") {
      log.warn(tpl`[nc-line] the manifest lists no ${task} task; its calls use the assistant's models`);
      return hostTaskModels("assistant", { fresh, kind });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// A wait in line
// ---------------------------------------------------------------------------

export type Grant = { id: string; cacheKey: string; model: string; window?: number };

export class LineRefused extends Error {
  readonly words: string;
  constructor(words: string) {
    super(`nativecluster: the host's line refused the call: ${words}`);
    this.name = "LineRefused";
    this.words = words;
  }
}

type WaitBody = {
  kind: "acquire";
  lane: "P" | "B";
  tag: Record<string, unknown>;
  ticket: Record<string, unknown>;
  pick?: "chat";
};

function waitBody(origin: NcOrigin, model: string, kind: "chat" | "embedding"): WaitBody {
  const tag: Record<string, unknown> = { Task: origin.task, Model: model };
  if (origin.person) tag.Person = origin.person;
  if (origin.job) tag.Job = true;
  if (origin.conversation) tag.Conversation = origin.conversation;
  return {
    kind: "acquire",
    lane: origin.lane,
    tag,
    ticket: { ...origin.ticket },
    ...(kind === "chat" ? { pick: "chat" as const } : {}),
  };
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** POST /host/v1/line/wait: the grant, or LineRefused. Closing it (the signal) gives the wait up. */
export async function waitInLine(body: WaitBody, signal?: AbortSignal | null): Promise<Grant> {
  const response = await hostFetch("/host/v1/line/wait", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (response.status !== 200) {
    throw new HostCallError("POST", "/host/v1/line/wait", response.status, await response.text());
  }
  if (!response.body) throw new HostCallError("POST", "/host/v1/line/wait", 200, "no answer");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let awaySaid = false;
  const read = (line: string): Grant | null => {
    if (!line.trim()) return null;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof message.refused === "string" && message.refused) throw new LineRefused(message.refused);
    if (typeof message.id === "string" && message.id) {
      return {
        id: message.id,
        cacheKey: typeof message.cache_key === "string" ? message.cache_key : "",
        model: typeof message.model === "string" ? message.model : "",
        ...(int(message.window) ? { window: int(message.window) } : {}),
      };
    }
    if (!awaySaid && typeof message.away === "string" && message.away) {
      // The call waits for a cluster out of reach; it goes on. Said once.
      awaySaid = true;
      log.info("nc-line", "a wait is held until the cluster is back in reach");
    }
    return null;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        const grant = read(buffered + decoder.decode());
        if (grant) return grant;
        throw new HostCallError("POST", "/host/v1/line/wait", 200, "the line ended the wait without an answer");
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const grant = read(line);
        if (grant) return grant;
      }
    }
  } finally {
    // The wait's connection closes; a grant given stands until its release.
    void reader.cancel().catch(() => {});
  }
}

/** POST /host/v1/line/release: what the call did, counts only. Never throws. */
async function releaseGrant(grant: Grant, model: string, read: number, written: number): Promise<void> {
  try {
    await hostJson("POST", "/host/v1/line/release", {
      grant: grant.id,
      notes: { model, calls: 1, read, written },
    });
  } catch {
    // The host ends the grant with the app's process at the latest.
  }
}

// The grants this thread holds and has not given back, and the releases on
// their way to the host. A process that leaves while a call streams, or
// between a grant and its call, gave nothing back: each grant stood in the
// host's ledger, never released (the models campaign's bug 2, 2026-11-24:
// a SIGTERM during a turn left its answer's grant and its title's).
const held = new Map<string, () => void>();
const sending = new Set<Promise<void>>();
let leaving = false;

/** Gives one grant back, once, whoever asks first. */
function releaser(grant: Grant, model: string): (read?: number, written?: number) => void {
  let given = false;
  const give = (read = 0, written = 0) => {
    if (given) return;
    given = true;
    held.delete(grant.id);
    const sent = releaseGrant(grant, model, read, written);
    sending.add(sent);
    void sent.finally(() => sending.delete(sent));
  };
  held.set(grant.id, () => give());
  return give;
}

/**
 * The process is leaving (its shutdown, a worker thread's): every grant this
 * thread still holds goes back now, a call under way on it ending with the
 * process, and every release on its way is awaited, at most `timeoutMs`.
 * A grant the line gives after this goes back at once and its call is not
 * made. Answers how many grants were still held.
 */
export async function releaseHeldGrants(timeoutMs = 2_000): Promise<number> {
  leaving = true;
  const gives = [...held.values()];
  for (const give of gives) give();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...sending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return gives.length;
}

/** How many grants this thread holds now. */
export function heldGrantCount(): number {
  return held.size;
}

/** Test seam: a thread that is not leaving, holding nothing. */
export function resetHeldGrantsForTests(): void {
  leaving = false;
  held.clear();
  sending.clear();
}

// ---------------------------------------------------------------------------
// The answer's body: read through, counted, given back once
// ---------------------------------------------------------------------------

/** The frame a stream the line cut short ends with (as the Python kit's). */
const EARLY_END = new TextEncoder().encode(
  'data: {"error":{"message":"the answer ended early: the waiting line may have stopped it to make way for someone; try again","type":"server_error","code":"nc_stopped"}}\n\n',
);

const MAX_WHOLE_ANSWER_SCAN = 16 * 1024 * 1024;

/** Reads an answer as it passes: its usage, and whether a stream reached [DONE] or an error. */
class AnswerScan {
  read = 0;
  written = 0;
  done = false;
  error = false;
  private tail = "";
  private whole = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly streamed: boolean) {}

  feed(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.streamed) {
      if (this.whole.length < MAX_WHOLE_ANSWER_SCAN) this.whole += text;
      return;
    }
    const lines = (this.tail + text).split("\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  end(): void {
    const rest = this.decoder.decode();
    if (!this.streamed) {
      this.usage(this.parse(this.whole + rest)?.usage);
      return;
    }
    this.line(this.tail + rest);
    this.tail = "";
  }

  private parse(text: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private usage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, unknown>;
    this.read = int(usage.prompt_tokens) ?? this.read;
    this.written = int(usage.completion_tokens) ?? this.written;
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    const frame = this.parse(data);
    if (!frame) return;
    if (frame.error) this.error = true;
    this.usage(frame.usage);
  }
}

function streams(response: Response): boolean {
  return response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/event-stream");
}

/**
 * The answer, its body passed through as it comes; `done(read, written)`
 * runs exactly once, when the body ends, is cancelled, fails, or the call's
 * signal aborts.
 */
function guardedAnswer(
  response: Response,
  done: (read: number, written: number) => void,
  signal?: AbortSignal | null,
): Response {
  const headers = new Headers(response.headers);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!response.body) {
    done(0, 0);
    return new Response(null, init);
  }
  const streamed = streams(response);
  const scan = new AnswerScan(streamed);
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    done(scan.read, scan.written);
  };
  const onAbort = () => {
    finish();
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          finish();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          scan.end();
          if (streamed && !scan.done && !scan.error && !signal?.aborted) controller.enqueue(EARLY_END);
          finish();
          controller.close();
          return;
        }
        scan.feed(chunk.value);
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, init);
}

// ---------------------------------------------------------------------------
// Answers the kit makes itself, in OpenAI's shapes
// ---------------------------------------------------------------------------

/** NativeCluster's codes for an error whose words are for the person. */
const PERSON_CODES = new Set(["inference_off", "computer_waiting", "computer_removed", "not_given", "app_not_here"]);

export function lineError(status: number, message: string, code: string, retryAfterSeconds?: number): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: status < 500 ? "invalid_request_error" : "server_error", code },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}),
      },
    },
  );
}

function hostWords(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    return typeof parsed.code === "string" && PERSON_CODES.has(parsed.code) && typeof parsed.error === "string"
      ? parsed.error
      : null;
  } catch {
    return null;
  }
}

function refusal(error: unknown): Response | null {
  if (error instanceof LineRefused) return lineError(503, error.words, "nc_refused");
  if (error instanceof HostCallError) {
    const words = hostWords(error.body);
    if (words) return lineError(503, words, "nc_refused");
    return lineError(error.status >= 400 ? error.status : 502, error.message, "nc_host");
  }
  return null;
}

function stopped(response: Response): boolean {
  return !!(response.headers.get("x-nc-stopped") || response.headers.get("x-nc-lost"));
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS) : null;
}

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

const DROPPED_HEADERS = ["authorization", "content-length", "transfer-encoding", "host", "connection", "x-nc-grant"];

export async function hostLineFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const parts = requestParts(input, init);
  const url = new URL(parts.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = (parts.init.method ?? "GET").toUpperCase();
  const kind = MODEL_ROUTES[path];
  const signal = parts.init.signal ?? null;
  if (!kind || method !== "POST") {
    // Not a model call (a listing): to the host as it is, with the credential.
    return hostFetch(`${url.pathname}${url.search}`, parts.init);
  }

  const origin = ncOriginFor();
  if (!origin) {
    return lineError(
      403,
      "nativecluster: a model call needs a person's request or a job one started",
      "nc_no_origin",
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(typeof parts.init.body === "string" ? parts.init.body : "") as Record<string, unknown>;
  } catch {
    return lineError(400, "nativecluster: a model call's body is JSON", "nc_bad_body");
  }
  const asked = typeof body.model === "string" ? body.model : "";

  let available: HostTaskModels;
  try {
    available = await modelsForTask(origin.task, kind);
  } catch (error) {
    const answer = refusal(error);
    if (answer) return answer;
    throw error;
  }
  const pickModel = (answer: HostTaskModels) =>
    answer.models.includes(asked) ? asked : (answer.models[0] ?? "");
  let model = pickModel(available);
  if (!model) {
    return lineError(
      503,
      available.words ?? `No computer in this cluster runs a model for ${origin.task} yet.`,
      "nc_refused",
    );
  }

  const headers = new Headers(parts.init.headers);
  for (const name of DROPPED_HEADERS) headers.delete(name);
  headers.set("content-type", "application/json");

  let current = origin;
  let stops = 0;
  let unavailable = 0;
  for (;;) {
    let grant: Grant;
    try {
      grant = await waitInLine(waitBody(current, model, kind), signal);
    } catch (error) {
      // A job whose request the host no longer holds waits as a resumed job.
      if (
        error instanceof LineRefused &&
        current.ticket.from === "request" &&
        /no such request/i.test(error.words)
      ) {
        const { request: _dropped, ...ticket } = current.ticket;
        current = { ...current, ticket: { ...ticket, from: "resume" }, lane: "B", job: true };
        continue;
      }
      const answer = refusal(error);
      if (answer) return answer;
      throw error;
    }
    const used = grant.model || model;
    const give = releaser(grant, used);
    if (leaving) {
      // The process is on its way out: the grant goes back, unused.
      give();
      throw new DOMException("the app is stopping", "AbortError");
    }
    const callHeaders = new Headers(headers);
    callHeaders.set("x-nc-grant", grant.id);
    const callBody = { ...body, model: used, ...(grant.cacheKey ? { cache_key: grant.cacheKey } : {}) };
    let response: Response;
    try {
      response = await hostFetch(path, {
        method: "POST",
        headers: callHeaders,
        body: JSON.stringify(callBody),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Cut off before the answer began (an abort, the socket gone).
      give();
      throw error;
    }

    if (stopped(response)) {
      await discard(response);
      give();
      stops += 1;
      if (stops < MAX_TRIES) continue;
      return lineError(
        503,
        "the waiting line stopped this call to make way for someone; try again",
        "nc_stopped",
        1,
      );
    }

    const wait = response.status === 503 ? retryAfterMs(response) : null;
    if (wait !== null && unavailable < MAX_UNAVAILABLE_WAITS) {
      await discard(response);
      give();
      unavailable += 1;
      await pause(wait, signal);
      // A model taken out of service gives way to the next the host names.
      available = await modelsForTask(origin.task, kind, true).catch(() => available);
      model = pickModel(available) || model;
      continue;
    }

    return guardedAnswer(response, give, signal);
  }
}
