"use client";

import { useState } from "react";
import { PillButtonUI, authGlassCardUIClassName } from "@mike/ui";
import { SiteLogo } from "@/app/components/site-logo";
import { cn } from "@/app/lib/utils";

/** What the NativeCluster app shows when the host names nobody signed in. */
export const NC_APP_SIGNED_OUT_MESSAGE = "Sign in to NativeCluster to use Mike.";

/**
 * In the NativeCluster app NativeCluster is the only sign-in (lib/ncApp.ts),
 * so a window nobody is signed in to has no login form to offer: it says
 * where to sign in, and checks again on request.
 */
export function NcAppSignedOut({ onRetry }: { onRetry: () => Promise<unknown> }) {
    const [checking, setChecking] = useState(false);
    const checkAgain = async () => {
        setChecking(true);
        try {
            await onRetry();
        } catch {
            // The auth context reports a check that failed.
        } finally {
            setChecking(false);
        }
    };
    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" />
            </div>
            <div className={cn(authGlassCardUIClassName, "w-full max-w-md")}>
                <h1 className="mb-3 text-left text-2xl font-medium font-serif text-gray-950">
                    Not signed in
                </h1>
                <p className="mb-6 text-sm text-muted-foreground">
                    {NC_APP_SIGNED_OUT_MESSAGE}
                </p>
                <PillButtonUI
                    type="button"
                    tone="black"
                    size="normal"
                    className="w-full"
                    onClick={() => void checkAgain()}
                    disabled={checking}
                >
                    {checking ? "Checking..." : "Check again"}
                </PillButtonUI>
            </div>
        </div>
    );
}
