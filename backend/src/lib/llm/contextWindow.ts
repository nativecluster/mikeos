import { cachedNativeClusterModel, isNativeClusterModel } from "./nativecluster";

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
 * - MIKE_CONTEXT_WINDOW_TOKENS, a positive integer, sets one window for every
 *   model. It is for trying a small window against any model; anything else
 *   in it is ignored.
 * - Otherwise, for a "nativecluster/<model>" id, NativeCluster's
 *   `context_length` (the window on the Mac that runs it). Undefined until a
 *   listing of the cluster's models has been read: the backend and each
 *   worker thread read one as they start (warmNativeClusterModels), and a
 *   stale one is refreshed in the background.
 */
export function contextWindowFor(modelId: string): number | undefined {
  const override = Number(process.env.MIKE_CONTEXT_WINDOW_TOKENS);
  if (Number.isSafeInteger(override) && override > 0) return override;
  if (!isNativeClusterModel(modelId)) return undefined;
  return cachedNativeClusterModel(modelId)?.contextLength;
}
