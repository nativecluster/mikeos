// The keys Mike's stack runs on, made on the first start on this computer
// and kept by NativeCluster's host (`/host/v1/secrets/<name>`), never in a
// file in the data folder:
//
//   mike:app:stack-keys    one JSON value, so the keys that go together are
//                          kept together: the JWT secret PostgREST checks,
//                          the anon and service-role JWTs signed with it,
//                          and DOWNLOAD_SIGNING_SECRET;
//   mike:app:api-keys-key  USER_API_KEYS_ENCRYPTION_SECRET, the key for the
//                          API keys people paste (CourtListener, Brave,
//                          Tavily). The backend's connectors read the same
//                          name (backend/src/lib/mcp/ncAppStartup.ts,
//                          API_KEYS_KEY_SECRET), so the two always agree.
//
// The internal secret between the launcher and the backend is made at each
// start and kept in memory only (stdin), never here.
//
// A value the host can no longer read (409 unreadable: the Keychain key it
// was sealed under is gone) is made anew. For the stack keys that costs
// nothing kept: they sign only what the launcher's own processes pass each
// other, and download links that last minutes. For the API keys' key it
// means the pasted keys must be pasted again, as the connectors' code does.

import { createHmac, randomBytes } from "node:crypto";

export const STACK_KEYS_SECRET = "mike:app:stack-keys";
export const API_KEYS_KEY_SECRET = "mike:app:api-keys-key";

const b64url = (b) => Buffer.from(b).toString("base64url");

export function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest())}`;
}

export function mintStackKeys(now = Math.floor(Date.now() / 1000)) {
  const jwtSecret = randomBytes(48).toString("hex");
  // Role keys, not sessions: ten years, as upstream's desktop mints them.
  const exp = now + 10 * 365 * 24 * 3600;
  const claims = (role) => ({ iss: "mike-nativecluster", role, iat: now, exp });
  return {
    version: 1,
    jwt_secret: jwtSecret,
    anon_key: signJwt(claims("anon"), jwtSecret),
    service_role_key: signJwt(claims("service_role"), jwtSecret),
    download_signing_secret: randomBytes(32).toString("hex"),
  };
}

function validStackKeys(v) {
  return (
    v &&
    v.version === 1 &&
    typeof v.jwt_secret === "string" &&
    v.jwt_secret.length >= 64 &&
    typeof v.anon_key === "string" &&
    typeof v.service_role_key === "string" &&
    typeof v.download_signing_secret === "string" &&
    v.download_signing_secret.length >= 32
  );
}

async function readOrNull(store, name, log) {
  try {
    return await store.get(name);
  } catch (e) {
    if (e?.code === "unreadable") {
      log.warn(`the host can no longer read ${name}: making a new one`);
      return null;
    }
    throw e;
  }
}

/** Reads the keys, or makes and keeps them the first time. */
export async function loadStackSecrets(store, log) {
  let keys = null;
  const raw = await readOrNull(store, STACK_KEYS_SECRET, log);
  if (raw !== null) {
    try {
      keys = JSON.parse(raw);
    } catch {}
    if (!validStackKeys(keys)) {
      log.warn(`${STACK_KEYS_SECRET} is not a set of keys this launcher reads: making a new one`);
      keys = null;
    }
  }
  if (!keys) {
    keys = mintStackKeys();
    await store.put(STACK_KEYS_SECRET, JSON.stringify(keys));
    log.info(`made ${STACK_KEYS_SECRET} and gave it to the host to keep`);
  }

  let apiKeysKey = await readOrNull(store, API_KEYS_KEY_SECRET, log);
  if (!apiKeysKey) {
    apiKeysKey = randomBytes(32).toString("hex");
    await store.put(API_KEYS_KEY_SECRET, apiKeysKey);
    log.info(`made ${API_KEYS_KEY_SECRET} and gave it to the host to keep`);
  }
  return {
    jwtSecret: keys.jwt_secret,
    anonKey: keys.anon_key,
    serviceRoleKey: keys.service_role_key,
    downloadSigningSecret: keys.download_signing_secret,
    userApiKeysEncryptionSecret: apiKeysKey,
  };
}
