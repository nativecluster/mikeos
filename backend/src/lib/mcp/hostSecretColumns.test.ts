import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptAuthConfig, decryptString, encryptString, setConnectorEncryptionSecret } from "./client";
import {
    cachedHostSecret,
    forgetResolvedHostSecrets,
    HOST_SECRET_IV,
    hostSecretName,
    isHostSecretRef,
    NcPersonUnknownError,
    releaseHostColumns,
    resolveHostColumns,
    sealHostColumns,
    withHostSecretWrite,
} from "./hostSecretColumns";
import {
    forgetHostSecretIndexes,
    HostSecretLimitError,
    hostSecretIndexName,
    indexedHostSecrets,
    PERSON_SECRET_MAX_BYTES,
    PERSON_SECRET_MAX_COUNT,
    SECRET_VALUE_MAX_BYTES,
} from "./hostSecretIndex";
import { configureNcAppConnectors, resetNcAppConnectors, withNcPerson } from "./ncApp";
import { HostSecretUnreadableError, memoryHostSecrets } from "./ncSecrets";
import type { ConnectorRow } from "./types";

let store: ReturnType<typeof memoryHostSecrets>;

/** The values kept, without the people's counts (hostSecretIndex.ts). */
const kept = () => new Map([...store.values].filter(([name]) => !name.endsWith(":index")));

beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    store = memoryHostSecrets();
    configureNcAppConnectors({ secrets: store });
    forgetResolvedHostSecrets();
    forgetHostSecretIndexes();
});

afterEach(() => {
    vi.unstubAllEnvs();
    resetNcAppConnectors();
    setConnectorEncryptionSecret(null);
});

