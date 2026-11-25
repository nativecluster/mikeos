// No process of the app holds a secret where another program of the same
// macOS user can read it: its environment and its arguments, as it started
// (sysctl KERN_PROCARGS2, which `ps -E` reads, and which NativeCluster's
// app sandbox lets any app read: `(allow sysctl-read)`). The 2026-11-24
// security review (M3) read the backend's service-role key, download
// secret and API keys' key there, from inside another app's sandbox.
//
// The secrets looked for are every one this run has: the host's credential
// and ticket key, and every value the app keeps in the host's secrets
// store (each key of a JSON value too: the stack's JWT secret, its anon and
// service-role keys, the download secret, the API keys' key...). Each of the
// app's processes is read while the app works, a document's parser
// included, and nothing of them may be in its data or sockets folders
// either (a secret handed over in a file that stayed).

import { describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, started, hooks, MANIFEST, PKG, SANDBOX, sleep, stateDir } from "./harness.mjs";
import { FakeHost } from "../fakehost/host.mjs";
import { treeOf } from "../fakehost/procs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const isMike = /mike/i.test(`${MANIFEST.id} ${MANIFEST.name}`);

/** A process's arguments and environment as it started, as `ps -E` reads them. */
function argsAndEnv(pid) {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { maxBuffer: 16 << 20 }, (err, stdout) =>
      resolve(err ? "" : String(stdout)),
    );
  });
}

/** Every secret value this run knows, each at least 16 characters. */
function knownSecrets(host) {
  const out = new Map([
    ["the app credential", host.credential],
    ["the ticket key", host.ticketKey],
  ]);
  for (const [name, value] of host.secrets) {
    if (typeof value !== "string") continue;
    out.set(name, value);
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out.set(`${name} ${k}`, v);
    } catch {}
  }
  for (const [k, v] of out) if (typeof v !== "string" || v.length < 16) out.delete(k);
  return out;
}

/**
 * Variables that once held a secret of the stack's, by name: none may be set.
 * (`gotrue migrate` needs GOTRUE_JWT_SECRET set, and gets a throwaway of its
 * own, since it signs nothing: the check of every known value proves it is
 * not the stack's.)
 */
const SECRET_NAMES = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "DOWNLOAD_SIGNING_SECRET",
  "USER_API_KEYS_ENCRYPTION_SECRET",
  "MCP_CONNECTORS_ENCRYPTION_SECRET",
  "PGRST_JWT_SECRET",
];

