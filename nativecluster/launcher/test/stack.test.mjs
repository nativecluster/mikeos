// The backend's environment, as the brief's last section names it, and
// nothing of the launcher's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backendEnv, backendLaunchLine, pgliteEnv, PGLITE_NODE_FLAGS, postgrestConfig, stackPaths } from "../lib/stack.mjs";

const secrets = { anonKey: "anon.jwt", serviceRoleKey: "service.jwt", downloadSigningSecret: "d".repeat(64), userApiKeysEncryptionSecret: "u".repeat(64), jwtSecret: "j".repeat(96) };

function env(extra = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { LB_APP_SOCKET: "/x/app.sock", LB_SECRETS_STDIN: "1", NC_APP_BASE: "/" }, extra);
  try {
    const paths = stackPaths("/pkg", "/data", "/socks");
    return backendEnv({ paths, dataDir: "/data", socketsDir: "/socks", hostSocket: "/host.sock", logDir: "/data/logs", version: "2.1.0-nc.1" });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("the backend runs on its socket, in app mode, its secret on stdin", () => {
  const e = env();
  assert.equal(e.PORT, "/socks/api.sock");
  assert.equal(e.HOST, undefined);
  assert.equal(e.MIKE_INTERNAL_SECRET_STDIN, "1");
  assert.equal(e.MIKE_NC_APP, "1");
  assert.equal(e.NODE_ENV, "production");
  assert.equal(e.MIKE_REST_SOCKET, "/socks/rest.sock");
  assert.equal(e.MIKE_AUTH_SOCKET, undefined, "GoTrue runs no service");
  assert.equal(e.SUPABASE_URL, "http://mike.internal");
  assert.equal(e.NATIVECLUSTER_TRANSPORT, "host");
  assert.equal(e.MIKE_INFERENCE_PROVIDER, "nativecluster");
  assert.equal(e.LB_HOST_SOCKET, "/host.sock");
  assert.equal(e.SENTRY_DISABLED, "true");
  assert.equal(e.STORAGE_DRIVER, "fs");
  assert.equal(e.STORAGE_FS_ROOT, "/data/storage");
  assert.equal(e.MIKE_LOG_DIR, "/data/logs");
});

test("storage links are the API's path on the app's own origin", () => {
  assert.equal(env().BACKEND_PUBLIC_URL, "/api");
});

test("no public URL, and nothing of the host's to the app or of the launcher's secrets", () => {
  const e = env({ LB_MIKE_WEBSEARCH: "0" });
  assert.equal(e.FRONTEND_URL, undefined);
  assert.equal(e.API_PUBLIC_URL, undefined);
  for (const name of ["LB_APP_SOCKET", "LB_SECRETS_STDIN", "NC_APP_BASE"]) assert.equal(e[name], undefined, name);
  assert.equal(e.LB_MIKE_WEBSEARCH, "0", "an off switch passes on");
  const text = JSON.stringify(e);
  assert.ok(!text.includes("j".repeat(96)), "never the JWT secret");
});

// Review M3: the stack's keys were in the backend's environment (and the
// JWT secret in PostgREST's and gotrue migrate's), which any program of the
// same macOS user reads (sysctl KERN_PROCARGS2, `ps -E`).
test("no stack key is in the backend's environment: they are on its stdin line", () => {
  const e = env();
  const text = JSON.stringify(e);
  for (const [name, value] of Object.entries(secrets)) assert.ok(!text.includes(value), `${name} is not in the environment`);
  for (const name of ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SECRET_KEY", "DOWNLOAD_SIGNING_SECRET", "USER_API_KEYS_ENCRYPTION_SECRET"])
    assert.equal(e[name], undefined, name);
  assert.deepEqual(backendLaunchLine({ credential: "cred", internalSecret: "i".repeat(64), secrets }), {
    app_credential: "cred",
    internal_secret: "i".repeat(64),
    supabase_publishable_key: "anon.jwt",
    supabase_secret_key: "service.jwt",
    download_signing_secret: "d".repeat(64),
    user_api_keys_encryption_secret: "u".repeat(64),
  });
});

test("PostgREST's JWT secret is a config file's one line, on a pipe", () => {
  const jwt = "a1".repeat(48);
  assert.equal(postgrestConfig(jwt), `jwt-secret = "${jwt}"\n`);
  // Only what the launcher makes: hex, so the line needs no quoting.
  assert.throws(() => postgrestConfig('x" \ndb-uri = "postgres://elsewhere'));
  assert.throws(() => postgrestConfig("ab"));
});

test("PGlite's child: a small young generation, the allocator's large cache off, nothing of the launcher's", () => {
  assert.deepEqual(PGLITE_NODE_FLAGS, ["--max-semi-space-size=2"]);
  const saved = { ...process.env };
  Object.assign(process.env, { LB_APP_SOCKET: "/x/app.sock", LB_SECRETS_STDIN: "1", NODE_OPTIONS: "--inspect" });
  try {
    const e = pgliteEnv();
    assert.equal(e.MallocLargeCache, "0");
    assert.equal(e.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    for (const name of ["LB_APP_SOCKET", "LB_SECRETS_STDIN", "NODE_OPTIONS"]) assert.equal(e[name], undefined, name);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
