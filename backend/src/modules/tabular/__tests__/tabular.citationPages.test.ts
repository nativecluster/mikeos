// A tabular cell's citation opens the page its quote is on. Found by the
// real-model campaign (2026-11-25, 04, build 2): the endorsement's cells
// cited the PDF's printed page numbers, s. 11.4 "at page 7" where it is on
// the PDF's page 5, renewal s. 8.1 at page 6 (page 4).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeText, streamChatWithTools } = vi.hoisted(() => ({
    completeText: vi.fn(),
    streamChatWithTools: vi.fn(),
}));
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()),
    completeText,
    streamChatWithTools,
}));

import { withInlineCitationPagesFound } from "../../chat/chat.service";
import { queryTabularAllColumns, queryTabularCell } from "../tabular.extract";
import type { CellResult } from "../tabular.shared";

const TERMINATION = "Either party may terminate this Agreement upon thirty (30) days written notice";
const RENEWAL = "This Agreement shall renew automatically for successive one-year terms";

/** The endorsement as its PDF's text reads: page 5 is printed "7", page 4 "6". */
const ENDORSEMENT = [
    "[Page 1]\nENDORSEMENT AGREEMENT\n- 3 -",
    "[Page 2]\n1. Definitions.\n- 4 -",
    "[Page 3]\n5. Compensation.\n- 5 -",
    `[Page 4]\n8.1 Renewal. ${RENEWAL} unless either party gives notice.\n- 6 -`,
    `[Page 5]\n11.4 Termination. ${TERMINATION} to the other party.\n- 7 -`,
].join("\n\n");

const cite = (page: number, quote: string) =>
    `[[document:doc-endorsement||page:${page}||quote:${quote}]]`;

beforeEach(() => {
    vi.clearAllMocks();
});

describe("withInlineCitationPagesFound", () => {
    it("sets each page citation to the page its quote is on", () => {
        const text = `30 days ${cite(7, TERMINATION)}; renews yearly ${cite(6, RENEWAL)}.`;
        expect(withInlineCitationPagesFound(text, ENDORSEMENT)).toBe(
            `30 days ${cite(5, TERMINATION)}; renews yearly ${cite(4, RENEWAL)}.`,
        );
    });

    it("keeps a cited page that holds the quote too", () => {
        // "either party" is on page 4 and on page 5.
        const text = `Termination ${cite(5, "either party")}`;
        expect(withInlineCitationPagesFound(text, ENDORSEMENT)).toBe(text);
    });

    it("leaves a quote not found, a cell citation and an unpaged source as written", () => {
        const missing = `Assignable ${cite(9, "Either party may assign freely")}`;
        expect(withInlineCitationPagesFound(missing, ENDORSEMENT)).toBe(missing);
        const cell = "42 [[document:doc-sheet||sheet:Summary||cell:B7||quote:42]]";
        expect(withInlineCitationPagesFound(cell, ENDORSEMENT)).toBe(cell);
        const text = `30 days ${cite(7, TERMINATION)}`;
        expect(withInlineCitationPagesFound(text, `11.4 Termination. ${TERMINATION}.`)).toBe(text);
    });
});

describe("a tabular review's cells", () => {
    it("cite the page a quote is on, not the page number printed on it (one cell)", async () => {
        completeText.mockResolvedValue(
            JSON.stringify({
                summary: `30 days' written notice ${cite(7, TERMINATION)}`,
                flag: "green",
                reasoning: `Section 11.4 ${cite(7, TERMINATION)}`,
            }),
        );

        const result = await queryTabularCell(
            "m",
            "endorsement.pdf",
            ENDORSEMENT,
            "How can the agreement be terminated?",
        );

        expect(result?.summary).toBe(`30 days' written notice ${cite(5, TERMINATION)}`);
        expect(result?.reasoning).toBe(`Section 11.4 ${cite(5, TERMINATION)}`);
    });

    it("cite the page a quote is on, not the page number printed on it (a row)", async () => {
        streamChatWithTools.mockImplementation(
            async (params: { callbacks: { onContentDelta: (delta: string) => void } }) => {
                params.callbacks.onContentDelta(
                    `${JSON.stringify({ column_index: 0, summary: `30 days ${cite(7, TERMINATION)}`, flag: "green", reasoning: "" })}\n` +
                        `${JSON.stringify({ column_index: 1, summary: `Yearly ${cite(6, RENEWAL)}`, flag: "grey", reasoning: "" })}\n`,
                );
                return { fullText: "" };
            },
        );
        const results = new Map<number, CellResult>();

        await queryTabularAllColumns(
            "m",
            "endorsement.pdf",
            ENDORSEMENT,
            [
                { index: 0, name: "Termination", prompt: "Termination notice?" },
                { index: 1, name: "Renewal", prompt: "Renewal?" },
            ],
            async (column, result) => void results.set(column, result),
        );

        expect(results.get(0)?.summary).toBe(`30 days ${cite(5, TERMINATION)}`);
        expect(results.get(1)?.summary).toBe(`Yearly ${cite(4, RENEWAL)}`);
    });
});
