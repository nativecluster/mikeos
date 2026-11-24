import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";
import {
  INFERENCE_ONLY_DETAIL,
  resetNativeClusterModelCache,
} from "./nativecluster";
import { ProviderConfigurationError } from "./providerErrors";
import type { OpenAIToolSchema } from "./types";

const BASE = "http://nc.test/v1";

const MODELS = {
  object: "list",
  data: [
    {
      id: "qwen3.8:27b",
      object: "model",
      kind: "chat",
      context_length: 65536,
      max_output_tokens: 8192,
      capabilities: ["completion", "tools", "thinking"],
    },
    {
      id: "gemma4:4b",
      object: "model",
      kind: "chat",
      context_length: 32768,
      capabilities: ["completion", "tools"],
    },
  ],
};

const READ_DOCUMENT: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read a document",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
};

/** NativeCluster's stream: keep-alives while queued, then the chunks. */
function sse(chunks: Record<string, unknown>[]): Response {
  return new Response(
    ": waiting\n\n: waiting\n\n" +
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };

let dir: string;
let calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }>;

function stubNativeCluster(answers: Response[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/models`) return Response.json(MODELS);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, init: init ?? {}, body });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return answer;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  resetNativeClusterModelCache();
  calls = [];
  dir = await mkdtemp(path.join(tmpdir(), "nativecluster-provider-"));
  const envFile = path.join(dir, "env.sh");
  await writeFile(
    envFile,
    "export OPENAI_BASE_URL='http://localhost:8487/v1'\n" +
      "export OPENAI_API_KEY='nct_session'\n" +
      "export NATIVECLUSTER_API_KEY='nct_session'\n",
  );
  vi.stubEnv("NATIVECLUSTER_BASE_URL", BASE);
  vi.stubEnv("NATIVECLUSTER_API_KEY", "");
  vi.stubEnv("NATIVECLUSTER_ENV_FILE", envFile);
  vi.stubEnv("MIKE_INFERENCE_PROVIDER", "");
  vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("NativeCluster adapter", () => {
  it("streams a tool turn and a thinking answer from the group's Macs", async () => {
    stubNativeCluster([
      // A tool call arrives whole, in one chunk.
      sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_document",
                      arguments: '{"id":"doc-1"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage },
      ]),
      sse([
        { choices: [{ index: 0, delta: { content: "<think>Checking the " } }] },
        { choices: [{ index: 0, delta: { content: "clause.</think>The notice " } }] },
        { choices: [{ index: 0, delta: { content: "period is 30 days." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage },
      ]),
    ]);
    const runTools = vi.fn(async () => [
      { tool_use_id: "call-1", content: "30 days" },
    ]);
    const onContentDelta = vi.fn();
    const onReasoningDelta = vi.fn();
    const onToolCallStart = vi.fn();
    const onUsage = vi.fn();

    const result = await streamWithProvider({
      model: "nativecluster/qwen3.8:27b",
      systemPrompt: "Review the document.",
      messages: [{ role: "user", content: "What is the notice period?" }],
      reasoning: "high",
      conversationId: "chat-1",
      tools: [READ_DOCUMENT],
      runTools,
      callbacks: { onContentDelta, onReasoningDelta, onToolCallStart, onUsage },
    });

    expect(result.fullText).toBe("The notice period is 30 days.");
    expect(onContentDelta.mock.calls.join("")).toBe(result.fullText);
    expect(onReasoningDelta.mock.calls.join("")).toBe("Checking the clause.");
    expect(onToolCallStart).toHaveBeenCalledWith({
      id: "call-1",
      name: "read_document",
      input: { id: "doc-1" },
    });
    expect(runTools).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 12, outputTokens: 5 }),
      "tool-calls",
    );

    expect(calls).toHaveLength(2);
    for (const { url, init, body } of calls) {
      expect(url).toBe(`${BASE}/chat/completions`);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer nct_session",
      );
      // Tool turns stream too: NativeCluster parses the calls itself.
      expect(body).toMatchObject({
        model: "qwen3.8:27b",
        stream: true,
        stream_options: { include_usage: true },
        think: true,
        max_tokens: 8192,
      });
      expect(body.tools).toHaveLength(1);
      // Nothing only a hosted provider reads.
      for (const field of [
        "reasoning_effort",
        "prompt_cache_key",
        "store",
        "user",
        "service_tier",
      ]) {
        expect(body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(body)).not.toContain("cache_control");
    }
    const followup = calls[1]!.body.messages as Array<Record<string, unknown>>;
    expect(followup.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: "30 days",
    });
  });

  it("recovers a tool call a model wrote as text", async () => {
    stubNativeCluster([
      sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                content:
                  '<tool_call>{"name":"read_document","arguments":{"id":"doc-2"}}</tool_call>',
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]),
      sse([
        { choices: [{ index: 0, delta: { content: "Done." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]),
    ]);
    const runTools = vi.fn(async (toolCalls: Array<{ id: string }>) =>
      toolCalls.map((call) => ({ tool_use_id: call.id, content: "text" })),
    );
    const onContentDelta = vi.fn();
    const result = await streamWithProvider({
      model: "nativecluster/qwen3.8:27b",
      systemPrompt: "S",
      messages: [{ role: "user", content: "Read doc-2." }],
      tools: [READ_DOCUMENT],
      runTools,
      callbacks: { onContentDelta },
    });
    expect(runTools).toHaveBeenCalledWith([
      expect.objectContaining({ name: "read_document", input: { id: "doc-2" } }),
    ]);
    expect(result.fullText).toBe("Done.");
    expect(onContentDelta.mock.calls.join("")).not.toContain("tool_call");
  });

  it("asks a thinking model not to think for a one-shot completion", async () => {
    stubNativeCluster([
      Response.json({
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Notice Period Review" },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
      Response.json({
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Lease Terms" },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
    ]);
    await expect(
      completeWithProvider({
        model: "nativecluster/qwen3.8:27b",
        user: "Title this chat.",
        maxTokens: 64,
      }),
    ).resolves.toBe("Notice Period Review");
    expect(calls[0]!.body).toMatchObject({
      model: "qwen3.8:27b",
      think: false,
      max_tokens: 64,
    });
    // A model without thinking is never sent the switch.
    await expect(
      completeWithProvider({ model: "nativecluster/gemma4:4b", user: "Title." }),
    ).resolves.toBe("Lease Terms");
    expect(calls[1]!.body).not.toHaveProperty("think");
    expect(calls[1]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("says NativeCluster is not set up when it has no key", async () => {
    vi.stubEnv("NATIVECLUSTER_ENV_FILE", path.join(dir, "missing.sh"));
    const fetchMock = stubNativeCluster([]);
    const failure = streamWithProvider({
      model: "nativecluster/qwen3.8:27b",
      systemPrompt: "S",
      messages: [{ role: "user", content: "Hi" }],
    });
    await expect(failure).rejects.toBeInstanceOf(ProviderConfigurationError);
    await expect(failure).rejects.toThrow(/NativeCluster is not set up/);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/chat/completions")),
    ).toBe(false);
  });
});

describe("MIKE_INFERENCE_PROVIDER=nativecluster", () => {
  it("refuses every other provider before any request leaves", async () => {
    vi.stubEnv("MIKE_INFERENCE_PROVIDER", "nativecluster");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-deployment");
    vi.stubEnv("OPENAI_API_KEY", "sk-deployment");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1");
    const fetchMock = stubNativeCluster([]);
    for (const model of [
      "claude-sonnet-5-5",
      "gpt-6.1-sol",
      "openrouter/anthropic/claude-sonnet-5.5",
      "ollama/qwen3.6",
      "custom/my-model",
    ]) {
      const stream = streamWithProvider({
        model,
        systemPrompt: "S",
        messages: [{ role: "user", content: "Hi" }],
        apiKeys: { claude: "sk-ant-user", custom: "key" },
      });
      await expect(stream).rejects.toBeInstanceOf(ProviderConfigurationError);
      await expect(stream).rejects.toThrow(INFERENCE_ONLY_DETAIL);
      await expect(
        completeWithProvider({ model, user: "Title." }),
      ).rejects.toThrow(INFERENCE_ONLY_DETAIL);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still runs NativeCluster's models", async () => {
    vi.stubEnv("MIKE_INFERENCE_PROVIDER", "nativecluster");
    stubNativeCluster([
      sse([
        { choices: [{ index: 0, delta: { content: "Hello." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]),
    ]);
    const result = await streamWithProvider({
      model: "nativecluster/gemma4:4b",
      systemPrompt: "S",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.fullText).toBe("Hello.");
  });
});
