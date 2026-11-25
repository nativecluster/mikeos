// D3 (robustness campaign, 2026-11-24): a DOCX's tracked deletion and its
// comments never reached the model, and nothing said the document had
// unaccepted changes. Upstream's read is the accepted view on purpose (the
// edit tool anchors on it, and search and tabular review keep it); what it
// left out is the review itself. read_document now gives the accepted view,
// then apart from it each tracked change (insertion or deletion) and each
// comment, with its author. The body, and every edit anchored on it, are as
// they were.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { applyTrackedEdits, extractDocxBodyAndReview, extractDocxBodyText } from "../docxTrackedChanges";
import { EXTRACTION_OPS } from "../extraction/ops";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function docx(body: string, comments?: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`);
  if (comments) zip.file("word/comments.xml", `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W_NS}>${comments}</w:comments>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** The campaign's document: an insertion, a deletion, two comments. */
const reviewed = () => docx(
  para("MASTER SERVICES AGREEMENT") +
  '<w:p><w:r><w:t xml:space="preserve">The fee is </w:t></w:r><w:del w:id="1" w:author="Harness Reviewer" w:date="2026-11-24T10:00:00Z"><w:r><w:delText>USD 10,000</w:delText></w:r></w:del><w:ins w:id="2" w:author="Harness Reviewer" w:date="2026-11-24T10:01:00Z"><w:r><w:t>USD 12,500</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> a month.</w:t></w:r></w:p>' +
  '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Either party may terminate on thirty days\' notice.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>' +
  '<w:p><w:r><w:t>This agreement is governed by the laws of New York.</w:t></w:r><w:r><w:commentReference w:id="1"/></w:r></w:p>',
  '<w:comment w:id="0" w:author="Harness Reviewer" w:date="2026-11-24T10:03:00Z"><w:p><w:r><w:t>Thirty days is short; ask for sixty.</w:t></w:r></w:p></w:comment>' +
  '<w:comment w:id="1" w:author="Harness Partner"><w:p><w:r><w:t>Delaware instead?</w:t></w:r></w:p></w:comment>',
);

const ACCEPTED_VIEW = [
  "MASTER SERVICES AGREEMENT",
  "The fee is USD 12,500 a month.",
  "Either party may terminate on thirty days' notice.",
  "This agreement is governed by the laws of New York.",
].join("\n");

describe("D3: the model reads a DOCX's tracked changes and comments", () => {
  it("gives the accepted view, then each change and comment with its author", async () => {
    const bytes = await reviewed();
    const text = await EXTRACTION_OPS.docxText(Uint8Array.from(bytes).buffer);
    expect(text).toBe(`${ACCEPTED_VIEW}\n\n${[
      "[Tracked changes: 2 not yet accepted or rejected. The text above reads as if each were accepted: its insertions are in it and its deletions are not. Base an edit on the text above.]",
      '1. Deleted by Harness Reviewer (2026-11-24): "USD 10,000", in "The fee is USD 12,500 a month."',
      '2. Inserted by Harness Reviewer (2026-11-24): "USD 12,500", in "The fee is USD 12,500 a month."',
      "",
      "[Comments: 2.]",
      `1. Harness Reviewer (2026-11-24), on "Either party may terminate on thirty days' notice.": Thirty days is short; ask for sixty.`,
      '2. Harness Partner, on "This agreement is governed by the laws of New York.": Delaware instead?',
    ].join("\n")}`);
  });

  it("keeps the body the edit tool anchors on exactly as it was", async () => {
    const bytes = await reviewed();
    const { body } = await extractDocxBodyAndReview(bytes);
    expect(body).toBe(ACCEPTED_VIEW);
    await expect(extractDocxBodyText(bytes)).resolves.toBe(ACCEPTED_VIEW);
    // An edit anchored on the body still applies; one copied from the notes
    // (a deleted text) matches nothing in the document.
    const applied = await applyTrackedEdits(bytes, [
      { find: "thirty", replace: "sixty", context_before: "terminate on ", context_after: " days" },
      { find: "USD 10,000", replace: "USD 11,000", context_before: "The fee is ", context_after: " a month." },
    ]);
    expect(applied.changes).toHaveLength(1);
    expect(applied.errors.map((error) => error.index)).toEqual([1]);
  });

  it("reads a document with neither exactly as the accepted view", async () => {
    const bytes = await docx(para("Plain clause one.") + para("Plain clause two."));
    await expect(EXTRACTION_OPS.docxText(Uint8Array.from(bytes).buffer)).resolves.toBe("Plain clause one.\nPlain clause two.");
  });

  it("says so when comments cannot be read, and reads the rest", async () => {
    const zip = await JSZip.loadAsync(await docx(para("Clause.")));
    zip.file("word/comments.xml", "x".repeat(9 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(EXTRACTION_OPS.docxText(Uint8Array.from(bytes).buffer)).resolves.toBe(
      "Clause.\n\n[This document has comments that could not be read.]",
    );
  });
});
