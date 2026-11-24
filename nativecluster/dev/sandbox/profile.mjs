// NativeCluster's app sandbox, as its host builds it, for running an app
// package confined without installing it.
//
// Provenance. The profile text below is NativeCluster's own, copied
// verbatim from host/host/sandbox.go on NativeCluster's origin/main
// (0eb7aa2a, 2026-11-24; the file last changed in 8db0957c, 2026-11-17):
// the constants appProfile, appProfileNet's text and appProfileTerminal, and
// egress.OwnPorts from host/egress/egress.go. `node check-installed.mjs`
// (beside this file) checks that each piece is still byte for byte in the
// installed host binary (/Applications/NativeCluster.app/Contents/Resources/
// nativecluster, 0.4.23 when this was written), so a later NativeCluster
// that changes its sandbox shows up as a failed check rather than a quiet
// difference.
//
// How the host uses it (sandbox.go, Sandbox.command and sandboxEnv; app.go,
// startLocked), which sandboxCommand below follows:
//   - the profile goes to /usr/bin/sandbox-exec with -p, every path as a
//     parameter (-D PKG=, DATA=, HOST_SOCKET=, APP_SOCKET=, SOCKS=), never
//     spliced into the text;
//   - each path has its links resolved first (realPath: /tmp is /private/tmp,
//     /var is /private/var), a socket not made yet by its folder;
//   - a running app gets the network part (Sandbox.Net is true for every
//     running app), with GATE_PORT only for an app that declares a net.*
//     permission (its egress gate; the fake host runs no gate, so a gated
//     app gets the profile without the gate's port: see the README);
//   - SOCKS is NC_APP_SOCKETS, or <data>/.no-sockets when there is none;
//   - HOME is the data folder and TMPDIR <data>/.tmp/ (made 0700);
//   - `<program> manifest` before install runs with Net off, HOST_SOCKET
//     <data>/.no-host and APP_SOCKET <data>/.no-app, in a data folder of
//     its own made for that one run (manifestSandbox, pkg.go's check).

import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const PROVENANCE = {
  repo: "NativeCluster (github.com/pablothe/nativecluster)",
  file: "host/host/sandbox.go",
  ref: "origin/main 0eb7aa2a7a0c39b2b7de4612a69bad6d207bc10a (2026-11-24)",
  file_last_changed: "8db0957cf8429fd8836f1e8e6d0b5e6edf1ff57e (2026-11-17)",
  own_ports_from: "host/egress/egress.go, OwnPorts",
  checked_against: "the installed host binary, NativeCluster 0.4.23 (check-installed.mjs)",
};

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// --- verbatim from host/host/sandbox.go ---

export const APP_PROFILE = `(version 1)
(deny default)
(import "bsd.sb")
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow process-exec
  (subpath (param "PKG"))
  (subpath "/bin") (subpath "/usr/bin") (subpath "/sbin") (subpath "/usr/sbin"))
(allow file-read* (subpath (param "PKG")))
(allow file-read* (subpath "/private/etc/ssl"))
(allow file-read* file-write* (subpath (param "DATA")))
(allow file-read* file-write-data
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))
(allow file-read* file-write* (subpath (param "SOCKS")))
(allow network-outbound (remote unix-socket (path-literal (param "HOST_SOCKET"))))
(allow network-bind network-inbound (local unix-socket (path-literal (param "APP_SOCKET"))))
(allow file-write* (literal (param "APP_SOCKET")))
(allow network-bind network-inbound
  (local unix-socket (subpath (param "DATA")))
  (local unix-socket (subpath (param "SOCKS"))))
(allow network-outbound
  (remote unix-socket (subpath (param "DATA")))
  (remote unix-socket (subpath (param "SOCKS")))
  (remote unix-socket (path-literal (param "APP_SOCKET"))))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
`;

export const PROFILE_NET_HEAD = `(allow network-outbound (remote ip "*:*"))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service"))
(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))
(deny network-outbound (remote ip "localhost:*"))
`;

