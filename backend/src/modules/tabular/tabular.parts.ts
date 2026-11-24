// A tabular source longer than the model's context window, read in parts.
//
// Only for a model whose window is known (lib/llm/contextWindow.ts): with no
// window, or a source that fits, nothing here runs and a cell or row is one
// model call as it always was. Otherwise the source is cut into overlapping
// parts, each part is read by a model call of its own (so a fair queue can let
// other work in between them), and one short call combines the parts' answers
// for each cell. Nothing is cut away: every character of the source is in at
// least one part, and a cell whose parts could not all be read fails rather
// than answering from some of them.

import { completeText, type UserApiKeys } from "../../lib/llm";
import {
    answerRoomTokens,
    completionMaxTokens,
    ContextWindowTooSmallError,
    estimateTokens,
    MIN_CHUNK_TOKENS,
    overlapTokensFor,
    promptBudgetTokens,
    splitByTokens,
    tokenCost,
} from "../../lib/llm/contextBudget";
import { contextWindowFor } from "../../lib/llm/contextWindow";
import { type CellResult } from "./tabular.shared";

export type SourcePart = {
    /** 1-based. */
    index: number;
    count: number;
    /** The part's text, led by where it is when it starts mid-source. */
    text: string;
};

/** Told to the model with each part, after the call's own instructions. */
export const PART_NOTE = `This document is too long to read at once, so it is being read in parts and you have been given one part. Answer only from this part. If this part does not contain what is asked for, answer "Not Found" and say in "reasoning" that this part does not cover it: another part may.`;

/** The cell's own note that it was read in parts, shown with its reasoning. */
export function partsNote(count: number): string {
    return `Read in ${count} parts: the document is longer than this model's context window, so each part was read separately and the answers combined.`;
}

// loadRowDocumentText heads each source with these two lines; PDFs mark each
// page and spreadsheets each sheet (lib/extraction, lib/spreadsheet.ts).
const SOURCE_HEADER = /^## Source document: .*\nSource document ID: .*$/gm;
const LOCATION_HEADER = /^## (?:Page \d+|Sheet: .*)$/gm;

type Header = { at: number; line: string };

function headersIn(text: string, pattern: RegExp): Header[] {
    return Array.from(text.matchAll(pattern), (m) => ({
        at: m.index ?? 0,
        line: m[0],
    }));
}

/** The last header that starts before `offset` and after `after`. */
function lastBefore(headers: Header[], offset: number, after = -1): Header | null {
    let found: Header | null = null;
    for (const header of headers) {
        if (header.at >= offset) break;
        if (header.at > after) found = header;
    }
    return found;
}

function longestCost(headers: Header[]): number {
    return headers.reduce((most, h) => Math.max(most, tokenCost(h.line)), 0);
}

/**
 * The source in parts of at most `budgetTokens` each, or null when it fits
 * whole. A part that starts inside a source repeats that source's heading
 * (its name and ID, which citations need) and the page or sheet it starts
 * on, so every part can be cited exactly.
 */
export function splitSource(
    text: string,
    budgetTokens: number,
): SourcePart[] | null {
    if (estimateTokens(text) <= budgetTokens) return null;
    const sources = headersIn(text, SOURCE_HEADER);
    const locations = headersIn(text, LOCATION_HEADER);
    // The heading a part may repeat, and the line break and "(continued)"
    // around it.
    const carried = Math.ceil(longestCost(sources) + longestCost(locations)) + 16;
    const partTokens = budgetTokens - carried;
    if (partTokens < MIN_CHUNK_TOKENS) {
        throw new ContextWindowTooSmallError(budgetTokens, carried + MIN_CHUNK_TOKENS);
    }
    const chunks = splitByTokens(text, partTokens, overlapTokensFor(partTokens));
    return chunks.map((chunk, i) => {
        let lead = "";
        if (chunk.start > 0) {
            const source = lastBefore(sources, chunk.start);
            const location = lastBefore(locations, chunk.start, source?.at ?? -1);
            const lines = [
                ...(source ? [source.line] : []),
                ...(location ? [`${location.line} (continued)`] : []),
            ];
            if (lines.length) lead = `${lines.join("\n")}\n\n`;
        }
        return { index: i + 1, count: chunks.length, text: lead + chunk.text };
    });
}

