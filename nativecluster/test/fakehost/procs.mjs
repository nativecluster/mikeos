// What the harness reads of the app's processes, with the system's own
// tools: ps for the process tree, lsof for listening sockets, and the
// unified log for the sandbox's refusals (`Sandbox: <name>(<pid>) deny(1)
// <operation> <path>`, which macOS's kernel writes for every refusal of a
// sandbox-exec profile).

import { execFile } from "node:child_process";

function run(file, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Every process: [{pid, ppid, pgid, comm}]. */
export async function processTable() {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="]);
  const out = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], comm: m[4].trim() });
  }
  return out;
}

/** The processes of a group, and every descendant of root by parent. */
export async function treeOf(root, pgid = root) {
  const table = await processTable();
  const byParent = new Map();
  for (const p of table) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const seen = new Map();
  const walk = (pid) => {
    for (const c of byParent.get(pid) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.set(c.pid, c);
      walk(c.pid);
    }
  };
  const self = table.find((p) => p.pid === root);
  if (self) seen.set(root, self);
  walk(root);
  for (const p of table) if (p.pgid === pgid && pgid > 1) seen.set(p.pid, p);
  return [...seen.values()];
}

/** Which of pids are still alive: [{pid, comm, ...}]. */
export async function alive(procs) {
  const table = await processTable();
  const now = new Map(table.map((p) => [p.pid, p]));
  // A pid reused by another program is not ours: same name required.
  return procs.filter((p) => now.has(p.pid) && now.get(p.pid).comm === p.comm);
}

/** Network sockets the processes hold: TCP listening, and UDP bound. */
export async function networkSockets(pids) {
  if (!pids.length) return { tcpListen: [], udp: [], tcp: [] };
  const list = pids.join(",");
  const parse = (stdout) => {
    const rows = [];
    let cur = {};
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const k = line[0];
      const v = line.slice(1);
      if (k === "p") cur = { pid: +v };
      else if (k === "c") cur.comm = v;
      else if (k === "n") rows.push({ ...cur, name: v });
    }
    return rows;
  };
  const [listen, udp, tcp] = await Promise.all([
    run("/usr/sbin/lsof", ["-nP", "-a", "-p", list, "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]),
    run("/usr/sbin/lsof", ["-nP", "-a", "-p", list, "-iUDP", "-F", "pcn"]),
    run("/usr/sbin/lsof", ["-nP", "-a", "-p", list, "-iTCP", "-F", "pcn"]),
  ]);
  return { tcpListen: parse(listen.stdout), udp: parse(udp.stdout), tcp: parse(tcp.stdout) };
}

/**
 * The sandbox's refusals since `since` (a Date), from the unified log:
 * [{at, comm, pid, op, target, line}]. The log takes a moment to hold a
 * refusal, so callers wait a second or two after the work first.
 */
export async function sandboxDenials(since) {
  const start = new Date(since.getTime() - 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}`;
  const { stdout, code, stderr } = await run("/usr/bin/log", ["show", "--start", stamp, "--style", "compact", "--predicate", 'sender == "Sandbox"'], { timeout: 120000 });
  if (code !== 0 && !stdout) throw new Error(`log show failed: ${stderr.trim()}`);
  const out = [];
  for (const line of stdout.split("\n")) {
    const m = /Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/.exec(line);
    if (m) out.push({ at: line.slice(0, 23), comm: m[1], pid: +m[2], op: m[3], target: (m[4] ?? "").trim(), line: line.trim() });
  }
  return out;
}
