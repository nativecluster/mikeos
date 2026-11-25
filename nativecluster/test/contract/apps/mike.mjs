// The contract tests' hooks for Mike packaged as a NativeCluster app.
//
// Pablo, 2026-11-24: NativeCluster is Mike's only login. Each NativeCluster
// person (the ticket's person, which the launcher passes to the backend as
// X-NC-Person) is a Mike account of its own, made on first use; a request
// naming nobody is refused 403, "Sign in to NativeCluster to use Mike." So a
// person here is a ticket and nothing else: no Mike session, no sign-in.
//
// Chosen for a package whose manifest id or name says Mike (harness.mjs).
// The launcher proxies /api/* to the backend, the prefix stripped
// (/api/health is the backend's /health; /api/projects its /projects).

import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const name = "mike";
export const NOBODY_WORDS = "Sign in to NativeCluster to use Mike.";

/** Up once the backend answers through the launcher. */
export async function ready(host) {
  const deadline = Date.now() + 300000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await host.request("GET", "/api/health", { as: "alice", timeoutMs: 10000 });
      if (r.status === 200) return r.json;
      last = `${r.status} ${r.text.slice(0, 100)}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error(`Mike's backend did not answer /api/health within 300 s (last: ${last})`);
}

const projectNames = async (host, as, headers = {}) => {
  const r = await host.request("GET", "/api/projects", { as, headers });
  if (r.status !== 200) throw new Error(`GET /api/projects as ${as ?? "nobody"} answered ${r.status}: ${r.text.slice(0, 200)}`);
  return (Array.isArray(r.json) ? r.json : (r.json?.projects ?? [])).map((p) => p.name);
};

/** A project of alice's, made through the API as the frontend makes one. */
export async function seed(host) {
  const name = `contract ${Date.now()}`;
  const r = await host.request("POST", "/api/projects", { as: "alice", body: { name } });
  if (r.status >= 300) throw new Error(`POST /api/projects answered ${r.status}: ${r.text.slice(0, 200)}`);
  if (!(await projectNames(host, "alice")).includes(name)) throw new Error("alice's new project is not in her list");
  return { name };
}

/** After the restart: alice still has it, bob never saw it, nobody gets 403. */
export async function kept(host, { name }) {
  if (!(await projectNames(host, "alice")).includes(name)) throw new Error(`alice's project "${name}" was gone after the restart`);
  if ((await projectNames(host, "bob")).includes(name)) throw new Error(`bob sees alice's project "${name}"`);
  const nobody = await host.request("GET", "/api/projects", { as: null });
  if (nobody.status !== 403 || !nobody.text.includes(NOBODY_WORDS)) {
    throw new Error(`a request naming nobody answered ${nobody.status} ${nobody.text.slice(0, 200)}, not 403 "${NOBODY_WORDS}"`);
  }
}

/**
 * Forged X-NC-* headers reach the launcher (the real host passes them on):
 * the backend must still act for the ticket's person, never the forged one.
 */
export async function forgedHeaders(host, forged) {
  const { name } = await seed(host);
  const alice = host.person("alice");
  if (!(await projectNames(host, "alice", forged)).includes(name)) throw new Error("alice, with forged X-NC-* headers naming bob, lost her own project");
  if ((await projectNames(host, "bob", { ...forged, "x-nc-person": alice.id })).includes(name)) throw new Error("bob, forging X-NC-Person as alice, saw alice's project");
  const nobody = await host.request("GET", "/api/projects", { as: null, headers: { ...forged, "x-nc-person": alice.id } });
  if (nobody.status !== 403) throw new Error(`a ticket naming nobody, forging X-NC-Person as alice, answered ${nobody.status}`);
}

/** Requests a browser makes, so the sandbox sees the stack at work. */
export async function exercise(host) {
  for (const p of ["/", "/assistant", "/projects", "/api/health"]) {
    const r = await host.request("GET", p, { as: "alice" });
    if (r.status >= 500) throw new Error(`GET ${p} answered ${r.status}`);
  }
  await seed(host);
}

