// A tabular source longer than the model's context window is read in parts
// (tabular.parts.ts): one model call per part and a short combining call per
// cell, nothing cut away, and the cell says it was read in parts. With no
// window known, every request is exactly what it was.
//
// The row path runs the real AI SDK adapter over the scripted mock model; no
// model is called.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeText, streamChatWithTools, reportError } = vi.hoisted(() => ({
    completeText: vi.fn(),
    streamChatWithTools: vi.fn(),
    reportError: vi.fn(),
}));
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()),
    completeText,
    streamChatWithTools,
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../lib/observability/sentry")
    >()),
    reportError,
}));

import { streamAiSdk } from "../../../lib/llm/aiSdk";
import {
    config,
    makeModel,
    textStep,
} from "../../../lib/llm/__tests__/mockLanguageModel";
import { estimateTokens, safetyMarginTokens } from "../../../lib/llm/contextBudget";
import { queryTabularAllColumns, queryTabularCell } from "../tabular.extract";
import { partsNote, splitSource } from "../tabular.parts";
import type { CellResult } from "../tabular.shared";

const WINDOW = 8_192;
const DOC_ID = "3f0c2a8e-0000-4000-8000-000000000001";

/** A PDF-shaped source as loadRowDocumentText builds it, `pages` long. */
function longSource(pages: number): string {
    const body = Array.from(
        { length: pages },
        (_, i) =>
            `## Page ${i + 1}\n\n` +
            Array.from(
                { length: 12 },
                (_, j) =>
                    `Clause ${i + 1}.${j + 1}. The Supplier shall deliver the Goods described in Schedule ${i + 1} within thirty days of the Order.`,
            ).join("\n"),
    ).join("\n\n");
    return `## Source document: Master Services Agreement.pdf\nSource document ID: ${DOC_ID}\n\n${body}`;
}

const answer = (summary: string, reasoning = "") =>
    JSON.stringify({ summary, flag: "green", reasoning });

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllEnvs();
});

describe("splitSource", () => {
    it("leaves a source that fits whole", () => {
        expect(splitSource("short", 1_000)).toBeNull();
    });

    it("covers every character, and repeats the source and page a part starts in", () => {
        const source = longSource(40);
        const parts = splitSource(source, 2_000)!;
        expect(parts.length).toBeGreaterThan(2);
        for (const part of parts) {
            expect(estimateTokens(part.text)).toBeLessThanOrEqual(2_000);
            expect(part.count).toBe(parts.length);
        }
        for (const part of parts.slice(1)) {
            expect(part.text).toMatch(
                new RegExp(
                    `^## Source document: Master Services Agreement\\.pdf\\nSource document ID: ${DOC_ID}\\n## Page \\d+ \\(continued\\)\\n\\n`,
                ),
            );
        }
        // Every clause is in some part.
        for (let page = 1; page <= 40; page++) {
            for (const clause of [1, 12]) {
                const line = `Clause ${page}.${clause}. `;
                expect(parts.some((p) => p.text.includes(line))).toBe(true);
            }
        }
    });
});

describe("queryTabularCell", () => {
    it("is one call with today's prompt when no window is known", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");
        completeText.mockResolvedValue(answer("30 days"));
        const source = longSource(40);

        const result = await queryTabularCell("m", "MSA.pdf", source, "Delivery period?");

        expect(completeText).toHaveBeenCalledTimes(1);
        expect(completeText.mock.calls[0][0]).toMatchObject({
            model: "m",
            maxTokens: 2048,
            user: `Document: MSA.pdf\n\n${source}\n\n---\nInstruction: Delivery period? If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`,
        });
        expect(result).toEqual({ summary: "30 days", flag: "green", reasoning: "" });
    });

    it("is one call when the source fits the window", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        completeText.mockResolvedValue(answer("30 days"));

        const result = await queryTabularCell("m", "MSA.pdf", longSource(2), "Delivery period?");

        expect(completeText).toHaveBeenCalledTimes(1);
        expect(result?.parts).toBeUndefined();
    });

    it("reads a longer source part by part, each call within the window, then combines", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        const source = longSource(40);
        completeText.mockImplementation(async ({ user }: { user: string }) =>
            user.includes("The answers from each part")
                ? answer(
                      `Thirty days [[document:${DOC_ID}||page:3||quote:within thirty days]]`,
                      "Every part agrees.",
                  )
                : user.includes("(part 1 of")
                  ? answer(`Thirty days [[document:${DOC_ID}||page:3||quote:within thirty days]]`)
                  : answer("Not Found"),
        );

        const result = await queryTabularCell("m", "MSA.pdf", source, "Delivery period?");

        const calls = completeText.mock.calls.map(([params]) => params);
        const partCalls = calls.filter((c) => c.user.startsWith("Document: MSA.pdf (part "));
        expect(partCalls.length).toBeGreaterThan(1);
        expect(calls).toHaveLength(partCalls.length + 1);
        for (const call of calls) {
            expect(
                estimateTokens(call.systemPrompt) + estimateTokens(call.user) + call.maxTokens,
            ).toBeLessThanOrEqual(WINDOW - safetyMarginTokens(WINDOW));
        }
        // Each part call says which part it is; the combining call is last
        // and sees every part's answer, in order.
        partCalls.forEach((call, i) =>
            expect(call.user).toContain(`(part ${i + 1} of ${partCalls.length})`),
        );
        const combine = calls.at(-1)!;
        for (let i = 1; i <= partCalls.length; i++) {
            expect(combine.user).toContain(`### Part ${i} of ${partCalls.length}`);
        }
        expect(result).toEqual({
            summary: `Thirty days [[document:${DOC_ID}||page:3||quote:within thirty days]]`,
            flag: "green",
            reasoning: `Every part agrees.\n\n_${partsNote(partCalls.length)}_`,
            parts: partCalls.length,
        });
    });

    it("fails the cell, reporting once, when a part cannot be read", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        completeText
            .mockResolvedValueOnce(answer("Not Found"))
            .mockRejectedValueOnce(
                Object.assign(new Error("503"), { name: "AI_APICallError", statusCode: 503 }),
            );

        const result = await queryTabularCell("m", "MSA.pdf", longSource(40), "Delivery period?");

        expect(result).toBeNull();
        expect(completeText).toHaveBeenCalledTimes(2);
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("combines long answers a run of neighbours at a time", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        const long = "x".repeat(4_000);
        completeText.mockImplementation(async ({ user }: { user: string }) =>
            user.includes("The answers from each part")
                ? answer("Combined", "")
                : answer(`Found ${long}`),
        );

        const result = await queryTabularCell("m", "MSA.pdf", longSource(80), "Delivery period?");

        const combines = completeText.mock.calls
            .map(([params]) => params.user as string)
            .filter((user) => user.includes("The answers from each part"));
        expect(combines.length).toBeGreaterThan(1);
        expect(combines.at(-1)).toMatch(/### Parts 1 to \d+ of \d+/);
        expect(result?.summary).toBe("Combined");
    });
});

