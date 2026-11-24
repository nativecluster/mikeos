/**
 * read_document for a model whose context window is known: a document longer
 * than the turn has room for comes back a part at a time, each part saying
 * where the document continues, and the model reads on with an offset. With
 * no window known the tool, the prompt and the result are as they were.
 *
 * Runs the real AI SDK adapter over a mock model that reads the tool results
 * it is sent; no model is called.
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

import type { MockLanguageModelV3 } from "ai/test" with {
  "resolution-mode": "import",
};
import { streamAiSdk } from "../../../../lib/llm/aiSdk";
import {
  config,
  step,
  text,
  textStep,
  toolCall,
  finish,
} from "../../../../lib/llm/__tests__/mockLanguageModel";
import { estimateTokens } from "../../../../lib/llm/contextBudget";
import { runLLMStream } from "../streaming";
import { PROJECT_EXTRA_TOOLS } from "../tools/toolSchemas";

const WINDOW = 16_384;

/** About 75,000 characters of numbered clauses. */
const LONG = Array.from(
  { length: 1_200 },
  (_, i) => `Clause ${i + 1}. The Tenant shall keep the Premises in good repair.`,
).join("\n");

type Prompt = MockLanguageModelV3["doStreamCalls"][number]["prompt"];

/** The text of every tool result in a prompt, in order. */
function toolResults(prompt: Prompt): string[] {
  return prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .flatMap((part) => {
      const output = (part as { output?: { type: string; value: unknown } }).output;
      return output && typeof output.value === "string" ? [output.value] : [];
    });
}

/**
 * A model that reads the document from the start and follows every "continues
 * at offset" it is given, then answers.
 */
async function readOnModel() {
  const { MockLanguageModelV3 } = await import("ai/test");
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      calls += 1;
      const last = toolResults(prompt).at(-1);
      if (calls === 1) {
        return step(toolCall("read-1", "read_document", { doc_id: "doc-0" }), finish("tool-calls"));
      }
      const next = last?.match(/continues at offset (\d+)/);
      if (next && calls < 20) {
        return step(
          toolCall(`read-${calls}`, "read_document", {
            doc_id: "doc-0",
            offset: Number(next[1]),
          }),
          finish("tool-calls"),
        );
      }
      return textStep("The Tenant must keep the Premises in repair.");
    },
  });
}

const SHORT = "Schedule 1. The Rent is payable quarterly in advance.";

function run(model: MockLanguageModelV3, extraTools: unknown[] = []) {
  streamChatWithTools.mockImplementation((params) =>
    streamAiSdk(params, config(model)),
  );
  return runLLMStream({
    model: "gemini-3.8-flash",
    apiMessages: [
      { role: "system", content: "You are Mike." },
      { role: "user", content: "What must the Tenant do?" },
    ],
    docStore: new Map([
      [
        "doc-0",
        {
          filename: "Lease.docx",
          file_type: "docx",
          storage_path: "",
          inline_text: LONG,
        },
      ],
      [
        "doc-1",
        {
          filename: "Schedule.docx",
          file_type: "docx",
          storage_path: "",
          inline_text: SHORT,
        },
      ],
    ]) as never,
    docIndex: {} as never,
    userId: "user-1",
    db: {} as never,
    write: () => {},
    includeAskInputs: false,
    includeResearchTools: false,
    extraTools,
    allowDocumentMutation: false,
  });
}

function readDocumentTool(model: MockLanguageModelV3) {
  return model.doStreamCalls[0].tools?.find(
    (tool) => (tool as { name?: string }).name === "read_document",
  ) as { description: string; inputSchema: { properties: Record<string, unknown> } };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("read_document with no known window", () => {
  it("returns the whole document once, with today's tool and prompt", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");
    const model = await readOnModel();

    await run(model);

    expect(model.doStreamCalls).toHaveLength(2);
    const [result] = toolResults(model.doStreamCalls[1].prompt);
    expect(result).toContain(LONG);
    expect(result).not.toContain("continues at offset");
    expect(Object.keys(readDocumentTool(model).inputSchema.properties)).toEqual(["doc_id"]);
    const system = model.doStreamCalls[0].prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).not.toContain("READING LONG DOCUMENTS");
  });
});

describe("read_document with a known window", () => {
  it("returns parts that fit, each saying where the document continues, until the end", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
    const model = await readOnModel();

    const { fullText } = await run(model);

    expect(fullText).toContain("keep the Premises in repair");
    expect(readDocumentTool(model).inputSchema.properties).toHaveProperty("offset");
    const system = model.doStreamCalls[0].prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).toContain("READING LONG DOCUMENTS");

    const results = toolResults(model.doStreamCalls.at(-1)!.prompt);
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]).toContain("This part: characters 0-");
    expect(results[0]).toMatch(/continues at offset \d+\. To read on, call read_document with doc_id "doc-0" and offset \d+/);
    // Every prompt the model was sent fits its window, answer room aside.
    for (const call of model.doStreamCalls) {
      const sent = toolResults(call.prompt).reduce((sum, r) => sum + estimateTokens(r), 0);
      expect(sent).toBeLessThan(WINDOW);
    }
    // The parts it read are consecutive pieces of the document.
    const parts = results.filter((r) => r.includes("This part: characters"));
    expect(parts.length).toBeGreaterThan(1);
    const positions = parts.map((r) =>
      r.match(/characters (\d+)-(\d+) of (\d+)/)!.slice(1).map(Number),
    );
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i][0]).toBe(positions[i - 1][1]);
    }
    positions.forEach(([start, end, total], i) => {
      expect(total).toBe(LONG.length);
      expect(parts[i]).toContain(LONG.slice(start, end));
    });
    // The turn runs out of room before the end, and says so rather than
    // returning more than fits.
    expect(results.at(-1)).toContain('"error":"context_full"');
  });

  it("returns a document that fits whole, as before", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "200000");
    const model = await readOnModel();

    await run(model);

    const [result] = toolResults(model.doStreamCalls[1].prompt);
    expect(result).toContain(LONG);
    expect(result).not.toContain("This part:");
  });

  it("gives each fetched document a share, a longer one coming back as its first part", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
    const { MockLanguageModelV3 } = await import("ai/test");
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () =>
        model.doStreamCalls.length < 2
          ? step(
              toolCall("fetch-1", "fetch_documents", { doc_ids: ["doc-0", "doc-1"] }),
              finish("tool-calls"),
            )
          : step(...text("Done."), finish("stop")),
    });

    await run(model, PROJECT_EXTRA_TOOLS);

    const [result] = toolResults(model.doStreamCalls[1].prompt);
    const [long, short] = result.split("--- doc-1 ---");
    expect(long).toContain("This part: characters 0-");
    expect(long).toMatch(/continues at offset \d+\. To read on, call read_document with doc_id "doc-0"/);
    expect(short).toContain(SHORT);
    expect(short).not.toContain("This part:");
    expect(estimateTokens(result)).toBeLessThan(WINDOW / 2);
  });

  it("answers a part asked for twice with a notice, not the text again", async () => {
    vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
    const { MockLanguageModelV3 } = await import("ai/test");
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doStream: async () =>
        model.doStreamCalls.length < 3
          ? step(
              toolCall(`read-${model.doStreamCalls.length}`, "read_document", { doc_id: "doc-0" }),
              finish("tool-calls"),
            )
          : step(...text("Done."), finish("stop")),
    });

    await run(model);

    const results = toolResults(model.doStreamCalls.at(-1)!.prompt);
    expect(results).toHaveLength(2);
    expect(results[1]).toContain('"status":"part_already_returned"');
    expect(results[1]).not.toContain("Clause 1.");
  });
});
