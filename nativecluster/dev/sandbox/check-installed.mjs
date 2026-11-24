#!/usr/bin/env node
// Checks that the sandbox profile in profile.mjs is the one the installed
// NativeCluster host runs apps under: each piece of the profile's text must
// sit byte for byte in the host binary, where Go keeps its string constants.
//
//   node nativecluster/dev/sandbox/check-installed.mjs [path to the host binary]
//
// Exits 1 when a piece is missing (NativeCluster changed its sandbox: copy
// host/host/sandbox.go again and say where from in profile.mjs).

import { readFileSync } from "node:fs";
import { APP_PROFILE, PROFILE_NET_HEAD, PROFILE_NET_GATE, PROFILE_TERMINAL, OWN_PORTS, PROVENANCE } from "./profile.mjs";

const bin = process.argv[2] ?? "/Applications/NativeCluster.app/Contents/Resources/nativecluster";
let data;
try {
  data = readFileSync(bin);
} catch (e) {
  console.error(`cannot read ${bin}: ${e.message}`);
  process.exit(2);
}
let version = "";
try {
  version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(readFileSync(bin.replace(/\/Contents\/.*$/, "/Contents/Info.plist"), "utf8"))?.[1] ?? "";
} catch {}

const pieces = {
  appProfile: APP_PROFILE,
  "appProfileNet (head)": PROFILE_NET_HEAD,
  "appProfileNet (gate)": PROFILE_NET_GATE,
  appProfileTerminal: PROFILE_TERMINAL,
  "the deny of NativeCluster's ports": '(deny network-outbound',
  sandboxExec: "/usr/bin/sandbox-exec",
};
let missing = 0;
for (const [name, text] of Object.entries(pieces)) {
  const found = data.indexOf(Buffer.from(text)) >= 0;
  if (!found) missing++;
  console.log(`${found ? "ok  " : "MISS"} ${name} (${text.length} bytes)`);
}
// OwnPorts is a []int: its values are not a string in the binary. The
// ports are frozen machine names (NativeCluster's CLAUDE.md naming contract),
// so they are listed here for the record only.
console.log(`     own ports (frozen, not checkable as text): ${OWN_PORTS.join(", ")}`);
console.log(`${missing ? "DIFFERS" : "same"}: profile.mjs (${PROVENANCE.ref}) against ${bin}${version ? ` (NativeCluster ${version})` : ""}`);
process.exit(missing ? 1 : 0);
