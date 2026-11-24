// Under NativeCluster's app sandbox (always, whatever HARNESS_SANDBOX says):
// the runner's profile is the installed host's, it confines a program as the
// host does, and the app writes nothing outside NC_APP_DATA. What the
// sandbox refused the app is read from the unified log (the kernel writes
// `Sandbox: <name>(<pid>) deny(1) <operation> <path>` for each refusal).

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, started, hooks, sleep } from "./harness.mjs";
import { sandboxDenials } from "../fakehost/procs.mjs";
import { sandboxCommand, sandboxEnv } from "../../dev/sandbox/profile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NC_BIN = "/Applications/NativeCluster.app/Contents/Resources/nativecluster";

/** Runs a shell script confined as an app is, in a package of its own. */
function confined(script) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "nc-control-")));
  const pkg = path.join(root, "pkg");
  const data = path.join(root, "data");
  mkdirSync(pkg);
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(path.join(pkg, "run"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(pkg, "run"), 0o755);
  const sockets = mkdtempSync("/tmp/nc-");
  const [file, argv] = sandboxCommand({ pkg, data, hostSocket: path.join(root, "host.sock"), appSocket: path.join(root, "app.sock"), sockets, net: true }, path.join(pkg, "run"));
  return new Promise((resolve) => {
    execFile(file, argv, { cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NC_APP_DATA: data, PKG: pkg, OUTSIDE: root, ...sandboxEnv(data) }, timeout: 20000 }, (err, stdout, stderr) => {
      rmSync(root, { recursive: true, force: true });
      rmSync(sockets, { recursive: true, force: true });
      resolve({ code: err ? (err.code ?? -1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

describe("sandbox", () => {
  test("the runner's profile is the installed NativeCluster host's", { skip: !existsSync(NC_BIN) && "NativeCluster is not installed" }, () => {
    const out = execFileSync(process.execPath, [path.join(here, "../../dev/sandbox/check-installed.mjs"), NC_BIN], { encoding: "utf8" });
    assert.match(out, /^same:/m, out);
  });

  test("a confined program writes in NC_APP_DATA and nowhere else", async () => {
    const r = await confined(`
try() { if ( : > "$1" ) 2>/dev/null; then echo "wrote $2"; else echo "refused $2"; fi; }
try "$NC_APP_DATA/inside" data
try "$TMPDIR/inside-tmp" tmpdir
try "$PKG/x" package
try "$OUTSIDE/x" beside-data
try "/tmp/nc-harness-control-$$" tmp
try "${os.homedir()}/nc-harness-control-$$" home
`);
    assert.equal(r.out.trim().split("\n").sort().join("\n"), ["refused beside-data", "refused home", "refused package", "refused tmp", "wrote data", "wrote tmpdir"].join("\n"), r.err);
  });

  test("a confined program reaches neither this Mac's TCP nor NativeCluster's ports", async () => {
    const r = await confined(`
for port in 8484 8487 22; do
  if /usr/bin/nc -z -G 2 127.0.0.1 $port 2>/dev/null; then echo "reached $port"; else echo "refused $port"; fi
done
if /usr/bin/nc -l 127.0.0.1 43999 </dev/null 2>/dev/null; then echo "listened"; else echo "refused listen"; fi
`);
    assert.equal(r.out.trim(), ["refused 8484", "refused 8487", "refused 22", "refused listen"].join("\n"), r.err);
  });

  describe("the app under the sandbox", () => {
    let host;
    let app;
    let t0;
    before(async () => {
      app = await hooks();
      t0 = new Date();
      host = await startApp("sandbox", { sandbox: true, watchWrites: true });
      await app.ready(host);
      await app.exercise?.(host);
      await host.sample();
    });
    after(() => host?.close());

    test("it runs confined, answering its routes", async (t) => {
      t.diagnostic(started(host));
      const r = await host.request("GET", "/.nc/whoami", { as: "alice" });
      assert.equal(r.status, 200);
    });

    test("it writes nothing outside NC_APP_DATA", async (t) => {
      const stop = await host.stop();
      t.diagnostic(`stopped: exit ${JSON.stringify(stop.exit)} after ${stop.ms} ms`);
      await sleep(2500); // the log takes a moment to hold a refusal
      const pids = new Set([...host.allSeen.keys()]);
      const all = await sandboxDenials(t0);
      // A refusal is the app's when its pid was seen in the app's tree, or
      // when it names the app's own package (no other process touches it).
      const ours = all.filter((d) => pids.has(d.pid) || d.target.startsWith(host.pkg));
      const expected = (op, target) => app.expectedDenials.some((re) => re.test(`${op} ${target}`));
      // Node's refusals reach no log (fswatch.mjs): its attempts, recorded.
      const nodeWrites = host.writesOutside();
      const grouped = new Map();
      for (const d of ours) grouped.set(`${d.comm} ${d.op} ${d.target}`, (grouped.get(`${d.comm} ${d.op} ${d.target}`) ?? 0) + 1);
      for (const w of nodeWrites) grouped.set(`node ${w.call} ${w.path} (from ${w.from})`, (grouped.get(`node ${w.call} ${w.path} (from ${w.from})`) ?? 0) + 1);
      for (const [k, n] of grouped) t.diagnostic(`refused or attempted: ${k}${n > 1 ? ` (x${n})` : ""}`);
      const bad = [
        ...ours.filter((d) => /^(file-write|network-bind|network-inbound)/.test(d.op) && !expected(d.op, d.target)).map((d) => `${d.comm} ${d.op} ${d.target}`),
        ...nodeWrites.filter((w) => !expected(`file-write-${w.call}`, w.path)).map((w) => `node ${w.call} ${w.path}`),
      ];
      assert.deepEqual([...new Set(bad)], []);
    });
  });
});