/** Files under dir (sockets and fifos skipped), for the secrets a file could hold. */
function files(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Mike: a document through the upload session, so a parser child runs. */
async function uploadADocument(host) {
  const project = await host.request("POST", "/api/projects", { as: "alice", body: { name: `environment ${Date.now()}` } });
  if (project.status >= 300) throw new Error(`POST /api/projects answered ${project.status}`);
  const pdf = readFileSync(path.join(here, "../../../e2e/fixtures/test.pdf"));
  const session = await host.request("POST", "/api/upload-sessions", {
    as: "alice",
    body: {
      purpose: "document_create",
      destination: { scope: "project", project_id: project.json.id },
      files: [{ client_id: "probe", filename: "test.pdf", size_bytes: pdf.length }],
    },
  });
  if (session.status >= 300) throw new Error(`POST /api/upload-sessions answered ${session.status}: ${session.text.slice(0, 200)}`);
  const sid = session.json.session?.id ?? session.json.id;
  const file = (session.json.files ?? session.json.session?.files ?? [])[0];
  const put = await host.request("PUT", file.upload.url, { as: "alice", body: pdf, headers: { "content-type": "application/pdf" } });
  if (put.status >= 300) throw new Error(`PUT ${file.upload.url.split("/signed/")[0]}/signed/… answered ${put.status}: ${put.text.slice(0, 200)}`);
  const done = await host.request("POST", `/api/upload-sessions/${sid}/files/${file.id}/complete`, { as: "alice", body: {} });
  if (done.status >= 300) throw new Error(`completing the upload answered ${done.status}: ${done.text.slice(0, 200)}`);
}

/** What each process showed while `busy` runs: pid -> {comm, texts}. */
async function watchWhile(rootPid, busy) {
  const seen = new Map();
  let done = false;
  const work = busy().finally(() => (done = true));
  while (!done) {
    const root = rootPid();
    if (root) {
      for (const p of await treeOf(root)) {
        const text = await argsAndEnv(p.pid);
        if (!text) continue;
        const entry = seen.get(p.pid) ?? { comm: path.basename(p.comm), texts: new Set() };
        entry.texts.add(text);
        seen.set(p.pid, entry);
      }
    }
    await sleep(50);
  }
  await work;
  return seen;
}

function findings(seen, secrets) {
  const found = [];
  for (const [pid, { comm, texts }] of seen) {
    for (const text of texts) {
      for (const [name, value] of secrets) if (text.includes(value)) found.push(`${comm}(${pid}) holds ${name}`);
      for (const name of SECRET_NAMES) if (new RegExp(`(^|\\s)${name}=\\S`).test(text)) found.push(`${comm}(${pid}) has ${name} set`);
    }
  }
  return [...new Set(found)];
}

describe("environments as the app starts", () => {
  let host;
  after(() => host?.close());

  // The first start runs the schema step: PGlite for it, `gotrue migrate`,
  // the schema; then the stack. Each is read as it runs.
  test("no process holds a secret while a first start sets the database up", async (t) => {
    host = new FakeHost({ pkg: PKG, state: stateDir("environment-start"), sandbox: SANDBOX, models: "fake", log: () => {} });
    const app = await hooks();
    const seen = await watchWhile(() => host.proc?.pid, async () => {
      await host.start();
      await app.ready(host);
    });
    t.diagnostic(started(host));
    const comms = [...new Set([...seen.values()].map((e) => e.comm))];
    t.diagnostic(`read as it started: ${comms.join(", ")}`);
    if (isMike) assert.ok(comms.includes("gotrue"), `gotrue migrate was among the processes read (${comms.join(", ")})`);
    assert.deepEqual(findings(seen, knownSecrets(host)), []);
  });
});

describe("environments", () => {
  let host;
  let app;
  before(async () => {
    app = await hooks();
    host = await startApp("environment");
    await app.ready(host);
    if (app.exercise) await app.exercise(host);
  });
  after(() => host?.close());

  test("no process of the app holds a secret in its environment or arguments", async (t) => {
    t.diagnostic(started(host));
    const secrets = knownSecrets(host);
    t.diagnostic(`looking for ${secrets.size} secrets: ${[...secrets.keys()].join(", ")}`);
    assert.ok(secrets.size >= 2, "the run's secrets are known");
    if (isMike) await uploadADocument(host);

    const seen = new Map();
    const found = [];
    let readable = 0;
    // Looks while the app works, for 20 s: short-lived children too (the
    // document's parser, which leaves once idle).
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      for (const p of await treeOf(host.proc.pid)) {
        const text = await argsAndEnv(p.pid);
        if (!text) continue;
        seen.set(p.pid, path.basename(p.comm));
        if (text.includes("NC_APP_DATA=") || text.includes("PATH=")) readable++;
        for (const [name, value] of secrets) if (text.includes(value)) found.push(`${path.basename(p.comm)}(${p.pid}) holds ${name}`);
        for (const name of SECRET_NAMES)
          if (new RegExp(`(^|\\s)${name}=\\S`).test(text)) found.push(`${path.basename(p.comm)}(${p.pid}) has ${name} set`);
      }
      await sleep(250);
    }
    t.diagnostic(`read: ${[...seen].map(([pid, comm]) => `${comm}(${pid})`).join(", ")}`);
    // The positive control: the environments were readable at all.
    assert.ok(readable > 0, "no process's environment could be read, so the check proves nothing");
    if (isMike) {
      const names = [...seen.values()];
      for (const want of ["node", "postgrest"]) assert.ok(names.includes(want), `${want} was among the processes read (${names.join(", ")})`);
    }
    assert.deepEqual([...new Set(found)], []);
  });

  test("no secret stays in a file of the app's data or sockets folders", async () => {
    const secrets = knownSecrets(host);
    const found = [];
    for (const dir of [host.data, host.socketsDir]) {
      for (const f of files(dir)) {
        let size = 0;
        try {
          size = statSync(f).size;
        } catch {
          continue;
        }
        if (size > 512 << 20) continue;
        let bytes;
        try {
          bytes = readFileSync(f);
        } catch {
          continue;
        }
        for (const [name, value] of secrets) if (bytes.includes(value)) found.push(`${path.relative(dir, f)} holds ${name}`);
      }
    }
    assert.deepEqual(found, []);
  });
});
