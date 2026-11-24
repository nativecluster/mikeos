// Mike's connectors when Mike runs as a NativeCluster app (MIKE_NC_APP=1).
// Off, nothing here changes how a deployment links or stores anything.
//
// What the app mode needs, and why (measured under NativeCluster 0.4.23):
// - The app's pages are served at `https://127.0.0.1:<port>`, a port of
//   8490-8499 that differs per computer, under NativeCluster's own CA. The
//   person's default browser does not trust that CA, and the app's origin
//   passes nothing on from a browser not signed in to NativeCluster there
//   (it answers "Sign in to use ..."). So a provider's redirect to the app's
//   own page lands in the browser and, in practice, never reaches the app.
//   Linking therefore takes the device grant where the provider offers one,
//   else the person pastes the address the browser landed on.
// - The app's window opens any link to another site in the person's default
//   browser, and a page that sends itself elsewhere goes nowhere: no popups.
// - Tokens go in the host's secrets store (ncSecrets.ts), keyed by the
//   NativeCluster person and the connection, never in Mike's tables.
// - The person is the ticket's (`X-NC-Person`, set by the launcher after its
//   ticket check), never a linked account.

import { AsyncLocalStorage } from "node:async_hooks";
import type { HostSecrets } from "./ncSecrets";

export function isNcAppMode(): boolean {
    return process.env.MIKE_NC_APP === "1";
}

// ---------------------------------------------------------------------------
// Wiring: the launcher's integration hands these in at startup.
// ---------------------------------------------------------------------------

let hostSecrets: HostSecrets | null = null;
let personResolver: (() => string | null | undefined) | null = null;

/**
 * Called once at startup in app mode: the host's secrets store (built from
 * LB_HOST_SOCKET and the app credential read on stdin) and, optionally, how
 * to learn the NativeCluster person of the work in hand (a request's or a
 * job's) outside a connector route. Without a resolver, only the routes that
 * run inside `withNcPerson` know the person.
 */
export function configureNcAppConnectors(options: {
    secrets: HostSecrets;
    currentPerson?: () => string | null | undefined;
}): void {
    hostSecrets = options.secrets;
    personResolver = options.currentPerson ?? null;
}

/** For tests: forget the wiring. */
export function resetNcAppConnectors(): void {
    hostSecrets = null;
    personResolver = null;
}

export class NcAppNotConfiguredError extends Error {
    code = "nc_app_not_configured";
    constructor() {
        super("Mike's connectors cannot reach NativeCluster's secrets store on this computer.");
        this.name = "NcAppNotConfiguredError";
    }
}

/** The host's store; throws in app mode when the wiring is missing. */
export function ncAppSecrets(): HostSecrets {
    if (!hostSecrets) throw new NcAppNotConfiguredError();
    return hostSecrets;
}

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

const personContext = new AsyncLocalStorage<{ person: string | null }>();

/** A ticket's person id is the host's opaque id for this app: `p_` and hex. */
const PERSON_RE = /^p_[A-Za-z0-9]{1,64}$/;

export function normalizeNcPerson(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return PERSON_RE.test(trimmed) ? trimmed : null;
}

/** Runs `fn` as work of `person` (the ticket's, from `X-NC-Person`). */
export function withNcPerson<T>(person: string | null | undefined, fn: () => T): T {
    return personContext.run({ person: normalizeNcPerson(person) }, fn);
}

/**
 * Express middleware: the rest of the request runs as the person the
 * launcher named in `X-NC-Person`. The backend trusts that header only in
 * app mode, where it answers 403 to any request without the launcher's
 * `X-NC-Internal` secret; elsewhere this does nothing.
 */
export function ncPersonContext(
    req: { get(name: string): string | undefined },
    _res: unknown,
    next: () => void,
): void {
    if (!isNcAppMode()) return next();
    withNcPerson(req.get("x-nc-person"), next);
}

