import { isNcApp } from "./ncApp";

/**
 * Mike's own sign-in, account-recovery, MFA and onboarding screens. In the
 * NativeCluster app NativeCluster is the only sign-in and owns people
 * (lib/ncApp.ts), so each of these leads to the app's home instead.
 */
export const NC_APP_AUTH_SCREENS = [
    "/login",
    "/login/:path*",
    "/signup",
    "/signup/:path*",
    "/setup",
    "/verify-mfa",
    "/forgot-password",
    "/reset-password",
    "/onboarding",
    "/onboarding/:path*",
    "/auth/callback",
] as const;

export const NC_APP_HOME = "/assistant";

export interface RouteRedirect {
    source: string;
    destination: string;
    permanent: false;
}

/**
 * next.config.ts `redirects()`: read at build time, so the app package is
 * built with NEXT_PUBLIC_MIKE_NC_APP=1. Every other build gets none.
 */
export function ncAppRedirects(appBuild: boolean = isNcApp()): RouteRedirect[] {
    if (!appBuild) return [];
    return [
        ...NC_APP_AUTH_SCREENS.map((source) => ({
            source,
            destination: NC_APP_HOME,
            permanent: false as const,
        })),
        // Passwords and MFA are NativeCluster's.
        { source: "/settings/security", destination: "/settings", permanent: false },
    ];
}
