// The fake host's socket (LB_HOST_SOCKET): what an installed app beside the
// bundle's reaches of NativeCluster's host (`ncdev spec hostapi`, "The host's
// socket", "The waiting line", "Apps beside the bundle's"), as far as Mike
// uses it, each call checked for the app's credential:
//
//   GET  /host/v1/models?task=&kind=       its tasks' models (models, windows, facts)
//   POST /host/v1/line/{wait,admit,release,end}, GET /host/v1/line/state
//   POST /host/v1/units
//   GET/PUT/DELETE /host/v1/secrets/<name> (in memory, or the state folder)
//   GET  /host/v1/people/<id>/role, GET /host/v1/grants?person=
//   POST /host/v1/triggers/{kick,hello}, /host/v1/triggers/table/*, firings/{done,renew}
//   POST /host/v1/main/hand                (409 no_main: this computer joined no main)
//   /v1/chat/completions, /v1/embeddings   on a live grant (X-NC-Grant)
//   /v1/models, /api/tags, /api/version, /api/show, /health
//
// Its rules follow NativeCluster's own where Mike could trip on them
// (host/host/line.go, origin/main): a wait's ticket must be one the host can
// check (lane P only for a request the front passed to this app within its
// 20-minute turn, as that request's person; a firing's only for a firing the
// clock handed over), a body field of the wrong type is a 400 naming it, a
// model call needs a live grant of this app's, a unit's grant carries calls
// on its own model only, and an admitted call is held to its max_tokens.
// Everything is written to the ledger.

import http from "node:http";
import { randomBytes } from "node:crypto";

const TURN_MS = 20 * 60 * 1000;
const LANES = new Set(["P", "A", "B", "I"]);
const KINDS = new Set(["chat", "embedding", "transcription", "tts", "image", "diarization"]);
const MODEL_CALLS = new Set(["/v1/chat/completions", "/v1/embeddings", "/v1/audio/transcriptions", "/v1/audio/speech", "/v1/images/generations", "/v1/audio/diarizations", "/api/kv-estimate"]);
const NO_GRANT = "a model call waits in line first (spec/hostapi.v1.md)";
const SECRET_NAME = /^[A-Za-z0-9._:-]{1,128}$/;

const rid = (p) => p + randomBytes(12).toString("hex");

function send(res, status, body, type = "application/json") {
  if (res.headersSent) return res.end();
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": b.length });
  res.end(b);
}
const text = (res, status, words) => send(res, status, words + "\n", "text/plain; charset=utf-8");