describe("connector secrets in NativeCluster's store", () => {
    it("keeps the value with the host and only a reference in the row", async () => {
        const columns = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "tok-A", { kind: "mcp", rowKey: "conn-1" }),
        );
        const name = hostSecretName("p_alice", "mcp", "conn-1", "access_token");
        expect(columns).toEqual({
            encrypted_access_token: `nc-host:${name}`,
            access_token_iv: HOST_SECRET_IV,
            access_token_tag: HOST_SECRET_IV,
        });
        expect(JSON.stringify(columns)).not.toContain("tok-A");
        expect(store.values.get(name)).toBe("tok-A");
        expect(name.length).toBeLessThanOrEqual(128);
        expect(name.startsWith("mike:p_alice:mcp:")).toBe(true);
    });

    it("is read back through Mike's own decrypt once the row is resolved", async () => {
        const row = await withNcPerson("p_alice", () =>
            sealHostColumns("refresh_token", "ref-A", { kind: "mcp", rowKey: "conn-1" }),
        );
        forgetResolvedHostSecrets();
        await withNcPerson("p_alice", async () => {
            // Not resolved in this process yet: nothing to read.
            expect(decryptString(row.encrypted_refresh_token, row.refresh_token_iv, row.refresh_token_tag)).toBeNull();
            await resolveHostColumns(row, ["refresh_token"]);
            expect(decryptString(row.encrypted_refresh_token, row.refresh_token_iv, row.refresh_token_tag)).toBe("ref-A");
        });
    });

    it("is never read for another NativeCluster person", async () => {
        const row = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "tok-A", { kind: "mcp", rowKey: "conn-1" }),
        );
        withNcPerson("p_bob", () =>
            expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBeNull(),
        );
        withNcPerson("p_alice", () =>
            expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBe("tok-A"),
        );
    });

    it("is not kept when no person is known", async () => {
        await expect(sealHostColumns("access_token", "tok", { kind: "mcp", rowKey: "c" })).rejects.toBeInstanceOf(
            NcPersonUnknownError,
        );
        expect(store.values.size).toBe(0);
    });

    it("keeps a refresh in place under the person who linked it", async () => {
        const first = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "old", { kind: "mcp", rowKey: "conn-1" }),
        );
        const next = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "new", { kind: "mcp", rowKey: "conn-1", previous: first }),
        );
        expect(next.encrypted_access_token).toBe(first.encrypted_access_token);
        expect([...kept().values()]).toEqual(["new"]);
    });

    // Review L3: "no person" is never a wildcard. A write with no person in
    // hand used to be kept under the previous reference's person.
    it("keeps nothing for no one, even over a previous reference", async () => {
        const first = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "old", { kind: "mcp", rowKey: "conn-1" }),
        );
        await expect(
            sealHostColumns("access_token", "new", { kind: "mcp", rowKey: "conn-1", previous: first }),
        ).rejects.toBeInstanceOf(NcPersonUnknownError);
        await expect(
            withNcPerson("p_bob", () =>
                sealHostColumns("access_token", "new", { kind: "mcp", rowKey: "conn-1", previous: first }),
            ),
        ).rejects.toBeInstanceOf(NcPersonUnknownError);
        expect([...kept().values()]).toEqual(["old"]);
    });

    // Review L3: a value used to be readable by anything that ran with no
    // person in hand.
    it("reads nothing for no one", async () => {
        const row = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "tok-A", { kind: "mcp", rowKey: "conn-1" }),
        );
        expect(cachedHostSecret(row.encrypted_access_token as string)).toBeNull();
        expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBeNull();
        withNcPerson(null, () =>
            expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBeNull(),
        );
        withNcPerson("p_al.ice", () =>
            expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBeNull(),
        );
    });

    it("deletes the kept value when the field is emptied or the row goes", async () => {
        const sealed = await withNcPerson("p_alice", async () => ({
            ...(await sealHostColumns("access_token", "a", { kind: "mcp", rowKey: "c" })),
            ...(await sealHostColumns("client_secret", "s", { kind: "mcp", rowKey: "c" })),
        }));
        expect(kept().size).toBe(2);
        const cleared = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", null, { kind: "mcp", rowKey: "c", previous: sealed }),
        );
        expect(cleared).toEqual({ encrypted_access_token: null, access_token_iv: null, access_token_tag: null });
        expect(kept().size).toBe(1);
        await releaseHostColumns(sealed, ["access_token", "client_secret"]);
        expect(kept().size).toBe(0);
        expect((await indexedHostSecrets("p_alice")).size).toBe(0);
    });

    it("reads a value the host can no longer open as nothing, so the person links again", async () => {
        const row = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "tok", { kind: "mcp", rowKey: "c" }),
        );
        forgetResolvedHostSecrets();
        configureNcAppConnectors({
            secrets: {
                ...store,
                getSecret: async () => {
                    throw new HostSecretUnreadableError();
                },
            },
        });
        await resolveHostColumns(row, ["access_token"]);
        withNcPerson("p_alice", () =>
            expect(decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag)).toBeNull(),
        );
    });

    it("leaves Mike's own encrypted columns as they were", async () => {
        setConnectorEncryptionSecret("k".repeat(64));
        const enc = encryptString("plain");
        expect(isHostSecretRef(enc.encrypted, enc.iv)).toBe(false);
        expect(decryptString(enc.encrypted, enc.iv, enc.tag)).toBe("plain");
    });

    it("keeps a pasted key's auth config the same way", async () => {
        const { sealAuthConfig, resolveConnectorSecrets } = await import("./client.js");
        const columns = await withNcPerson("p_alice", () =>
            sealAuthConfig("conn-9", { bearerToken: "pasted-key", headers: { "X-Team": "t1" } }),
        );
        expect(JSON.stringify(columns)).not.toContain("pasted-key");
        const row = { id: "conn-9", ...columns } as unknown as ConnectorRow;
        forgetResolvedHostSecrets();
        await withNcPerson("p_alice", async () => {
            await resolveConnectorSecrets(row);
            expect(decryptAuthConfig(row)).toEqual({ bearerToken: "pasted-key", headers: { "X-Team": "t1" } });
        });
        // An empty config keeps nothing.
        const empty = await withNcPerson("p_alice", () => sealAuthConfig("conn-9", {}, row));
        expect(empty.encrypted_auth_config).toBeNull();
        expect(kept().size).toBe(0);
    });

    it("is not used outside app mode", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        setConnectorEncryptionSecret("k".repeat(64));
        const { sealAuthConfig } = await import("./client.js");
        const columns = await sealAuthConfig("conn-9", { bearerToken: "pasted-key" });
        expect(columns.auth_config_iv).not.toBe(HOST_SECRET_IV);
        expect(store.values.size).toBe(0);
    });
});

