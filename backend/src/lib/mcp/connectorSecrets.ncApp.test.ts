import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The 2026-11-24 security review, M2: in the NativeCluster app one person
// could fill the app's one secrets store (1 MiB, no list route) with values
// no row pointed to, and break everyone's connectors:
// - PATCH /user/mcp-connectors/<an id not theirs> kept the pasted key in the
//   store before the owner-filtered update failed;
// - nothing capped a pasted key under the host's 64 KiB;
// - a row that failed to save left its value behind, for good.

const { validateRemoteMcpUrlMock } = vi.hoisted(() => ({ validateRemoteMcpUrlMock: vi.fn() }));
vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return { ...actual, validateRemoteMcpUrl: (url: string) => validateRemoteMcpUrlMock(url) };
});

import { personalConnectorOwner } from "../connectorOwner";
import { PASTED_AUTH_MAX_BYTES, setConnectorEncryptionSecret } from "./client";
import { forgetResolvedHostSecrets, hostSecretName, hostSecretRef } from "./hostSecretColumns";
import { forgetHostSecretIndexes, HostSecretLimitError, indexedHostSecrets } from "./hostSecretIndex";
import { sweepOrphanHostSecrets } from "./hostSecretSweep";
import { configureNcAppConnectors, resetNcAppConnectors, withNcPerson } from "./ncApp";
import { memoryHostSecrets } from "./ncSecrets";
import { createUserMcpConnector, McpConnectorNotFoundError, updateUserMcpConnector } from "./servers";
import { memoryDb } from "./__tests__/memoryDb";
import type { Db } from "./types";

let store: ReturnType<typeof memoryHostSecrets>;
const puts: string[] = [];

/** The values kept, without the people's counts. */
const kept = () => [...store.values.keys()].filter((name) => !name.endsWith(":index"));

const BOBS = "22222222-2222-2222-2222-222222222222";
const ALICES = "33333333-3333-3333-3333-333333333333";

function connectorRow(id: string, userId: string) {
    return {
        id,
        user_id: userId,
        org_id: null,
        name: "Docs",
        transport: "streamable_http",
        server_url: "https://mcp.example.com/mcp",
        auth_type: "none",
        enabled: true,
        tool_policy: {},
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
    };
}

/** memoryDb, with the connector table's writes failing when asked to. */
function failingWrites(db: Db & { tables: Map<string, Record<string, unknown>[]> }, ops: string[]) {
    const from = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
        const query = from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        if (table !== "user_mcp_connectors") return query;
        for (const op of ops) {
            const original = query[op];
            query[op] = (...args: unknown[]) => {
                original(...args);
                return {
                    ...query,
                    select: () => ({
                        single: () => Promise.resolve({ data: null, error: { code: "23505", message: "write failed" } }),
                    }),
                    eq: () => ({
                        eq: () => ({
                            select: () => ({
                                single: () => Promise.resolve({ data: null, error: { code: "23505", message: "write failed" } }),
                            }),
                        }),
                    }),
                };
            };
        }
        return query;
    };
    return db;
}

beforeEach(() => {
    vi.stubEnv("MIKE_NC_APP", "1");
    setConnectorEncryptionSecret("k".repeat(64));
    store = memoryHostSecrets();
    puts.length = 0;
    const putSecret = store.putSecret.bind(store);
    store.putSecret = async (name, value) => {
        puts.push(name);
        return putSecret(name, value);
    };
    configureNcAppConnectors({ secrets: store });
    forgetResolvedHostSecrets();
    forgetHostSecretIndexes();
    validateRemoteMcpUrlMock.mockReset();
    validateRemoteMcpUrlMock.mockImplementation(async (url: string) => url);
});

afterEach(() => {
    vi.unstubAllEnvs();
    resetNcAppConnectors();
    setConnectorEncryptionSecret(null);
});

describe("a connector another person owns", () => {
    it("is not found, before any key is kept or any name looked up", async () => {
        const db = memoryDb({ user_mcp_connectors: [connectorRow(ALICES, "user-alice")] });
        await expect(
            withNcPerson("p_bob", () =>
                updateUserMcpConnector(
                    "user-bob",
                    ALICES,
                    { bearerToken: "b".repeat(60 * 1024), serverUrl: "https://bob-chosen.example.test/mcp" },
                    db,
                ),
            ),
        ).rejects.toBeInstanceOf(McpConnectorNotFoundError);
        expect(puts).toEqual([]);
        expect(store.values.size).toBe(0);
        expect(validateRemoteMcpUrlMock).not.toHaveBeenCalled();
    });

    it("nor is one that does not exist", async () => {
        const db = memoryDb({ user_mcp_connectors: [] });
        await expect(
            withNcPerson("p_bob", () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: "k" }, db)),
        ).rejects.toBeInstanceOf(McpConnectorNotFoundError);
        expect(store.values.size).toBe(0);
    });

    it("its owner still updates", async () => {
        const db = memoryDb({ user_mcp_connectors: [connectorRow(BOBS, "user-bob")] });
        await withNcPerson("p_bob", () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: "bobs-key" }, db));
        expect(kept()).toEqual([hostSecretName("p_bob", "mcp-auth", BOBS, "auth_config")]);
        expect(db.tables.get("user_mcp_connectors")![0].encrypted_auth_config).toBe(
            hostSecretRef(hostSecretName("p_bob", "mcp-auth", BOBS, "auth_config")),
        );
    });
});

