// The fake host's two kinds of models.
//
// FakeModels (--models fake): fixed, deterministic answers in OpenAI's chat
// shapes, streamed or whole, with a tool call when tools are offered. It
// knows Mike's own protocols well enough to fill a tabular review (one JSON
// object a cell, or one JSON line a column for a row), to title a chat, and
// to run the upstream e2e fixture's two scripts ("Reply with exactly: X", and
// "Read test.pdf and quote its first line." through read_document). It never
// guesses a model's words beyond these.
//
// Directives a test may put in a person's message, read only by this model:
//   [[fake:say <text>]]              answer exactly <text>
//   [[fake:tool <name> <json args>]] call that tool (when it is offered)
//   [[fake:no-tools]]                answer in words even when tools are offered
//   [[fake:slow <ms>]]               stream the answer a piece every <ms> (a turn
//                                    still streaming when a test stops it or the app)
// and scripted answers a test may queue through the front door's control
// routes (POST /.harness/models/script): {"status": 409, "header": "X-NC-Stopped"},
// {"status": 503, "retry_after": 1}, {"text": "..."}, {"tool": "name", "args": {}}.
//
// RealModels (--models nativecluster): every chat call forwarded to this
// Mac's NativeCluster at its local address (http://localhost:8487/v1), with
// the key from the env file `nativecluster env` names (parsed, never run,
// never printed), the answer streamed through as it comes.

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FAKE_CHAT = "fake:harness";
export const FAKE_EMBED = "fake-embed:harness";
export const FAKE_WINDOW = 32768;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (p) => `${p}${randomBytes(8).toString("hex")}`;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p?.type === "text" || p?.type === "input_text" ? (p.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

const toolName = (t) => t?.function?.name ?? t?.name ?? "";

// --- what the fake model answers ---

/** A cell's or a column's summary in the shape its instruction asks for. */
function shapedSummary(instruction, name) {
  if (/\[\[Yes\]\] or \[\[No\]\]/.test(instruction)) return "[[Yes]]";
  if (/DD Month YYYY/.test(instruction)) return "1 January 2024";
  const tags = /Available tags: (\[\[[^\]]+\]\])/.exec(instruction);
  if (tags) return tags[1];
  return `Harness value for ${name || "this cell"}`;
}

const REASONING = "The harness's fake model filled this cell.";

/** A JSON value that fits a JSON schema, deterministically. */
function fromSchema(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 6) return null;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const alt = s.oneOf ?? s.anyOf;
  if (Array.isArray(alt) && alt.length) return fromSchema(alt[0], depth + 1);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const o = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) o[k] = fromSchema(v, depth + 1);
      return o;
    }
    case "array":
      return s.items ? [fromSchema(s.items, depth + 1)] : [];
    case "string":
      return "harness";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return s.properties ? fromSchema({ ...s, type: "object" }, depth + 1) : "harness";
  }
}

/**
 * The fake model's answer to a chat body: {text} or {calls: [{id, name,
 * arguments}]}, or {status, message} for a body no model would take.
 */
