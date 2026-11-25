// Connector secrets kept in NativeCluster's host store instead of Mike's
// tables, in app mode (MIKE_NC_APP=1).
//
// Mike keeps each secret as a column triple: `encrypted_<field>`,
// `<field>_iv`, `<field>_tag` (AES-256-GCM under Mike's own key). In app mode
// the value goes to the host's secrets store and the triple holds only a
// reference: `encrypted_<field>` = "nc-host:<name>", iv and tag = "nc-host".
// Everything that reads a row keeps working: a loader resolves the row's
// references first (resolveHostColumns), and Mike's synchronous decrypt reads
// the resolved value from this process's memory (cachedHostSecret).
//
// A name is `mike:<person>:<kind>:<row>:<field>`: the NativeCluster person
// who linked it (the ticket's), the kind of row (mcp, mcp-auth, gdrive,
// gws), a hash of the row's identity and the field. It is deterministic per
// row and field, so a refresh replaces the value in place and a disconnect
// knows what to delete. A reference read under another person is refused
// (read as nothing): the host's store is one for the whole app, so the app
// itself reads only the asking person's values, and none for no one.
//
// Each person's values are counted, and held to their share of the store
// (hostSecretIndex.ts). A write whose row then fails to save is undone
// (withHostSecretWrite): a new value is deleted, a replaced one put back, so
// the store keeps nothing no row points to.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { log } from "../log";
import { currentNcPerson, ncAppSecrets, NcPersonUnknownError, normalizeNcPerson } from "./ncApp";
import { HostSecretUnreadableError } from "./ncSecrets";
import { releaseHostSecret, reserveHostSecret } from "./hostSecretIndex";

export { NcPersonUnknownError };

export const HOST_SECRET_IV = "nc-host";
const REF_PREFIX = "nc-host:";

export type HostSecretKind = "mcp" | "mcp-auth" | "gdrive" | "gws";

/** Resolved values in this process: name -> value (null: none or unreadable). */
const resolved = new Map<string, string | null>();

/** For tests. */
export function forgetResolvedHostSecrets(): void {
    resolved.clear();
}

/** The reference a row's column holds for the value kept under `name`. */
export function hostSecretRef(name: string): string {
    return REF_PREFIX + name;
}

export function isHostSecretRef(
    encrypted: unknown,
    iv: unknown,
): encrypted is string {
    return (
        iv === HOST_SECRET_IV &&
        typeof encrypted === "string" &&
        encrypted.startsWith(REF_PREFIX)
    );
}

function refName(encrypted: string): string {
    return encrypted.slice(REF_PREFIX.length);
}

/** The person a reference was kept for, from its name. */
function refPerson(encrypted: string): string | null {
    return normalizeNcPerson(refName(encrypted).split(":")[1]);
}

export function hostSecretName(
    person: string,
    kind: HostSecretKind,
    rowKey: string,
    field: string,
): string {
    const row = crypto
        .createHash("sha256")
        .update(`${kind}\0${rowKey}`)
        .digest("hex")
        .slice(0, 24);
    return `mike:${person}:${kind}:${row}:${field}`;
}

/**
 * A reference is read only for the person it was kept for. With no person
 * in hand nothing is read: "no person" is never a wildcard (the 2026-11-24
 * security review, L3).
 */
function refused(encrypted: string): boolean {
    const asking = currentNcPerson();
    return asking === null || refPerson(encrypted) !== asking;
}

/**
 * The value a reference names, as resolved in this process; null when it was
 * not resolved, is gone, cannot be read on this computer, or belongs to
 * another person than the one asking.
 */
export function cachedHostSecret(encrypted: string): string | null {
    if (refused(encrypted)) return null;
    return resolved.get(refName(encrypted)) ?? null;
}

type Row = Record<string, unknown>;

function triple(row: Row, field: string) {
    return {
        encrypted: row[`encrypted_${field}`],
        iv: row[`${field}_iv`],
    };
}

/**
 * Reads, from the host, every reference `row` holds among `fields`, so the
 * synchronous decrypt can answer for them. Values already resolved in this
 * process are not asked for again. A value the host can no longer open is
 * read as nothing: the person links again.
 */
export async function resolveHostColumns(
    row: Row | null | undefined,
    fields: readonly string[],
): Promise<void> {
    if (!row) return;
    for (const field of fields) {
        const { encrypted, iv } = triple(row, field);
        if (!isHostSecretRef(encrypted, iv)) continue;
        const name = refName(encrypted);
        if (resolved.has(name) || refused(encrypted)) continue;
        try {
            resolved.set(name, await ncAppSecrets().getSecret(name));
        } catch (err) {
            if (!(err instanceof HostSecretUnreadableError)) throw err;
            resolved.set(name, null);
        }
    }
}

/** resolveHostColumns for many rows. */
export async function resolveHostColumnsForRows(
    rows: readonly Row[] | null | undefined,
    fields: readonly string[],
): Promise<void> {
    for (const row of rows ?? []) await resolveHostColumns(row, fields);
}

type HostSecretWrite = {
    /** Run in reverse when the row's write fails: each value as it was. */
    undo: Array<() => Promise<void>>;
    /** Run once the row's write succeeded: the values it no longer points to. */
    after: Array<() => Promise<void>>;
};

const writeScope = new AsyncLocalStorage<HostSecretWrite>();

