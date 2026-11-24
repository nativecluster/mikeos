import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNcCall, runInNcJob, runInNcRequest, type NcRequest } from "../context";
import { forgetHostTaskModels, HOST_LINE_BASE_URL, hostLineFetch } from "../hostLine";
import { resetLaunchSecrets, setNcAppCredential } from "../launchSecrets";
import { closeUnixSocketAgents } from "../unixFetch";
import { isNativeClusterRefusal } from "../../llm/aiSdk";
import {
  CREDENTIAL,
  eventually,
  heldStream,
  sse,
  startFakeHost,
  status,
  streamAnswer,
  wholeAnswer,
  type FakeHost,
} from "./fakeHost";

let host: FakeHost;

beforeEach(async () => {
  host = await startFakeHost();
  vi.stubEnv("NATIVECLUSTER_TRANSPORT", "host");
  vi.stubEnv("LB_HOST_SOCKET", host.socketPath);
  setNcAppCredential(CREDENTIAL);
  forgetHostTaskModels();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetLaunchSecrets();
  forgetHostTaskModels();
  await closeUnixSocketAgents();
  await host.close();
});

const REQUEST: NcRequest = { person: "p_alice", request: "req_1", at: Date.now(), task: "assistant" };

function chat(body: Record<string, unknown> = {}, init: RequestInit = {}) {
  return hostLineFetch(`${HOST_LINE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-the-credential" },
    body: JSON.stringify({ model: "qwen3.8:27b", messages: [{ role: "user", content: "Hi" }], stream: true, ...body }),
    ...init,
  });
}

function asRequest<T>(fn: () => Promise<T>, request: Partial<NcRequest> = {}): Promise<T> {
  return runInNcRequest({ ...REQUEST, at: Date.now(), ...request }, fn);
}

describe("a model call through the host's line", () => {
  it("waits as the person's request, calls on the grant, and gives it back once with the usage", async () => {
    const response = await asRequest(() => chat());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain("data: [DONE]");

    expect(host.waits).toEqual([
      {
        kind: "acquire",
        lane: "P",
        tag: { Task: "assistant", Model: "qwen3.8:27b", Person: "p_alice" },
        ticket: { origin: "request", person: "p_alice", request: "req_1" },
        pick: "chat",
      },
    ]);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].grant).toMatch(/^g\d+$/);
    expect(host.calls[0].body).toMatchObject({ model: "qwen3.8:27b", cache_key: expect.stringMatching(/^k\d+$/) });
    await eventually(() =>
      expect(host.releases).toEqual([
        { grant: host.calls[0].grant, notes: { model: "qwen3.8:27b", calls: 1, read: 12, written: 5 } },
      ]),
    );
    // Every call carried the app's credential, never the client's key.
    expect(host.unauthorized).toBe(0);
    expect(host.modelReads).toEqual(["assistant"]);
  });

  it("sends the model the line seated the call for", async () => {
    host.waitScripts.push({ lines: [{ id: "g-seat", cache_key: "", model: "gemma4:4b" }] });
    const response = await asRequest(() => chat());
    await response.text();
    expect(host.calls[0].body.model).toBe("gemma4:4b");
    expect(host.calls[0].body).not.toHaveProperty("cache_key");
    await eventually(() => expect(host.releases[0]).toMatchObject({ grant: "g-seat", notes: { model: "gemma4:4b" } }));
  });

  it("gives a whole answer's grant back once it is read, with its usage", async () => {
    host.callScripts.push(wholeAnswer("Done"));
    const response = await asRequest(() => chat({ stream: false }));
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "Done" } }] });
    await eventually(() =>
      expect(host.releases).toEqual([
        { grant: host.calls[0].grant, notes: { model: "qwen3.8:27b", calls: 1, read: 7, written: 3 } },
      ]),
    );
  });

  it("uses the task's first model when the host does not name the one asked for", async () => {
    const response = await asRequest(() => chat({ model: "llama-retired:70b" }));
    await response.text();
    expect((host.waits[0].tag as Record<string, unknown>).Model).toBe("qwen3.8:27b");
    expect(host.calls[0].body.model).toBe("qwen3.8:27b");
  });

  it("runs a call the line stopped again, giving each grant back", async () => {
    host.callScripts.push(status(409, { "X-NC-Stopped": "1" }), status(409, { "X-NC-Lost": "1" }));
    const response = await asRequest(() => chat());
    expect(response.status).toBe(200);
    await response.text();
    expect(host.waits).toHaveLength(3);
    expect(host.calls).toHaveLength(3);
    await eventually(() => expect(host.releases).toHaveLength(3));
    expect(host.releases.map((r) => r.grant)).toEqual(host.calls.map((c) => c.grant));
    expect(host.releases[0]).toMatchObject({ notes: { read: 0, written: 0 } });
    expect(host.releases[2]).toMatchObject({ notes: { read: 12, written: 5 } });
  });

  it("stops after three runs again, in words", async () => {
    for (let i = 0; i < 4; i++) host.callScripts.push(status(409, { "X-NC-Stopped": "1" }));
    const response = await asRequest(() => chat());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "nc_stopped" } });
    expect(response.headers.get("retry-after")).toBe("1");
    expect(host.waits).toHaveLength(4);
    await eventually(() => expect(host.releases).toHaveLength(4));
  });

  it("waits out a 503's Retry-After, reads the task's models again, and runs the call again", async () => {
    host.callScripts.push(status(503, { "Retry-After": "0" }, { error: { message: "engine restarting", code: "engine_restarting" } }));
    const response = await asRequest(() => chat());
    expect(response.status).toBe(200);
    await response.text();
    expect(host.waits).toHaveLength(2);
    expect(host.modelReads).toEqual(["assistant", "assistant"]);
    await eventually(() => expect(host.releases).toHaveLength(2));
  });

  it("passes a 503 without Retry-After on as it is", async () => {
    host.callScripts.push(status(503, {}, { error: "This Mac isn't on for inference.", code: "inference_off" }));
    const response = await asRequest(() => chat());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "inference_off" });
    expect(host.waits).toHaveLength(1);
    await eventually(() => expect(host.releases).toHaveLength(1));
  });

  it("passes a 410 on as an ending, never running it again", async () => {
    host.callScripts.push(status(410, {}, { error: { message: "stopped by an administrator" } }));
    const response = await asRequest(() => chat());
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { message: "stopped by an administrator" } });
    expect(host.waits).toHaveLength(1);
    await eventually(() => expect(host.releases).toHaveLength(1));
  });

  it("gives the grant back once when the app cancels the stream, and the host hears the hang-up", async () => {
    host.callScripts.push(heldStream("Hel"));
    const response = await asRequest(() => chat());
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"content":"Hel"');
    await reader.cancel();
    await eventually(() => expect(host.releases).toHaveLength(1));
    await eventually(() => expect(host.calls[0].closedEarly).toBe(true));
    // A second cancel, or anything else, gives nothing back again.
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.releases).toHaveLength(1);
    expect(host.releases[0]).toMatchObject({ grant: host.calls[0].grant, notes: { calls: 1 } });
  });

  it("gives the grant back once when the call's signal aborts mid-answer", async () => {
    host.callScripts.push(heldStream("Hel"));
    const controller = new AbortController();
    const response = await asRequest(() => chat({}, { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true }).catch(() => undefined);
    await eventually(() => expect(host.releases).toHaveLength(1));
    await eventually(() => expect(host.calls[0].closedEarly).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.releases).toHaveLength(1);
  });

  it("gives the grant back once when the answer fails mid-stream", async () => {
    host.callScripts.push((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([{ choices: [{ index: 0, delta: { content: "x" } }] }], { done: false }));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const response = await asRequest(() => chat());
    await expect(response.text()).rejects.toThrow();
    await eventually(() => expect(host.releases).toHaveLength(1));
  });

  it("leaves the line when the signal aborts while it waits, holding nothing", async () => {
    host.waitScripts.push({ hold: true });
    const controller = new AbortController();
    const calling = asRequest(() => chat({}, { signal: controller.signal }));
    await eventually(() => expect(host.waits).toHaveLength(1));
    controller.abort();
    await expect(calling).rejects.toThrow();
    await eventually(() => expect(host.waitsGivenUp).toBe(1));
    expect(host.calls).toHaveLength(0);
    expect(host.releases).toHaveLength(0);
  });

  it("ends a stream the line cut short with an error frame", async () => {
    host.callScripts.push((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ choices: [{ index: 0, delta: { content: "par" } }] }], { done: false }));
    });
    const response = await asRequest(() => chat());
    const text = await response.text();
    expect(text).toContain('"code":"nc_stopped"');
    await eventually(() => expect(host.releases).toHaveLength(1));
  });

  it("answers a refused wait with the line's words, which the SDK does not retry", async () => {
    host.waitScripts.push({ lines: [{ position: 1 }, { refused: "This Mac isn't on for inference, and it can't reach the Studio." }] });
    const response = await asRequest(() => chat());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { message: "This Mac isn't on for inference, and it can't reach the Studio.", type: "server_error", code: "nc_refused" },
    });
    expect(isNativeClusterRefusal({ responseBody: body })).toBe(true);
    expect(isNativeClusterRefusal({ responseBody: '{"error":{"code":"rate_limited"}}' })).toBe(false);
    expect(host.calls).toHaveLength(0);
    expect(host.releases).toHaveLength(0);
  });

  it("says why when no computer runs a model for the task", async () => {
    host.tasks.assistant = { task: "assistant", models: [], to_get: [], off: "This Mac isn't on for inference." };
    const response = await asRequest(() => chat());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { message: "This Mac isn't on for inference.", code: "nc_refused" } });
    expect(host.waits).toHaveLength(0);
  });

  it("refuses a call nothing started, sending nothing to the host", async () => {
    const response = await chat();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "nc_no_origin" } });
    expect(host.modelReads).toHaveLength(0);
    expect(host.waits).toHaveLength(0);
  });

  it("passes a call that is no model call to the host with the credential", async () => {
    const response = await hostLineFetch(`${HOST_LINE_BASE_URL}/models`, { headers: { authorization: "Bearer other" } });
    expect(await response.json()).toEqual({ other: true });
    expect(host.other).toEqual([{ method: "GET", url: "/v1/models" }]);
    expect(host.unauthorized).toBe(0);
  });
});

describe("the call's task, lane and origin", () => {
  it("names a title as the titles task, with its own models", async () => {
    host.callScripts.push(wholeAnswer("A title"));
    const response = await asRequest(() =>
      runInNcCall({ kind: "complete", task: "titles" }, () => chat({ model: "qwen3.8:27b", stream: false })),
    );
    await response.text();
    expect(host.modelReads).toEqual(["titles"]);
    expect(host.waits[0]).toMatchObject({ lane: "P", tag: { Task: "titles", Model: "gemma4:4b" } });
  });

  it("carries the conversation a chat continues", async () => {
    const response = await asRequest(() => runInNcCall({ kind: "stream", conversation: "chat-42" }, () => chat()));
    await response.text();
    expect(host.waits[0]).toMatchObject({ tag: { Conversation: "chat-42" } });
  });

  it("waits as a job of the request, in lane B, for long work a request starts", async () => {
    const response = await asRequest(() => chat(), { task: "tabular" });
    await response.text();
    expect(host.waits[0]).toMatchObject({
      lane: "B",
      tag: { Task: "tabular", Job: true, Person: "p_alice" },
      ticket: { origin: "job", from: "request", person: "p_alice", request: "req_1" },
    });
  });

  it("waits as a job past the request's turn", async () => {
    const response = await asRequest(() => chat(), { at: Date.now() - 25 * 60 * 1000 });
    await response.text();
    expect(host.waits[0]).toMatchObject({
      lane: "P",
      tag: { Job: true },
      ticket: { origin: "job", from: "request", request: "req_1" },
    });
  });

  it("waits as a DB job in lane B: from its request while the host holds it, resumed after", async () => {
    const fresh = await runInNcJob({ task: "memory", person: "p_bob", request: "req_9", at: Date.now() }, () => chat());
    await fresh.text();
    expect(host.waits[0]).toMatchObject({
      lane: "B",
      tag: { Task: "memory", Job: true, Person: "p_bob" },
      ticket: { origin: "job", from: "request", person: "p_bob", request: "req_9" },
    });
    const old = await runInNcJob({ task: "playbook", person: "p_bob", request: "req_9", at: 1 }, () => chat());
    await old.text();
    expect(host.waits[1]).toMatchObject({
      lane: "B",
      tag: { Task: "playbook" },
      ticket: { origin: "job", from: "resume", person: "p_bob" },
    });
    expect((host.waits[1].ticket as Record<string, unknown>).request).toBeUndefined();
  });

  it("waits again as resumed when the host no longer holds the job's request", async () => {
    host.waitScripts.push({ lines: [{ refused: "no such request" }] });
    const response = await runInNcJob({ task: "tabular", person: "p_bob", request: "req_9", at: Date.now() }, () => chat());
    expect(response.status).toBe(200);
    await response.text();
    expect(host.waits.map((w) => (w.ticket as Record<string, unknown>).from)).toEqual(["request", "resume"]);
  });

  it("uses the assistant's models when the manifest lists no such task", async () => {
    delete host.tasks.memory;
    const response = await runInNcJob({ task: "memory", person: "p_bob" }, () => chat());
    expect(response.status).toBe(200);
    await response.text();
    expect(host.modelReads).toEqual(["memory", "assistant"]);
    expect(host.waits[0]).toMatchObject({ tag: { Task: "memory" } });
  });

  it("keeps a task's models a minute", async () => {
    for (let i = 0; i < 3; i++) await (await asRequest(() => chat())).text();
    expect(host.modelReads).toEqual(["assistant"]);
  });

  it("gives the 2nd and later stream a fresh answer each", async () => {
    host.callScripts.push(streamAnswer(["One"]), streamAnswer(["Two"]));
    const [a, b] = await Promise.all([asRequest(() => chat()), asRequest(() => chat())]);
    const texts = [await a.text(), await b.text()];
    expect(texts.join("")).toContain('"content":"One"');
    expect(texts.join("")).toContain('"content":"Two"');
    await eventually(() => expect(host.releases).toHaveLength(2));
    expect(new Set(host.releases.map((r) => r.grant)).size).toBe(2);
  });
});
