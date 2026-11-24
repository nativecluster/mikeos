// One real call to NativeCluster, through Mike's provider: a short streamed
// chat turn with one tool. Skipped unless NATIVECLUSTER_LIVE_TEST=1, with
// NativeCluster's settings in the environment as the backend reads them
// (NATIVECLUSTER_BASE_URL, and NATIVECLUSTER_API_KEY or
// NATIVECLUSTER_ENV_FILE). It uses NATIVECLUSTER_LIVE_MODEL, or else the
// smallest chat model GET /v1/models lists; it never downloads one.
//
//   NATIVECLUSTER_LIVE_TEST=1 NATIVECLUSTER_ENV_FILE=<path `nativecluster env` prints> \
//     npm test --prefix backend -- src/lib/llm/nativecluster.live.test.ts

import { describe, expect, it } from "vitest";
import {
  isNativeClusterChatModel,
  listNativeClusterModels,
  NATIVECLUSTER_MODEL_PREFIX,
  type NativeClusterModelInfo,
} from "./nativecluster";
import { contextWindowFor } from "./contextWindow";
import { streamWithProvider } from "./providers";
import type { NormalizedToolCall } from "./types";

const live = process.env.NATIVECLUSTER_LIVE_TEST === "1";

/** Billions of parameters, from a name such as "gemma4:4b" or "qwen3-0.6b". */
function parameterBillions(model: NativeClusterModelInfo): number {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model.id);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

describe.skipIf(!live)("NativeCluster, live", () => {
  // A call waits in the cluster's line for as long as it takes.
  it("streams a chat turn with one tool", { timeout: 0 }, async () => {
    const listed = await listNativeClusterModels({ maxAgeMs: 0 });
    const chat = listed.filter(isNativeClusterChatModel);
    const name =
      process.env.NATIVECLUSTER_LIVE_MODEL?.trim() ||
      [...chat].sort((a, b) => parameterBillions(a) - parameterBillions(b))[0]
        ?.id;
    expect(name, "NativeCluster lists no chat model").toBeTruthy();
    const model = `${NATIVECLUSTER_MODEL_PREFIX}${name}`;

    const toolCalls: NormalizedToolCall[] = [];
    const deltas: string[] = [];
    let reasoning = "";
    const result = await streamWithProvider({
      model,
      systemPrompt:
        "You answer in one short sentence. To learn the notice period, call get_notice_period.",
      messages: [
        { role: "user", content: "What is the notice period in the lease?" },
      ],
      reasoning: "none",
      maxIterations: 2,
      tools: [
        {
          type: "function",
          function: {
            name: "get_notice_period",
            description: "The lease's notice period.",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({ tool_use_id: call.id, content: "30 days" })),
      callbacks: {
        onToolCallStart: (call) => toolCalls.push(call),
        onContentDelta: (text) => deltas.push(text),
        onReasoningDelta: (text) => {
          reasoning += text;
        },
      },
    });

    console.info(
      JSON.stringify({
        model,
        contextWindow: contextWindowFor(model) ?? null,
        toolCalls: toolCalls.map((call) => call.name),
        contentDeltas: deltas.length,
        reasoningChars: reasoning.length,
        answer: result.fullText,
      }),
    );
    expect(toolCalls.map((call) => call.name)).toEqual(["get_notice_period"]);
    expect(result.fullText).toMatch(/30/);
  });
});