export const PROFILE_NET_GATE = `(allow network-outbound (remote tcp (string-append "localhost:" (param "GATE_PORT"))))
`;

export const PROFILE_TERMINAL = `(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* file-ioctl
  (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))
(allow file-ioctl (literal "/dev/tty"))
`;

/** NativeCluster's frozen ports (host/egress/egress.go, OwnPorts). */
export const OWN_PORTS = [8484, 8485, 8486, 8487, 8490, 8491, 8492, 8493, 8494, 8495, 8496, 8497, 8498, 8499];

// --- the host's assembly of it ---

/** appProfileNet(gate), as sandbox.go builds it. */
export function profileNet(gate = false) {
  let s = PROFILE_NET_HEAD;
  if (gate) s += PROFILE_NET_GATE;
  s += "(deny network-outbound" + OWN_PORTS.map((p) => ` (remote ip "*:${p}")`).join("") + ")\n";
  return s;
}

/** Sandbox.profile(): the base, the network for a running app, a terminal when let in. */
export function buildProfile({ net = true, gate = false, terminal = false } = {}) {
  let p = APP_PROFILE;
  if (net) p += profileNet(gate);
  if (terminal) p += PROFILE_TERMINAL;
  return p;
}

/** sandbox.go's realPath: links resolved; a socket not made yet by its folder. */
export function realPath(p) {
  p = path.resolve(p);
  try {
    return realpathSync(p);
  } catch {
    return path.join(realpathSync(path.dirname(p)), path.basename(p));
  }
}

/**
 * The confined command for `program args...`, as Sandbox.command makes it:
 * [file, argv]. paths: {pkg, data, hostSocket, appSocket, sockets}.
 */
export function sandboxCommand({ pkg, data, hostSocket, appSocket, sockets, net = true, gatePort = 0, terminal = false }, program, args = []) {
  const socks = sockets || path.join(data, ".no-sockets");
  const params = { PKG: pkg, DATA: data, HOST_SOCKET: hostSocket, APP_SOCKET: appSocket, SOCKS: socks };
  const argv = ["-p", buildProfile({ net, gate: net && gatePort > 0, terminal })];
  for (const k of ["PKG", "DATA", "HOST_SOCKET", "APP_SOCKET", "SOCKS"]) {
    let real;
    try {
      real = realPath(params[k]);
    } catch (e) {
      throw new Error(`the sandbox's ${k.toLowerCase()} (${params[k]}): ${e.message}`);
    }
    argv.push("-D", `${k}=${real}`);
  }
  if (net && gatePort > 0) argv.push("-D", `GATE_PORT=${gatePort}`);
  argv.push(program, ...args);
  return [SANDBOX_EXEC, argv];
}

/** sandboxEnv: HOME and TMPDIR inside the data folder (TMPDIR made, 0700). */
export function sandboxEnv(data) {
  const tmp = path.join(data, ".tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { HOME: data, TMPDIR: tmp + "/" };
}

/** The sandbox `<program> manifest` runs in before install (manifestSandbox). */
export function manifestSandbox(pkg, data) {
  return { pkg, data, hostSocket: path.join(data, ".no-host"), appSocket: path.join(data, ".no-app"), sockets: "", net: false };
}

/**
 * The profile with its parameters written in, for reading (or for
 * `sandbox-exec -f`): what the app runs under, with this run's paths. The
 * runner itself passes them as parameters, exactly as the host does.
 */
export function renderProfile(opts) {
  const [, argv] = sandboxCommand(opts, "/bin/true");
  let text = argv[1];
  for (let i = 2; i < argv.length - 1; i += 2) {
    if (argv[i] !== "-D") break;
    const [k, ...rest] = argv[i + 1].split("=");
    const v = rest.join("=");
    text = text.replaceAll(`(param "${k}")`, JSON.stringify(v));
  }
  return `; NativeCluster's app sandbox profile, its parameters written in.\n; From ${PROVENANCE.file} at ${PROVENANCE.ref}.\n${text}`;
}
