/**
 * Stands in for e2e/users.ts in the staged upstream specs (same exports).
 * In the NativeCluster app, NativeCluster is Mike's only login (Pablo,
 * 2026-11-24): each NativeCluster person is a Mike account, made on first
 * use, so there is no account to create and no password. A worker's
 * "account" is the person the harness's front door signs it in as, and its
 * email the one the fake host's ticket carries (people.read).
 */
import { emailFor, personForWorker } from "../lib/door";

export interface E2eAccount {
    email: string;
    password: string;
    /** The front door's person label (X-Harness-Person). */
    person: string;
}

export function workerAccount(parallelIndex: number): E2eAccount {
    const person = personForWorker(parallelIndex);
    return { email: emailFor(person), password: "", person };
}

export function readApiEnv(key: string): string | undefined {
    return process.env[key];
}

/** Nothing to make: NativeCluster's person is the account. */
export async function ensureUser(_email: string, _password: string): Promise<void> {}
