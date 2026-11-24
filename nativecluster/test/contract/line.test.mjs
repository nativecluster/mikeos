// Every wait in line the app makes gets exactly one release, and every model
// call it makes carries a live grant. The app's hook drives its model calls
// (contract/apps/<id>.mjs, `drive`); an app with none to drive here holds
// this vacuously, and its end-to-end tests drive them instead (the e2e
// chat and tabular specs check the same ledger).

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, started, hooks } from "./harness.mjs";

describe("the waiting line", () => {
  let host;
  let app;
  before(async () => {
    app = await hooks();
    host = await startApp("line");
    await app.ready(host);
  });
  after(() => host?.close());

  test("every line wait has exactly one release", async (t) => {
    t.diagnostic(started(host));
    if (app.drive) await app.drive(host, t);
    else t.diagnostic(`${app.name}: no model calls to drive here (the e2e specs drive them)`);
    await host.stop();
    const problems = host.ledger.problems({ final: true });
    t.diagnostic(`the ledger: ${JSON.stringify(host.ledger.summary())}`);
    assert.deepEqual(problems, []);
  });
});
