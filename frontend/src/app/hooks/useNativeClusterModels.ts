import { useEffect, useState } from "react";
import { nativeClusterModelOptions, type ModelOption } from "@mike/client";
import { getNativeClusterModels } from "@/app/lib/mikeApi";

/** What every picker knows of NativeCluster. */
export interface NativeClusterState {
    /** Picker rows for NativeCluster's chat models. */
    models: ModelOption[];
    /**
     * Every model call goes to NativeCluster: offer no other provider. False
     * until known; the server refuses other providers either way.
     */
    inferenceOnly: boolean;
}

const EMPTY: NativeClusterState = { models: [], inferenceOnly: false };

// Module-level store so every picker shares one fetch, as with Ollama. A
// failed fetch is an empty catalog that allows every provider (the server
// still decides), and is retried on the next mount.
let cache: NativeClusterState | null = null;
let inflight: Promise<NativeClusterState> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<NativeClusterState> {
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        inflight = Promise.resolve()
            .then(() => getNativeClusterModels())
            .then((catalog) => {
                cache = {
                    models: nativeClusterModelOptions(catalog.models),
                    inferenceOnly: catalog.inferenceOnly,
                };
                listeners.forEach((listener) => listener());
                return cache;
            })
            .catch(() => {
                inflight = null;
                return EMPTY;
            });
    }
    return inflight;
}

/** Test seam: forget the shared catalog. */
export function resetNativeClusterModels(): void {
    cache = null;
    inflight = null;
}

export function useNativeClusterModels(): NativeClusterState {
    const [state, setState] = useState<NativeClusterState>(cache ?? EMPTY);

    useEffect(() => {
        let mounted = true;
        const update = () => {
            if (mounted && cache) setState(cache);
        };
        listeners.add(update);
        void load().then((loaded) => {
            if (mounted) setState(loaded);
        });
        return () => {
            mounted = false;
            listeners.delete(update);
        };
    }, []);

    return state;
}
