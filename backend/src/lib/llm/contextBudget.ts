/**
 * Token budgets for models whose context window is known
 * (lib/llm/contextWindow.ts).
 *
 * Mike counts no tokens: it has no tokenizer for most of the models it runs,
 * and a local model's tokenizer is not reachable from here. So the budget is
 * an estimate from characters that errs toward too many tokens, never too few:
 * an overestimate costs a few more parts or pages, an underestimate is a
 * request the model refuses or silently cuts off.
 *
 * The estimate: each ASCII character costs a third of a token and every other
 * character a whole one. English prose runs about four characters a token on
 * current tokenizers (cl100k, o200k, Llama 3, Qwen); legal text is denser
 * (section numbers, citations, defined terms, dates and figures split into
 * short pieces), and older small-vocabulary tokenizers run nearer three and a
 * half. Three keeps English legal text on the safe side. Outside ASCII the
 * spread is wide: accented Latin letters often cost a token each, Cyrillic or
 * Greek two or three characters a token, Chinese, Japanese and Korean about a
 * token a character, some scripts more. One token a character is the safe end
 * of that, and the safety margin below covers the rest (chat-template tokens,
 * digit runs, markup).
 *
 * Every function here is pure; callers decide what a budget is for.
 */

/** ASCII characters per estimated token. See the module comment. */
export const ASCII_CHARS_PER_TOKEN = 3;

/** Chat-template tokens assumed for each message (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/** Below this many tokens a part of a document is too small to be useful. */
export const MIN_CHUNK_TOKENS = 1_024;

/** A window too small for even the fixed parts of a request and one useful part. */
export class ContextWindowTooSmallError extends Error {
    constructor(
        readonly windowTokens: number,
        readonly neededTokens: number,
    ) {
        super(
            `The model's context window (${windowTokens} tokens) is too small for this request: its instructions and answer alone need about ${neededTokens} tokens.`,
        );
        this.name = "ContextWindowTooSmallError";
    }
}

/** The estimated token cost of `text`, unrounded so pieces can be summed. */
export function tokenCost(text: string): number {
    let ascii = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 0x80) ascii += 1;
    }
    return ascii / ASCII_CHARS_PER_TOKEN + (text.length - ascii);
}

/** The estimated tokens of `text`, rounded up. */
export function estimateTokens(text: string): number {
    return Math.ceil(tokenCost(text));
}

/** The estimated tokens of chat messages, their reasoning and template included. */
export function estimateMessageTokens(
    messages: readonly { content?: unknown; reasoning?: string }[],
): number {
    let total = 0;
    for (const message of messages) {
        const content =
            typeof message.content === "string"
                ? message.content
                : message.content == null
                  ? ""
                  : JSON.stringify(message.content);
        total +=
            tokenCost(content) +
            (message.reasoning ? tokenCost(message.reasoning) : 0) +
            MESSAGE_OVERHEAD_TOKENS;
    }
    return Math.ceil(total);
}

/** The estimated tokens of tool schemas, as a chat template renders them. */
export function estimateToolTokens(tools: readonly unknown[]): number {
    if (!tools.length) return 0;
    return (
        estimateTokens(JSON.stringify(tools)) +
        tools.length * MESSAGE_OVERHEAD_TOKENS
    );
}

/** Tokens kept back from every budget for what the estimate cannot see. */
export function safetyMarginTokens(windowTokens: number): number {
    return Math.max(256, Math.ceil(windowTokens * 0.05));
}

