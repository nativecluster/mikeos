// The sweep, at start, of what NativeCluster's secrets store keeps for Mike
// that no row points to any more, in app mode (MIKE_NC_APP=1).
//
// A value is left behind when its row was never saved or was removed while
// the store could not be reached. The host has no route that lists the
// store, so the sweep reads each person's count (hostSecretIndex.ts) and
// asks the tables whose columns reference a value ("nc-host:<name>") which
// names they still use; every other one is deleted. It runs once before
// Mike serves anything, so no save is under way. A value kept before the
// count began is in no index and stays (it is counted once it is written
// again).

import { log } from "../log";
import type { Db } from "../supabase";
import { ncPersonIdOf } from "../nc/personId";
import { forgetHostSecret, hostSecretRef } from "./hostSecretColumns";
import { indexedHostSecrets } from "./hostSecretIndex";

/** Every column that may hold a reference to the host's store, by table. */
export const HOST_SECRET_REFERENCES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
    { table: "user_mcp_connectors", columns: ["encrypted_auth_config"] },
    {
        table: "user_mcp_oauth_tokens",
        columns: ["encrypted_access_token", "encrypted_refresh_token", "encrypted_client_secret"],
    },
    { table: "user_google_drive_tokens", columns: ["encrypted_access_token", "encrypted_refresh_token"] },
    { table: "user_google_workspace_tokens", columns: ["encrypted_access_token", "encrypted_refresh_token"] },
];

const BATCH = 50;

async function referencedOf(db: Db, refs: string[]): Promise<Set<string>> {
    const used = new Set<string>();
    for (const { table, columns } of HOST_SECRET_REFERENCES) {
        for (const column of columns) {
            for (let i = 0; i < refs.length; i += BATCH) {
                const { data, error } = await db
                    .from(table)
                    .select(column)
                    .in(column, refs.slice(i, i + BATCH));
                if (error) throw error;
                for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
                    const value = row[column];
                    if (typeof value === "string") used.add(value);
                }
            }
        }
    }
    return used;
}

/** Deletes every counted value no row points to. Answers how many went. */
export async function sweepOrphanHostSecrets(db: Db): Promise<{ people: number; removed: number }> {
    const { data, error } = await db.from("nativecluster_people").select("nc_person");
    if (error) throw error;
    const people = ((data ?? []) as { nc_person?: unknown }[])
        .map((row) => ncPersonIdOf(row.nc_person))
        .filter((person): person is string => person !== null);
    let removed = 0;
    for (const person of people) {
        const names = [...(await indexedHostSecrets(person)).keys()];
        if (!names.length) continue;
        const used = await referencedOf(db, names.map(hostSecretRef));
        for (const name of names) {
            if (used.has(hostSecretRef(name))) continue;
            await forgetHostSecret(name);
            removed++;
        }
    }
    if (removed) log.info("connectors", "removed connector secrets no connection used", { removed });
    return { people: people.length, removed };
}
