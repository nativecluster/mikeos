// `<program> manifest` prints nc-app.json, byte for byte: plainly, and in the
// sandbox the host runs it in at install (no network, no socket, a data
// folder for that one run; host/host/pkg.go's check, which compares the two
// compacted: this test holds the app to the bytes themselves).

import { describe, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { FakeHost } from "../fakehost/host.mjs";
import { PKG, MANIFEST, stateDir } from "./harness.mjs";

const NCDEV = "/Applications/NativeCluster.app/Contents/Resources/ncdev";

describe("manifest", () => {
  const host = new FakeHost({ pkg: PKG, state: stateDir("manifest"), log: () => {} });
  after(() => host.close());

  test("nc-app.json names a program in the package", () => {
    assert.match(MANIFEST.program ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assert.ok(existsSync(`${PKG}/${MANIFEST.program}`), `${MANIFEST.program} is not in the package`);
  });

  for (const sandbox of [false, true]) {
    test(`\`${MANIFEST.program} manifest\` prints nc-app.json byte for byte${sandbox ? ", in the install sandbox" : ""}`, async () => {
      const r = await host.manifestOutput({ sandbox });
      assert.equal(r.code, 0, `it exited ${r.code}: ${r.stderr.slice(0, 300)}`);
      assert.ok(r.stdout.equals(host.manifestRaw), `its output (${r.stdout.length} bytes) differs from nc-app.json (${host.manifestRaw.length} bytes)`);
    });
  }

  test("ncdev check holds the package to NativeCluster's contract", { skip: !existsSync(NCDEV) && "NativeCluster's ncdev is not installed" }, async (t) => {
    const r = await new Promise((resolve) =>
      execFile(NCDEV, ["check", PKG], { timeout: 600000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? -1) : 0, out: `${stdout}${stderr}` })),
    );
    for (const line of r.out.trim().split("\n").slice(-40)) t.diagnostic(line);
    assert.equal(r.code, 0, "ncdev check failed (its last lines are above)");
  });
});
