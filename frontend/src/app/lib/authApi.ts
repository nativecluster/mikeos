import { BACKEND_REPORTING_OWNER } from "@mike/client";
import {
    markErrorHandled,
    reportApiFailure,
    reportNetworkFailure,
} from "@/app/lib/errorReporting";
import {
    reportedUpstreamMessage,
    type Operation,
} from "@mike/client";
import {
    clearAppSession,
    fetchWithAppSession,
    readAppSession,
    storeAppSession,
} from "@/app/lib/appSession";
import { isNcApp } from "@/app/lib/ncApp";

export interface AuthUser {
    id: string;
    email: string;
    pendingEmail: string | null;
    createdWithGoogle: boolean;
}

export interface MfaFactor {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
    status?: string;
}

export class AuthApiError extends Error {
    status: number;
    code: string | null;
    /**
     * The id the API stamped on this request. Support cannot find an auth
     * failure in the logs without it, and `describeError` reads it straight
     * off the error, so it has to be carried here the way `MikeApiError`
     * carries it.
     */
    requestId: string | null;
    reportingOwner?: typeof BACKEND_REPORTING_OWNER;

    constructor(
        status: number,
        code: string | null,
        message: string,
        requestId: string | null = null,
        reportingOwner?: typeof BACKEND_REPORTING_OWNER,
    ) {
        super(message);
        this.name = "AuthApiError";
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        this.reportingOwner = reportingOwner;
    }
}

/**
 * `report: false` marks a failure handled instead of sending it: a caller
 * retrying the same request (AuthContext's session check during an outage)
 * reports the first failure of its streak, not every attempt.
 *
 * `authenticated` marks a route that acts on the signed-in session. In the
 * NativeCluster app (lib/ncApp.ts), where no cookie carries it, such a
 * request presents the session lib/appSession.ts keeps, refreshing it once
 * on a 401.
 */
async function authRequest<T>(
    operation: Operation,
    path: string,
    init?: RequestInit,
    {
        report = true,
        authenticated = false,
    }: { report?: boolean; authenticated?: boolean } = {},
): Promise<T> {
    const url = `/api/auth${path}`;
    const method = init?.method ?? "GET";
    const requestInit: RequestInit = {
        ...init,
        credentials: "include",
        cache: "no-store",
        headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...(init?.headers as Record<string, string> | undefined),
        },
    };
    let response: Response;
    try {
        response =
            authenticated && isNcApp()
                ? (await fetchWithAppSession(url, requestInit)).response
                : await fetch(url, requestInit);
    } catch (error) {
        // Same rule as mikeApi: a request that never got a response is one
        // "API unreachable" event per outage, never one per auth screen. An
        // abort is the caller's doing, not an outage.
        if (!report) markErrorHandled(error);
        else if (!init?.signal?.aborted) {
            reportNetworkFailure(error, { method, url });
        }
        throw error;
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
            code?: unknown;
            detail?: unknown;
            request_id?: unknown;
            reporting_owner?: unknown;
        };
        const code = typeof body.code === "string" ? body.code : null;
        // Mirrors mikeApi.toApiError: the body wins, the header is the
        // fallback for a response that carried no JSON id.
        const requestId =
            typeof body.request_id === "string" && body.request_id
                ? body.request_id
                : response.headers.get("x-request-id");
        const error = new AuthApiError(
            response.status,
            code,
            (code && reportedUpstreamMessage(code)) ??
                (response.status < 500 && typeof body.detail === "string"
                    ? body.detail
                    : "Authentication could not be completed."),
            requestId,
            body.reporting_owner === BACKEND_REPORTING_OWNER ? BACKEND_REPORTING_OWNER : undefined,
        );
        // A 4xx is the auth server's intentional answer (wrong password, a
        // spent link); a 5xx is a fault, reported under the same request id
        // the backend attached to its own event, unless the backend or the
        // gateway explicitly claims ownership in the response.
        if (!report) markErrorHandled(error);
        else if (response.status >= 500) {
            reportApiFailure({
                operation,
                path: url,
                status: response.status,
                code,
                requestId,
                method,
                error,
                reportingOwner: error.reportingOwner,
            });
        }
        throw error;
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export async function getAuthSession(
    options: { report?: boolean } = {},
): Promise<AuthUser | null> {
    // In the app, no stored session is no session: nothing to ask.
    if (isNcApp() && !readAppSession()) return null;
    try {
        return (
            await authRequest<{ user: AuthUser }>("auth.session", "/session", undefined, {
                ...options,
                authenticated: true,
            })
        ).user;
    } catch (error) {
        if (error instanceof AuthApiError && error.status === 401) return null;
        throw error;
    }
}

/**
 * In the NativeCluster app an answer that made a session carries its tokens
 * (`session`), which the browser keeps; elsewhere it sets the cookie and
 * carries none.
 */
function keepSession<T>(answer: T): T {
    if (isNcApp()) storeAppSession((answer as { session?: unknown } | undefined)?.session);
    return answer;
}

export async function login(email: string, password: string) {
    return keepSession(
        await authRequest<{ user: AuthUser }>("auth.signin", "/login", {
            method: "POST",
            body: JSON.stringify({ email, password }),
        }),
    );
}

