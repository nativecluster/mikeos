// What Mike keeps for each person in NativeCluster's secrets store, counted,
// in app mode (MIKE_NC_APP=1).
//
// The host keeps one store for the whole app (1 MiB, at most 64 KiB a value)
// and has no route that lists it, so without a count of its own one person
// could fill it and break everyone's connectors, and a value no row points
// to could never be found again (the 2026-11-24 security review, M2). Each
// person's names and sizes are kept here, in the store itself, under
// `mike:<person>:index`:
//
//   {"v":1,"names":{"mike:p_…:mcp:…:access_token":1234,…}}
//
// - A value is counted before it is written (reserve), and uncounted after
//   it is deleted (release), so every value the store holds for a person is
//   in their index, whatever a crash interrupts. A name counted but never
//   written is found by the sweep at start (hostSecretSweep.ts) and dropped.
// - Each person may keep at most PERSON_SECRET_MAX_COUNT values of at most
//   PERSON_SECRET_MAX_BYTES together, and no value is larger than
//   SECRET_VALUE_MAX_BYTES: a write past either is refused in words, and
//   nothing is written.
// - One backend process writes the store (worker threads hold no store), so
//   each person's index is read once, kept in memory, and changed one write
//   at a time.

import { ncAppSecrets } from "./ncApp";
import { HostSecretUnreadableError, type HostSecrets } from "./ncSecrets";

/** The most values Mike keeps for one person: about nine linked connectors. */
export const PERSON_SECRET_MAX_COUNT = 40;
/** The most bytes Mike keeps for one person: an eighth of the app's store. */
export const PERSON_SECRET_MAX_BYTES = 128 * 1024;
/** The largest single value Mike keeps (a token a service gave, a pasted key). */
export const SECRET_VALUE_MAX_BYTES = 16 * 1024;

/** A write past a person's share of the store, or a value too large. In words. */
export class HostSecretLimitError extends Error {
    constructor(
        readonly code: "connector_secret_too_large" | "connector_secrets_full",
        message: string,
    ) {
        super(message);
        this.name = "HostSecretLimitError";
    }
}

export function tooLarge(): HostSecretLimitError {
    return new HostSecretLimitError(
        "connector_secret_too_large",
        `A connector's key or token is larger than Mike keeps (${SECRET_VALUE_MAX_BYTES / 1024} KiB). Check what you pasted, or ask the service for a smaller one.`,
    );
}

function full(): HostSecretLimitError {
    return new HostSecretLimitError(
        "connector_secrets_full",
        `Mike keeps at most ${PERSON_SECRET_MAX_COUNT} connector keys and tokens (${PERSON_SECRET_MAX_BYTES / 1024} KiB) for each person on this computer. Remove a connector you no longer use, then try again.`,
    );
}

type Index = Map<string, number>;

const indexes = new Map<string, Index>();
const locks = new Map<string, Promise<unknown>>();
/** The store the counts in memory were read from: another one counts afresh. */
let countedIn: HostSecrets | null = null;

/** For tests. */
export function forgetHostSecretIndexes(): void {
    indexes.clear();
    locks.clear();
    countedIn = null;
}

export function hostSecretIndexName(person: string): string {
    return `mike:${person}:index`;
}

/** The person a value's name was kept for (`mike:<person>:…`), or null. */
export function personOfSecretName(name: string): string | null {
    const [app, person, kind] = name.split(":");
    return app === "mike" && person && kind && kind !== "index" ? person : null;
}

function bytes(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

/** One change of a person's index at a time, in this process. */
function locked<T>(person: string, fn: () => Promise<T>): Promise<T> {
    const before = locks.get(person) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.then(
        () => undefined,
        () => undefined,
    );
    locks.set(person, settled);
    void settled.then(() => {
        if (locks.get(person) === settled) locks.delete(person);
    });
    return run;
}

async function load(person: string): Promise<Index> {
    const store = ncAppSecrets();
    if (countedIn !== store) {
        indexes.clear();
        countedIn = store;
    }
    const cached = indexes.get(person);
    if (cached) return cached;
    let raw: string | null = null;
    try {
        raw = await store.getSecret(hostSecretIndexName(person));
    } catch (err) {
        // An index this computer can no longer open counts nothing: the
        // values it counted are unreadable too, and are written again.
        if (!(err instanceof HostSecretUnreadableError)) throw err;
    }
    const index: Index = new Map();
    try {
        const parsed = raw ? (JSON.parse(raw) as { names?: unknown }) : null;
        const names = parsed?.names;
        if (names && typeof names === "object" && !Array.isArray(names)) {
            for (const [name, size] of Object.entries(names as Record<string, unknown>)) {
                if (typeof size === "number" && Number.isFinite(size) && size >= 0) index.set(name, size);
            }
        }
    } catch {
        // Not JSON: an empty index, rewritten on the next change.
    }
    indexes.set(person, index);
    return index;
}

async function save(person: string, index: Index): Promise<void> {
    const names = Object.fromEntries(index);
    await ncAppSecrets().putSecret(hostSecretIndexName(person), JSON.stringify({ v: 1, names }));
}

/**
 * Counts `value` under `name` for `person` before it is written, or refuses
 * (HostSecretLimitError) when it would pass their share. Answers whether the
 * name was already counted (the write replaces a value the store holds).
 */
export function reserveHostSecret(person: string, name: string, value: string): Promise<{ had: boolean }> {
    const size = bytes(value);
    if (size > SECRET_VALUE_MAX_BYTES) return Promise.reject(tooLarge());
    return locked(person, async () => {
        const index = await load(person);
        const had = index.has(name);
        if (had && index.get(name) === size) return { had };
        const count = index.size + (had ? 0 : 1);
        let total = size;
        for (const [other, otherSize] of index) if (other !== name) total += otherSize;
        if (count > PERSON_SECRET_MAX_COUNT || total > PERSON_SECRET_MAX_BYTES) throw full();
        const next = new Map(index).set(name, size);
        await save(person, next);
        indexes.set(person, next);
        return { had };
    });
}

/** Uncounts `name` for `person`, after its value was deleted. */
export function releaseHostSecret(person: string, name: string): Promise<void> {
    return locked(person, async () => {
        const index = await load(person);
        if (!index.has(name)) return;
        const next = new Map(index);
        next.delete(name);
        await save(person, next);
        indexes.set(person, next);
    });
}

/** What the index counts for `person`: name -> bytes. */
export function indexedHostSecrets(person: string): Promise<ReadonlyMap<string, number>> {
    return locked(person, () => load(person));
}
