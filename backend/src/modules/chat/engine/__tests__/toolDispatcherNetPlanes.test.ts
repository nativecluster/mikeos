import { afterEach, expect, it, vi } from "vitest";

// The dispatcher's own guard (lib/nc/netPlanes.ts): a call on a plane
// NativeCluster turned off for everyone, reaching it by any path (a script's
// inner call, a turn the stream did not filter), runs nothing.
const { executeMcpToolCall, planConnectorToolCall, searchCourtlistenerCaseLaw } = vi.hoisted(() => ({
  executeMcpToolCall: vi.fn(),
  planConnectorToolCall: vi.fn(),
  searchCourtlistenerCaseLaw: vi.fn(),
}));
vi.mock("../../../../lib/mcpConnectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mcpConnectors")>()),
  executeMcpToolCall,
}));
vi.mock("../tools/connectorApprovals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/connectorApprovals")>()),
  planConnectorToolCall,
}));
vi.mock("../../../../lib/courtlistener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/courtlistener")>()),
  searchCourtlistenerCaseLaw,
}));

import { runToolCalls } from "../tools/toolDispatcher";
import { NET_PLANE_OFF_MESSAGES } from "../../../../lib/nc/netPlanes";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("answers MCP and CourtListener calls in words while their planes are off", async () => {
  vi.stubEnv("LB_MIKE_MCP", "0");
  vi.stubEnv("LB_MIKE_COURTLISTENER", "0");
  const write = vi.fn();
  const result = await runToolCalls(
    [
      { id: "mcp", function: { name: "mcp_slack_search_1a2b3c4d", arguments: "{}" } },
      { id: "case", function: { name: "courtlistener_search_case_law", arguments: '{"query":"x"}' } },
    ],
    new Map(),
    "u1",
    {} as never,
    write,
  );

  expect(result.toolResults).toEqual([
    { role: "tool", tool_call_id: "mcp", content: JSON.stringify({ ok: false, error: NET_PLANE_OFF_MESSAGES.mcp }) },
    {
      role: "tool",
      tool_call_id: "case",
      content: JSON.stringify({ ok: false, error: NET_PLANE_OFF_MESSAGES.courtlistener }),
    },
  ]);
  expect(planConnectorToolCall).not.toHaveBeenCalled();
  expect(executeMcpToolCall).not.toHaveBeenCalled();
  expect(searchCourtlistenerCaseLaw).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
