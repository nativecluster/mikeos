"use client";

import { useEffect, useState } from "react";
import { getSignInOptions, type SignInOptions } from "@/app/lib/authApi";
import { useSignInProviderHint } from "@/app/contexts/SignInProviderHintContext";
import { isNcApp } from "@/app/lib/ncApp";

/**
 * What the sign-in screens offered before the deployment could say: both
 * provider buttons, the sign-up form, no setup screen. Used while the answer is unknown or
 * could not be read, so a failed check never hides a working provider.
 */
export const DEFAULT_SIGN_IN_OPTIONS: SignInOptions = {
    google: true,
    sso: true,
    setupRequired: false,
    signup: true,
};

export interface SignInOptionsState {
    options: SignInOptions;
    /** True once the browser's own check has answered (or failed). */
    loaded: boolean;
    /**
     * True once `options.google` and `options.sso` are worth drawing: after
     * the check answers, or straight away when the server rendered the page
     * with a provider hint. Gate provider buttons on this, not on `loaded`,
     * so they are part of the first paint instead of growing the form later.
     */
    providersKnown: boolean;
}

/**
 * Ask the API which sign-in routes this deployment offers (Google and SSO
 * only when configured) and whether it still needs its first account.
 * `loaded` stays false until the answer arrives, so callers can avoid
 * flashing buttons that are about to disappear. The server's provider hint,
 * when the page was rendered with one, fills in `google` and `sso` until
 * then; first-run setup and sign-up availability always wait for the answer.
 */
export function useSignInOptions(): SignInOptionsState {
    const hint = useSignInProviderHint();
    const [state, setState] = useState<{ options: SignInOptions; loaded: boolean }>({
        options: withAppProviders(
            hint ? { ...DEFAULT_SIGN_IN_OPTIONS, ...hint } : DEFAULT_SIGN_IN_OPTIONS,
        ),
        loaded: false,
    });

    useEffect(() => {
        let cancelled = false;
        getSignInOptions()
            .then((options) => {
                if (!cancelled) setState({ options: withAppProviders(options), loaded: true });
            })
            .catch(() => {
                // Reported by the auth client; keep the defaults.
                if (!cancelled) {
                    setState({ options: withAppProviders(DEFAULT_SIGN_IN_OPTIONS), loaded: true });
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return {
        ...state,
        // The app's providers are known from the start: none.
        providersKnown: state.loaded || hint !== null || isNcApp(),
    };
}

/**
 * The NativeCluster app offers email and password alone: Google refuses
 * embedded web views and, like SSO, redirects to an origin fixed in
 * advance, where the app's differs per computer.
 */
function withAppProviders(options: SignInOptions): SignInOptions {
    return isNcApp() ? { ...options, google: false, sso: false } : options;
}
