// The app's processes: nothing listens on TCP, a restart keeps its data, and
// SIGTERM leaves no process behind (the host's stop: SIGTERM, a grace, then
// its process group ended; an app's children end with it by themselves, as
// the sandbox lets a process signal only itself).

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { startApp, started, hooks, snapshot } from "./harness.mjs";
import { networkSockets, treeOf } from "../fakehost/procs.mjs";

describe("processes", () => {
  let host;
  let app;
  before(async () => {
    app = await hooks();
    host = await startApp("process");
    await app.ready(host);
    await host.sample();
  });
  after(() => host?.close());

  test("nothing listens on TCP, loopback included", async (t) => {
    t.diagnostic(started(host));
    const procs = await treeOf(host.proc.pid);
    t.diagnostic(`its processes: ${procs.map((p) => `${path.basename(p.comm)}(${p.pid})`).join(", ")}`);
    const s = await networkSockets(procs.map((p) => p.pid));
    if (s.udp.length) t.diagnostic(`UDP sockets (not listeners): ${s.udp.map((x) => `${x.comm} ${x.name}`).join("; ")}`);
    if (s.tcp.length) t.diagnostic(`TCP connections: ${s.tcp.map((x) => `${x.comm} ${x.name}`).join("; ")}`);
    assert.deepEqual(s.tcpListen.map((x) => `${x.comm}(${x.pid}) listens on ${x.name}`), []);
  });

  test("its own sockets stay short enough for a unix socket's path", () => {
    const long = [];
    for (const dir of [host.socketsDir, host.data]) {
      const walk = (d) => {
        let names = [];
        try {
          names = readdirSync(d, { withFileTypes: true });
        } catch {}
        for (const n of names) {
          const p = path.join(d, n.name);
          if (n.isSocket() && Buffer.byteLength(p) >= 104) long.push(p);
          else if (n.isDirectory() && !n.isSymbolicLink()) walk(p);
        }
      };
      walk(dir);
    }
    assert.deepEqual(long, []);
  });

  test("a restart keeps the data", async (t) => {
    const seeded = await app.seed(host);
    const before = snapshot(host.data);
    const stopped = await host.restart();
    t.diagnostic(`stopped in ${stopped.ms} ms (exit ${JSON.stringify(stopped.exit)}); ${started(host)}`);
    await app.ready(host);
    const now = snapshot(host.data);
    // A database rewrites its own files as it pleases: what must survive is
    // each thing at the top of NC_APP_DATA (its folders and files), and the
    // app's own record of its data (its hook, below).
    const top = (m) => new Set([...m.keys()].map((f) => f.split("/")[0]));
    const gone = [...top(before)].filter((f) => !top(now).has(f) && !/^(logs?|tmp|cache)$/i.test(f) && !/\.(pid|lock|sock)$/.test(f));
    assert.deepEqual(gone, [], "what the first run left at the top of NC_APP_DATA was gone after the restart");
    await app.kept(host, seeded);
  });

  test("SIGTERM leaves no process behind", async (t) => {
    await app.ready(host);
    const s = await host.stop();
    t.diagnostic(`exit ${JSON.stringify(s.exit)} after ${s.ms} ms`);
    assert.equal(s.killed, false, "it did not end within the host's grace after SIGTERM, and was killed");
    assert.deepEqual(s.leftAfterExit.map((p) => `${path.basename(p.comm)}(${p.pid})`), [], "processes it started were still running 3 s after it ended (the host would have had to end its group)");
    assert.deepEqual(s.escaped.map((p) => `${path.basename(p.comm)}(${p.pid})`), [], "processes it started survived even the host's ending its group");
    assert.equal(s.exit?.code, 0, `it exited ${JSON.stringify(s.exit)}, not 0`);
  });
});
