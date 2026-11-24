// A Node preload (NODE_OPTIONS=--import) the contract test for "writes
// nothing outside NC_APP_DATA" adds to the app's environment, for that test
// alone. macOS's kernel writes a log line for each refusal of a sandbox
// profile, but none for a Node process (measured 2026-11-24 on macOS 27.2:
// sh, touch, Python and Postgres are reported, node never, whatever its
// binary's name), so for Node the harness records the attempts itself.
//
// It records every call that would write, create, move or remove a file
// outside the folders the app may write (read from fswatch.json beside it,
// which the fake host writes), whether the call succeeds or not, and changes
// nothing of what the call does. Each line of fswatch.log (beside it): the
// time, the pid, the call, the path, and the first frame outside node's own.

import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let allowed = [];
try {
  allowed = JSON.parse(fs.readFileSync(path.join(here, "fswatch.json"), "utf8")).allowed ?? [];
} catch {}
const LOG = path.join(here, "fswatch.log");
const append = fs.appendFileSync;
const norm = (p) => {
  if (typeof p !== "string") {
    if (p instanceof URL) p = fileURLToPath(p);
    else if (Buffer.isBuffer(p)) p = p.toString("utf8");
    else return null;
  }
  p = path.resolve(p);
  if (p.startsWith("/tmp/") || p === "/tmp" || p.startsWith("/var/")) p = "/private" + p;
  return p;
};
const inside = (p) => allowed.some((root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/"));

function caller() {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  return (lines.find((l) => !/node:|fswatch\.mjs|<anonymous>/.test(l)) ?? "").trim().replace(/^at /, "").slice(0, 300);
}

function note(call, target) {
  const p = norm(target);
  if (p === null || inside(p) || p === LOG) return;
  try {
    append(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, call, path: p, from: caller() }) + "\n");
  } catch {}
}

const WRITE_FLAGS = /[wa+]/;
const writes = (flags) => (typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : typeof flags === "string" && WRITE_FLAGS.test(flags));

function wrap(obj, name, which) {
  const orig = obj?.[name];
  if (typeof orig !== "function") return;
  obj[name] = function (...args) {
    try {
      which(args).forEach(([call, p]) => note(call, p));
    } catch {}
    return orig.apply(this, args);
  };
  Object.defineProperties(obj[name], Object.getOwnPropertyDescriptors(orig));
}

const first = (n) => (a) => [[n, a[0]]];
const both = (n) => (a) => [[n, a[1]]];
const open = (n) => (a) => (writes(a[1]) ? [[n, a[0]]] : []);
const stream = (n) => (a) => [[n, a[0]]];

for (const [obj, sfx] of [[fs, ""], [fs, "Sync"], [fs.promises, ""]]) {
  if (obj === fs.promises && sfx) continue;
  for (const n of ["writeFile", "appendFile", "mkdir", "mkdtemp", "rmdir", "rm", "unlink", "truncate", "utimes", "chmod", "chown", "lchown", "lutimes"]) wrap(obj, n + sfx, first(n));
  for (const n of ["rename", "copyFile", "link", "cp"]) wrap(obj, n + sfx, both(n));
  wrap(obj, "symlink" + sfx, both("symlink"));
  wrap(obj, "open" + sfx, open("open"));
}
wrap(fs, "createWriteStream", stream("createWriteStream"));
syncBuiltinESMExports();
