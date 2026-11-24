// The stack's keys: made once and kept by the host, read back on every later
// start, made anew only when the host can no longer read them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadStackSecrets, STACK_KEYS_SECRET, API_KEYS_KEY_SECRET } from "../lib/stackSecrets.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function store() {
  const values = new Map();
  const unreadable = new Set();
  return {
    values,
    unreadable,
    puts: 0,
    async get(name) {
      if (unreadable.has(name)) throw Object.assign(new Error("unreadable"), { code: "unreadable" });
      return values.get(name) ?? null;
    },
    async put(name, value) {
      this.puts++;
      unreadable.delete(name);
      values.set(name, value);
    },
  };
}

test("the first start makes the keys and gives them to the host", async () => {
  const s = store();
  const k = await loadStackSecrets(s, quiet);
  assert.equal(s.puts, 2);
  assert.ok(s.values.has(STACK_KEYS_SECRET));
  assert.equal(s.values.get(API_KEYS_KEY_SECRET), k.userApiKeysEncryptionSecret);
  assert.match(k.userApiKeysEncryptionSecret, /^[0-9a-f]{64}$/);
  assert.match(k.downloadSigningSecret, /^[0-9a-f]{64}$/);
  // The role keys are HS256 JWTs signed with the JWT secret, for those roles.
  for (const [key, role] of [[k.anonKey, "anon"], [k.serviceRoleKey, "service_role"]]) {
    const [h, b, sig] = key.split(".");
    assert.equal(createHmac("sha256", k.jwtSecret).update(`${h}.${b}`).digest("base64url"), sig);
    const claims = JSON.parse(Buffer.from(b, "base64url").toString());
    assert.equal(claims.role, role);
    assert.notEqual(claims.iss, "supabase-demo");
  }
});

test("a later start reads the same keys and keeps nothing new", async () => {
  const s = store();
  const first = await loadStackSecrets(s, quiet);
  const puts = s.puts;
  const again = await loadStackSecrets(s, quiet);
  assert.deepEqual(again, first);
  assert.equal(s.puts, puts);
});

test("the API keys' key the backend's connectors made is the one used", async () => {
  const s = store();
  s.values.set(API_KEYS_KEY_SECRET, "c".repeat(64));
  const k = await loadStackSecrets(s, quiet);
  assert.equal(k.userApiKeysEncryptionSecret, "c".repeat(64));
});

test("keys the host can no longer read are made anew", async () => {
  const s = store();
  const first = await loadStackSecrets(s, quiet);
  s.unreadable.add(STACK_KEYS_SECRET);
  const again = await loadStackSecrets(s, quiet);
  assert.notEqual(again.jwtSecret, first.jwtSecret);
  assert.equal(again.userApiKeysEncryptionSecret, first.userApiKeysEncryptionSecret);
});

test("a host that does not answer stops the start", async () => {
  const s = store();
  s.get = async () => {
    throw Object.assign(new Error("unreachable"), { code: "unreachable" });
  };
  await assert.rejects(loadStackSecrets(s, quiet));
});