function positiveInteger(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Room kept for the answer. `requested` is a call's own output cap (a
 * one-shot completion's maxTokens); a streamed answer has none unless the
 * operator set LLM_MAX_OUTPUT_TOKENS (lib/llm/aiSdk.ts), so it is assumed to
 * need a quarter of the window, at least 1,024 and at most 16,384 tokens.
 * Never more than half the window: the prompt needs the other half.
 */
export function answerRoomTokens(
    windowTokens: number,
    requested?: number,
): number {
    const room =
        positiveInteger(requested) ??
        positiveInteger(process.env.LLM_MAX_OUTPUT_TOKENS) ??
        Math.min(16_384, Math.max(1_024, Math.floor(windowTokens / 4)));
    return Math.min(room, Math.floor(windowTokens / 2));
}

/**
 * A one-shot completion's output cap for a model with a known window: the
 * caller's own, but never more than half the window. Without a window the
 * caller's cap is returned unchanged.
 */
export function completionMaxTokens(
    windowTokens: number | undefined,
    requested: number,
): number {
    return windowTokens === undefined
        ? requested
        : answerRoomTokens(windowTokens, requested);
}

/**
 * Tokens left for a request's variable content (a document, a transcript)
 * once the answer, the safety margin and its fixed parts are counted.
 * Negative when the fixed parts alone do not fit.
 */
export function promptBudgetTokens(args: {
    windowTokens: number;
    answerTokens: number;
    systemPrompt?: string;
    /** Fixed text sent with the variable content: instructions, headers. */
    fixedText?: string;
    tools?: readonly unknown[];
    messages?: readonly { content?: unknown; reasoning?: string }[];
}): number {
    return (
        args.windowTokens -
        args.answerTokens -
        safetyMarginTokens(args.windowTokens) -
        (args.systemPrompt ? estimateTokens(args.systemPrompt) : 0) -
        (args.fixedText ? estimateTokens(args.fixedText) : 0) -
        (args.tools ? estimateToolTokens(args.tools) : 0) -
        (args.messages ? estimateMessageTokens(args.messages) : 0) -
        // The system prompt and the request's own message.
        2 * MESSAGE_OVERHEAD_TOKENS
    );
}

function charCost(text: string, index: number): number {
    return text.charCodeAt(index) < 0x80 ? 1 / ASCII_CHARS_PER_TOKEN : 1;
}

/** Never split a surrogate pair. */
function safeCut(text: string, index: number): number {
    if (index <= 0 || index >= text.length) return index;
    const before = text.charCodeAt(index - 1);
    return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}

const BOUNDARIES = ["\n\n", "\n", ". ", " "] as const;

/**
 * Index where a piece ending at `limit` should end instead: just after the
 * last paragraph break, line break, sentence end or space in its final fifth,
 * so a part ends between words.
 */
function backToBoundary(text: string, from: number, limit: number): number {
    if (limit >= text.length) return text.length;
    const floor = from + Math.floor((limit - from) * 0.8);
    for (const boundary of BOUNDARIES) {
        const at = text.lastIndexOf(boundary, limit - boundary.length);
        if (at >= floor) return at + boundary.length;
    }
    return safeCut(text, limit);
}

/**
 * Where a piece starting at `limit` should start instead: just after the
 * first line break or space in its first fifth.
 */
function forwardToBoundary(text: string, limit: number, to: number): number {
    if (limit <= 0) return 0;
    const ceiling = limit + Math.floor((to - limit) * 0.2);
    for (const boundary of ["\n", " "] as const) {
        const at = text.indexOf(boundary, limit);
        if (at !== -1 && at + boundary.length <= ceiling) {
            return at + boundary.length;
        }
    }
    return safeCut(text, limit);
}

/**
 * The end (exclusive) of the longest piece of `text` from `start` whose
 * estimate is at most `tokens`, moved back to a boundary when one is near.
 * Always past `start` while text remains, so a caller always progresses.
 */
export function endWithinTokens(
    text: string,
    start: number,
    tokens: number,
): number {
    let cost = 0;
    let end = start;
    while (end < text.length) {
        const next = cost + charCost(text, end);
        if (next > tokens) break;
        cost = next;
        end += 1;
    }
    if (end >= text.length) return text.length;
    const cut = backToBoundary(text, start, end);
    return cut > start ? cut : Math.max(safeCut(text, end), start + 1);
}

/**
 * The start of the longest piece of `text` ending at `end` whose estimate is
 * at most `tokens`, moved forward to a boundary when one is near.
 */
export function startWithinTokens(
    text: string,
    tokens: number,
    end = text.length,
): number {
    let cost = 0;
    let start = end;
    while (start > 0) {
        const next = cost + charCost(text, start - 1);
        if (next > tokens) break;
        cost = next;
        start -= 1;
    }
    if (start <= 0) return 0;
    const cut = forwardToBoundary(text, start, end);
    return cut < end ? cut : start;
}

/** The longest opening of `text` within `tokens`, ending at a boundary. */
export function headWithinTokens(text: string, tokens: number): string {
    return text.slice(0, endWithinTokens(text, 0, tokens));
}

/** The longest ending of `text` within `tokens`, starting at a boundary. */
export function tailWithinTokens(text: string, tokens: number): string {
    return text.slice(startWithinTokens(text, tokens));
}

export type TextChunk = {
    /** Character offsets into the original text, end exclusive. */
    start: number;
    end: number;
    text: string;
};

/**
 * `text` in consecutive parts of at most `chunkTokens` each, every part after
 * the first starting `overlapTokens` before the previous one ended, so a
 * clause cut at a boundary is whole in one of them. Parts end at paragraph,
 * line, sentence or word boundaries where one is near. Text that fits is one
 * part.
 */
export function splitByTokens(
    text: string,
    chunkTokens: number,
    overlapTokens = 0,
): TextChunk[] {
    if (chunkTokens < 1) throw new RangeError("chunkTokens must be at least 1");
    const chunks: TextChunk[] = [];
    let start = 0;
    while (true) {
        const end = endWithinTokens(text, start, chunkTokens);
        chunks.push({ start, end, text: text.slice(start, end) });
        if (end >= text.length) return chunks;
        const overlapped =
            overlapTokens > 0 ? startWithinTokens(text, overlapTokens, end) : end;
        start = overlapped > start ? overlapped : end;
    }
}

/** How much of a part's budget the overlap with the previous part takes. */
export function overlapTokensFor(chunkTokens: number): number {
    return Math.min(512, Math.floor(chunkTokens * 0.05));
}

/** Below this a page of a document is not worth returning. */
export const MIN_PAGE_TOKENS = 512;

/**
 * What one assistant turn has put in front of the model so far, against its
 * window. The turn starts with the system prompt, tools and history counted;
 * every tool result, and the model's own words between them, is spent as it
 * arrives, because each stays in the conversation for the rest of the turn.
 */
export class TurnContextBudget {
    private used: number;

    constructor(
        readonly windowTokens: number,
        /** Tokens already committed: prompt, tools, history, answer, margin. */
        committedTokens: number,
    ) {
        this.used = committedTokens;
    }

    /** Tokens still free in this turn. */
    remaining(): number {
        return Math.max(0, Math.floor(this.windowTokens - this.used));
    }

    spendText(text: string): void {
        this.used += tokenCost(text);
    }

    spendTokens(tokens: number): void {
        this.used += tokens;
    }

    /**
     * Tokens one of `count` reads may return now: half of what is free,
     * shared between them, so the turn keeps room to work with what it read.
     * Zero when that is too little to be useful.
     */
    pageTokens(count = 1): number {
        const share = Math.floor(this.remaining() / 2 / Math.max(1, count));
        return share >= MIN_PAGE_TOKENS ? share : 0;
    }
}

/**
 * A turn's budget, or null when the window is unknown (the hosted case, which
 * keeps every request as it was).
 */
export function turnContextBudget(
    windowTokens: number | undefined,
    args: {
        systemPrompt: string;
        tools: readonly unknown[];
        messages: readonly { content?: unknown; reasoning?: string }[];
        answerTokens?: number;
    },
): TurnContextBudget | null {
    if (windowTokens === undefined) return null;
    const free = promptBudgetTokens({
        windowTokens,
        answerTokens: answerRoomTokens(windowTokens, args.answerTokens),
        systemPrompt: args.systemPrompt,
        tools: args.tools,
        messages: args.messages,
    });
    return new TurnContextBudget(windowTokens, windowTokens - free);
}

/** The share of a turn's free room its earlier conversation may take. */
export const HISTORY_SHARE = 0.6;

/**
 * A conversation cut to fit: the oldest turns left out until the rest fits
 * `historyTokens`, always keeping the newest user message and what follows
 * it (the turn being answered), and starting the rest on a user message.
 * `pinned` leading messages (a memory turn) are kept while anything older
 * can go, and go only when the turn being answered needs their room.
 * `fits` is false only when the turn being answered is over `ceilingTokens`
 * on its own.
 */
export function fitHistory<
    T extends { role: string; content?: unknown; reasoning?: string },
>(
    messages: readonly T[],
    args: { historyTokens: number; ceilingTokens: number; pinned?: number },
): { messages: T[]; dropped: number; tokens: number; fits: boolean } {
    const all = estimateMessageTokens(messages);
    if (all <= args.historyTokens) {
        return { messages: [...messages], dropped: 0, tokens: all, fits: true };
    }
    const pinnedCount = Math.min(args.pinned ?? 0, messages.length);
    let lastUser = -1;
    for (let i = messages.length - 1; i >= pinnedCount; i--) {
        if (messages[i].role === "user") {
            lastUser = i;
            break;
        }
    }
    const currentStart = lastUser >= 0 ? lastUser : Math.max(pinnedCount, messages.length - 1);
    const pinned = messages.slice(0, pinnedCount);
    const current = messages.slice(currentStart);
    const older = messages.slice(pinnedCount, currentStart);
    const pinnedTokens = estimateMessageTokens(pinned);
    const currentTokens = estimateMessageTokens(current);

    // The newest earlier messages that fit beside the pinned and current ones.
    let room = args.historyTokens - pinnedTokens - currentTokens;
    let keepFrom = older.length;
    while (keepFrom > 0) {
        const cost = estimateMessageTokens([older[keepFrom - 1]]);
        if (cost > room) break;
        room -= cost;
        keepFrom -= 1;
    }
    // Begin on a user message, as a conversation does.
    while (keepFrom < older.length && older[keepFrom].role !== "user") keepFrom += 1;
    const kept = older.slice(keepFrom);

    const keepPinned = pinnedTokens + currentTokens <= args.ceilingTokens;
    const result = [...(keepPinned ? pinned : []), ...kept, ...current];
    return {
        messages: result,
        dropped: messages.length - result.length,
        tokens: estimateMessageTokens(result),
        fits: currentTokens <= args.ceilingTokens,
    };
}