/**
 * Runs `write`, a row's save whose secret columns sealHostColumns made, so
 * that a failed save leaves the store as it was: a value it added is
 * deleted, one it replaced is put back, and a value the row stops pointing
 * to is deleted only once the save succeeded. Nested, the outermost one
 * decides. Outside app mode it only runs `write`.
 */
export async function withHostSecretWrite<T>(write: () => Promise<T>): Promise<T> {
    if (writeScope.getStore()) return write();
    const scope: HostSecretWrite = { undo: [], after: [] };
    let result: T;
    try {
        result = await writeScope.run(scope, write);
    } catch (err) {
        for (const undo of scope.undo.reverse()) {
            await undo().catch((undoError: unknown) =>
                log.warn("connectors", "a connector secret could not be put back after a failed save", { error: undoError }),
            );
        }
        throw err;
    }
    for (const after of scope.after) {
        await after().catch((afterError: unknown) =>
            log.warn("connectors", "a connector secret the row no longer uses could not be deleted", { error: afterError }),
        );
    }
    return result;
}

/** The value kept under `name` now, as this process knows it or the host says. */
async function valueBefore(name: string): Promise<string | null> {
    if (resolved.has(name)) return resolved.get(name) ?? null;
    try {
        return await ncAppSecrets().getSecret(name);
    } catch (err) {
        if (err instanceof HostSecretUnreadableError) return null;
        throw err;
    }
}

/**
 * Keeps `value` for `field` of the row `rowKey` names in the host's store and
 * answers the column triple that references it (all null for no value, the
 * kept value deleted). `previous` is the row as it was, when there was one: a
 * reference it held under another name is deleted. Only the person of the
 * work in hand keeps a value, and only in their own name: with no person, or
 * a previous reference of another person's, nothing is written.
 */
export async function sealHostColumns(
    field: string,
    value: string | null | undefined,
    where: { kind: HostSecretKind; rowKey: string; previous?: Row | null },
): Promise<Record<string, string | null>> {
    const columns = (encrypted: string | null) => ({
        [`encrypted_${field}`]: encrypted,
        [`${field}_iv`]: encrypted ? HOST_SECRET_IV : null,
        [`${field}_tag`]: encrypted ? HOST_SECRET_IV : null,
    });
    const before = where.previous ? triple(where.previous, field) : null;
    const previousRef =
        before && isHostSecretRef(before.encrypted, before.iv)
            ? before.encrypted
            : null;
    const person = currentNcPerson();
    if (!person) throw new NcPersonUnknownError();
    if (previousRef && refPerson(previousRef) !== person) throw new NcPersonUnknownError();
    const scope = writeScope.getStore();
    const dropPrevious = async () => {
        if (previousRef) await dropRef(previousRef);
    };
    if (!value) {
        if (scope) scope.after.push(dropPrevious);
        else await dropPrevious();
        return columns(null);
    }
    const name = hostSecretName(person, where.kind, where.rowKey, field);
    const secrets = ncAppSecrets();
    const prior = scope ? await valueBefore(name) : null;
    const { had } = await reserveHostSecret(person, name, value);
    try {
        await secrets.putSecret(name, value);
    } catch (err) {
        if (!had) await releaseHostSecret(person, name).catch(() => undefined);
        throw err;
    }
    resolved.set(name, value);
    if (scope) {
        scope.undo.push(async () => {
            // A value the store held before (counted or from before the
            // count began) is put back; a new one is deleted.
            if (prior !== null) {
                await reserveHostSecret(person, name, prior);
                await secrets.putSecret(name, prior);
                resolved.set(name, prior);
            } else {
                await dropName(name);
            }
        });
    }
    if (previousRef && refName(previousRef) !== name) {
        if (scope) scope.after.push(dropPrevious);
        else await dropPrevious();
    }
    return columns(REF_PREFIX + name);
}

/**
 * Deletes the value kept under `name`, and its count: for the sweep of
 * values no row points to (hostSecretSweep.ts).
 */
export function forgetHostSecret(name: string): Promise<void> {
    return dropName(name);
}

async function dropName(name: string): Promise<void> {
    await ncAppSecrets().deleteSecret(name);
    resolved.delete(name);
    const person = normalizeNcPerson(name.split(":")[1]);
    if (person) await releaseHostSecret(person, name);
}

async function dropRef(encrypted: string): Promise<void> {
    await dropName(refName(encrypted));
}

/**
 * Deletes from the host's store every value `row` references among
 * `fields`: the row is going (a disconnect, a removed connector).
 */
export async function releaseHostColumns(
    row: Row | null | undefined,
    fields: readonly string[],
): Promise<void> {
    if (!row) return;
    for (const field of fields) {
        const { encrypted, iv } = triple(row, field);
        if (isHostSecretRef(encrypted, iv)) await dropRef(encrypted);
    }
}

/** releaseHostColumns for many rows. */
export async function releaseHostColumnsForRows(
    rows: readonly Row[] | null | undefined,
    fields: readonly string[],
): Promise<void> {
    for (const row of rows ?? []) await releaseHostColumns(row, fields);
}

/** The secret fields of each kind of row. */
export const MCP_TOKEN_FIELDS = ["access_token", "refresh_token", "client_secret"] as const;
export const MCP_AUTH_FIELDS = ["auth_config"] as const;
export const GOOGLE_TOKEN_FIELDS = ["access_token", "refresh_token"] as const;
