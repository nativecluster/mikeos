import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
    value: undefined as
        | undefined
        | { profile: { connectorsOff: string[] } | null; loading: boolean },
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useOptionalUserProfile: () => context.value,
}));

import { useConnectorsOff } from "./useConnectorsOff";

describe("useConnectorsOff", () => {
    it("turns nothing off outside a profile provider", () => {
        context.value = undefined;
        const { result } = renderHook(() => useConnectorsOff());
        expect(result.current.off("mcp")).toBe(false);
        expect(result.current.loading).toBe(false);
    });

    it("waits for the profile, then reads the planes it names", () => {
        context.value = { profile: null, loading: true };
        const { result, rerender } = renderHook(() => useConnectorsOff());
        expect(result.current.loading).toBe(true);
        expect(result.current.off("mcp")).toBe(false);

        context.value = { profile: { connectorsOff: ["mcp"] }, loading: false };
        rerender();
        expect(result.current.loading).toBe(false);
        expect(result.current.off("mcp")).toBe(true);
        expect(result.current.off("websearch")).toBe(false);
    });
});
