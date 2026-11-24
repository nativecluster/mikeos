// lib/ticket.mjs against every case of NativeCluster's ticket vectors
// (ticket-vectors.json is `ncdev spec vectors` of NativeCluster 0.4.23; its
// key is the vectors' own test key). A valid case gives exactly the ticket
// the vectors name, absent fields empty; an invalid one gives none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketCheck } from "../lib/ticket.mjs";

const vectors = JSON.parse(readFileSync(new URL("./ticket-vectors.json", import.meta.url), "utf8"));
const verify = ticketCheck(vectors.key);
const empty = { id: "", remote: "", tls: false, sni: "", iat: 0, host: false, person: "", email: "", name: "", session: "", label: "", mcp: false };

for (const c of vectors.cases) {
  test(`ticket vector: ${c.name}`, () => {
    const got = verify(c.header, vectors.now_ms);
    if (!c.valid) {
      assert.equal(got, null);
      return;
    }
    assert.notEqual(got, null);
    assert.deepEqual(got, { ...empty, ...c.ticket });
  });
}

test("a key that is not 32 bytes of hex is refused at start", () => {
  assert.throws(() => ticketCheck("abc"));
});