export async function signup(email: string, password: string, next: string) {
    return keepSession(
        await authRequest<{
            user: AuthUser;
            requiresEmailConfirmation: boolean;
        }>("auth.signup", "/signup", {
            method: "POST",
            body: JSON.stringify({ email, password, next }),
        }),
    );
}

/** Which sign-in routes this deployment offers, and whether it still needs its first account. */
export interface SignInOptions {
    google: boolean;
    sso: boolean;
    setupRequired: boolean;
    /** False while email sign-up cannot work on this deployment (no email configured). */
    signup: boolean;
}

/**
 * Bounded: the login page holds its provider buttons back until this
 * answers, so a hung request must fall back to showing them (see
 * useSignInOptions) rather than leave them missing.
 */
export async function getSignInOptions() {
    return authRequest<SignInOptions>("auth.options", "/options", {
        signal: AbortSignal.timeout(8_000),
    });
}

/** First-run setup: create this deployment's first account and sign it in. */
export async function setupFirstAccount(email: string, password: string) {
    return keepSession(
        await authRequest<{ user: AuthUser }>("auth.setup", "/setup", {
            method: "POST",
            body: JSON.stringify({ email, password }),
        }),
    );
}

export async function startGoogleOAuth(next: string) {
    return authRequest<{ url: string }>("auth.signin", "/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "google", next }),
    });
}

export function startSso(next: string, email: string) {
    return authRequest<{ url: string }>("auth.signin", "/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "sso", next, email }),
    });
}

export async function exchangeAuthCode(code: string) {
    return authRequest<{ user: AuthUser }>("auth.signin", "/exchange", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
}

export async function requestPasswordReset(email: string) {
    return authRequest<void>("auth.signin", "/password-reset", {
        method: "POST",
        body: JSON.stringify({ email }),
    });
}

const SESSION = { authenticated: true } as const;

export async function logout(scope: "local" | "global" = "local") {
    try {
        return await authRequest<void>(
            "auth.session",
            "/logout",
            {
                method: "POST",
                body: JSON.stringify({ scope }),
            },
            SESSION,
        );
    } finally {
        // Signing out here is forgetting the tokens; the request above
        // revokes them in GoTrue when it can.
        if (isNcApp()) clearAppSession();
    }
}

export async function updateAuthEmail(email: string, next: string) {
    return authRequest<{ user: AuthUser }>(
        "auth.session",
        "/email",
        {
            method: "PATCH",
            body: JSON.stringify({ email, next }),
        },
        SESSION,
    );
}

export async function updateAuthPassword(password: string, signOut = false) {
    const answer = await authRequest<{ user: AuthUser }>(
        "auth.session",
        "/password",
        {
            method: "PATCH",
            body: JSON.stringify({ password, signOut }),
        },
        SESSION,
    );
    // The server signed every session out, this one included.
    if (signOut && isNcApp()) clearAppSession();
    return answer;
}

export function listMfaFactors() {
    return authRequest<{ all: MfaFactor[]; totp: MfaFactor[] }>(
        "auth.mfa",
        "/mfa/factors",
        undefined,
        SESSION,
    );
}

export function getMfaAssurance() {
    return authRequest<{
        currentLevel: string | null;
        nextLevel: string | null;
    }>("auth.mfa", "/mfa/assurance", undefined, SESSION);
}

export function enrollMfa(friendlyName: string) {
    return authRequest<{
        id: string;
        totp: { qr_code: string; secret: string };
    }>(
        "auth.mfa",
        "/mfa/enroll",
        {
            method: "POST",
            body: JSON.stringify({ friendlyName }),
        },
        SESSION,
    );
}

export function challengeMfa(factorId: string) {
    return authRequest<{ id: string }>(
        "auth.mfa",
        "/mfa/challenge",
        {
            method: "POST",
            body: JSON.stringify({ factorId }),
        },
        SESSION,
    );
}

/** A verified factor raises the session to aal2, with new tokens in the app. */
export async function verifyMfa(factorId: string, challengeId: string, code: string) {
    return keepSession(
        await authRequest<unknown>(
            "auth.mfa",
            "/mfa/verify",
            {
                method: "POST",
                body: JSON.stringify({ factorId, challengeId, code }),
            },
            SESSION,
        ),
    );
}

export async function challengeAndVerifyMfa(factorId: string, code: string) {
    return keepSession(
        await authRequest<unknown>(
            "auth.mfa",
            "/mfa/challenge-and-verify",
            {
                method: "POST",
                body: JSON.stringify({ factorId, code }),
            },
            SESSION,
        ),
    );
}

export function unenrollMfa(factorId: string) {
    return authRequest<unknown>(
        "auth.mfa",
        `/mfa/factors/${encodeURIComponent(factorId)}`,
        {
            method: "DELETE",
        },
        SESSION,
    );
}

export function clearLegacyBrowserAuthStorage() {
    if (typeof window === "undefined") return;
    for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = storage.length - 1; index >= 0; index -= 1) {
            const key = storage.key(index);
            if (key && /(?:^|-)auth-token(?:$|-)|supabase.*auth/i.test(key)) {
                storage.removeItem(key);
            }
        }
    }
}
