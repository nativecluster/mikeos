// PGlite (Postgres compiled to WebAssembly) served on a unix socket, as
// Mike's database inside NativeCluster's sandbox, where real Postgres cannot
// run (SysV shared memory is denied).
//
//   runtime/bin/node launcher/pglite-server.mjs <data dir> <socket path>
//
// The launcher runs it as a child process, so a long statement (PGlite runs
// in this thread) never stalls the launcher's pages. It leaves when its
// stdin ends: the launcher keeps that pipe open for its life (an app cannot
// signal its own children in the sandbox), and closing it, or the launcher
// dying, closes the database cleanly here.
//
// PGlite is ONE Postgres session. pglite-socket lets several connections in
// and runs their wire-protocol messages through that session; its own queue
// fails most reads under several clients. SessionQueue (below, from
// desktop/src/local/pglite-server.mjs on nativecluster-pglite at b6ad4cd4,
// measured there under Mike's load with no error) gives the session to one
// connection for a whole query cycle or transaction block, keeps going after
// a failed message, and deallocates a departed connection's prepared
// statements. Every connection is the same superuser session whatever user
// it names: no per-connection settings, prepared statements shared by name,
// no statement_timeout or cancel (a long statement stalls every client).

import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

//
// It also deallocates, in a turn of their own, the named statements a
// connection prepared, once it leaves. PGlite ignores Terminate, so they
// outlived every connection (6,153 cached plans, about 98 MB, after a few
// minutes of the desktop stack's traffic).
const SYNC = new Uint8Array([0x53, 0, 0, 0, 4]);
const TERMINATE = 0x58;
const PARSE = 0x50;
const CLOSE = 0x43;

function cstring(bytes, offset) {
  const end = bytes.indexOf(0, offset);
  return Buffer.from(bytes.subarray(offset, end === -1 ? bytes.length : end)).toString("utf8");
}

function simpleQuery(sql) {
  const body = Buffer.from(`${sql}\0`, "utf8");
  const head = Buffer.alloc(5);
  head[0] = 0x51; // 'Q'
  head.writeInt32BE(4 + body.length, 1);
  return new Uint8Array(Buffer.concat([head, body]));
}
class SessionQueue {
  constructor(db) {
    this.db = db;
    this.queue = [];
    this.processing = false;
    this.owner = null; // the connection holding the session, between turns
    this.ownedSince = 0;
    this.longest = { ms: 0, handler: null };
    this.prepared = new Map(); // connection -> names of the statements it prepared
  }

  // Parse with a name prepares a statement; Close of a statement ('S') ends it.
  track(q) {
    const type = q.message[0];
    if (type === PARSE) {
      const name = cstring(q.message, 5);
      if (!name) return;
      if (!this.prepared.has(q.handlerId)) this.prepared.set(q.handlerId, new Set());
      this.prepared.get(q.handlerId).add(name);
    } else if (type === CLOSE && q.message[5] === 0x53) {
      this.prepared.get(q.handlerId)?.delete(cstring(q.message, 6));
    }
  }

  enqueue(handlerId, message, onData) {
    return new Promise((resolve, reject) => {
      this.queue.push({ handlerId, message, onData, resolve, reject });
      void this.run();
    });
  }

  getQueueLength() {
    return this.queue.length;
  }

  clearQueueForHandler(handlerId) {
    this.queue = this.queue.filter((q) => {
      if (q.handlerId !== handlerId) return true;
      q.reject(new Error("Handler disconnected"));
      return false;
    });
    // Its statements go too, each in a turn of its own (a negative id is
    // nobody's connection): an error, say one already deallocated, ends only
    // that turn.
    const names = this.prepared.get(handlerId);
    this.prepared.delete(handlerId);
    for (const name of names ?? []) {
      this.queue.push({
        handlerId: -handlerId,
        message: simpleQuery(`DEALLOCATE "${name.replace(/"/g, '""')}"`),
        onData: () => {},
        resolve: () => {},
        reject: () => {},
      });
    }
    if (names?.size) void this.run();
  }

