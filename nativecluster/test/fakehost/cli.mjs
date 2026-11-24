#!/usr/bin/env node
// Runs an app package behind the fake NativeCluster host, with its front
// door for a browser, until Ctrl-C.
//
//   node nativecluster/test/fakehost/cli.mjs <package dir> [options]
//
//   --models fake|nativecluster   fixed answers (default), or this Mac's NativeCluster
//   --sandbox                     start the app under NativeCluster's app profile
//                                 (what nativecluster/dev/sandboxed.mjs does)
//   --front <port>|off            the front door's port (default 43900; 0 for any)
//   --person <label>              the door's default person (default alice; "nobody")
//   --role <label>=<role>         a person's role (owner, admin, member); repeatable
//   --data <dir>                  NC_APP_DATA (default <state>/Data/<name>)
//   --state <dir>                 the harness's own folder (ledger, logs, secrets)
//   --keep-credentials            pass Cookie and Bearer Authorization on (the host does not)
//   --line-delay <ms>             how long each wait in line takes (default 0)
//
// It prints one line `ready <url>` once the app answers /healthz, writes
// <state>/front.json, and on SIGINT or SIGTERM stops the app as the host does.

import { writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeHost } from "./host.mjs";
import { listenFront } from "./front.mjs";

const FORBIDDEN_PORTS = [42810, 42811, 42812, 42813, 42814, 42815];

export async function main(argv, { forceSandbox = false } = {}) {
  const args = { models: "fake", front: "43900", person: "alice", roles: {}, sandbox: forceSandbox };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--models") args.models = next();
    else if (a === "--sandbox") args.sandbox = true;
    else if (a === "--front") args.front = next();
    else if (a === "--person") args.person = next();
    else if (a === "--role") {
      const [label, role] = next().split("=");
      args.roles[label] = role;
    } else if (a === "--data") args.data = next();
    else if (a === "--state") args.state = next();
    else if (a === "--keep-credentials") args.keepCredentials = true;
    else if (a === "--line-delay") args.lineDelayMs = Number(next());
    else if (a === "-h" || a === "--help") {
      console.log("usage: cli.mjs <package dir> [--models fake|nativecluster] [--sandbox] [--front <port>|off] [--person <label>] [--role label=role] [--data dir] [--state dir] [--keep-credentials] [--line-delay ms]");
      return;
    } else rest.push(a);
  }
  if (rest.length !== 1) throw new Error("name one package folder (the one holding nc-app.json)");
  if (!["fake", "nativecluster"].includes(args.models)) throw new Error("--models is fake or nativecluster");
  const port = args.front === "off" ? null : Number(args.front);
  if (port !== null && FORBIDDEN_PORTS.includes(port)) throw new Error(`port ${port} is Stage 1's (42810-42815): pick another`);

  const people = { alice: "admin", bob: "member", ...args.roles };
  const host = new FakeHost({ pkg: rest[0], data: args.data, state: args.state, models: args.models, sandbox: args.sandbox, people, lineDelayMs: args.lineDelayMs });
  let front = null;
  let closing = false;
  const close = async (why) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`fakehost: ${why}: stopping the app\n`);
    const s = await host.stop().catch((e) => ({ error: e.message }));
    process.stderr.write(`fakehost: stopped ${JSON.stringify({ exit: s?.exit, ms: s?.ms, killed: s?.killed, left: s?.leftAfterExit?.map((p) => `${p.comm}(${p.pid})`), escaped: s?.escaped?.map((p) => `${p.comm}(${p.pid})`) })}\n`);
    await host.close();
    front?.server.close();
    const problems = host.ledger.problems({ final: true });
    if (problems.length) process.stderr.write(`fakehost: the line's ledger has ${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));

  process.stderr.write(`fakehost: starting ${host.manifest.name} (${host.manifest.id}) from ${host.pkg}${host.sandbox ? ", sandboxed" : ""}, models ${args.models}\n`);
  process.stderr.write(`fakehost: data ${host.data}\nfakehost: state ${host.state} (ledger.json, app-output.log${host.sandbox ? ", sandbox.sb" : ""})\n`);
  if (!host.peopleRead) process.stderr.write(`fakehost: ${host.manifest.name}'s manifest asks no people.read, so its tickets carry no email or name (as the real host's)\n`);
  await host.start();
  if (port !== null) {
    front = await listenFront(host, port, { person: args.person, keepCredentials: args.keepCredentials });
  }
  const info = { url: front?.url ?? null, pid: host.proc.pid, appSocket: host.appSocket, hostSocket: host.hostSocket, socketsDir: host.socketsDir, data: host.data, state: host.state, sandbox: host.sandbox, models: args.models, healthy_ms: host.healthy.ms };
  writeFileSync(path.join(host.state, "front.json"), JSON.stringify(info, null, 2));
  console.log(`ready ${front?.url ?? "(no front door)"} pid ${host.proc.pid} healthy in ${host.healthy.ms} ms`);
  host.proc.exited.then((e) => {
    if (!closing) {
      process.stderr.write(`fakehost: the app ended by itself: ${JSON.stringify(e)}; its output is in ${host.outFile}\n`);
    }
  });
  return host;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`fakehost: ${e.message}\n`);
    process.exit(1);
  });
}