async function readBody(req, max = 32 << 20) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Go's decoder matches a field's name in any case; a value of the wrong
// type fails the body, naming the field and the type it takes.
function field(obj, name) {
  if (!obj || typeof obj !== "object") return undefined;
  if (name in obj) return obj[name];
  const k = Object.keys(obj).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

function typeWhy(where, value, want) {
  if (value === undefined || value === null) return "";
  const got = Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : typeof value === "string" ? "a string" : typeof value === "boolean" ? "a boolean" : "a number";
  const ok = want === "string" ? typeof value === "string" : want === "boolean" ? typeof value === "boolean" : want === "integer" ? Number.isInteger(value) : want === "object" ? typeof value === "object" && !Array.isArray(value) : true;
  if (ok) return "";
  const article = { string: "a string", boolean: "a boolean", integer: "an integer", object: "an object" }[want];
  return `${where} is ${article}, not ${got}`;
}

/** What is wrong with a wait's body, as the host reads it, or "". */
export function checkWaitBody(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "the body is not a JSON object";
  const checks = [
    ["kind", field(b, "kind"), "string"],
    ["lane", field(b, "lane"), "string"],
    ["pick", field(b, "pick"), "string"],
    ["turn", field(b, "turn"), "boolean"],
    ["tag", field(b, "tag"), "object"],
    ["ticket", field(b, "ticket"), "object"],
    ["call", field(b, "call"), "object"],
  ];
  const tag = field(b, "tag");
  for (const [k, t] of [["Person", "string"], ["Task", "string"], ["Model", "string"], ["Job", "boolean"], ["Conversation", "string"], ["App", "string"], ["Key", "string"]]) {
    checks.push([`tag.${k}`, field(tag, k), t]);
  }
  const ticket = field(b, "ticket");
  for (const [k, t] of [["origin", "string"], ["from", "string"], ["person", "string"], ["firing", "string"], ["request", "string"], ["heavy", "boolean"], ["end_if_left", "boolean"]]) {
    checks.push([`ticket.${k}`, field(ticket, k), t]);
  }
  const call = field(b, "call");
  for (const k of ["prompt", "max_tokens"]) checks.push([`call.${k}`, field(call, k), "integer"]);
  for (const [where, v, want] of checks) {
    const why = typeWhy(where, v, want);
    if (why) return why;
  }
  return "";
}

export function createHostSocket(host) {
  const L = host.ledger;
  const manifest = host.manifest;
  const tasks = new Map((manifest.tasks ?? []).map((t) => [t.id, t]));
  const perms = manifest.permissions ?? [];
  const usePerm = perms.find((p) => p.id === "models.use");
  const netItems = perms.filter((p) => p.id.startsWith("net.")).map((p) => p.id);
  const hasTriggers = (manifest.triggers ?? []).length > 0 && perms.some((p) => p.id === "compute.background");
  const live = new Map(); // grant id -> {model, picked, unit, maxOut, released}
  const works = new Map(); // work id -> {ended, lane, ticket, model}
  const triggers = new Map(); // row id -> trigger
  host.triggers = triggers;

  function ticketWhy(t, lane) {
    const origin = field(t, "origin") ?? "";
    const from = field(t, "from") ?? "";
    let person = field(t, "person") ?? "";
    const request = field(t, "request") ?? "";
    const firingId = field(t, "firing") ?? "";
    const heavy = !!field(t, "heavy");
    let liveTurn = false;
    const issued = request ? host.issued.get(request) : undefined;
    const firing = (fid) => {
      const f = host.firings.get(fid);
      if (!f) return "no such firing";
      if ((f.person ?? "") !== person) return "this firing is someone else's";
      return "";
    };
    switch (origin) {
      case "request":
        if (!issued) person = "";
        else if (person !== issued.person) return { why: "this request is someone else's" };
        liveTurn = !!issued && Date.now() - issued.at < TURN_MS;
        if (lane === "P") return liveTurn ? { person } : { why: `no ticket for lane P: request ${JSON.stringify(request)} is not one the host passed to this app in the last 20 minutes` };
        return lane === "B" || lane === "I" ? { person } : { why: `no ticket for lane ${lane}` };
      case "firing": {
        const w = firing(firingId);
        if (w) return { why: w };
        if (heavy) return lane === "I" ? { person } : { why: `a heavy firing waits in lane I, not ${lane}` };
        return lane === "B" || lane === "I" ? { person } : { why: `a firing's work waits in lane B or I, not ${lane}` };
      }
      case "job":
        if (from === "firing") {
          const w = firing(firingId);
          if (w) return { why: w };
          return lane === "B" || lane === "I" ? { person } : { why: `a firing's job waits in lane B or I, not ${lane}` };
        }
        if (from === "request" && request) {
          if (!issued) return { why: "no such request" };
          if (person !== issued.person) return { why: "this request is someone else's" };
          liveTurn = Date.now() - issued.at < TURN_MS;
          if (lane === "P" && !liveTurn) return { person, lane: "B", note: "a job past its request's turn waits in lane B" };
          return LANES.has(lane) && lane !== "A" ? { person } : { why: `no ticket for lane ${lane}` };
        }
        if (from === "request" || from === "resume") return lane === "B" || lane === "I" ? { person } : lane === "P" ? { person, lane: "B", note: "a resumed job waits in lane B" } : { why: `no ticket for lane ${lane}` };
        return { why: `a job's ticket says what started it (from: request, firing or resume), not ${JSON.stringify(from)}` };
      case "resume":
        return lane === "B" || lane === "I" ? { person } : { why: `no ticket for lane ${lane}` };
      case "upkeep":
        return lane === "I" ? { person } : { why: `no ticket for lane ${lane}` };
      default:
        return { why: `an app cannot wait on a ${origin || "none"} ticket` };
    }
  }

  async function wait(req, res) {
    let b;
    try {
      b = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return text(res, 400, "bad request: the body is not JSON");
    }
    const bad = checkWaitBody(b);
    if (bad) {
      L.note(`a wait's body was refused: ${bad}`);
      return text(res, 400, `bad request: ${bad}`);
    }
    const kind = field(b, "kind") ?? "";
    let lane = field(b, "lane") ?? "";
    const tag = { ...(field(b, "tag") ?? {}) };
    const t = field(b, "ticket") ?? {};
    const entry = L.wait({ kind, lane, tag, ticket: t, pick: field(b, "pick") ?? "", turn: !!field(b, "turn"), call: field(b, "call") ?? null });
    if (!LANES.has(lane)) {
      entry.refused = "unknown lane";
      L.save();
      return text(res, 400, "unknown lane");
    }
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const line = (o) => res.write(JSON.stringify(o) + "\n");
    const refuse = (why) => {
      entry.refused = why;
      L.save();
      line({ refused: why });
      res.end();
    };
    const tk = ticketWhy(t, lane);
    if (tk.why) return refuse(tk.why);
    if (tk.lane) {
      L.note(`${tk.note} (wait ${entry.seq})`);
      lane = tk.lane;
      entry.moved_to = lane;
    }
    const taggedPerson = field(tag, "Person") ?? "";
    if (taggedPerson && taggedPerson !== tk.person) L.note(`wait ${entry.seq}'s tag named person ${taggedPerson}; the host's word is its ticket's (${tk.person || "no one"})`);
    tag.Person = tk.person;
    if (!["begin", "acquire", "try"].includes(kind)) return refuse("unknown kind of wait");

    let gone = false;
    req.on("close", () => (gone = true));
    res.on("close", () => (gone = true));
    line({ position: 1, ahead: 0, running: 0, seats: 1, waiting: "next on the harness's fake line" });
    await host.lineGate(); // a test may hold the line closed
    if (host.lineDelayMs) await new Promise((r) => setTimeout(r, host.lineDelayMs));
    if (gone) {
      entry.left_early = true;
      L.save();
      return;
    }
    if (kind === "begin") {
      const wid = rid("w_");
      works.set(wid, { ended: false, lane, person: tk.person, model: field(tag, "Model") ?? "" });
      L.work({ id: wid, wait: entry.seq, lane, origin: t.origin, from: t.from ?? "", person: tk.person, request: t.request ?? "" });
      entry.answer = { id: wid, kind: "work" };
      L.save();
      line({ id: wid, cache_key: rid("k_") });
      return res.end();
    }
    let model = field(tag, "Model") ?? "";
    const pick = field(b, "pick") ?? "";
    if (pick === "chat" && !model) {
      const task = field(tag, "Task") ?? "";
      const r = tasks.has(task) ? await host.models.route(task, "chat") : { models: [] };
      model = r.models[0] ?? "";
      if (!model) return refuse(`no model on this Mac may do ${task || "a task it did not name"}`);
    }
    const windows = model ? ((await host.models.route("", "chat").catch(() => ({}))).windows ?? {}) : {};
    const gid = rid("g_");
    const unit = !!model && (pick === "chat" || !field(b, "turn"));
    const call = field(b, "call");
    live.set(gid, { model, picked: pick === "chat", unit, maxOut: call?.max_tokens > 0 ? call.max_tokens : 0, released: false });
    L.grant({ id: gid, via: kind, wait: entry.seq, model, lane, origin: t.origin, from: t.from ?? "", person: tk.person, request: t.request ?? "", firing: t.firing ?? "", task: field(tag, "Task") ?? "", job: !!field(tag, "Job") });
    entry.answer = { id: gid, kind: "grant" };
    L.save();
    const adm = { id: gid, cache_key: rid("k_") };
    if (kind !== "try" && model) {
      adm.model = model;
      if (windows[model]) adm.window = windows[model];
    }
    line(adm);
    res.end();
  }

  async function admit(req, res) {
    let b;
    try {
      b = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return text(res, 400, "bad request: the body is not JSON");
    }
    const workId = field(b, "work") ?? "";
    const w = works.get(workId);
    if (!w || w.ended) return text(res, 410, "ended");
    const call = field(b, "call") ?? {};
    const model = field(call, "Model") || w.model;
    const maxOut = field(call, "MaxOut") ?? 0;
    const gid = rid("g_");
    live.set(gid, { model, picked: false, unit: true, maxOut: maxOut > 0 ? maxOut : 0, released: false });
    L.grant({ id: gid, via: "admit", work: workId, model, lane: w.lane, origin: "work", person: w.person });
    const lw = L.works[workId];
    if (lw) lw.admits++;
    send(res, 200, model ? { grant: gid, model } : { grant: gid });
  }

  async function release(req, res) {
    let b;
    try {
      b = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return text(res, 400, "bad request: the body is not JSON");
    }
    const gid = field(b, "grant") ?? "";
    const g = live.get(gid);
    if (g) g.released = true;
    L.release(gid, field(b, "notes") ?? null);
    send(res, 204);
  }

  async function end(req, res) {
    let b;
    try {
      b = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return text(res, 400, "bad request: the body is not JSON");
    }
    const wid = field(b, "work") ?? "";
    const w = works.get(wid);
    if (w) w.ended = true;
    L.end(wid);
    send(res, 204);
  }

  async function modelCall(path, req, res) {
    const gid = req.headers["x-nc-grant"] ?? "";
    const g = live.get(gid);
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return text(res, e.status ?? 400, e.message);
    }
    if (!g || g.released) {
      L.refusedCall({ path, grant: gid || null, why: gid ? (g ? "its grant was given back" : "its grant is none the line gave") : "it carries no X-NC-Grant", status: 403 });
      return text(res, 403, NO_GRANT);
    }
    let body = null;
    const json = (req.headers["content-type"] ?? "").includes("json");
    if (json) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: { message: "the call's body is not JSON", type: "invalid_request_error" } });
      }
    }
    if (body && g.model && g.unit && body.model !== g.model) {
      if (g.picked) {
        body.model = g.model;
        raw = Buffer.from(JSON.stringify(body));
      } else {
        L.refusedCall({ path, grant: gid, why: `the grant was given for ${g.model}, the call names ${body.model}`, status: 403 });
        return text(res, 403, "this turn in line was given for calls on its model only: wait again for this call, naming the model it waits for");
      }
    }
    if (body && path === "/v1/chat/completions" && g.maxOut > 0) {
      const mt = body.max_tokens;
      if (mt === undefined || mt === null || !Number.isInteger(mt) || mt <= 0 || mt > g.maxOut) {
        L.refusedCall({ path, grant: gid, why: `max_tokens ${JSON.stringify(mt)} against the ${g.maxOut} its wait said`, status: 400 });
        return send(res, 400, { error: { message: `This call's max_tokens (${JSON.stringify(mt ?? null)}) is not within the ${g.maxOut} tokens of answer it waited in line for: send max_tokens ${g.maxOut} or less.`, type: "invalid_request_error", code: "over_admitted" } });
      }
    }
    const t0 = Date.now();
    let info;
    try {
      info = await host.models.call(path, body, req, res, raw);
    } catch (e) {
      info = { status: 500, error: e.message };
      if (!res.headersSent) send(res, 500, { error: { message: `the harness's model failed: ${e.message}`, type: "server_error" } });
      else res.end();
    }
    L.call({ path, grant: gid, model: body?.model ?? null, ms: Date.now() - t0, ...info });
  }

  async function secrets(req, res, name) {
    if (!SECRET_NAME.test(name)) return send(res, 400, { error: "bad_name" });
    const store = host.secrets;
    if (req.method === "GET") {
      if (!store.has(name)) return send(res, 404, { error: "not_found" });
      return send(res, 200, { name, value: store.get(name) });
    }
    if (req.method === "PUT") {
      let b;
      try {
        b = JSON.parse((await readBody(req, 1 << 20)).toString("utf8"));
      } catch {
        return send(res, 400, { error: "not_json" });
      }
      if (typeof b?.value !== "string") return send(res, 400, { error: "a value is a string" });
      if (Buffer.byteLength(b.value) > 64 * 1024) return send(res, 413, { error: "too_large" });
      store.set(name, b.value);
      host.saveState();
      L.note(`the app kept a secret named ${name}`);
      return send(res, 204);
    }
    if (req.method === "DELETE") {
      store.delete(name);
      host.saveState();
      return send(res, 204);
    }
    return text(res, 405, "method not allowed");
  }

  async function table(req, res, op) {
    if (!hasTriggers) return text(res, 404, "404 page not found");
    let c = {};
    try {
      c = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      return text(res, 400, "invalid JSON body");
    }
    L.note(`triggers table: ${op}`);
    switch (op) {
      case "put": {
        const tr = c.trigger ?? {};
        const rowId = tr.ID ?? tr.id;
        if (!rowId) return text(res, 400, "put names one trigger");
        triggers.set(rowId, { ...tr, Person: c.person ?? "" });
        return send(res, 200, {});
      }
      case "set":
        for (const [k, v] of triggers) if ((v.Person ?? "") === (c.person ?? "")) triggers.delete(k);
        for (const tr of c.list ?? []) triggers.set(tr.ID ?? tr.id, { ...tr, Person: c.person ?? "" });
        return send(res, 200, {});
      case "remove":
        triggers.delete(c.id);
        return send(res, 200, {});
      case "get":
        return triggers.has(c.id) ? send(res, 200, triggers.get(c.id)) : text(res, 404, "not found");
      case "list":
        return send(res, 200, [...triggers.values()].filter((t) => (t.Person ?? "") === (c.person ?? "")));
      case "all":
        return send(res, 200, [...triggers.values()]);
      default:
        return send(res, 200, {});
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://host.invalid");
    const p = url.pathname;
    L.route(req.method, p.replace(/\/host\/v1\/(secrets|people)\/[^/]+/, "/host/v1/$1/<x>"));
    if (req.headers.authorization !== `Bearer ${host.credential}`) {
      L.unauthorized++;
      L.save();
      return send(res, 401, { error: { message: "the host's socket answers only the app's own credential", type: "authentication_error" } });
    }
    try {
      if (MODEL_CALLS.has(p) && req.method === "POST") return await modelCall(p, req, res);
      if (p === "/host/v1/line/wait" && req.method === "POST") return await wait(req, res);
      if (p === "/host/v1/line/admit" && req.method === "POST") return await admit(req, res);
      if (p === "/host/v1/line/release" && req.method === "POST") return await release(req, res);
      if (p === "/host/v1/line/end" && req.method === "POST") return await end(req, res);
      if (p === "/host/v1/line/state" && req.method === "GET") {
        const r = await host.models.route("", "chat");
        return send(res, 200, { depth: 0, busy: false, wanted: 0, drain: false, seats_for: Object.fromEntries(r.models.map((m) => [m, 1])) });
      }
      if (p === "/host/v1/models" && req.method === "GET") {
        const task = url.searchParams.get("task") ?? "";
        const kind = url.searchParams.get("kind") || "chat";
        if (!KINDS.has(kind)) return text(res, 400, `unknown kind ${kind}`);
        const named = !usePerm?.tasks || usePerm.tasks.includes(task);
        if (!tasks.has(task) || !usePerm || !named) {
          L.note(`models route: ${!tasks.has(task) ? `task ${JSON.stringify(task)} is not in the manifest's tasks` : "the manifest's models.use does not name it"} (404)`);
          return text(res, 404, "404 page not found");
        }
        return send(res, 200, await host.models.route(task, kind));
      }
      if (p === "/host/v1/units" && req.method === "POST") {
        try {
          L.units.push({ at: new Date().toISOString(), report: JSON.parse((await readBody(req)).toString("utf8")) });
        } catch {
          return text(res, 400, "bad request: the body is not JSON");
        }
        L.save();
        return send(res, 204);
      }
      if (p.startsWith("/host/v1/secrets/")) return await secrets(req, res, decodeURIComponent(p.slice("/host/v1/secrets/".length)));
      const role = /^\/host\/v1\/people\/([^/]+)\/role$/.exec(p);
      if (role && req.method === "GET") {
        const person = host.personById(decodeURIComponent(role[1]));
        if (!person) return text(res, 404, "404 page not found");
        return send(res, 200, { person: person.id, role: person.role });
      }
      if (p === "/host/v1/grants" && req.method === "GET") {
        const id = url.searchParams.get("person");
        if (!id) return text(res, 400, "a person");
        if (!host.personById(id)) return text(res, 404, "404 page not found");
        return send(res, 200, { person: id, on: netItems });
      }
      if (p === "/host/v1/role" && req.method === "POST") return send(res, 204);
      if ((p === "/host/v1/triggers/kick" || p === "/host/v1/triggers/hello") && req.method === "POST") {
        await readBody(req);
        return send(res, 204);
      }
      if (p.startsWith("/host/v1/triggers/table/") && req.method === "POST") return await table(req, res, p.slice("/host/v1/triggers/table/".length));
      if ((p === "/host/v1/triggers/firings/done" || p === "/host/v1/triggers/firings/renew") && req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const f = host.firings.get(b.firing);
        if (!f) return text(res, 404, "no running firing of this app's by that id");
        if (p.endsWith("/done")) {
          if (f.done) return text(res, 409, "settled already");
          f.done = b.outcome ?? "done";
          return send(res, 204);
        }
        return send(res, 200, { lease_until: new Date(Date.now() + 600000).toISOString() });
      }
      if (p === "/host/v1/main/hand" && req.method === "POST") {
        await readBody(req);
        return send(res, 409, { code: "no_main", words: "This computer is not joined to a main: the app keeps this work itself." });
      }
      if (p === "/v1/models" && req.method === "GET") {
        const data = (await host.models.list()).map((m) => ({ object: "model", owned_by: "nativecluster", created: 0, ...m }));
        return send(res, 200, { object: "list", data });
      }
      if (p === "/api/tags" && req.method === "GET") return send(res, 200, { models: (await host.models.list()).map((m) => ({ name: m.id, model: m.id, size: 0 })) });
      if (p === "/api/version" && req.method === "GET") return send(res, 200, { version: `harness-${host.models.kind}` });
      if (p === "/api/show" && req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const m = (await host.models.list()).find((x) => x.id === (b.model ?? b.name));
        if (!m) return text(res, 404, "model not found");
        return send(res, 200, { capabilities: m.capabilities ?? [], model_info: { "general.context_length": m.context_length } });
      }
      if (p === "/health" && req.method === "GET") return send(res, 200, { status: "ok" });
      L.note(`the app asked ${req.method} ${p}, which an installed app's socket does not answer (404)`);
      return text(res, 404, "404 page not found");
    } catch (e) {
      L.note(`the fake host failed on ${req.method} ${p}: ${e.message}`);
      if (!res.headersSent) text(res, 500, "the fake host failed: " + e.message);
      else res.end();
    }
  });
  server.live = live;
  return server;
}
