#!/usr/bin/env node
// Runs an app package behind the fake NativeCluster host, confined by
// NativeCluster's own app sandbox, without installing it.
//
//   node nativecluster/dev/sandboxed.mjs <package dir> [the fake host's options]
//
// The same fake host as nativecluster/test/fakehost/cli.mjs (its options),
// with the app started through /usr/bin/sandbox-exec under the profile in
// dev/sandbox/profile.mjs: NativeCluster's host/host/sandbox.go, copied
// verbatim (its provenance there; `node nativecluster/dev/sandbox/
// check-installed.mjs` holds it to the installed host). The profile this run
// used, with its paths written in, is <state>/sandbox.sb.
//
// What the sandbox refused is in the unified log:
//   log show --last 10m --style compact --predicate 'sender == "Sandbox"'
// (the contract tests read it for the app's own processes).

import { main } from "../test/fakehost/cli.mjs";

main(process.argv.slice(2), { forceSandbox: true }).catch((e) => {
  process.stderr.write(`sandboxed: ${e.message}\n`);
  process.exit(1);
});
