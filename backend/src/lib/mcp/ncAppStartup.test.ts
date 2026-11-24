import { afterEach, describe, expect, it } from "vitest";
import { decryptString, encryptString, setConnectorEncryptionSecret } from "./client";
import { ncAppSecrets, resetNcAppConnectors } from "./ncApp";
import { API_KEYS_KEY_SECRET, CONNECTOR_KEY_SECRET, ensureConnectorKey, startNcAppConnectors } from "./ncAppStartup";
import { HostSecretUnreadableError, memoryHostSecrets } from "./ncSecrets";

afterEach(() => {
    resetNcAppConnectors();
    setConnectorEncryptionSecret(null);
});

describe("starting Mike's connectors as a NativeCluster app", () => {
    it("makes the column key once and keeps it in the host's store", async () => {
        const store = memoryHostSecrets();
        const first = await ensureConnectorKey(store);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(store.values.get(CONNECTOR_KEY_SECRET)).toBe(first);
        expect(await ensureConnectorKey(store)).toBe(first);
    });

    it("starts a new key when the host can no longer open the old one", async () => {
        const store = memoryHostSecrets();
        await store.putSecret(CONNECTOR_KEY_SECRET, "old");
        const unreadable = {
            ...store,
            getSecret: async () => {
                throw new HostSecretUnreadableError();
            },
        };
        const key = await ensureConnectorKey(unreadable);
        expect(key).not.toBe("old");
        expect(store.values.get(CONNECTOR_KEY_SECRET)).toBe(key);
    });

    it("wires the store and encrypts with the host's key, not the environment's", async () => {
        const store = memoryHostSecrets();
        const { apiKeysEncryptionSecret } = await startNcAppConnectors({ socketPath: "", credential: "", secrets: store });
        expect(ncAppSecrets()).toBe(store);
        expect(apiKeysEncryptionSecret).toMatch(/^[0-9a-f]{64}$/);
        expect(store.values.get(API_KEYS_KEY_SECRET)).toBe(apiKeysEncryptionSecret);
        const sealed = encryptString("x");
        expect(decryptString(sealed.encrypted, sealed.iv, sealed.tag)).toBe("x");
        setConnectorEncryptionSecret("another-key");
        expect(decryptString(sealed.encrypted, sealed.iv, sealed.tag)).toBeNull();
    });
});
