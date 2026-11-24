// What the host hands a NativeCluster app at start (`ncdev spec hostapi`,
// "Starting an app"): the environment, and its secrets on stdin; and how
// it serves: HTTP on the unix socket LB_APP_SOCKET (0600), never a TCP port.

import { chmodSync, unlinkSync, mkdirSync } from "node:fs";

const MAX_SECRETS = 64 * 1024;

// readSecrets reads one JSON object from stdin. It needs no end of file
// (the host may keep the pipe open) and never echoes what it read.
export function readSecrets(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err, value) => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onEnd);
      stream.pause();
      if (typeof stream.unref === "function") stream.unref();
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_SECRETS) return done(new Error("the secrets on stdin are too long"));
      let obj;
      try {
        obj = JSON.parse(buf);
      } catch {
        return; // not whole yet
      }
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return done(new Error("the secrets on stdin are not a JSON object"));
      done(null, obj);
    };
    const onEnd = () => done(new Error(buf.trim() ? "the secrets on stdin are not a JSON object" : "the parent sent no secrets on stdin"));
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onEnd);
    stream.resume();
  });
}

// launch reads the environment and the secrets: the socket to serve on,
// the host's socket, the data folder, and the two secrets (memory only).
export async function launch() {
  const env = process.env;
  if (!env.LB_APP_SOCKET) throw new Error("not started by NativeCluster's host (no LB_APP_SOCKET)");
  const secrets = env.LB_SECRETS_STDIN === "1" ? await readSecrets() : {};
  const ticketKey = String(secrets.ticket_key ?? "").trim();
  if (!ticketKey) throw new Error("the host sent no ticket key");
  const dataDir = env.NC_APP_DATA ?? "";
  if (!dataDir) throw new Error("the host gave no data folder (NC_APP_DATA)");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!env.NC_APP_SOCKETS) throw new Error("the host gave no sockets folder (NC_APP_SOCKETS; NativeCluster 0.3.5 or later)");
  return {
    appSocket: env.LB_APP_SOCKET,
    hostSocket: env.LB_HOST_SOCKET ?? "",
    dataDir,
    base: (env.NC_APP_BASE ?? "/").replace(/\/+$/, ""),
    socketsDir: env.NC_APP_SOCKETS ?? "",
    credential: String(secrets.app_credential ?? "").trim(),
    ticketKey,
    woken: secrets.woken === true,
  };
}

// listenOnSocket serves an http.Server on a unix socket path, removing a
// stale file first and leaving the socket 0600.
export function listenOnSocket(server, path) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const old = process.umask(0o177);
  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      process.umask(old);
      reject(e);
    });
    server.listen(path, () => {
      process.umask(old);
      chmodSync(path, 0o600);
      resolve();
    });
  });
}

// exitWithParent ends the process once the host that started it is gone
// (LB_EXIT_WITH_PARENT=1): the process is then reparented.
export function exitWithParent(onGone) {
  if (process.env.LB_EXIT_WITH_PARENT !== "1") return;
  const ppid = process.ppid;
  setInterval(() => {
    if (process.ppid !== ppid) onGone();
  }, 1000).unref();
}
