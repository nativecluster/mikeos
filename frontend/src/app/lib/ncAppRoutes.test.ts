// @vitest-environment node
// next.config.ts is a Node module, loaded here as `next build` loads it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ncAppRedirects } from "./ncAppRoutes";
import nextConfig from "../../../next.config";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("the NativeCluster app's redirects", () => {
    it("send Mike's own sign-in, recovery, MFA and onboarding screens home", () => {
        const redirects = ncAppRedirects(true);
        const sources = redirects.map((redirect) => redirect.source);
        for (const screen of [
            "/login",
            "/login/:path*",
            "/signup",
            "/signup/:path*",
            "/setup",
            "/verify-mfa",
            "/forgot-password",
            "/reset-password",
            "/onboarding/:path*",
            "/auth/callback",
        ]) {
            expect(sources).toContain(screen);
        }
        expect(redirects.find((r) => r.source === "/login")).toEqual({
            source: "/login",
            destination: "/assistant",
            permanent: false,
        });
        expect(redirects.find((r) => r.source === "/settings/security")?.destination).toBe(
            "/settings",
        );
    });

    it("are none in any other build", () => {
        expect(ncAppRedirects(false)).toEqual([]);
    });

    it("are what next.config serves, following the build's flag", async () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        const inApp = await nextConfig.redirects!();
        expect(inApp).toEqual(expect.arrayContaining(ncAppRedirects(true)));
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "");
        const elsewhere = await nextConfig.redirects!();
        expect(elsewhere.map((redirect) => redirect.source)).toEqual(["/account", "/account/:path*"]);
    });
});
