import { beforeEach, describe, expect, it, vi } from "vitest";

// A tool's own failure is that tool's result, never the turn's. Found by the
// real-model campaign (2026-11-25): qwen3.8:27b sent find_in_document's
// `query` as a list of phrases, query.trim() threw inside runToolCalls, and
// the person saw only "The response could not be completed".

type StreamParams = {
  runTools: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<{ tool_use_id: string; content: string }[]>;
};
const { streamChatWithTools, loadActiveVersion, loadVersionTextState, generateDocx } =
  vi.hoisted(() => ({
    streamChatWithTools:
      vi.fn<(...args: [StreamParams]) => Promise<{ fullText: string }>>(),
    loadActiveVersion: vi.fn(),
    loadVersionTextState: vi.fn(),
    generateDocx: vi.fn(),
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
vi.mock("../../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion,
}));
vi.mock("../../../../lib/documentTextCache", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentTextCache")>()),
  loadVersionTextState,
}));
vi.mock("../tools/documentOps", async (original) => ({
  ...(await original<typeof import("../tools/documentOps")>()),
  generateDocx,
}));

import { runLLMStream } from "../streaming";
import { runToolCalls } from "../tools/toolDispatcher";
import { argumentProblems } from "../tools/toolFailure";
import type { DocIndex, DocStore } from "../types";

// The licence's clause, as its stored text reads (a public CUAD contract).
const LICENCE_TEXT = [
  "[Page 1]",
  "12. TERM AND TERMINATION",
  "12.1 Either party may terminate this Agreement upon sixty (60) days' prior written notice to the other party.",
  "12.2 Any notice under this Agreement shall be in writing.",
].join("\n");

const docStore = (): DocStore =>
  new Map([
    [
      "doc-0",
      {
        storage_path: "documents/licence.pdf",
        file_type: "pdf",
        filename: "license-datacall-planb.pdf",
      },
    ],
  ]);
const docIndex = (): DocIndex => ({
  "doc-0": {
    document_id: "d1",
    filename: "license-datacall-planb.pdf",
    version_id: "v1",
    version_number: 1,
  },
});

const dispatch = (
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  write: (frame: string) => void = () => {},
) =>
  runToolCalls(
    calls.map(({ id, name, args }) => ({
      id,
      function: { name, arguments: JSON.stringify(args) },
    })),
    docStore(),
    "user-1",
    {} as never,
    write,
    undefined,
    undefined,
    docIndex(),
    undefined,
    new Map(),
  );

const resultOf = (
  batch: Awaited<ReturnType<typeof dispatch>>,
  id: string,
) => {
  const row = batch.toolResults.find(
    (r) => (r as { tool_call_id: string }).tool_call_id === id,
  ) as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as Record<string, unknown>) : undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  loadActiveVersion.mockResolvedValue({
    id: "v1",
    version_number: 1,
    storage_path: "documents/licence.pdf",
    text_revision: "r1",
  });
  loadVersionTextState.mockResolvedValue({
    revision: "r1",
    text: LICENCE_TEXT,
    textlessPageCount: 0,
  });
});

describe("find_in_document with query given as a list", () => {
  it("searches each phrase on its own and answers with every search", async () => {
    const batch = await dispatch([
      {
        id: "find-1",
        name: "find_in_document",
        args: { doc_id: "doc-0", query: ["termination", "notice"] },
      },
    ]);

    const result = resultOf(batch, "find-1");
    expect(result).toMatchObject({
      ok: true,
      filename: "license-datacall-planb.pdf",
      total_matches: 3,
      searches: [
        { ok: true, query: "termination", total_matches: 1 },
        { ok: true, query: "notice", total_matches: 2 },
      ],
    });
    expect(result?.note).toContain("one string per call");
    // Each phrase shows in the timeline as a search of its own.
    expect(batch.docsFound.map((found) => found.query)).toEqual([
      "termination",
      "notice",
    ]);
  });

  it("answers a query that is not a string or a list of strings in words", async () => {
    const write = vi.fn();
    const batch = await dispatch(
      [
        { id: "find-1", name: "find_in_document", args: { doc_id: "doc-0", query: { text: "notice" } } },
        { id: "find-2", name: "find_in_document", args: { doc_id: "doc-0", query: ["notice", 60] } },
      ],
      write,
    );

    for (const id of ["find-1", "find-2"]) {
      expect(resultOf(batch, id)).toEqual({
        ok: false,
        error: expect.stringContaining("query must be a string"),
      });
    }
    // Nothing was searched, so nothing shows as a search.
    expect(
      write.mock.calls.some(([frame]) => String(frame).includes("doc_find_start")),
    ).toBe(false);
  });
});