export function fakeAnswer(body) {
  if (!body || typeof body.model !== "string" || !body.model) return { status: 400, message: "a chat call names its model" };
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { status: 400, message: "a chat call carries messages" };
  const msgs = body.messages;
  const sys = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") {
    lastUser = i;
    break;
  }
  const user = lastUser >= 0 ? textOf(msgs[lastUser].content) : "";
  const after = lastUser >= 0 ? msgs.slice(lastUser + 1) : [];
  const toolResults = after.filter((m) => m.role === "tool");
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const offered = new Set(tools.map(toolName));

  // Mike's tabular review: a whole row, one JSON line a column.
  if (sys.includes('"column_index"')) {
    const lines = [];
    const re = /Column (\d+) — "((?:[^"\\]|\\.)*)": ([^\n]*)/g;
    for (let m; (m = re.exec(user)); ) {
      lines.push(JSON.stringify({ column_index: Number(m[1]), summary: shapedSummary(m[3], m[2]), flag: "grey", reasoning: REASONING }));
    }
    return { text: lines.join("\n") + "\n" };
  }
  // One cell.
  if (sys.includes("Return ONLY valid JSON") && sys.includes('"summary"')) {
    const instruction = /Instruction: ([\s\S]*)$/.exec(user)?.[1] ?? user;
    return { text: JSON.stringify({ summary: shapedSummary(instruction, ""), flag: "grey", reasoning: REASONING }) };
  }
  if (/Generate a short title/.test(user)) return { text: "Harness chat title" };

  const rf = body.response_format;
  if (rf?.type === "json_schema") return { text: JSON.stringify(fromSchema(rf.json_schema?.schema ?? {})) };
  if (rf?.type === "json_object") return { text: JSON.stringify({ answer: "harness" }) };

  const echo = /Reply with exactly: ([^\n]+)/.exec(user);
  if (echo) return { text: echo[1].trim() };
  const say = /\[\[fake:say ([\s\S]*?)\]\]/.exec(user);
  if (say) return { text: say[1] };

  if (tools.length && toolResults.length === 0 && !user.includes("[[fake:no-tools]]")) {
    const asked = /\[\[fake:tool ([A-Za-z0-9_.-]+)(?: (\{[\s\S]*?\}))?\]\]/.exec(user);
    if (asked && offered.has(asked[1])) {
      let args = {};
      try {
        args = asked[2] ? JSON.parse(asked[2]) : {};
      } catch {}
      return { calls: [{ id: id("call_"), name: asked[1], arguments: JSON.stringify(args) }] };
    }
    // The upstream fixture's document script: read_document on the doc the
    // system prompt lists under that file's name.
    const read = /Read (\S+) and quote its first line\./.exec(user);
    if (read && offered.has("read_document")) {
      const esc = read[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const doc = new RegExp(`^- (doc-\\d+): (?:<untrusted-content[^>]*>\\s*)?${esc}(?:\\s|<|$)`, "m").exec(sys);
      if (doc) return { calls: [{ id: id("call_"), name: "read_document", arguments: JSON.stringify({ doc_id: doc[1] }) }] };
    }
    // Otherwise one harmless, read-only tool, the same one every time.
    for (const name of ["list_workflows", "list_documents", "list_playbooks"]) {
      if (offered.has(name)) return { calls: [{ id: id("call_"), name, arguments: "{}" }] };
    }
    const noArgs = tools.find((t) => !(t?.function?.parameters?.required ?? []).length);
    if (noArgs) return { calls: [{ id: id("call_"), name: toolName(noArgs), arguments: "{}" }] };
  }

  if (toolResults.length) {
    const results = toolResults.map((m) => textOf(m.content));
    const read = results.find((t) => t.includes("<untrusted-content"));
    if (read) {
      const source = [...read.matchAll(/<untrusted-content\b[^>]*>\n([\s\S]*?)\n<\/untrusted-content\b[^>]*>/g)].at(-1)?.[1] ?? read;
      return { text: `Document tool result:\n\n\`\`\`text\n${source}\n\`\`\`` };
    }
    const names = after.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function?.name)).filter(Boolean);
    return { text: `Harness answer after the ${names.join(", ") || "tool"} tool: it answered ${results.join("").length} characters.` };
  }
  return { text: `Harness answer to: "${user.replace(/\s+/g, " ").trim().slice(0, 60)}"` };
}

function chunks(text, size = 16) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

const tokens = (s) => Math.max(1, Math.ceil(String(s ?? "").length / 4));

/** [[fake:slow <ms>]] in the last user message: how long each streamed piece waits (at most 10 s). */
function slowOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const m = /\[\[fake:slow (\d{1,5})\]\]/.exec(textOf(msgs[i].content));
    return m ? Math.min(Number(m[1]), 10000) : null;
  }
  return null;
}

export class FakeModels {
  constructor({ delayMs = 5 } = {}) {
    this.kind = "fake";
    this.delayMs = delayMs;
    this.script = []; // queued answers, used first
  }

  async list() {
    return [
      { id: FAKE_CHAT, kind: "chat", context_length: FAKE_WINDOW, capabilities: ["completion", "tools"], max_output_tokens: 8192 },
      { id: FAKE_EMBED, kind: "embedding", context_length: 8192, capabilities: ["embedding"] },
    ];
  }

  /** The models route's answer for one task and kind. */
  async route(task, kind) {
    if (kind === "chat") {
      return { task, kind, models: [FAKE_CHAT], to_get: [], windows: { [FAKE_CHAT]: FAKE_WINDOW }, facts: { [FAKE_CHAT]: { speed: null, window: FAKE_WINDOW } } };
    }
    if (kind === "embedding") return { task, kind, models: [FAKE_EMBED], to_get: [], facts: { [FAKE_EMBED]: { speed: null } } };
    return { task, kind, models: [], to_get: [] };
  }

