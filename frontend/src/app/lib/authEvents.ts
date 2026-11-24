import {
    clearAppSession,
    fetchWithAppSession,
    isPersonRefusal,
} from "@/app/lib/appSession";
import { isNcApp } from "@/app/lib/ncApp";

export const AUTH_SESSION_INVALIDATED_EVENT = "mike:auth-session-invalidated";

/** Why the session ended, when there is more to say than "it expired". */
export interface AuthSessionInvalidatedDetail {
    message: string | null;
}

/**
 * Fetch an authenticated application resource and immediately invalidate the
 * browser's in-memory auth state when the backend rejects the session.
 *
 * In the NativeCluster app (lib/ncApp.ts) the session is the one
 * lib/appSession.ts keeps: its access token rides on the request, a 401 is
 * refreshed once and retried, and a session the app refuses for the
 * NativeCluster person signed in (another person's Mike account) is dropped
 * with the app's own sentence.
 */
export async function authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    if (isNcApp()) return appAuthenticatedFetch(input, init);

    const response = await globalThis.fetch(input, {
        ...init,
        credentials: "include",
    });

    if (response.status === 401 && typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    }

    return response;
}

function dispatchAppSessionEnded(message: string | null) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
        new CustomEvent<AuthSessionInvalidatedDetail>(
            AUTH_SESSION_INVALIDATED_EVENT,
            { detail: { message } },
        ),
    );
}

async function appAuthenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const { response, refresh } = await fetchWithAppSession(input, init);
    if (response.status === 401) {
        // A refresh nobody answered keeps the stored session for later.
        if (refresh?.kind !== "unavailable") clearAppSession();
        dispatchAppSessionEnded(refresh?.kind === "ended" ? refresh.message : null);
    } else if (response.status === 403) {
        const body = (await response
            .clone()
            .json()
            .catch(() => null)) as { code?: unknown; detail?: unknown } | null;
        if (isPersonRefusal(body?.code)) {
            clearAppSession();
            dispatchAppSessionEnded(
                typeof body?.detail === "string" ? body.detail : null,
            );
        }
    }
    return response;
}