  async clearTransactionIfNeeded(handlerId) {
    if (this.owner !== handlerId) return;
    try {
      await this.db.runExclusive(() => this.db.execProtocolRawStream(SYNC, { onRawData: () => {} }));
      if (this.db.isInTransaction()) await this.db.exec("ROLLBACK");
    } catch (err) {
      log(`ending a departed connection's turn: ${err?.message ?? err}`);
    }
    this.release();
    void this.run();
  }

  release() {
    if (this.owner !== null) {
      const ms = performance.now() - this.ownedSince;
      if (ms > this.longest.ms) this.longest = { ms, handler: this.owner };
    }
    this.owner = null;
  }

  async run() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const i = this.owner === null ? 0 : this.queue.findIndex((q) => q.handlerId === this.owner);
        if (i === -1) break; // the holder's next message has not arrived yet
        const q = this.queue.splice(i, 1)[0];
        if (this.owner === null) {
          this.owner = q.handlerId;
          this.ownedSince = performance.now();
        }
        let bytes = 0;
        let tail = new Uint8Array(0);
        try {
          await this.db.runExclusive(() =>
            this.db.execProtocolRawStream(q.message, {
              onRawData: (data) => {
                bytes += data.length;
                tail = data.length >= 6 ? data.subarray(data.length - 6) : Uint8Array.from([...tail, ...data].slice(-6));
                q.onData(data);
              },
            }),
          );
        } catch (err) {
          this.release();
          q.reject(err);
          continue;
        }
        // ReadyForQuery: 'Z', length 5, status. Idle ends the turn; in a
        // transaction block, or mid-cycle (no ReadyForQuery yet), it goes on.
        // Terminate is answered with nothing and ends nothing.
        if (q.handlerId > 0) this.track(q);
        const ready = tail.length === 6 && tail[0] === 0x5a && tail[4] === 5;
        if (q.message[0] === TERMINATE || (ready && tail[5] === 0x49)) this.release();
        q.resolve(bytes);
      }
    } finally {
      this.processing = false;
    }
  }
}

const [dataDir, socketPath] = process.argv.slice(2);
if (!dataDir || !socketPath) {
  console.error("usage: pglite-server.mjs <data dir> <socket path>");
  process.exit(2);
}
function log(msg) {
  process.stdout.write(`${new Date().toISOString()} [pglite] ${msg}\n`);
}

let db = null;
let server = null;
let stopping = false;
async function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`${why}: closing`);
  try {
    if (server) await server.stop();
    if (db) await db.close();
    log("closed");
  } catch (err) {
    log(`close failed: ${err?.stack ?? err}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {}
    process.exit();
  }
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
// The launcher's pipe: its end is the launcher gone, or the launcher asking.
process.stdin.on("end", () => void stop("the launcher closed its pipe"));
process.stdin.on("error", () => void stop("the launcher's pipe failed"));
process.stdin.resume();

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const t0 = performance.now();
const fresh = !fs.existsSync(`${dataDir}/PG_VERSION`);
db = await PGlite.create(dataDir, { extensions: { pgcrypto, pg_trgm } });
log(`opened the database (${fresh ? "created" : "existing"}) in ${Math.round(performance.now() - t0)} ms`);

fs.rmSync(socketPath, { force: true });
server = new PGLiteSocketServer({ db, path: socketPath, maxConnections: 64 });
const queue = new SessionQueue(db);
// Each connection's handler takes the server's queue when it connects.
server.queryQueue = queue;
server.addEventListener("error", (e) => log(`socket error: ${e.detail?.message ?? e.detail}`));
setInterval(() => {
  if (queue.longest.ms < 250) return;
  log(`longest hold ${Math.round(queue.longest.ms)} ms (connection #${queue.longest.handler}); ${server.getStats().activeConnections} connections`);
  queue.longest = { ms: 0, handler: null };
}, 60_000).unref();
const old = process.umask(0o177);
try {
  await server.start();
} finally {
  process.umask(old);
}
fs.chmodSync(socketPath, 0o600);
// The launcher waits for this line.
log(`ready ${fresh ? "fresh" : "existing"}`);