/** How a part is named in the document line of its prompt. */
export function partLabel(filename: string, part: SourcePart): string {
    return `${filename} (part ${part.index} of ${part.count})`;
}

/** The longest part label, for budgeting before the count is known. */
const LABEL_ALLOWANCE = " (part 9999 of 9999)";

/**
 * The parts to read a source in for `model`, or null to read it in one call:
 * the model's window is unknown, or the source fits beside the call's fixed
 * text and answer.
 */
export function planSourceParts(args: {
    model: string;
    documentText: string;
    systemPrompt: string;
    /** The call's prompt without the source, as it is sent. */
    fixedText: string;
    answerTokens: number;
}): SourcePart[] | null {
    const windowTokens = contextWindowFor(args.model);
    if (windowTokens === undefined) return null;
    const budget = promptBudgetTokens({
        windowTokens,
        answerTokens: answerRoomTokens(windowTokens, args.answerTokens),
        systemPrompt: args.systemPrompt,
        fixedText: args.fixedText + LABEL_ALLOWANCE,
    });
    return splitSource(args.documentText, budget);
}

const COMBINE_SYSTEM = `You are a legal document analyst. A document too long to read at once was read in parts, and the same instruction was answered for each part on its own. Combine those answers into the one answer for the whole document. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

Rules:
- Use only what the parts' answers say. Never add facts, citations or quotes of your own.
- Keep every citation exactly as a part wrote it ([[document:...||page:...||quote:...]] or [[document:...||sheet:...||cell:...||quote:...]]), next to the claim it supports.
- A part that answered "Not Found" only did not contain the answer; it says nothing against what another part found. Only when every part answered "Not Found" is the answer "Not Found".
- When parts disagree, give the answer the document as a whole supports and say in "reasoning" where they disagree.
- Parts overlap a little at their edges, so one finding may appear twice: give it once.
- The instruction's own requirements for "summary" still apply.
- The "summary" and "reasoning" values may use markdown; escape newlines as \\n inside the JSON strings.`;

/** The answer for parts `first` to `last` (1-based) of `count`. */
type Partial = { first: number; last: number; count: number; result: CellResult };

function renderPartial(partial: Partial): string {
    const { first, last, count } = partial;
    const label =
        first === last
            ? `Part ${first} of ${count}`
            : `Parts ${first} to ${last} of ${count}`;
    const { summary, flag, reasoning } = partial.result;
    return `### ${label}\n${JSON.stringify({ summary, flag, reasoning })}`;
}

function combineHeader(filename: string, instruction: string): string {
    return `Document: ${filename}\n\nInstruction: ${instruction}\n\nThe answers from each part, in document order:\n\n`;
}

/**
 * One answer from every part's answer. Each combining call is a model call of
 * its own; when the answers are too long to combine at once they are
 * combined a run of neighbours at a time, then those results again.
 */