/** The NativeCluster person of the work in hand, or null when none is known. */
export function currentNcPerson(): string | null {
    const scoped = personContext.getStore();
    if (scoped) return scoped.person;
    return normalizeNcPerson(personResolver?.() ?? null);
}

// ---------------------------------------------------------------------------
// The app's own origin
// ---------------------------------------------------------------------------

/**
 * The hosts the app's origin may have: 127.0.0.1 (or localhost) on one of
 * NativeCluster's ten app ports. Anything else is refused, so a redirect URI
 * is never built from a header pointing elsewhere.
 */
const APP_HOST_RE = /^(?:127\.0\.0\.1|localhost):(849\d)$/;

/**
 * `https://127.0.0.1:<port>`, the app's origin on this computer, from the
 * request itself: the browser's `Host` (the host passes it on, and so does
 * the launcher), which must be 127.0.0.1 or localhost on one of
 * NativeCluster's app ports. An `Origin` the browser sent must be that same
 * origin; one that is not is never trusted. Null otherwise.
 */
export function ncAppOrigin(req: { get(name: string): string | undefined }): string | null {
    const host = req.get("host")?.trim().toLowerCase();
    if (!host || !APP_HOST_RE.test(host)) return null;
    const origin = `https://${host}`;
    const sent = req.get("origin")?.trim().toLowerCase();
    if (sent && sent !== "null" && sent !== origin) return null;
    return origin;
}

export class NcAppOriginUnknownError extends Error {
    code = "nc_app_origin_unknown";
    constructor() {
        super("Mike could not tell its own address on this computer. Reopen Mike from NativeCluster and try again.");
        this.name = "NcAppOriginUnknownError";
    }
}

/**
 * The redirect URI for `path` (a backend route, e.g.
 * `/user/mcp-connectors/oauth/callback`) on the app's origin: the launcher
 * serves the backend under `/api`.
 */
export function ncAppRedirectUri(
    req: { get(name: string): string | undefined },
    path: string,
): string {
    const origin = ncAppOrigin(req);
    if (!origin) throw new NcAppOriginUnknownError();
    return `${origin}/api${path}`;
}

// ---------------------------------------------------------------------------
// The address the person pastes back
// ---------------------------------------------------------------------------

export type PastedAuthorization = {
    code: string | null;
    state: string | null;
    error: string | null;
};

/**
 * Reads what the person pasted: the whole address their browser landed on
 * (a warning page, or "Sign in to use Mike"), its `?query` alone, or a bare
 * code. Only `code`, `state` and `error` are taken.
 */
export function parsePastedAuthorization(pasted: unknown): PastedAuthorization {
    const empty: PastedAuthorization = { code: null, state: null, error: null };
    if (typeof pasted !== "string") return empty;
    const text = pasted.trim();
    if (!text || text.length > 8192) return empty;
    let params: URLSearchParams | null = null;
    try {
        const url = new URL(text);
        params = new URLSearchParams(url.search || url.hash.replace(/^#/, ""));
    } catch {
        if (text.includes("=")) params = new URLSearchParams(text.replace(/^[?#]/, ""));
    }
    if (!params) return { ...empty, code: /^[\w.~\-/+]+$/.test(text) ? text : null };
    // NativeCluster's origin may show the address mid-way through its
    // sign-in hand-off (`/.nc/handoff?next=/api/…/callback?code=…&state=…`):
    // the authorization is then inside `next`, a path on the same origin.
    const next = params.get("next");
    if (!params.has("code") && !params.has("error") && next?.startsWith("/")) {
        try {
            params = new URL(next, "https://app.invalid").searchParams;
        } catch {
            // `next` was not an address: nothing more to read.
        }
    }
    const pick = (key: string) => {
        const value = params!.get(key);
        return value && value.length <= 4096 ? value : null;
    };
    return { code: pick("code"), state: pick("state"), error: pick("error") };
}
