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
// itself reads only the asking person's values.

import crypto from "node:crypto";
import { currentNcPerson, ncAppSecrets, normalizeNcPerson } from "./ncApp";
import { HostSecretUnreadableError } from "./ncSecrets";

export const HOST_SECRET_IV = "nc-host";
const REF_PREFIX = "nc-host:";

export type HostSecretKind = "mcp" | "mcp-auth" | "gdrive" | "gws";

export class NcPersonUnknownError extends Error {
    code = "nc_person_unknown";
    constructor() {
        super("Mike could not tell which NativeCluster person this connection is for.");
        this.name = "NcPersonUnknownError";
    }
}

/** Resolved values in this process: name -> value (null: none or unreadable). */
const resolved = new Map<string, string | null>();

/** For tests. */
export function forgetResolvedHostSecrets(): void {
    resolved.clear();
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

function refused(encrypted: string): boolean {
    const asking = currentNcPerson();
    return asking !== null && refPerson(encrypted) !== asking;
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

/**
 * Keeps `value` for `field` of the row `rowKey` names in the host's store and
 * answers the column triple that references it (all null for no value, the
 * kept value deleted). `previous` is the row as it was, when there was one:
 * its reference says whose the value is when no person is in hand (a
 * background refresh), and a reference it held under another name is deleted.
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
    if (!value) {
        if (previousRef) await dropRef(previousRef);
        return columns(null);
    }
    const person =
        currentNcPerson() ?? (previousRef ? refPerson(previousRef) : null);
    if (!person) throw new NcPersonUnknownError();
    const name = hostSecretName(person, where.kind, where.rowKey, field);
    await ncAppSecrets().putSecret(name, value);
    resolved.set(name, value);
    if (previousRef && refName(previousRef) !== name) await dropRef(previousRef);
    return columns(REF_PREFIX + name);
}

async function dropRef(encrypted: string): Promise<void> {
    const name = refName(encrypted);
    await ncAppSecrets().deleteSecret(name);
    resolved.delete(name);
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
