import { beforeEach, describe, expect, it, vi } from "vitest";

// A quote is cited on the page it is on. Found by the real-model campaign
// (2026-11-25, 02c): on the 50-page CytoDyn/Vyera licence the model
// answered from find_in_document hits alone, whose hits carried no page,
// so every citation opened page 1 although Mike's own verification had
// found each quote deep in the text (s. 11.2(c), page 32).

type StreamParams = {
  runTools: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<{ tool_use_id: string; content: string }[]>;
};
const { streamChatWithTools, loadActiveVersion, loadVersionTextState } =
  vi.hoisted(() => ({
    streamChatWithTools:
      vi.fn<(...args: [StreamParams]) => Promise<{ fullText: string }>>(),
    loadActiveVersion: vi.fn(),
    loadVersionTextState: vi.fn(),
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
vi.mock("../../../../lib/integrations/googleDrive", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleDrive")>()),
  buildGoogleDriveTools: async () => [],
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleWorkspace")>()),
  buildGoogleWorkspaceTools: async () => [],
}));
vi.mock("../../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion,
}));
vi.mock("../../../../lib/documentTextCache", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentTextCache")>()),
  loadVersionTextState,
}));

import { runLLMStream } from "../streaming";
import { findTextMatches } from "../tools/documentOps";
import { citedPageAt, pageAt, pageStarts } from "../tools/pageMarkers";
import { verifyDocumentCitationAnnotation } from "../verifyCitations";
import type { DocIndex, DocStore } from "../types";

const TERMINATION =
  "Vyera may terminate this Agreement at any time following the second (2nd) anniversary of the First Commercial Sale of the Licensed Product, for any reason or no reason, upon one hundred eighty (180) days' written notice to CytoDyn.";

/** A 50-page licence as its PDF's stored text reads: "[Page N]" markers, pages joined by a blank line. */
function pagedLicence(): string {
  const pages: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const body =
      page === 32
        ? `11.2 Unilateral Termination by Vyera.\n(c) ${TERMINATION}`
        : page === 5
          ? // A line of the document's own that reads like a marker.
            "See the schedule below.\n\n[Page 2]\nof Exhibit A, as amended."
          : `Section ${page}. General provisions continue on this page.`;
    pages.push(`[Page ${page}]\n${body}`);
  }
  return pages.join("\n\n");
}

describe("page markers", () => {
  it("count only in sequence from [Page 1]", () => {
    const text = pagedLicence();
    const starts = pageStarts(text);
    expect(starts).toHaveLength(50);
    expect(pageAt(starts, text.indexOf("of Exhibit A"))).toBe(5);
    expect(pageAt(starts, text.indexOf(TERMINATION))).toBe(32);
    expect(pageAt(pageStarts("No markers here."), 3)).toBeNull();
    // A quote that runs over a page break names both pages.
    const end = text.indexOf("Section 33.") + "Section 33".length;
    expect(citedPageAt(starts, text.indexOf(TERMINATION), end)).toBe("32-33");
  });

  it("give each find hit its page", () => {
    const text = pagedLicence();
    const { hits } = findTextMatches({
      text,
      query: "one hundred eighty (180) days",
      maxResults: 5,
      contextChars: 20,
      pageStarts: pageStarts(text),
    });
    expect(hits).toEqual([expect.objectContaining({ page: 32 })]);
    // An unpaged text's hits say no page.
    const unpaged = findTextMatches({
      text: TERMINATION,
      query: "written notice",
      maxResults: 5,
      contextChars: 20,
      pageStarts: pageStarts(TERMINATION),
    });
    expect(unpaged.hits[0]).not.toHaveProperty("page");
  });
});

