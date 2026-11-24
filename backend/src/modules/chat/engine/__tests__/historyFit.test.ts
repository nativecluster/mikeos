/**
 * The conversation sent with a chat turn fits the model's context window when
 * the window is known: the oldest turns are left out, the model is told so,
 * and a log line records how many (counts only, never the text). With no
 * window known every message is sent, as before.
 *
 * Runs the real AI SDK adapter over the scripted mock model; no model is
 * called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
}));
vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools,
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
  executeMcpToolCall: vi.fn(),
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleWorkspace")>()),
  buildGoogleWorkspaceTools: vi.fn(async () => []),
}));
vi.mock("../../../../lib/integrations/googleDrive", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleDrive")>()),
  buildGoogleDriveTools: vi.fn(async () => []),
}));

import { streamAiSdk } from "../../../../lib/llm/aiSdk";
import {
  config,
  makeModel,
  textStep,
} from "../../../../lib/llm/__tests__/mockLanguageModel";
import { AssistantStreamError, runLLMStream } from "../streaming";

const SECRET = "Project Nightingale";

/** Twenty earlier turns of about 6,000 characters each, then the question. */
const HISTORY = [
  ...Array.from({ length: 20 }, (_, i) => [
    { role: "user", content: `Turn ${i + 1}: tell me about ${SECRET}. ${"q".repeat(3_000)}` },
    { role: "assistant", content: `Answer ${i + 1}. ${"a".repeat(3_000)}` },
  ]).flat(),
  { role: "user", content: "And the latest question?" },
];

async function run(messages: { role: string; content: string }[]) {
  const model = await makeModel([textStep("Here is the answer.")]);
  streamChatWithTools.mockImplementation((params) =>
    streamAiSdk(params, config(model)),
  );
  const outcome = await runLLMStream({
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "system", content: "You are Mike." }, ...messages],
    docStore: new Map() as never,
    docIndex: {} as never,
    userId: "user-1",
    db: {} as never,
    write: () => {},
    includeAskInputs: false,
    includeResearchTools: false,
    allowDocumentMutation: false,
  }).catch((error: unknown) => error);
  return { model, outcome };
}

/** The conversation messages the model was sent, system prompt aside. */
function sentMessages(model: Awaited<ReturnType<typeof makeModel>>) {
  return model.doStreamCalls[0].prompt
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      text: (message.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .join(""),
    }));
}

function systemPrompt(model: Awaited<ReturnType<typeof makeModel>>) {
  const system = model.doStreamCalls[0].prompt.find((m) => m.role === "system");
  return String(system?.content ?? "");
}

let consoleLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  consoleLog.mockRestore();
  vi.unstubAllEnvs();
});

describe("history and the context window", () => {
  it("sends every message when no window is known", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");

    const { model } = await run(HISTORY);

    expect(sentMessages(model)).toHaveLength(HISTORY.length);
    expect(systemPrompt(model)).not.toContain("EARLIER CONVERSATION");
  });

  it("leaves out the oldest turns, tells the model, and logs only counts", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "32768");

    const { model } = await run(HISTORY);

    const sent = sentMessages(model);
    expect(sent.length).toBeLessThan(HISTORY.length);
    expect(sent[0].role).toBe("user");
    expect(sent.at(-1)!.text).toBe("And the latest question?");
    // The newest turns are the ones kept, in order.
    const dropped = HISTORY.length - sent.length;
    expect(sent[0].text).toBe(HISTORY[dropped].content);
    expect(systemPrompt(model)).toContain(
      `The ${dropped} oldest messages of this conversation are not included`,
    );

    const logged = consoleLog.mock.calls.find(
      ([line]: unknown[]) =>
        line === "[chat/context] earlier messages left out to fit the context window",
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toEqual({
      dropped_messages: dropped,
      kept_messages: sent.length,
      window_tokens: 32_768,
      history_tokens: expect.any(Number),
    });
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(SECRET);
  });

  it("sends a conversation that fits unchanged", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "1000000");

    const { model } = await run(HISTORY);

    expect(sentMessages(model)).toHaveLength(HISTORY.length);
    expect(systemPrompt(model)).not.toContain("EARLIER CONVERSATION");
  });

  it("refuses, in words, a message too long for the window on its own", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "8192");

    const { model, outcome } = await run([
      { role: "user", content: "x".repeat(60_000) },
    ]);

    expect(model.doStreamCalls).toHaveLength(0);
    expect(outcome).toBeInstanceOf(AssistantStreamError);
    expect((outcome as AssistantStreamError).events).toContainEqual(
      expect.objectContaining({
        type: "error",
        safe_to_display: true,
        message: expect.stringContaining("too long for the selected model's context window"),
      }),
    );
  });
});
