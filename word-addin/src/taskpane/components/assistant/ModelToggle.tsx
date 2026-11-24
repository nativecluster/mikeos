import React, { useEffect, useMemo, useState } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ReasoningLevel,
} from "@mike/ui";
import {
  getNativeClusterModels,
  getOllamaModels,
  type ApiKeyStatus,
} from "../../api/mikeApi";
import {
  MODELS,
  NATIVECLUSTER_GROUP,
  allRouterModelOptions,
  inferenceProviderModels,
  modelDisplayName,
  nativeClusterModelOptions,
  type ModelOption,
  type NoModelsReason,
  type RouterSelections,
} from "@mike/client";
import { isModelAvailable } from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  routerSelections,
  compact = false,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No Models". */
  keyStatusLoading?: boolean;
  /** Each router's saved Model Selections; null before the profile loads. */
  routerSelections: RouterSelections | null;
  compact?: boolean;
  /** "nativecluster" when every model call goes to NativeCluster. */
  onNoModelsClick?: (reason?: NoModelsReason) => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
}): React.ReactElement {
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);
  const [nativeCluster, setNativeCluster] = useState<{
    models: ModelOption[];
    inferenceOnly: boolean;
  }>({ models: [], inferenceOnly: false });

  useEffect(() => {
    let cancelled = false;
    void getNativeClusterModels()
      .then((catalog) => ({
        models: nativeClusterModelOptions(catalog.models),
        inferenceOnly: catalog.inferenceOnly,
      }))
      // Not reachable: offer what else there is; the server still decides.
      .catch(() => ({ models: [], inferenceOnly: false }))
      .then((catalog) => {
        if (!cancelled) setNativeCluster(catalog);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getOllamaModels()
      .then((models) => {
        if (!cancelled) setOllamaModels(models);
      })
      // Local (Ollama) models are an optional extra: when the host is not
      // running there is simply no "Local" group, and nothing the user asked
      // for has failed.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    const routerOptions = allRouterModelOptions(routerSelections ?? {});
    const localOptions = ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Local",
    }));
    // Where every model call goes to NativeCluster, it is all there is.
    return inferenceProviderModels(
      [...MODELS, ...routerOptions, ...localOptions, ...nativeCluster.models],
      nativeCluster.inferenceOnly,
    ).filter(
      (model) =>
        model.group === "Local" ||
        model.group === NATIVECLUSTER_GROUP ||
        isModelAvailable(model.id, keyStatus),
    );
  }, [keyStatus, nativeCluster, ollamaModels, routerSelections]);
  const selected = models.find((model) => model.id === value);
  const supportedReasoningLevels = reasoningLevelsForModel(value);
  const normalizedReasoningLevel = reasoningLevel
    ? nearestReasoningLevelForModel(value, reasoningLevel)
    : undefined;

  useEffect(() => {
    if (
      reasoningLevel &&
      normalizedReasoningLevel &&
      normalizedReasoningLevel !== reasoningLevel &&
      onReasoningChange
    ) {
      onReasoningChange(normalizedReasoningLevel);
    }
  }, [normalizedReasoningLevel, onReasoningChange, reasoningLevel]);

  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={models}
      selectedLabel={
        keyStatusLoading
          ? (selected?.label ?? "Select model")
          : (selected?.label ??
            (models.length > 0 ? "Select model" : "No Models"))
      }
      selectedAvailable={selected !== undefined}
      loading={keyStatusLoading}
      compact={compact}
      emptyLabel="No Models"
      onEmptyClick={
        onNoModelsClick
          ? () =>
              onNoModelsClick(
                nativeCluster.inferenceOnly ? "nativecluster" : undefined,
              )
          : undefined
      }
      reasoningLevel={normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
    />
  );
}
