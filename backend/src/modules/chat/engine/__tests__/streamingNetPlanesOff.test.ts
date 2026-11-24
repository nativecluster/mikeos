import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mike's NativeCluster app: with a net plane's off switch at 0 the turn gets
// none of the plane's tools, and a call the model makes on one anyway (from
// memory, or in a subagent) is answered in the plane's words and never runs.
// lib/nc/netPlanes.ts.

const { streamChatWithTools, runToolCalls, searchWeb, buildUserMcpTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  runToolCalls: vi.fn(async (_calls: { function: { name: string } }[]) => ({
    toolResults: [] as { tool_call_id: string; content: string }[],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  })),
  searchWeb: vi.fn(),
  buildUserMcpTools: vi.fn(async () => [
    { type: "function", function: { name: "mcp_slack_search_1a2b3c4d", description: "", parameters: {} } },
  ]),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools }));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (calls: { function: { name: string } }[]) => runToolCalls(calls),
}));
vi.mock("../../../../lib/webSearch", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/webSearch")),
  searchWeb,
}));

import { runLLMStream } from "../streaming";
import { NET_PLANE_OFF_MESSAGES, NET_PLANE_SWITCHES, type NetPlane } from "../../../../lib/nc/netPlanes";

type StreamChatCall = {
  tools: { function: { name: string } }[];
  systemPrompt?: string;
  runTools?: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<{ tool_use_id: string; content: string }[]>;
  [key: string]: unknown;
};

function params() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user", content: "Find the case and search the web." }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
    includeResearchTools: true,
    webSearch: "brave" as const,
    apiKeys: { brave: "brave-key" },
  };
}

const PLANE_TOOLS: Record<NetPlane, string> = {
  courtlistener: "courtlistener_get_cases",
  websearch: "web_search",
  mcp: "mcp_slack_search_1a2b3c4d",
};

function advertised(): string[] {
  return streamChatWithTools.mock.calls[0]![0].tools.map((t) => t.function.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});
afterEach(() => vi.unstubAllEnvs());

describe("a turn under a plane NativeCluster turned off for everyone", () => {
  it("with every switch on, offers every plane's tools", async () => {
    await runLLMStream(params());
    for (const tool of Object.values(PLANE_TOOLS)) expect(advertised()).toContain(tool);
  });

  it.each(Object.keys(PLANE_TOOLS) as NetPlane[])(
    "%s: offers none of its tools, and answers a call on one in words",
    async (plane) => {
      vi.stubEnv(NET_PLANE_SWITCHES[plane], "0");
      let results: { tool_use_id: string; content: string }[] | undefined;
      streamChatWithTools.mockImplementationOnce(async (call) => {
        results = await call.runTools?.([
          { id: "off", name: PLANE_TOOLS[plane], input: { query: "qualified immunity" } },
          { id: "doc", name: "read_document", input: { doc_id: "doc-0" } },
        ]);
        return { fullText: "Answer" };
      });

      await runLLMStream(params());

      const names = advertised();
      expect(names).not.toContain(PLANE_TOOLS[plane]);
      if (plane === "websearch") expect(names).not.toContain("read_webpage");
      if (plane === "courtlistener")
        expect(names.some((name) => name.startsWith("courtlistener_"))).toBe(false);
      if (plane === "mcp") expect(buildUserMcpTools).not.toHaveBeenCalled();
      // The other planes are untouched.
      for (const [other, tool] of Object.entries(PLANE_TOOLS))
        if (other !== plane) expect(names).toContain(tool);

      expect(JSON.parse(results!.find((r) => r.tool_use_id === "off")!.content)).toEqual({
        ok: false,
        error: NET_PLANE_OFF_MESSAGES[plane],
      });
      expect(searchWeb).not.toHaveBeenCalled();
      expect(runToolCalls.mock.calls[0]![0].map((c) => c.function.name)).toEqual(["read_document"]);
    },
  );

  it("web search off: the system prompt says nothing of searching the web", async () => {
    vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
    await runLLMStream(params());
    expect(streamChatWithTools.mock.calls[0]![0].systemPrompt).not.toContain("WEB SEARCH");
  });
});
