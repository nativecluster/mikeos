import { afterEach, describe, expect, it, vi } from "vitest";
import { isNcApp } from "./ncApp";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("isNcApp", () => {
    it("is off unless the package was built for NativeCluster", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "");
        expect(isNcApp()).toBe(false);
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "true");
        expect(isNcApp()).toBe(false);
    });

    it("is on with NEXT_PUBLIC_MIKE_NC_APP=1", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        expect(isNcApp()).toBe(true);
    });
});
