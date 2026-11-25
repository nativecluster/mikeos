/**
 * The robustness campaign's O1 (2026-11-24): with a net plane's off switch at
 * 0 the turn gets none of the plane's tools, so a model that names one from
 * memory (`web_search`, `courtlistener_search_case_law`, an `mcp_*` tool) was
 * answered by the SDK's NoSuchToolError ("Model tried to call unavailable
 * tool 'web_search'. Available tools: ..."), not the plane's words. The
 * dispatcher's own off-switch answer never ran: the SDK rejects an unknown
 * tool before any tool is dispatched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamAiSdk } from "../aiSdk";
import { NET_PLANE_OFF_MESSAGES } from "../../nc/netPlanes";
import { callStep, config, makeModel, okRunTools, textStep, TOOLS } from "./mockLanguageModel";

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  tools: TOOLS,
  maxIterations: 5,
};

async function secondPrompt(toolName: string) {
  const model = await makeModel([callStep("c1", toolName, { query: "x" }), textStep("recovered")]);
  const dispatched: string[] = [];
  const res = await streamAiSdk(
    {
      ...base,
      runTools: async (calls) => {
        dispatched.push(...calls.map((c) => c.name));
        return okRunTools(calls);
      },
    },
    config(model),
  );
  expect(res.fullText).toBe("recovered");
  expect(dispatched, "the call is never dispatched").toEqual([]);
  expect(model.doStreamCalls.length).toBe(2);
  return JSON.stringify((model.doStreamCalls[1] as { prompt: unknown }).prompt);
}

afterEach(() => vi.unstubAllEnvs());

describe("a call on an off plane's tool the turn does not have", () => {
  it("is answered with the plane's words, for web search, CourtListener and MCP alike", async () => {
    vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
    vi.stubEnv("LB_MIKE_COURTLISTENER", "0");
    vi.stubEnv("LB_MIKE_MCP", "0");
    for (const [tool, words] of [
      ["web_search", NET_PLANE_OFF_MESSAGES.websearch],
      ["read_webpage", NET_PLANE_OFF_MESSAGES.websearch],
      ["courtlistener_search_case_law", NET_PLANE_OFF_MESSAGES.courtlistener],
      ["mcp_notion_search_1a2b3c4d", NET_PLANE_OFF_MESSAGES.mcp],
    ] as const) {
      const prompt = await secondPrompt(tool);
      expect(prompt, tool).toContain(JSON.stringify(words).slice(1, -1));
      expect(prompt, tool).not.toContain("unavailable tool");
      expect(prompt, tool).not.toContain("Available tools");
    }
  });

  it("is the SDK's own answer when the plane is on, and for a tool of no plane", async () => {
    vi.stubEnv("LB_MIKE_WEBSEARCH", "0");
    expect(await secondPrompt("courtlistener_search_case_law")).toContain("unavailable tool 'courtlistener_search_case_law'");
    expect(await secondPrompt("nonexistent_tool")).toContain("unavailable tool 'nonexistent_tool'");
  });
});
