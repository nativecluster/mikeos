import { isNcApp } from "@/app/lib/ncApp";

/**
 * Mike's own session in the NativeCluster app (lib/ncApp.ts).
 *
 * The host drops every Set-Cookie the app sends, so the session cannot live
 * in the backend's HttpOnly cookie as it does elsewhere. The auth routes
 * answer the GoTrue tokens in their bodies instead; this module keeps them in
 * the app origin's localStorage and presents the access token on every API
 * call. Not `Authorization: Bearer`: the host reads that header as a
 * NativeCluster session of its own and removes it, so the token travels in
 * `X-Mike-Session`.
 *
 * The access token is refreshed before it expires (a timer, and a check
 * before each call), and a call the API answers with a 401 refreshes once and
 * is sent again. Concurrent refreshes share one request, so a page's parallel
 * calls never spend the same refresh token twice. Every read goes back to
 * storage, so another window's refresh is seen at once.
 *
 * Outside the app none of this runs: `appAccessToken` answers null and the
 * cookie carries the session as before.
 */

export const APP_SESSION_HEADER = "X-Mike-Session";

/** Named so `clearLegacyBrowserAuthStorage` (lib/authApi.ts) never matches it. */
const STORAGE_KEY = "mike.nc-app.session";

/** Refresh this long before the access token expires (auth-js keeps 90 s). */
export const REFRESH_AHEAD_SECONDS = 120;
/** After a refresh the server could not answer, try again this much later. */
const RETRY_AFTER_UNAVAILABLE_MS = 30_000;

export interface AppSession {
    access_token: string;
    refresh_token: string;
    /** Unix seconds. */
    expires_at: number;
}

/** What a refresh came to. */
export type RefreshOutcome =
    | { kind: "refreshed" }
    /** GoTrue or the app refused it: the session is gone, and was cleared. */
    | { kind: "ended"; message: string | null }
    /** No answer (offline, an outage): the session is kept for a later try. */
    | { kind: "unavailable" };

function parseSession(value: unknown): AppSession | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (
        typeof candidate.access_token !== "string" ||
        !candidate.access_token ||
        typeof candidate.refresh_token !== "string" ||
        !candidate.refresh_token ||
        typeof candidate.expires_at !== "number" ||
        !Number.isFinite(candidate.expires_at)
    ) {
        return null;
    }
    return {
        access_token: candidate.access_token,
        refresh_token: candidate.refresh_token,
        expires_at: candidate.expires_at,
    };
}

function storage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readAppSession(): AppSession | null {
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(STORAGE_KEY);
        return raw ? parseSession(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
}

function scheduleRefresh(delayMs: number) {
    cancelScheduledRefresh();
    if (typeof window === "undefined") return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshAppSession();
    }, Math.max(0, delayMs));
}

function scheduleRefreshFor(session: AppSession) {
    scheduleRefresh(
        (session.expires_at - REFRESH_AHEAD_SECONDS) * 1000 - Date.now(),
    );
}

/**
 * Keep the session an auth answer carried (`{ session }` from log-in,
 * sign-up, setup, refresh or an MFA verification). Anything else is ignored,
 * so a deployment that answers no tokens changes nothing here.
 */
export function storeAppSession(value: unknown): boolean {
    if (!isNcApp()) return false;
    const session = parseSession(value);
    const store = storage();
    if (!session || !store) return false;
    try {
        store.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
        return false;
    }
    scheduleRefreshFor(session);
    return true;
}

export function clearAppSession(): void {
    cancelScheduledRefresh();
    try {
        storage()?.removeItem(STORAGE_KEY);
    } catch {
        // Nothing stored, or nothing to clear.
    }
}

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/** Trade the stored refresh token for a new pair. One request at a time. */
export function refreshAppSession(): Promise<RefreshOutcome> {
    if (!refreshInFlight) {
        refreshInFlight = runRefresh().finally(() => {
            refreshInFlight = null;
        });
    }
    return refreshInFlight;
}