  /** Answers one model call on `path`; returns what the ledger keeps of it. */
  async call(path, body, req, res) {
    if (path === "/v1/embeddings") return this.embed(body, res);
    if (path !== "/v1/chat/completions") {
      send(res, 400, { error: { message: `the harness's fake models answer no ${path}`, type: "invalid_request_error" } });
      return { status: 400 };
    }
    const scripted = this.script.shift();
    if (scripted?.status) {
      const headers = { "content-type": "application/json" };
      if (scripted.header) headers[scripted.header.toLowerCase()] = "1";
      if (scripted.retry_after) headers["retry-after"] = String(scripted.retry_after);
      const code = scripted.status === 503 ? "engine_restarting" : scripted.status === 409 ? "stopped" : "harness";
      res.writeHead(scripted.status, headers);
      res.end(JSON.stringify({ error: { message: scripted.message ?? "scripted by the harness", type: "server_error", code } }));
      return { status: scripted.status, scripted: true };
    }
    const ans = scripted?.text !== undefined
      ? { text: scripted.text }
      : scripted?.tool
        ? { calls: [{ id: id("call_"), name: scripted.tool, arguments: JSON.stringify(scripted.args ?? {}) }] }
        : fakeAnswer(body);
    if (ans.status) {
      send(res, ans.status, { error: { message: ans.message, type: "invalid_request_error" } });
      return { status: ans.status };
    }
    const model = body.model;
    const created = Math.floor(Date.now() / 1000);
    const cid = id("chatcmpl-");
    const prompt = tokens(JSON.stringify(body.messages));
    const completion = tokens(ans.text ?? JSON.stringify(ans.calls));
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    const finish = ans.calls ? "tool_calls" : "stop";
    const info = { status: 200, stream: !!body.stream, tools: (body.tools ?? []).length, tool_calls: (ans.calls ?? []).map((c) => c.name) };
    if (!body.stream) {
      const message = { role: "assistant", content: ans.calls ? null : ans.text };
      if (ans.calls) message.tool_calls = ans.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
      send(res, 200, { id: cid, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }], usage });
      return info;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frame = (delta, finish_reason = null) =>
      `data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const write = (s) => !res.destroyed && res.write(s);
    write(frame({ role: "assistant", content: "" }));
    if (ans.calls) {
      ans.calls.forEach((c, index) => {
        write(frame({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] }));
        for (const part of chunks(c.arguments, 24)) write(frame({ tool_calls: [{ index, function: { arguments: part } }] }));
      });
    } else {
      const delay = slowOf(body) ?? this.delayMs;
      for (const part of chunks(ans.text)) {
        if (res.destroyed) return { ...info, status: 499, cut: true };
        write(frame({ content: part }));
        if (delay) await sleep(delay);
      }
    }
    write(frame({}, finish));
    if (body.stream_options?.include_usage) {
      write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
    }
    write("data: [DONE]\n\n");
    res.end();
    return info;
  }

  embed(body, res) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
    const data = inputs.map((text, index) => {
      const h = createHash("sha256").update(String(text)).digest();
      const v = Array.from({ length: 16 }, (_, i) => (h[i] - 128) / 128);
      const norm = Math.hypot(...v) || 1;
      return { object: "embedding", index, embedding: v.map((x) => x / norm) };
    });
    send(res, 200, { object: "list", data, model: body?.model ?? FAKE_EMBED, usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } });
    return { status: 200 };
  }
}

function send(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": b.length });
  res.end(b);
}

// --- the real NativeCluster, at its local address ---

/** The env file `nativecluster env` names (its key's file), or null. */
export function nativeClusterEnvFile() {
  if (process.env.NATIVECLUSTER_ENV_FILE) return process.env.NATIVECLUSTER_ENV_FILE;
  for (const cli of [path.join(os.homedir(), ".local/bin/nativecluster"), "/Applications/NativeCluster.app/Contents/Resources/nativecluster"]) {
    try {
      const out = execFileSync(cli, ["env"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      const m = /The key is in (.+?) \(only you can read it\)/.exec(out);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

/** The variables a shell env file assigns, parsed, never run. */
export function parseEnvFile(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim().replace(/^export\s+/, ""));
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1).replaceAll(`'\\''`, "'");
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    values.set(m[1], v);
  }
  return values;
}

