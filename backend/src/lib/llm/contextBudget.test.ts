import { afterEach, describe, expect, it, vi } from "vitest";

import {
    answerRoomTokens,
    completionMaxTokens,
    endWithinTokens,
    estimateMessageTokens,
    estimateTokens,
    headWithinTokens,
    MESSAGE_OVERHEAD_TOKENS,
    MIN_PAGE_TOKENS,
    promptBudgetTokens,
    safetyMarginTokens,
    splitByTokens,
    startWithinTokens,
    tailWithinTokens,
    tokenCost,
    turnContextBudget,
} from "./contextBudget";
import { contextWindowFor } from "./contextWindow";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("contextWindowFor (stub)", () => {
    it("knows no window by default, so hosted models keep today's requests", () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "");
        expect(contextWindowFor("claude-opus-5-5")).toBeUndefined();
    });

    it("takes a positive integer override for every model", () => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", "32768");
        expect(contextWindowFor("any-model")).toBe(32_768);
    });

    it.each(["0", "-5", "12.5", "lots"])("ignores an unusable override %j", (value) => {
        vi.stubEnv("MIKE_CONTEXT_WINDOW_TOKENS", value);
        expect(contextWindowFor("any-model")).toBeUndefined();
    });
});

describe("estimating tokens", () => {
    it("counts three ASCII characters a token, rounding up", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abc")).toBe(1);
        expect(estimateTokens("abcd")).toBe(2);
        expect(tokenCost("x".repeat(300))).toBe(100);
    });

    it("counts every other character as a whole token", () => {
        // Chinese and Japanese run about a token a character on current
        // tokenizers; accented Latin letters often cost one each.
        expect(estimateTokens("合同条款")).toBe(4);
        expect(estimateTokens("été")).toBe(Math.ceil(2 + 1 / 3));
    });

    it("overestimates ordinary English legal text against ~4 characters a token", () => {
        const clause =
            "The Supplier shall indemnify the Customer against all losses arising under clause 14.2(b) of this Agreement. ";
        const text = clause.repeat(100);
        expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
    });

    it("adds template overhead per message, and counts replayed reasoning", () => {
        expect(
            estimateMessageTokens([
                { content: "abc" },
                { content: "abc", reasoning: "abcabc" },
            ]),
        ).toBe(1 + 1 + 2 + 2 * MESSAGE_OVERHEAD_TOKENS);
    });
});

describe("answer room and prompt budget", () => {
    it("assumes a quarter of the window for a streamed answer, within bounds", () => {
        vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
        expect(answerRoomTokens(32_768)).toBe(8_192);
        expect(answerRoomTokens(2_048)).toBe(1_024);
        expect(answerRoomTokens(1_000_000)).toBe(16_384);
    });

    it("uses the operator's output cap when one is set", () => {
        vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "4096");
        expect(answerRoomTokens(32_768)).toBe(4_096);
    });

    it("never gives the answer more than half the window", () => {
        expect(answerRoomTokens(32_768, 20_000)).toBe(16_384);
        expect(completionMaxTokens(32_768, 20_000)).toBe(16_384);
    });

    it("leaves a completion's cap alone when no window is known", () => {
        expect(completionMaxTokens(undefined, 20_000)).toBe(20_000);
    });

    it("subtracts the answer, the margin and every fixed part", () => {
        const window = 32_768;
        const budget = promptBudgetTokens({
            windowTokens: window,
            answerTokens: 2_048,
            systemPrompt: "x".repeat(300),
            fixedText: "y".repeat(30),
        });
        expect(budget).toBe(
            window - 2_048 - safetyMarginTokens(window) - 100 - 10 -
                2 * MESSAGE_OVERHEAD_TOKENS,
        );
    });
});

