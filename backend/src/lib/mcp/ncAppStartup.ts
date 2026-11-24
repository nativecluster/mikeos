// The one call Mike's backend makes at startup in app mode (MIKE_NC_APP=1)
// for its connectors. The integration calls it after reading the stdin line:
//
//     await startNcAppConnectors({
//         socketPath: process.env.LB_HOST_SOCKET!,
//         credential: <app_credential from the stdin line>,
//         currentPerson: () => <the person of the request or job in hand>,
//     });
//
// It connects the host's secrets store, and makes the key Mike encrypts its
// remaining connector columns with (OAuth states, anything stored before app
// mode) one the host keeps, never one in the environment or a file. The key
// is made on the first start on this computer.

import crypto from "node:crypto";
import { setConnectorEncryptionSecret } from "./client";
import { configureNcAppConnectors } from "./ncApp";
import { createHostSecrets, HostSecretUnreadableError, type HostSecrets } from "./ncSecrets";

export const CONNECTOR_KEY_SECRET = "mike:app:connectors-key";
/**
 * The key for the API keys people paste (CourtListener, Brave, Tavily),
 * which lib/providerCredentials keeps encrypted in Mike's tables under
 * USER_API_KEYS_ENCRYPTION_SECRET: kept by the host too, for the integration
 * to hand that module (it reads the environment today).
 */
export const API_KEYS_KEY_SECRET = "mike:app:api-keys-key";

/** Reads (or, the first time, makes and keeps) the connectors' column key. */
export function ensureConnectorKey(secrets: HostSecrets): Promise<string> {
    return ensureHostKey(secrets, CONNECTOR_KEY_SECRET);
}

/** Reads (or, the first time, makes and keeps) a 32-byte key the host keeps under `name`. */
export async function ensureHostKey(secrets: HostSecrets, name: string): Promise<string> {
    let key: string | null = null;
    try {
        key = await secrets.getSecret(name);
    } catch (err) {
        // The key is sealed under a key this computer no longer holds: what it
        // encrypted is lost either way, so a new one starts. Connections whose
        // tokens the host keeps are not affected.
        if (!(err instanceof HostSecretUnreadableError)) throw err;
    }
    if (!key) {
        key = crypto.randomBytes(32).toString("hex");
        await secrets.putSecret(name, key);
    }
    return key;
}

export async function startNcAppConnectors(options: {
    socketPath: string;
    credential: string;
    currentPerson?: () => string | null | undefined;
    /** For tests: a store in place of the host socket's. */
    secrets?: HostSecrets;
}): Promise<{ apiKeysEncryptionSecret: string }> {
    const secrets =
        options.secrets ?? createHostSecrets({ socketPath: options.socketPath, credential: options.credential });
    configureNcAppConnectors({ secrets, currentPerson: options.currentPerson });
    setConnectorEncryptionSecret(await ensureConnectorKey(secrets));
    return { apiKeysEncryptionSecret: await ensureHostKey(secrets, API_KEYS_KEY_SECRET) };
}
