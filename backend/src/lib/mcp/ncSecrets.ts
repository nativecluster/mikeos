// The NativeCluster host's secrets store, as Mike's connectors use it when
// Mike runs as a NativeCluster app (MIKE_NC_APP=1).
//
// The host keeps each value sealed in its own database, for this app alone,
// never in the app's data folder: `GET`, `PUT {"value": ...}` and `DELETE`
// on `/host/v1/secrets/<name>` over the host's unix socket (LB_HOST_SOCKET),
// with `Authorization: Bearer <app_credential>` (NativeCluster's host API,
// "An app's own secrets", from host 0.4.15). A value holds at most 64 KiB;
// one store at most 1 MiB. A value this computer can no longer open answers
// `409 unreadable`: the person links again.
//
// This file knows nothing of where the socket path and the credential come
// from: the launcher hands the credential to the backend on its stdin, and
// the caller passes both in.

import http from "node:http";

/** The host's cap on one value, in bytes (`413 too_large` above it). */
export const HOST_SECRET_MAX_BYTES = 64 * 1024;

/** A name is the app's own label: 1 to 128 of letters, digits and `. _ : -`. */
const NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isHostSecretName(name: string): boolean {
    return NAME_RE.test(name);
}

export interface HostSecrets {
    /** The value, or null when none is kept under that name. */
    getSecret(name: string): Promise<string | null>;
    putSecret(name: string, value: string): Promise<void>;
    /** Deleting a name with nothing kept is no error. */
    deleteSecret(name: string): Promise<void>;
}

/** Why the host would not keep or give a value. Never carries the value. */
export class HostSecretError extends Error {
    constructor(
        message: string,
        readonly status: number | null,
        readonly code: string | null,
    ) {
        super(message);
        this.name = "HostSecretError";
    }
}

/**
 * A value sealed under a key this computer no longer holds (`409
 * unreadable`). The host keeps it; the app asks the person to link again and
 * keeps the new value.
 */
export class HostSecretUnreadableError extends HostSecretError {
    constructor() {
        super("This computer can no longer read a stored connector secret.", 409, "unreadable");
        this.name = "HostSecretUnreadableError";
    }
}

type HostAnswer = { status: number; body: string };

function hostRequest(
    socketPath: string,
    credential: string,
    method: "GET" | "PUT" | "DELETE",
    name: string,
    body: string | null,
    timeoutMs: number,
): Promise<HostAnswer> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                socketPath,
                method,
                path: `/host/v1/secrets/${encodeURIComponent(name)}`,
                headers: {
                    Host: "host",
                    Authorization: `Bearer ${credential}`,
                    Accept: "application/json",
                    ...(body !== null
                        ? {
                              "Content-Type": "application/json",
                              "Content-Length": Buffer.byteLength(body),
                          }
                        : {}),
                },
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
                res.on("error", reject);
            },
        );
        req.on("timeout", () =>
            req.destroy(new HostSecretError("The NativeCluster host did not answer in time.", null, "timeout")),
        );
        req.on("error", (err) =>
            reject(
                err instanceof HostSecretError
                    ? err
                    : new HostSecretError("The NativeCluster host could not be reached.", null, "unreachable"),
            ),
        );
        if (body !== null) req.write(body);
        req.end();
    });
}

function errorCode(body: string): string | null {
    try {
        const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
        if (typeof parsed.error === "string") return parsed.error;
        if (typeof parsed.code === "string") return parsed.code;
    } catch {
        // Not JSON: the status alone says what happened.
    }
    return null;
}

function failure(answer: HostAnswer, action: string): HostSecretError {
    const code = errorCode(answer.body);
    if (answer.status === 409) return new HostSecretUnreadableError();
    if (answer.status === 413)
        return new HostSecretError("A connector secret is larger than the host keeps (64 KiB).", 413, code ?? "too_large");
    if (answer.status === 507)
        return new HostSecretError("The host's store for Mike is full.", 507, code ?? "store_full");
    if (answer.status === 404)
        // Only a GET reads 404 as "none kept"; anywhere else it is a host
        // older than 0.4.15, which has no secrets route.
        return new HostSecretError("This NativeCluster is too old to keep connector secrets (0.4.15 or later).", 404, code);
    return new HostSecretError(`The host would not ${action} a connector secret (HTTP ${answer.status}).`, answer.status, code);
}

/**
 * The store on `socketPath`, as the app `credential` names it. Every call is
 * one request on the socket; nothing is cached here.
 */
export function createHostSecrets(options: {
    socketPath: string;
    credential: string;
    timeoutMs?: number;
}): HostSecrets {
    const { socketPath, credential } = options;
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!socketPath) throw new Error("The host socket path is required.");
    if (!credential) throw new Error("The app credential is required.");
    const checkName = (name: string) => {
        if (!isHostSecretName(name)) throw new HostSecretError("A connector secret's name is not one the host keeps.", 400, "bad_name");
    };
    return {
        async getSecret(name) {
            checkName(name);
            const answer = await hostRequest(socketPath, credential, "GET", name, null, timeoutMs);
            if (answer.status === 404) {
                // "None kept" is a JSON answer from the route; a host with no
                // secrets route at all answers 404 too, and reads as none.
                return null;
            }
            if (answer.status !== 200) throw failure(answer, "give");
            let parsed: unknown;
            try {
                parsed = JSON.parse(answer.body);
            } catch {
                throw new HostSecretError("The host's answer for a connector secret was not JSON.", 200, null);
            }
            const value = (parsed as { value?: unknown } | null)?.value;
            if (typeof value !== "string") throw new HostSecretError("The host's answer for a connector secret had no value.", 200, null);
            return value;
        },
        async putSecret(name, value) {
            checkName(name);
            if (Buffer.byteLength(value) > HOST_SECRET_MAX_BYTES)
                throw new HostSecretError("A connector secret is larger than the host keeps (64 KiB).", 413, "too_large");
            const answer = await hostRequest(socketPath, credential, "PUT", name, JSON.stringify({ value }), timeoutMs);
            if (answer.status !== 204 && answer.status !== 200) throw failure(answer, "keep");
        },
        async deleteSecret(name) {
            checkName(name);
            const answer = await hostRequest(socketPath, credential, "DELETE", name, null, timeoutMs);
            if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) throw failure(answer, "delete");
        },
    };
}

/** An in-memory store with the host's rules, for tests and dev runs. */
export function memoryHostSecrets(): HostSecrets & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
        values,
        async getSecret(name) {
            if (!isHostSecretName(name)) throw new HostSecretError("bad name", 400, "bad_name");
            return values.get(name) ?? null;
        },
        async putSecret(name, value) {
            if (!isHostSecretName(name)) throw new HostSecretError("bad name", 400, "bad_name");
            if (Buffer.byteLength(value) > HOST_SECRET_MAX_BYTES) throw new HostSecretError("too large", 413, "too_large");
            values.set(name, value);
        },
        async deleteSecret(name) {
            values.delete(name);
        },
    };
}
