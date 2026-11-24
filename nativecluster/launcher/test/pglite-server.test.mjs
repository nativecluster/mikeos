// pglite-server.mjs run as the stack runs it (PGLITE_NODE_FLAGS, pgliteEnv):
// Postgres's small buffers and its memory logged; SessionQueue's one
// session given whole to a connection's transaction block and to each query
// cycle, and a departed connection's statements deallocated; the database
// closed cleanly when stdin ends, and kept for the next start.
//
// It needs the launcher's own modules (PGlite, pglite-socket, pg): run
// `npm ci` in nativecluster/launcher. Without them it skips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgliteEnv, PGLITE_NODE_FLAGS } from "../lib/stack.mjs";

const launcherDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireLauncher = createRequire(path.join(launcherDir, "package.json"));
let pg = null;
try {
  requireLauncher.resolve("@electric-sql/pglite");
  requireLauncher.resolve("@electric-sql/pglite-socket");
  pg = requireLauncher("pg");
} catch {}
const skip = pg ? false : "nativecluster/launcher has no node_modules (npm ci there)";

const started = [];
function startServer(dataDir, socketPath) {
  const proc = spawn(process.execPath, [...PGLITE_NODE_FLAGS, path.join(launcherDir, "pglite-server.mjs"), dataDir, socketPath], {
    cwd: launcherDir,
    env: pgliteEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(proc);
  let out = "";
  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line in 120 s:\n${out}`)), 120000);
    proc.stdout.on("data", (d) => {
      out += d;
      const m = /ready (fresh|existing)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.stderr.on("data", (d) => (out += d));
    exited.then((code) => reject(new Error(`exited ${code} before ready:\n${out}`)));
  });
  return { proc, ready, exited, output: () => out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("pglite-server: small buffers, its memory logged, one session shared whole, a clean close, the data kept", { skip, timeout: 300000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pgl-"));
  const dataDir = path.join(dir, "db");
  const socketPath = path.join(dir, ".s.PGSQL.5432");
  // A query left unanswered fails the test in 30 s rather than hanging it.
  const client = () => new pg.Client({ host: dir, port: 5432, user: "postgres", database: "postgres", query_timeout: 30000, connectionTimeoutMillis: 30000 });
  try {
    let s = startServer(dataDir, socketPath);
    assert.equal(await s.ready, "fresh");
    assert.match(s.output(), /memory: rss \d+ MB, WebAssembly \d+ MB, JS heap \d+ of \d+ MB; shared_buffers 16MB, maintenance_work_mem 16MB/);

    const a = client();
    const b = client();
    await a.connect();
    await b.connect();
    assert.equal((await a.query("show shared_buffers")).rows[0].shared_buffers, "16MB");
    assert.equal((await a.query("show maintenance_work_mem")).rows[0].maintenance_work_mem, "16MB");
    assert.equal((await a.query("show wal_buffers")).rows[0].wal_buffers, "512kB");

    // a holds the one session for its whole transaction block: b's query
    // runs only after a's commit, so it sees the rows a committed.
    await a.query("create table kept (id int primary key, body text)");
    await a.query("begin");
    await a.query("insert into kept select i, repeat('x', 100) from generate_series(1, 500) i");
    const order = [];
    const read = b.query("select count(*)::int as n from kept").then((r) => {
      order.push("b read");
      return r.rows[0].n;
    });
    await sleep(300);
    await a.query("insert into kept values (501, 'last')");
    await a.query("commit");
    order.push("a committed");
    assert.equal(await read, 501);
    assert.deepEqual(order, ["a committed", "b read"]);

    // Several connections' extended-protocol cycles at once (Parse, Bind,
    // Execute, Sync on the one unnamed statement): each runs whole, so each
    // gets its own answer (pglite-socket's own queue interleaved them).
    const many = await Promise.all(Array.from({ length: 8 }, async () => {
      const c = client();
      await c.connect();
      return c;
    }));
    const answers = await Promise.all(many.flatMap((c, i) => Array.from({ length: 25 }, async (_, j) => {
      const id = 1 + ((i * 25 + j) % 500);
      const r = await c.query("select id, length(body) as n from kept where id = $1", [id]);
      return r.rows[0]?.id === id && r.rows[0]?.n === 100;
    })));
    assert.equal(answers.filter(Boolean).length, 200);

    // A departed connection's named statements are deallocated: the next
    // connection may prepare the same name (PGlite ignores Terminate).
    await many[0].query({ name: "by_id", text: "select id from kept where id = $1", values: [7] });
    await Promise.all(many.map((c) => c.end()));
    await sleep(200);
    assert.equal((await a.query({ name: "by_id", text: "select id from kept where id = $1", values: [9] })).rows[0].id, 9);
    await a.end();
    await b.end();

    s.proc.stdin.end();
    assert.equal(await s.exited, 0, s.output());
    assert.match(s.output(), /the launcher closed its pipe: closing[\s\S]*closed/);
    assert.equal(existsSync(socketPath), false, "the socket is gone");

    s = startServer(dataDir, socketPath);
    assert.equal(await s.ready, "existing");
    const c = client();
    await c.connect();
    assert.equal((await c.query("select count(*)::int as n from kept")).rows[0].n, 501);
    await c.end();
    s.proc.stdin.end();
    assert.equal(await s.exited, 0, s.output());
  } finally {
    // A server left running by a failure would keep this test's process up.
    for (const proc of started) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
