import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptAuthConfig, decryptString, encryptString, setConnectorEncryptionSecret } from "./client";
import {
    forgetResolvedHostSecrets,
    HOST_SECRET_IV,
    hostSecretName,
    isHostSecretRef,
    NcPersonUnknownError,
    releaseHostColumns,
    resolveHostColumns,
    sealHostColumns,
} from "./hostSecretColumns";
import { configureNcAppConnectors, resetNcAppConnectors, withNcPerson } from "./ncApp";
import { HostSecretUnreadableError, memoryHostSecrets } from "./ncSecrets";
import type { ConnectorRow } from "./types";

let store: ReturnType<typeof memoryHostSecrets>;

beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    store = memoryHostSecrets();
    configureNcAppConnectors({ secrets: store });
    forgetResolvedHostSecrets();
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
        // Not resolved in this process yet: nothing to read.
        expect(decryptString(row.encrypted_refresh_token, row.refresh_token_iv, row.refresh_token_tag)).toBeNull();
        await resolveHostColumns(row, ["refresh_token"]);
        expect(decryptString(row.encrypted_refresh_token, row.refresh_token_iv, row.refresh_token_tag)).toBe("ref-A");
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

    it("keeps a background refresh under the person who linked it", async () => {
        const first = await withNcPerson("p_alice", () =>
            sealHostColumns("access_token", "old", { kind: "mcp", rowKey: "conn-1" }),
        );
        // A job with no person in hand: the previous reference says whose it is.
        const next = await sealHostColumns("access_token", "new", { kind: "mcp", rowKey: "conn-1", previous: first });
        expect(next.encrypted_access_token).toBe(first.encrypted_access_token);
        expect([...store.values.values()]).toEqual(["new"]);
    });

    it("deletes the kept value when the field is emptied or the row goes", async () => {
        const sealed = await withNcPerson("p_alice", async () => ({
            ...(await sealHostColumns("access_token", "a", { kind: "mcp", rowKey: "c" })),
            ...(await sealHostColumns("client_secret", "s", { kind: "mcp", rowKey: "c" })),
        }));
        expect(store.values.size).toBe(2);
        const cleared = await sealHostColumns("access_token", null, { kind: "mcp", rowKey: "c", previous: sealed });
        expect(cleared).toEqual({ encrypted_access_token: null, access_token_iv: null, access_token_tag: null });
        expect(store.values.size).toBe(1);
        await releaseHostColumns(sealed, ["access_token", "client_secret"]);
        expect(store.values.size).toBe(0);
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
        await resolveConnectorSecrets(row);
        withNcPerson("p_alice", () =>
            expect(decryptAuthConfig(row)).toEqual({ bearerToken: "pasted-key", headers: { "X-Team": "t1" } }),
        );
        // An empty config keeps nothing.
        const empty = await withNcPerson("p_alice", () => sealAuthConfig("conn-9", {}, row));
        expect(empty.encrypted_auth_config).toBeNull();
        expect(store.values.size).toBe(0);
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
