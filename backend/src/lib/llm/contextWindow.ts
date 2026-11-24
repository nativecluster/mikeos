/**
 * A model's context window, in tokens (the prompt and the answer together),
 * or undefined when Mike does not know it.
 *
 * Undefined is the hosted case: those windows (200k to 1M tokens) are far
 * larger than anything Mike sends, and every budget in lib/llm/contextBudget.ts
 * steps aside, so the requests are exactly what they were before windows were
 * known. A local model's window is set by the hardware it runs on, often 32k
 * to 128k tokens, and is what turns the budgets on.
 *
 * MIKE_CONTEXT_WINDOW_TOKENS, a positive integer, sets one window for every
 * model. It is for trying a small window against any model; anything else in
 * it is ignored.
 */
export function contextWindowFor(modelId: string): number | undefined {
    void modelId;
    const override = Number(process.env.MIKE_CONTEXT_WINDOW_TOKENS);
    if (Number.isSafeInteger(override) && override > 0) return override;
    return undefined;
}
