import { cachedNativeClusterModel, isNativeClusterModel } from "./nativecluster";

/**
 * The context window, in tokens, of the model behind an app-level model id,
 * where the provider states one: NativeCluster's `context_length` for a
 * "nativecluster/<model>" id (the window on the Mac that runs it, which the
 * prompt and the answer share). Undefined for every other model, and for a
 * NativeCluster model until a listing of the cluster's models has been read
 * (the first call starts one in the background).
 */
export function contextWindowFor(modelId: string): number | undefined {
  if (!isNativeClusterModel(modelId)) return undefined;
  return cachedNativeClusterModel(modelId)?.contextLength;
}