describe("verifyDocumentCitationAnnotation", () => {
  const annotation = (page: number | string, quote: string) => ({
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-0",
    document_id: "d1",
    filename: "long-license-cytodyn-vyera.pdf",
    page,
    quote,
    quotes: [{ page, quote }],
    document: {
      document_id: "d1",
      title: "long-license-cytodyn-vyera.pdf",
      type: "pdf",
      metadata: [],
      quotes: [{ quote, target: { page } }],
    },
  });

  it("cites a quote verified on page 32 at page 32, whatever page it was given", async () => {
    // Page 1 is normalizeCitation's default for no page; 30 a printed number.
    for (const given of [1, 30, "1"]) {
      const verified = (await verifyDocumentCitationAnnotation(
        annotation(given, TERMINATION),
        async () => pagedLicence(),
      )) as ReturnType<typeof annotation> & {
        quotes: { page: unknown; verification: Record<string, unknown> }[];
      };
      expect(verified.page).toBe(32);
      expect(verified.quotes[0]).toMatchObject({
        page: 32,
        verification: { verified: true, start_char: expect.any(Number) },
      });
      expect(verified.quotes[0].verification).not.toHaveProperty("span");
      expect(verified.document.quotes[0].target.page).toBe(32);
    }
  });

  it("keeps a cited page that holds the quote too, for a phrase the document repeats", async () => {
    const repeated = "General provisions continue on this page.";
    const cited = async (page: number) =>
      ((await verifyDocumentCitationAnnotation(
        annotation(page, repeated),
        async () => pagedLicence(),
      )) as ReturnType<typeof annotation>).page;
    expect(await cited(20)).toBe(20);
    expect(await cited(1)).toBe(1);
    // Page 5 does not have it: the first page that does.
    expect(await cited(5)).toBe(1);
  });

  it("finds the page of a quote with an omission from its first part", async () => {
    const quote = "Vyera may terminate this Agreement ... upon one hundred eighty (180) days' written notice";
    const verified = (await verifyDocumentCitationAnnotation(
      annotation(1, quote),
      async () => pagedLicence(),
    )) as ReturnType<typeof annotation>;
    expect(verified.page).toBe(32);
    expect(verified.document.quotes[0].target.page).toBe(32);
  });

  it("keeps the given page for an unpaged text and for a quote not found", async () => {
    const unpaged = (await verifyDocumentCitationAnnotation(
      annotation(3, TERMINATION),
      async () => `Recitals.\n\n${TERMINATION}`,
    )) as ReturnType<typeof annotation>;
    expect(unpaged.page).toBe(3);
    expect(unpaged.document.quotes[0].target.page).toBe(3);

    const missing = (await verifyDocumentCitationAnnotation(
      annotation(7, "CytoDyn may assign this Agreement freely."),
      async () => pagedLicence(),
    )) as ReturnType<typeof annotation>;
    expect(missing.page).toBe(7);
  });
});

describe("a quote found only by search", () => {
  const docStore = (): DocStore =>
    new Map([
      [
        "doc-0",
        {
          storage_path: "documents/licence.pdf",
          file_type: "pdf",
          filename: "long-license-cytodyn-vyera.pdf",
        },
      ],
    ]);
  const docIndex = (): DocIndex => ({
    "doc-0": {
      document_id: "d1",
      filename: "long-license-cytodyn-vyera.pdf",
      version_id: "v1",
      version_number: 1,
    },
  });

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
      text: pagedLicence(),
      textlessPageCount: 0,
    });
  });

  it("on page 32 of a paged text is cited at page 32", async () => {
    let hit: { excerpt: string; page?: unknown } | undefined;
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      const [found] = await runTools([
        {
          id: "find-1",
          name: "find_in_document",
          input: { doc_id: "doc-0", query: "one hundred eighty (180) days" },
        },
      ]);
      hit = JSON.parse(found.content).hits[0];
      // As qwen3.8 did: the quote from the hit, cited with no page.
      await runTools([
        {
          id: "cite-1",
          name: "cite_sources",
          input: {
            citations: [
              {
                ref: 1,
                doc_id: "doc-0",
                quotes: [{ quote: `upon ${hit!.excerpt}' written notice to CytoDyn` }],
              },
            ],
          },
        },
      ]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [
        { role: "user", content: "On how many days' notice can Vyera terminate for any reason?" },
      ],
      docStore: docStore(),
      docIndex: docIndex(),
      userId: "user-1",
      db: {} as never,
      write: vi.fn(),
      includeAskInputs: false,
      allowDocumentMutation: false,
    });

    expect(hit?.page).toBe(32);
    expect(outcome.citations).toMatchObject([
      {
        ref: 1,
        page: 32,
        verified: true,
        quotes: [{ page: 32 }],
        document: { quotes: [{ target: { page: 32 } }] },
      },
    ]);
  });
});