describe("cutting text to a budget", () => {
    const paragraph = (n: number) => `Paragraph ${n}. ${"word ".repeat(40).trim()}`;
    const text = Array.from({ length: 30 }, (_, i) => paragraph(i)).join("\n\n");

    it("keeps a head within the budget, ending between words", () => {
        const head = headWithinTokens(text, 200);
        expect(estimateTokens(head)).toBeLessThanOrEqual(200);
        expect(head).toMatch(/\s$/);
        expect(text.startsWith(head)).toBe(true);
    });

    it("prefers a paragraph break near the end of the budget", () => {
        const twoParagraphs = `${"a".repeat(570)}\n\n${"b".repeat(100)}`;
        expect(headWithinTokens(twoParagraphs, 200)).toBe(`${"a".repeat(570)}\n\n`);
    });

    it("keeps a tail within the budget, starting after a break", () => {
        const tail = tailWithinTokens(text, 200);
        expect(estimateTokens(tail)).toBeLessThanOrEqual(200);
        expect(text.endsWith(tail)).toBe(true);
        expect(text[text.length - tail.length - 1]).toMatch(/\s/);
    });

    it("returns the whole text when it fits", () => {
        expect(headWithinTokens("short", 100)).toBe("short");
        expect(tailWithinTokens("short", 100)).toBe("short");
        expect(endWithinTokens("short", 0, 100)).toBe(5);
        expect(startWithinTokens("short", 100)).toBe(0);
    });

    it("always moves forward, even when one character is over budget", () => {
        expect(endWithinTokens("合同", 0, 0.5)).toBe(1);
    });

    it("never splits a surrogate pair", () => {
        const emoji = "😀".repeat(10);
        const end = endWithinTokens(emoji, 0, 5);
        expect(end % 2).toBe(0);
    });
});

describe("splitByTokens", () => {
    const text = Array.from(
        { length: 200 },
        (_, i) => `Clause ${i + 1}. The parties agree to term ${i + 1}.`,
    ).join("\n");

    it("covers the whole text in parts within the budget, in order", () => {
        const chunks = splitByTokens(text, 300, 30);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0].start).toBe(0);
        expect(chunks.at(-1)!.end).toBe(text.length);
        for (const [i, chunk] of chunks.entries()) {
            expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(300);
            expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
            if (i > 0) {
                // Overlapping, but always progressing.
                expect(chunk.start).toBeLessThan(chunks[i - 1].end);
                expect(chunk.start).toBeGreaterThan(chunks[i - 1].start);
            }
        }
    });

    it("loses no character between parts", () => {
        const chunks = splitByTokens(text, 250, 20);
        let covered = 0;
        for (const chunk of chunks) {
            expect(chunk.start).toBeLessThanOrEqual(covered);
            covered = Math.max(covered, chunk.end);
        }
        expect(covered).toBe(text.length);
    });

    it("returns text that fits as one part", () => {
        expect(splitByTokens("a short contract", 100, 10)).toEqual([
            { start: 0, end: 16, text: "a short contract" },
        ]);
    });
});

describe("TurnContextBudget", () => {
    it("is null when the window is unknown", () => {
        expect(
            turnContextBudget(undefined, { systemPrompt: "", tools: [], messages: [] }),
        ).toBeNull();
    });

    it("starts from the prompt, tools and history, and spends what arrives", () => {
        vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
        const budget = turnContextBudget(32_768, {
            systemPrompt: "x".repeat(3_000),
            tools: [],
            messages: [{ content: "hello" }],
        })!;
        const start = budget.remaining();
        expect(start).toBe(
            promptBudgetTokens({
                windowTokens: 32_768,
                answerTokens: 8_192,
                systemPrompt: "x".repeat(3_000),
                messages: [{ content: "hello" }],
            }),
        );
        expect(budget.pageTokens()).toBe(Math.floor(start / 2));
        expect(budget.pageTokens(2)).toBe(Math.floor(start / 4));
        budget.spendText("z".repeat(3_000));
        expect(budget.remaining()).toBe(start - 1_000);
    });

    it("offers no page once too little is free", () => {
        const budget = turnContextBudget(8_192, {
            systemPrompt: "",
            tools: [],
            messages: [],
        })!;
        budget.spendTokens(budget.remaining() - MIN_PAGE_TOKENS);
        expect(budget.pageTokens()).toBe(0);
    });
});