describe("a tool that throws", () => {
  it("yields a tool-error result naming the mistyped argument, and the batch's next call still runs", async () => {
    // A tool that assumes its title is a string, as find_in_document assumed
    // its query was.
    generateDocx.mockImplementationOnce(async (title: unknown) =>
      (title as string).trim(),
    );
    const batch = await dispatch([
      { id: "docx-1", name: "generate_docx", args: { title: ["Memo"], sections: [] } },
      { id: "card-1", name: "create_text_card", args: { title: "Notice", text: "60 days" } },
    ]);

    const failed = resultOf(batch, "docx-1");
    expect(failed).toEqual({
      ok: false,
      error: expect.stringContaining("title must be a string (it was an array)"),
    });
    expect(String(failed?.error)).not.toContain("trim");
    expect(resultOf(batch, "card-1")).toMatchObject({ displayed: true });
  });

  it("says plainly that the call could not complete when its arguments fit the schema", async () => {
    generateDocx.mockRejectedValueOnce(new Error("storage said no: s3://bucket/key"));
    const batch = await dispatch([
      { id: "docx-1", name: "generate_docx", args: { title: "Memo", sections: [] } },
    ]);

    const failed = resultOf(batch, "docx-1");
    expect(failed).toEqual({
      ok: false,
      error: expect.stringContaining("generate_docx could not complete this call"),
    });
    expect(JSON.stringify(failed)).not.toContain("s3://");
  });
});

describe("the turn", () => {
  it('goes on past find_in_document called with ["termination", "notice"]', async () => {
    let firstStep: { tool_use_id: string; content: string }[] = [];
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      firstStep = await runTools([
        { id: "find-1", name: "find_in_document", input: { doc_id: "doc-0", query: "termination" } },
        {
          id: "find-2",
          name: "find_in_document",
          input: { doc_id: "doc-0", query: ["termination", "notice"] },
        },
      ]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "What's the termination notice period?" }],
      docStore: docStore(),
      docIndex: docIndex(),
      userId: "user-1",
      db: {} as never,
      write: vi.fn(),
      includeAskInputs: false,
      allowDocumentMutation: false,
    });

    // The turn ended as a turn, not as "The response could not be completed".
    expect(outcome.events.filter((event) => event.type === "doc_find")).toHaveLength(3);
    expect(firstStep.map((result) => result.tool_use_id)).toEqual(["find-1", "find-2"]);
    expect(JSON.parse(firstStep[1].content)).toMatchObject({
      ok: true,
      searches: [{ query: "termination" }, { query: "notice" }],
    });
  });
});

describe("argumentProblems", () => {
  it("names each platform argument whose type differs from the schema", () => {
    expect(
      argumentProblems("find_in_document", {
        doc_id: "doc-0",
        query: ["a", "b"],
        max_results: "5",
      }),
    ).toEqual([
      "query must be a string (it was an array)",
      "max_results must be an integer (it was a string)",
    ]);
    expect(argumentProblems("find_in_document", { query: "notice" })).toEqual([
      "doc_id is required",
    ]);
    expect(
      argumentProblems("find_in_document", { doc_id: "doc-0", query: "x" }),
    ).toEqual([]);
    // A connector's tool is not the platform's to describe.
    expect(argumentProblems("mcp_crm_update_record", { id: ["r1"] })).toEqual([]);
  });
});
