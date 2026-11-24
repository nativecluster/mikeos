// Stage 1's NativeCluster provider inside the app (NATIVECLUSTER_TRANSPORT=host):
// the whole AI SDK stack over a fake host on a unix socket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";
import { contextWindowFor } from "./contextWindow";
import { listNativeClusterModels, nativeClusterChatModelIds, resetNativeClusterModelCache } from "./nativecluster";
import { ProviderConfigurationError } from "./providerErrors";
import { runInNcRequest } from "../nc/context";
import { forgetHostTaskModels } from "../nc/hostLine";
import { resetLaunchSecrets, setNcAppCredential } from "../nc/launchSecrets";
import { closeUnixSocketAgents } from "../nc/unixFetch";
import { CREDENTIAL, eventually, startFakeHost, streamAnswer, wholeAnswer, type FakeHost } from "../nc/__tests__/fakeHost";
import type { OpenAIToolSchema } from "./types";

let host: FakeHost;

beforeEach(async () => {
  host = await startFakeHost();
  vi.stubEnv("NATIVECLUSTER_TRANSPORT", "host");
  vi.stubEnv("MIKE_INFERENCE_PROVIDER", "nativecluster");
  vi.stubEnv("LB_HOST_SOCKET", host.socketPath);
  vi.stubEnv("NATIVECLUSTER_BASE_URL", "");
  vi.stubEnv("NATIVECLUSTER_API_KEY", "");
  vi.stubEnv("NATIVECLUSTER_ENV_FILE", "");
  vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
  vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");
  // Nothing may reach the network or the local address.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("the global fetch was used");
  }));
  setNcAppCredential(CREDENTIAL);
  forgetHostTaskModels();
  resetNativeClusterModelCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetLaunchSecrets();
  forgetHostTaskModels();
  resetNativeClusterModelCache();
  await closeUnixSocketAgents();
  await host.close();
});

const asAlice = <T>(fn: () => Promise<T>) =>
  runInNcRequest({ person: "p_alice", request: "req_1", at: Date.now(), task: "assistant" }, fn);

const READ_DOCUMENT: OpenAIToolSchema = {
  type: "function",
  function: { name: "read_document", description: "Read a document", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
};

describe("the NativeCluster provider through the host's line", () => {
  it("streams a chat turn, tools and all, as the person's request in their conversation", async () => {
    host.callScripts.push((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_document", arguments: '{"id":"doc-1"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } },
      ];
      res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n");
    }, streamAnswer(["The notice ", "period is 30 days."]));
    const runTools = vi.fn(async () => [{ tool_use_id: "call-1", content: "30 days" }]);
    const onContentDelta = vi.fn();

    const result = await asAlice(() =>
      streamWithProvider({
        model: "nativecluster/qwen3.8:27b",
        systemPrompt: "Review the document.",
        messages: [{ role: "user", content: "What is the notice period?" }],
        reasoning: "none",
        conversationId: "chat-1",
        tools: [READ_DOCUMENT],
        runTools,
        callbacks: { onContentDelta },
      }),
    );

    expect(result.fullText).toBe("The notice period is 30 days.");
    expect(runTools).toHaveBeenCalledOnce();
    // One wait and one release per model call (two steps of the turn).
    expect(host.waits).toHaveLength(2);
    for (const wait of host.waits) {
      expect(wait).toEqual({
        kind: "acquire",
        lane: "P",
        tag: { Task: "assistant", Model: "qwen3.8:27b", Person: "p_alice", Conversation: "chat-1" },
        ticket: { origin: "request", person: "p_alice", request: "req_1" },
        pick: "chat",
      });
    }
    expect(host.calls[0].body).toMatchObject({ model: "qwen3.8:27b", stream: true, think: false });
    expect(host.calls[0].body).not.toHaveProperty("reasoning_effort");
    expect(host.calls[0].body.cache_key).toMatch(/^k/);
    await eventually(() => expect(host.releases).toHaveLength(2));
    expect(host.releases.map((r) => r.notes)).toEqual([
      { model: "qwen3.8:27b", calls: 1, read: 30, written: 4 },
      { model: "qwen3.8:27b", calls: 1, read: 12, written: 5 },
    ]);
    expect(host.unauthorized).toBe(0);
  });

  it("names a chat's title the titles task, from the function that writes it", async () => {
    host.callScripts.push(wholeAnswer("Notice period question"));
    async function generateAssistantChatTitle() {
      return completeWithProvider({ model: "nativecluster/qwen3.8:27b", user: "Title this", maxTokens: 64 });
    }
    const title = await asAlice(() => generateAssistantChatTitle());
    expect(title).toBe("Notice period question");
    expect(host.modelReads).toEqual(["titles"]);
    expect(host.waits[0]).toMatchObject({ lane: "P", tag: { Task: "titles", Model: "gemma4:4b" } });
    expect(host.calls[0].body).toMatchObject({ model: "gemma4:4b", think: false });
    await eventually(() => expect(host.releases).toEqual([{ grant: host.calls[0].grant, notes: { model: "gemma4:4b", calls: 1, read: 7, written: 3 } }]));
  });

  it("gives a one-shot completion elsewhere in a chat the assistant task", async () => {
    host.callScripts.push(wholeAnswer("ok"));
    await asAlice(() => completeWithProvider({ model: "nativecluster/qwen3.8:27b", user: "Hi" }));
    expect(host.waits[0]).toMatchObject({ tag: { Task: "assistant", Model: "qwen3.8:27b" } });
  });

  it("does not ask again when the line refuses in words", async () => {
    host.waitScripts.push({ lines: [{ refused: "Mike isn't given to you on this cluster." }] });
    await expect(
      asAlice(() => completeWithProvider({ model: "nativecluster/qwen3.8:27b", user: "Hi" })),
    ).rejects.toThrow(/Mike isn't given to you on this cluster\./);
    expect(host.waits).toHaveLength(1);
  });

  it("lists the assistant task's models with their windows", async () => {
    const models = await listNativeClusterModels();
    expect(models).toEqual([
      { id: "qwen3.8:27b", kind: "chat", contextLength: 65536, capabilities: [] },
      { id: "gemma4:4b", kind: "chat", contextLength: 32768, capabilities: [] },
    ]);
    expect(await nativeClusterChatModelIds()).toEqual(["nativecluster/qwen3.8:27b", "nativecluster/gemma4:4b"]);
    expect(contextWindowFor("nativecluster/qwen3.8:27b")).toBe(65536);
    expect(contextWindowFor("nativecluster/gemma4:4b")).toBe(32768);
    expect(host.modelReads).toEqual(["assistant"]);
  });

  it("lists nothing, and says so, when the host cannot be read", async () => {
    setNcAppCredential("wrong-credential");
    expect(await listNativeClusterModels()).toEqual([]);
  });

  it("refuses at once without the host's socket or the app's credential", async () => {
    resetLaunchSecrets();
    await expect(
      asAlice(() => completeWithProvider({ model: "nativecluster/qwen3.8:27b", user: "Hi" })),
    ).rejects.toBeInstanceOf(ProviderConfigurationError);
    expect(host.waits).toHaveLength(0);
  });
});
