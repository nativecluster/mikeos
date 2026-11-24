import {
    inferenceOnlyProvider,
    isNativeClusterChatModel,
    listNativeClusterModels,
    NATIVECLUSTER_MODEL_PREFIX,
} from "../../lib/llm/nativecluster";
import type { NativeClusterCatalog } from "./models.types";

/**
 * NativeCluster's chat models, live from its GET /v1/models, and whether
 * this deployment runs every model there (MIKE_INFERENCE_PROVIDER), which
 * is how the clients know to offer nothing else. Empty, never an error,
 * when NativeCluster is off or unreachable: Mike still opens without it.
 */
export async function listNativeClusterCatalog(): Promise<NativeClusterCatalog> {
    const models = (await listNativeClusterModels())
        .filter(isNativeClusterChatModel)
        .map((model) => ({
            id: `${NATIVECLUSTER_MODEL_PREFIX}${model.id}`,
            label: model.id,
            group: "NativeCluster",
        }));
    return { inferenceOnly: inferenceOnlyProvider() !== null, models };
}
