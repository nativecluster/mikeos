import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getNativeClusterModels } = vi.hoisted(() => ({
    getNativeClusterModels: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => ({ getNativeClusterModels }));

import {
    resetNativeClusterModels,
    useNativeClusterModels,
} from "./useNativeClusterModels";

beforeEach(() => {
    resetNativeClusterModels();
    getNativeClusterModels.mockReset();
});

describe("useNativeClusterModels", () => {
    it("shares one catalog between pickers, as picker rows", async () => {
        getNativeClusterModels.mockResolvedValue({
            inferenceOnly: true,
            models: [
                {
                    id: "nativecluster/qwen3.8:27b",
                    label: "qwen3.8:27b",
                    group: "NativeCluster",
                },
            ],
        });
        const first = renderHook(() => useNativeClusterModels());
        const second = renderHook(() => useNativeClusterModels());
        await waitFor(() =>
            expect(first.result.current.inferenceOnly).toBe(true),
        );
        await waitFor(() =>
            expect(second.result.current.inferenceOnly).toBe(true),
        );
        expect(first.result.current.models).toEqual([
            {
                id: "nativecluster/qwen3.8:27b",
                label: "Qwen3.8 (27b)",
                group: "NativeCluster",
                source: "NativeCluster",
            },
        ]);
        expect(getNativeClusterModels).toHaveBeenCalledTimes(1);
    });

    it("allows every provider while the catalog cannot be read, and asks again later", async () => {
        getNativeClusterModels.mockRejectedValueOnce(new Error("offline"));
        const { result, unmount } = renderHook(() => useNativeClusterModels());
        await waitFor(() => expect(getNativeClusterModels).toHaveBeenCalled());
        expect(result.current).toEqual({ models: [], inferenceOnly: false });
        unmount();

        getNativeClusterModels.mockResolvedValue({
            inferenceOnly: false,
            models: [],
        });
        renderHook(() => useNativeClusterModels());
        await waitFor(() =>
            expect(getNativeClusterModels).toHaveBeenCalledTimes(2),
        );
    });
});