async function runRefresh(): Promise<RefreshOutcome> {
    const session = readAppSession();
    if (!session) return { kind: "ended", message: null };
    let response: Response;
    try {
        response = await globalThis.fetch("/api/auth/refresh", {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
    } catch {
        scheduleRefresh(RETRY_AFTER_UNAVAILABLE_MS);
        return { kind: "unavailable" };
    }
    if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
            session?: unknown;
        } | null;
        if (storeAppSession(body?.session)) return { kind: "refreshed" };
        scheduleRefresh(RETRY_AFTER_UNAVAILABLE_MS);
        return { kind: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
        // Another window may have refreshed (and rotated the token) while
        // this request was on its way: its session stands.
        const current = readAppSession();
        if (current && current.refresh_token !== session.refresh_token) {
            return { kind: "refreshed" };
        }
        const body = (await response.json().catch(() => null)) as {
            code?: unknown;
            detail?: unknown;
        } | null;
        clearAppSession();
        return {
            kind: "ended",
            message:
                isPersonRefusal(body?.code) && typeof body?.detail === "string"
                    ? body.detail
                    : null,
        };
    }
    scheduleRefresh(RETRY_AFTER_UNAVAILABLE_MS);
    return { kind: "unavailable" };
}

/** The app's refusals of a session for the NativeCluster person (backend lib/authPersonBinding.ts). */
export function isPersonRefusal(code: unknown): boolean {
    return code === "nc_person_mismatch" || code === "nc_person_required";
}

/**
 * The access token to present now, refreshed first when it is about to
 * expire; null outside the app or with no session.
 */
export async function appAccessToken(): Promise<string | null> {
    if (!isNcApp()) return null;
    const session = readAppSession();
    if (!session) return null;
    if (session.expires_at - REFRESH_AHEAD_SECONDS <= Date.now() / 1000) {
        await refreshAppSession();
        return readAppSession()?.access_token ?? null;
    }
    if (refreshTimer === null) scheduleRefreshFor(session);
    return session.access_token;
}

function bodyCanBeSentAgain(input: RequestInfo | URL, body: BodyInit | null | undefined) {
    if (typeof Request !== "undefined" && input instanceof Request) return false;
    return (
        body === undefined ||
        body === null ||
        typeof body === "string" ||
        body instanceof URLSearchParams ||
        (typeof FormData !== "undefined" && body instanceof FormData) ||
        (typeof Blob !== "undefined" && body instanceof Blob) ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body)
    );
}

export interface AppFetchResult {
    response: Response;
    /** Set when this call refreshed the session (after a 401). */
    refresh: RefreshOutcome | null;
}

/**
 * `fetch` with the app's session: the access token in its header, and a 401
 * answered by one refresh and one retry when the body can be sent again.
 * Outside the app it is plain `fetch` with the cookie.
 */
export async function fetchWithAppSession(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<AppFetchResult> {
    if (!isNcApp()) {
        return {
            response: await globalThis.fetch(input, { ...init, credentials: "include" }),
            refresh: null,
        };
    }
    const send = async () => {
        const headers = new Headers(init?.headers);
        const token = await appAccessToken();
        if (token) headers.set(APP_SESSION_HEADER, token);
        else headers.delete(APP_SESSION_HEADER);
        return globalThis.fetch(input, {
            ...init,
            headers,
            credentials: "same-origin",
        });
    };
    const response = await send();
    if (
        response.status !== 401 ||
        !readAppSession() ||
        !bodyCanBeSentAgain(input, init?.body)
    ) {
        return { response, refresh: null };
    }
    const refresh = await refreshAppSession();
    if (refresh.kind !== "refreshed") return { response, refresh };
    return { response: await send(), refresh };
}

/** Test seam: forget timers and any refresh in flight. */
export function resetAppSessionForTests(): void {
    cancelScheduledRefresh();
    refreshInFlight = null;
}