export class RealModels {
  constructor({ baseURL = "http://localhost:8487/v1", prefer = process.env.HARNESS_REAL_MODEL || "qwen2.5:7b" } = {}) {
    this.kind = "nativecluster";
    this.base = new URL(baseURL.replace(/\/+$/, "") + "/");
    this.prefer = prefer;
    this._key = null;
    this._list = null;
    this.script = [];
  }

  key() {
    if (this._key) return this._key;
    const file = nativeClusterEnvFile();
    if (!file) throw new Error("no NativeCluster key: `nativecluster env` named no env file");
    const vars = parseEnvFile(readFileSync(file, "utf8"));
    const k = vars.get("NATIVECLUSTER_API_KEY") ?? vars.get("OPENAI_API_KEY");
    if (!k) throw new Error("NativeCluster's env file holds no key");
    this._key = k;
    return k;
  }

  request(method, p, { body, headers = {} } = {}) {
    const url = new URL(p.replace(/^\/v1\//, ""), this.base);
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers: { ...headers, authorization: `Bearer ${this.key()}` } }, resolve);
      req.on("error", reject);
      if (body) req.end(body);
      else req.end();
    });
  }

  async list() {
    if (this._list && Date.now() - this._list.at < 60000) return this._list.data;
    const res = await this.request("GET", "/v1/models");
    let text = "";
    for await (const c of res) text += c;
    if (res.statusCode !== 200) throw new Error(`NativeCluster's /v1/models answered ${res.statusCode}`);
    const data = JSON.parse(text).data ?? [];
    this._list = { at: Date.now(), data };
    return data;
  }

  async route(task, kind) {
    const all = await this.list();
    const want = kind === "embedding" ? "embedding" : kind === "chat" ? "chat" : kind;
    let models = all.filter((m) => (m.kind ?? "chat") === want);
    models.sort((a, b) => (b.id === this.prefer) - (a.id === this.prefer));
    const out = { task, kind, models: models.map((m) => m.id), to_get: [] };
    if (kind === "chat") {
      out.windows = Object.fromEntries(models.map((m) => [m.id, m.context_length]));
      out.facts = Object.fromEntries(models.map((m) => [m.id, { speed: null, window: m.context_length }]));
    }
    return out;
  }

  /** Forwards one model call to NativeCluster, its answer streamed through. */
  async call(path, body, req, res, raw) {
    const scripted = this.script.shift();
    if (scripted) return new FakeModels({ delayMs: 0 }).call(path, body, req, res);
    // The host's socket and the local address read two fields differently:
    // the socket ignores `think` for a model that does not think, where the
    // local address refuses it (400 invalid_value, measured 2026-11-24), and
    // `cache_key` is the socket's own (a grant's warm conversation). An
    // app's call is the socket's, so the forward says what the socket means.
    if (body && typeof body === "object" && path === "/v1/chat/completions") {
      let changed = false;
      if ("cache_key" in body) {
        delete body.cache_key;
        changed = true;
      }
      if ("think" in body) {
        const m = (await this.list().catch(() => [])).find((x) => x.id === body.model);
        if (!m?.capabilities?.includes("thinking")) {
          delete body.think;
          changed = true;
        }
      }
      if (changed) raw = Buffer.from(JSON.stringify(body));
    }
    let up;
    try {
      up = await this.request("POST", path, { body: raw, headers: { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*" } });
    } catch (e) {
      send(res, 502, { error: { message: `NativeCluster's local address did not answer: ${e.message}`, type: "server_error" } });
      return { status: 502 };
    }
    const headers = {};
    for (const h of ["content-type", "retry-after", "x-nc-stopped", "x-nc-lost", "cache-control"]) if (up.headers[h]) headers[h] = up.headers[h];
    res.writeHead(up.statusCode, headers);
    res.flushHeaders?.();
    let cut = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        cut = true;
        up.destroy();
      }
    });
    try {
      for await (const c of up) if (!res.destroyed) res.write(c);
    } catch {
      cut = true;
    }
    res.end();
    return { status: up.statusCode, stream: !!body?.stream, tools: (body?.tools ?? []).length, real: true, cut };
  }
}