/**
 * A chat turn's answer, read as it streams over the app's socket: its frames
 * as they come, `until(pred)` for the first frame that matches, and
 * `leave()` to hang up while the turn goes on in the app.
 */
function streamTurn(host, as, content) {
  const frames = [];
  const waiters = [];
  let ended = false;
  let failure = null;
  const settle = () => {
    for (const w of [...waiters]) {
      const hit = frames.find(w.pred);
      if (hit || ended) {
        waiters.splice(waiters.indexOf(w), 1);
        if (hit) w.resolve(hit);
        else w.reject(new Error(`the turn's stream ended without the frame looked for (${failure ?? "ended"}); frames: ${JSON.stringify(frames).slice(0, 400)}`));
      }
    }
  };
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }], model: "nativecluster/fake:harness" }));
  const req = http.request({
    socketPath: host.appSocket,
    path: "/api/chat",
    method: "POST",
    agent: false,
    headers: { "x-nc-ticket": host.mint(as).header, "content-type": "application/json", "content-length": body.length, accept: "text/event-stream" },
  });
  req.on("response", (res) => {
    let tail = "";
    res.on("data", (chunk) => {
      const lines = (tail + chunk.toString("utf8")).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          frames.push(JSON.parse(line.slice(6)));
        } catch {}
      }
      settle();
    });
    const end = () => {
      ended = true;
      settle();
    };
    res.on("end", end);
    res.on("close", end);
  });
  req.on("error", (e) => {
    failure = e.message;
    ended = true;
    settle();
  });
  req.end(body);
  return {
    frames,
    until: (pred, ms = 60000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no such frame in ${ms} ms; frames: ${JSON.stringify(frames).slice(0, 400)}`)), ms);
        waiters.push({ pred, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
        settle();
      }),
    ended: () => ended,
    leave: () => req.destroy(),
  };
}

const unreleased = (host) => Object.values(host.ledger.grants).filter((g) => g.releases.length === 0);

/**
 * The line test's model calls (the models campaign's bug 2, 2026-11-24:
 * stopping mid-turn left grants unreleased): one chat turn is stopped with
 * its Stop while its answer streams, and every grant it took is given back
 * once; a second is left streaming, its reader gone, so the test's stop of
 * the app (SIGTERM) comes in the middle of it, and the ledger is held to one
 * release a grant after that too. The answers stream slowly ([[fake:slow]]),
 * so each stop lands mid-answer.
 */
export async function drive(host, t) {
  const slow = (tag) => `[[fake:no-tools]] [[fake:slow 250]] [[fake:say ${"A slow harness answer. ".repeat(40)}]] ${tag}`;

  const stopped = streamTurn(host, "alice", slow("Stop me."));
  const ids = await stopped.until((f) => f.type === "chat_id");
  await stopped.until((f) => f.type === "content_delta");
  const stop = await host.request("POST", `/api/chat/${ids.chatId}/turn/${ids.turnId}/stop`, { as: "alice", body: {} });
  if (stop.status !== 200) throw new Error(`the turn's Stop answered ${stop.status}: ${stop.text.slice(0, 200)}`);
  await stopped.until((f) => f.type === "cancelled" || f.type === "stopped" || f.type === "error", 30000).catch(() => null);
  const deadline = Date.now() + 30000;
  while (unreleased(host).length && Date.now() < deadline) await sleep(100);
  const left = unreleased(host);
  if (left.length) throw new Error(`after Stop, grants never given back: ${JSON.stringify(left.map((g) => ({ id: g.id, task: g.tag?.Task, calls: g.calls })))}`);
  t.diagnostic(`Stop mid-answer: ${Object.keys(host.ledger.grants).length} grants, each given back once`);

  const left2 = streamTurn(host, "alice", slow("Stop the app under me."));
  await left2.until((f) => f.type === "content_delta");
  left2.leave();
  t.diagnostic("a second turn left streaming, its reader gone, for the app's stop");
}

export const expectedDenials = [];
