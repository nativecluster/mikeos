// A DOCX's pending tracked changes are read as proposals, not as its terms.
// Found by the real-model campaign (2026-11-25, 03b, build 2): after two
// edits left pending in services-federated-fasc.docx (s. 5(a) 60 to 90
// days, s. 7 Pennsylvania to Delaware), a memo drafted from it in a new chat
// said "90 days' written notice" and "the laws of the State of Delaware",
// with no word that either was unaccepted. read_document's text is the
// accepted view (the edit tool anchors on it) and listed the changes only
// after it; it now says first, before the body, that the body shows
// pending changes as if accepted and that the original wording governs.
//
// fixtures/services-federated-fasc.docx is the campaign's own: CUAD v1's
// "FEDERATEDGOVERNMENTINCOMESECURITIESINC_04_28_2020-EX-99.SERV AGREE-
// SERVICES AGREEMENT" (The Atticus Project, CC BY 4.0; a public SEC EDGAR
// filing), its text made into a Word file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocIndex, DocStore } from "../../types";
import type { Db } from "../../../../../lib/supabase";

const mocks = vi.hoisted(() => ({ active: vi.fn(), bytes: vi.fn(), stored: vi.fn() }));
vi.mock("../../../../../lib/documentVersions", async (load) => ({
  ...(await load<object>()),
  loadActiveVersion: mocks.active,
}));
vi.mock("../../../../documents/documents.service", async (load) => ({
  ...(await load<object>()),
  loadCurrentVersionBytes: mocks.bytes,
  readStoredDocumentText: mocks.stored,
}));
// The parsers run here, in-process, as the parser thread would run them.
vi.mock("../../../../../lib/extraction/isolated", async (load) => {
  const { EXTRACTION_OPS } = await vi.importActual<
    typeof import("../../../../../lib/extraction/ops")
  >("../../../../../lib/extraction/ops");
  return {
    ...(await load<object>()),
    withExtractionRequest: (
      work: (extract: (op: string, bytes: ArrayBuffer) => unknown) => unknown,
    ) =>
      work((op, bytes) =>
        (EXTRACTION_OPS as Record<string, (b: ArrayBuffer, t: string) => unknown>)[op](bytes, "docx"),
      ),
  };
});

import { applyTrackedEdits, extractDocxBodyText } from "../../../../../lib/docxTrackedChanges";
import { EXTRACTION_OPS } from "../../../../../lib/extraction/ops";
import { readDocumentContent } from "../documentOps";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "services-federated-fasc.docx"));
const LEAD_START = "[This version has 4 tracked changes not yet accepted or rejected.";

/** The campaign's 03a: two edits as tracked changes, neither accepted nor rejected. */
async function withPendingEdits(): Promise<Buffer> {
  const { bytes, changes, errors } = await applyTrackedEdits(FIXTURE, [
    { find: "60", replace: "90", context_before: "not less than ", context_after: " days" },
    {
      find: "the Commonwealth of Pennsylvania",
      replace: "the State of Delaware",
      context_before: "in accordance with the laws of ",
      context_after: ".",
    },
  ]);
  expect(errors).toEqual([]);
  expect(changes).toHaveLength(2);
  return bytes;
}

const asArrayBuffer = (bytes: Buffer) => Uint8Array.from(bytes).buffer;

const index: DocIndex = {
  D1: { document_id: "doc", filename: "services-federated-fasc.docx", version_id: "version" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockResolvedValue({ id: "version", version_number: 2, storage_path: "v2", text_revision: "r2" });
});

describe("services-federated-fasc.docx with two edits pending", () => {
  it("read_document says first that the text shows proposals as if accepted, and lists the original wording after", async () => {
    const edited = await withPendingEdits();
    mocks.bytes.mockResolvedValue({ bytes: edited, storage_path: "v2" });
    const docs: DocStore = new Map([
      ["D1", { storage_path: "v1", filename: "services-federated-fasc.docx", file_type: "docx" }],
    ]);

    const text = await readDocumentContent("D1", docs, () => {}, index, {} as Db);

    // Before a word of the body.
    expect(text.startsWith(LEAD_START)).toBe(true);
    const [lead] = text.split("\n\n");
    expect(lead).toContain("as if accepted");
    expect(lead).toContain("the original wording is what the document says");
    expect(lead).toContain("name each change as proposed");
    // The body is the accepted view, character for character, as before.
    const body = await extractDocxBodyText(edited);
    expect(text.slice(lead.length + 2, lead.length + 2 + body.length)).toBe(body);
    expect(body).toContain("not less than 90 days");
    // After it, each change in its place, a deletion in the original
    // wording: the edit tool's minimal "6" for "9" is seen as 60 days.
    const notes = text.slice(lead.length + 2 + body.length);
    expect(notes).toMatch(
      /Deleted by Mike \(\d{4}-\d{2}-\d{2}\): "6", where the original reads "…[^"]*by either party on not less than 60 days’ written notice to the other party hereto\."/,
    );
    expect(notes).toMatch(
      /Inserted by Mike \(\d{4}-\d{2}-\d{2}\): "9", in "…[^"]*not less than 90 days’ written notice[^"]*"/,
    );
    expect(notes).toMatch(
      /Deleted by Mike \(\d{4}-\d{2}-\d{2}\): "Commonwealth of Pennsylvania", where the original reads "7\. Governing Law\. [^"]*the laws of the Commonwealth of Pennsylvania\."/,
    );
    expect(notes).toMatch(/Inserted by Mike \(\d{4}-\d{2}-\d{2}\): "State of Delaware", in "7\. Governing Law\./);
  });

  it("says so first on a search result's stored text too", async () => {
    const edited = await withPendingEdits();
    mocks.bytes.mockResolvedValue({ bytes: edited, storage_path: "v2" });
    const stored = await extractDocxBodyText(edited);
    mocks.stored.mockResolvedValue({ revision: "r2", status: "ready", text: stored, textless_page_count: 0 });
    const docs: DocStore = new Map([
      [
        "D1",
        {
          storage_path: "v2",
          filename: "services-federated-fasc.docx",
          file_type: "docx",
          search_source: { revision: "r2", userId: "u1" },
        },
      ],
    ]);

    const text = await readDocumentContent("D1", docs, () => {}, index, {} as Db);

    expect(text.startsWith(LEAD_START)).toBe(true);
    expect(text).toContain(`\n\n${stored}\n\n[Tracked changes: 4 not yet accepted or rejected.`);
  });

  it("leaves the edit tool's anchors and the search and tabular text as they were", async () => {
    const edited = await withPendingEdits();
    // Search and tabular review read documentText: the accepted view, no notes.
    const indexed = await EXTRACTION_OPS.documentText(asArrayBuffer(edited), "docx");
    expect(indexed.text).not.toContain("[This version has");
    expect(indexed.text).not.toContain("[Tracked changes");
    // An edit anchored on the body still applies on top of the pending ones.
    const again = await applyTrackedEdits(edited, [
      { find: "written notice", replace: "prior written notice", context_before: "90 days’ ", context_after: " to the other party" },
    ]);
    expect(again.errors).toEqual([]);
  });

  it("reads the document without pending changes exactly as its body", async () => {
    const text = await EXTRACTION_OPS.docxText(asArrayBuffer(FIXTURE));
    expect(text).toBe(await extractDocxBodyText(FIXTURE));
    expect(text).toContain("not less than 60 days");
    expect(text).toContain("the Commonwealth of Pennsylvania");
  });
});