async function combinePartials(args: {
    model: string;
    filename: string;
    instruction: string;
    partials: Partial[];
    maxTokens: number;
    apiKeys?: UserApiKeys;
    abortSignal?: AbortSignal;
    parse: (raw: string) => CellResult | null;
}): Promise<CellResult> {
    const windowTokens = contextWindowFor(args.model);
    const header = combineHeader(args.filename, args.instruction);
    const maxTokens = completionMaxTokens(windowTokens, args.maxTokens);
    const budget =
        windowTokens === undefined
            ? Number.POSITIVE_INFINITY
            : promptBudgetTokens({
                  windowTokens,
                  answerTokens: maxTokens,
                  systemPrompt: COMBINE_SYSTEM,
                  fixedText: header,
              });
    const combine = async (group: Partial[]): Promise<CellResult> => {
        args.abortSignal?.throwIfAborted();
        const raw = await completeText({
            model: args.model,
            systemPrompt: COMBINE_SYSTEM,
            user: header + group.map(renderPartial).join("\n\n"),
            maxTokens,
            apiKeys: args.apiKeys,
            abortSignal: args.abortSignal,
        });
        const result = args.parse(raw);
        if (!result) throw new Error("The combining call returned no answer.");
        return result;
    };

    let level = args.partials;
    while (true) {
        const costs = level.map((p) => estimateTokens(renderPartial(p)) + 1);
        if (costs.reduce((sum, c) => sum + c, 0) <= budget) return combine(level);
        const groups: Partial[][] = [];
        let current: Partial[] = [];
        let used = 0;
        for (const [i, partial] of level.entries()) {
            if (costs[i] > budget) {
                throw new ContextWindowTooSmallError(windowTokens ?? 0, costs[i]);
            }
            if (current.length && used + costs[i] > budget) {
                groups.push(current);
                current = [];
                used = 0;
            }
            current.push(partial);
            used += costs[i];
        }
        groups.push(current);
        if (groups.every((g) => g.length === 1)) {
            throw new ContextWindowTooSmallError(windowTokens ?? 0, costs[0] * 2);
        }
        const next: Partial[] = [];
        for (const group of groups) {
            next.push(
                group.length === 1
                    ? group[0]
                    : {
                          first: group[0].first,
                          last: group.at(-1)!.last,
                          count: group[0].count,
                          result: await combine(group),
                      },
            );
        }
        level = next;
    }
}

/**
 * The cell's answer from its parts' answers, marked as read in parts.
 * `results[i]` is part i+1's answer.
 */
export async function combinePartAnswers(args: {
    model: string;
    filename: string;
    instruction: string;
    results: CellResult[];
    maxTokens: number;
    apiKeys?: UserApiKeys;
    abortSignal?: AbortSignal;
    parse: (raw: string) => CellResult | null;
}): Promise<CellResult> {
    const count = args.results.length;
    const combined = await combinePartials({
        ...args,
        partials: args.results.map((result, i) => ({
            first: i + 1,
            last: i + 1,
            count,
            result,
        })),
    });
    const note = `_${partsNote(count)}_`;
    return {
        ...combined,
        reasoning: combined.reasoning.trim()
            ? `${combined.reasoning.trim()}\n\n${note}`
            : note,
        parts: count,
    };
}

/**
 * One cell read in parts: one call per part, then the combining call.
 * Throws when any call fails, so the cell is never answered from some parts.
 */
export async function answerCellInParts(args: {
    model: string;
    filename: string;
    parts: SourcePart[];
    systemPrompt: string;
    instruction: string;
    /** The call's prompt for one part. */
    userFor: (label: string, text: string) => string;
    maxTokens: number;
    apiKeys?: UserApiKeys;
    parse: (raw: string) => CellResult | null;
}): Promise<CellResult> {
    const maxTokens = completionMaxTokens(contextWindowFor(args.model), args.maxTokens);
    const results: CellResult[] = [];
    for (const part of args.parts) {
        const raw = await completeText({
            model: args.model,
            systemPrompt: `${args.systemPrompt}\n\n${PART_NOTE}`,
            user: args.userFor(partLabel(args.filename, part), part.text),
            maxTokens,
            apiKeys: args.apiKeys,
        });
        const result = args.parse(raw);
        if (!result) {
            throw new Error(`Part ${part.index} of ${part.count} returned no answer.`);
        }
        results.push(result);
    }
    return combinePartAnswers({
        model: args.model,
        filename: args.filename,
        instruction: args.instruction,
        results,
        maxTokens: args.maxTokens,
        apiKeys: args.apiKeys,
        parse: args.parse,
    });
}