// Review M2: one person could fill the app's one store (1 MiB) with values no
// row pointed to, and break everyone's connectors.
describe("each person's share of NativeCluster's store", () => {
    const seal = (person: string, row: string, value: string) =>
        withNcPerson(person, () => sealHostColumns("access_token", value, { kind: "mcp", rowKey: row }));

    it("counts every value a person keeps, in the store itself", async () => {
        await seal("p_alice", "c1", "aaaa");
        await seal("p_alice", "c2", "bb");
        const index = await indexedHostSecrets("p_alice");
        expect([...index.values()].sort()).toEqual([2, 4]);
        const saved = JSON.parse(store.values.get(hostSecretIndexName("p_alice"))!) as { names: Record<string, number> };
        expect(Object.keys(saved.names).sort()).toEqual([...kept().keys()].sort());
        // Read again after a restart, from the store.
        forgetHostSecretIndexes();
        expect((await indexedHostSecrets("p_alice")).size).toBe(2);
    });

    it(`keeps at most ${PERSON_SECRET_MAX_COUNT} values for a person, and says so in words`, async () => {
        for (let i = 0; i < PERSON_SECRET_MAX_COUNT; i++) await seal("p_alice", `c${i}`, "t");
        const refused = seal("p_alice", "one-more", "t");
        await expect(refused).rejects.toBeInstanceOf(HostSecretLimitError);
        await expect(refused).rejects.toMatchObject({ code: "connector_secrets_full" });
        await expect(refused).rejects.toThrow(/Remove a connector you no longer use/);
        expect(kept().size).toBe(PERSON_SECRET_MAX_COUNT);
        // Replacing a value it already keeps is no new one.
        await seal("p_alice", "c0", "t2");
        // Another person's share is their own.
        await seal("p_bob", "c0", "t");
        expect(kept().size).toBe(PERSON_SECRET_MAX_COUNT + 1);
    });

    it(`keeps at most ${PERSON_SECRET_MAX_BYTES / 1024} KiB for a person`, async () => {
        const big = "x".repeat(SECRET_VALUE_MAX_BYTES);
        for (let i = 0; i < PERSON_SECRET_MAX_BYTES / SECRET_VALUE_MAX_BYTES; i++) await seal("p_alice", `c${i}`, big);
        await expect(seal("p_alice", "more", "y")).rejects.toMatchObject({ code: "connector_secrets_full" });
        expect([...kept().keys()].some((name) => name.includes(hostSecretName("p_alice", "mcp", "more", "x").split(":")[3]))).toBe(false);
    });

    it(`refuses a value over ${SECRET_VALUE_MAX_BYTES / 1024} KiB before anything is kept`, async () => {
        await expect(seal("p_alice", "c1", "x".repeat(SECRET_VALUE_MAX_BYTES + 1))).rejects.toMatchObject({
            code: "connector_secret_too_large",
        });
        expect(store.values.size).toBe(0);
    });
});

// Review M2: a value was kept in the host's store before its row was saved,
// and stayed there when the save failed.
describe("a save that fails", () => {
    it("deletes a value it added, and its count", async () => {
        await expect(
            withNcPerson("p_alice", () =>
                withHostSecretWrite(async () => {
                    await sealHostColumns("auth_config", "{\"bearerToken\":\"k\"}", { kind: "mcp-auth", rowKey: "new" });
                    throw new Error("insert failed");
                }),
            ),
        ).rejects.toThrow("insert failed");
        expect(kept().size).toBe(0);
        expect((await indexedHostSecrets("p_alice")).size).toBe(0);
    });

    it("puts back a value it replaced, and keeps the one the row stops using until the save succeeds", async () => {
        const first = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "old", { kind: "mcp", rowKey: "c1" }),
        );
        forgetResolvedHostSecrets();
        await expect(
            withNcPerson("p_alice", () =>
                withHostSecretWrite(async () => {
                    await sealHostColumns("access_token", "new", { kind: "mcp", rowKey: "c1", previous: first });
                    throw new Error("update failed");
                }),
            ),
        ).rejects.toThrow("update failed");
        expect([...kept().values()]).toEqual(["old"]);

        await expect(
            withNcPerson("p_alice", () =>
                withHostSecretWrite(async () => {
                    await sealHostColumns("access_token", null, { kind: "mcp", rowKey: "c1", previous: first });
                    throw new Error("update failed");
                }),
            ),
        ).rejects.toThrow("update failed");
        expect([...kept().values()]).toEqual(["old"]);

        await withNcPerson("p_alice", () =>
            withHostSecretWrite(() => sealHostColumns("access_token", null, { kind: "mcp", rowKey: "c1", previous: first })),
        );
        expect(kept().size).toBe(0);
    });
});