describe("a pasted key and headers", () => {
    it(`are refused in words over ${PASTED_AUTH_MAX_BYTES / 1024} KiB, before anything is kept`, async () => {
        const db = memoryDb({ user_mcp_connectors: [connectorRow(BOBS, "user-bob")] });
        const tooLong = "k".repeat(PASTED_AUTH_MAX_BYTES + 1);
        for (const attempt of [
            () => createUserMcpConnector(personalConnectorOwner("user-bob"), { name: "X", serverUrl: "https://x.example/mcp", bearerToken: tooLong }, db),
            () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: tooLong }, db),
            () =>
                updateUserMcpConnector(
                    "user-bob",
                    BOBS,
                    { headers: { "X-A": "a".repeat(4000), "X-B": "b".repeat(4000), "X-C": "c".repeat(400) } },
                    db,
                ),
        ]) {
            const refused = withNcPerson("p_bob", attempt);
            await expect(refused).rejects.toBeInstanceOf(HostSecretLimitError);
            await expect(refused).rejects.toMatchObject({ code: "connector_secret_too_large" });
        }
        expect(store.values.size).toBe(0);
        expect(db.tables.get("user_mcp_connectors")).toHaveLength(1);
    });

    it("of ordinary size are kept", async () => {
        const db = memoryDb({ user_mcp_connectors: [] });
        await withNcPerson("p_bob", () =>
            createUserMcpConnector(
                personalConnectorOwner("user-bob"),
                { name: "X", serverUrl: "https://x.example/mcp", bearerToken: "k".repeat(PASTED_AUTH_MAX_BYTES) },
                db,
            ),
        );
        expect(kept()).toHaveLength(1);
    });
});

describe("a connector whose row is not saved", () => {
    it("keeps no key when it is created", async () => {
        const db = failingWrites(memoryDb({ user_mcp_connectors: [] }), ["insert"]);
        await expect(
            withNcPerson("p_bob", () =>
                createUserMcpConnector(personalConnectorOwner("user-bob"), { name: "X", serverUrl: "https://x.example/mcp", bearerToken: "k" }, db),
            ),
        ).rejects.toMatchObject({ message: "write failed" });
        expect(puts.filter((n) => !n.endsWith(":index"))).toHaveLength(1);
        expect(kept()).toEqual([]);
        expect((await indexedHostSecrets("p_bob")).size).toBe(0);
    });

    it("keeps the key it had when it is updated", async () => {
        const db = memoryDb({ user_mcp_connectors: [connectorRow(BOBS, "user-bob")] });
        await withNcPerson("p_bob", () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: "old-key" }, db));
        const [name] = kept();
        failingWrites(db, ["update"]);
        await expect(
            withNcPerson("p_bob", () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: "new-key" }, db)),
        ).rejects.toMatchObject({ message: "write failed" });
        expect(JSON.parse(store.values.get(name)!)).toEqual({ bearerToken: "old-key" });
    });
});

describe("the sweep at start", () => {
    it("deletes every counted value no row points to, and keeps the rest", async () => {
        const used = memoryDb({ user_mcp_connectors: [connectorRow(BOBS, "user-bob")] });
        await withNcPerson("p_bob", () => updateUserMcpConnector("user-bob", BOBS, { bearerToken: "used" }, used));
        // A value left behind (a crash between the store and the row).
        const { sealHostColumns } = await import("./hostSecretColumns.js");
        await withNcPerson("p_bob", () => sealHostColumns("access_token", "orphan", { kind: "mcp", rowKey: "gone" }));
        await withNcPerson("p_alice", () => sealHostColumns("access_token", "orphan", { kind: "mcp", rowKey: "gone" }));
        expect(kept()).toHaveLength(3);

        used.tables.set("nativecluster_people", [{ nc_person: "p_bob" }, { nc_person: "p_alice" }, { nc_person: "not a person" }]);
        forgetHostSecretIndexes();
        expect(await sweepOrphanHostSecrets(used)).toEqual({ people: 2, removed: 2 });
        expect(kept()).toEqual([hostSecretName("p_bob", "mcp-auth", BOBS, "auth_config")]);
        expect((await indexedHostSecrets("p_alice")).size).toBe(0);
        expect((await indexedHostSecrets("p_bob")).size).toBe(1);
    });
});