describe("queryTabularAllColumns", () => {
    const COLUMNS = [
        { index: 0, name: "Delivery", prompt: "Delivery period?" },
        { index: 1, name: "Law", prompt: "Governing law?" },
    ];
    const line = (column: number, summary: string) =>
        `${JSON.stringify({ column_index: column, summary, flag: "grey", reasoning: "" })}\n`;

    it("streams one call per part through the adapter, then combines each column", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        const source = longSource(40);
        const sent: { systemPrompt: string; messages: { content: string }[] }[] = [];
        const model = await makeModel(
            Array.from({ length: 20 }, () =>
                textStep(line(0, "Not Found") + line(1, "England")),
            ),
        );
        streamChatWithTools.mockImplementation(async (params) => {
            sent.push(params);
            return streamAiSdk(params, config(model));
        });
        completeText.mockResolvedValue(answer("Combined"));
        const results = new Map<number, CellResult>();

        await queryTabularAllColumns("m", "MSA.pdf", source, COLUMNS, async (index, result) => {
            results.set(index, result);
        });

        expect(sent.length).toBeGreaterThan(1);
        expect(model.doStreamCalls).toHaveLength(sent.length);
        for (const [i, params] of sent.entries()) {
            expect(params.messages[0].content).toContain(
                `Document: MSA.pdf (part ${i + 1} of ${sent.length})`,
            );
            expect(
                estimateTokens(params.systemPrompt) +
                    estimateTokens(params.messages[0].content),
            ).toBeLessThan(WINDOW);
        }
        // One combining call per column, each a call of its own.
        expect(completeText).toHaveBeenCalledTimes(2);
        expect([...results.keys()].sort()).toEqual([0, 1]);
        for (const result of results.values()) expect(result.parts).toBe(sent.length);
    });

    it("leaves a column out when a part did not answer it", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", String(WINDOW));
        const model = await makeModel([
            textStep(line(0, "Not Found") + line(1, "England")),
            ...Array.from({ length: 20 }, () => textStep(line(1, "England"))),
        ]);
        streamChatWithTools.mockImplementation((params) =>
            streamAiSdk(params, config(model)),
        );
        completeText.mockResolvedValue(answer("Combined"));
        const onResult = vi.fn(async () => {});

        await queryTabularAllColumns("m", "MSA.pdf", longSource(40), COLUMNS, onResult);

        expect(onResult).toHaveBeenCalledTimes(1);
        expect(onResult).toHaveBeenCalledWith(1, expect.objectContaining({ summary: "Combined" }));
    });

    it("sends today's single request when no window is known", async () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");
        const model = await makeModel([textStep(line(0, "30 days") + line(1, "England"))]);
        streamChatWithTools.mockImplementation((params) =>
            streamAiSdk(params, config(model)),
        );
        const onResult = vi.fn(async () => {});
        const source = longSource(40);

        await queryTabularAllColumns("m", "MSA.pdf", source, COLUMNS, onResult);

        expect(streamChatWithTools).toHaveBeenCalledTimes(1);
        const params = streamChatWithTools.mock.calls[0][0];
        expect(params.messages[0].content.startsWith(`Document: MSA.pdf\n\n${source}\n\n---\nColumns to extract:\n`)).toBe(true);
        expect(params.sourcePrefixLength).toBe(`Document: MSA.pdf\n\n${source}`.length);
        expect(completeText).not.toHaveBeenCalled();
        expect(onResult).toHaveBeenCalledTimes(2);
    });
});
