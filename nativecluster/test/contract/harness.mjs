// What every contract test shares: the package under test, a fake host for
// it, and the app's own hooks (contract/apps/<manifest id>.mjs) for what only
// that app can say: when it is fully up, what data a restart must keep, which
// sandbox refusals are its design, and how to make it call a model.
//
//   HARNESS_PKG=<package dir> node --test nativecluster/test/contract/
//
// HARNESS_SANDBOX=1 runs every test's app under NativeCluster's app sandbox
// (the sandbox test always does). HARNESS_RUN_DIR keeps each test's state
// folder (ledger, app output, data) there instead of a temporary one.

import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeHost, readManifest } from "../fakehost/host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PKG = process.env.HARNESS_PKG ? path.resolve(process.env.HARNESS_PKG) : null;
if (!PKG) throw new Error("set HARNESS_PKG to the package folder under test (the one holding nc-app.json)");
if (!existsSync(path.join(PKG, "nc-app.json"))) throw new Error(`${PKG} holds no nc-app.json`);
export const SANDBOX = process.env.HARNESS_SANDBOX === "1";
export const MANIFEST = readManifest(PKG).manifest;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app's hooks, or the generic ones. */
export async function hooks() {
  let file = path.join(here, "apps", `${MANIFEST.id}.mjs`);
  if (!existsSync(file) && /mike/i.test(`${MANIFEST.id} ${MANIFEST.name}`)) file = path.join(here, "apps", "mike.mjs");
  const generic = {
    name: "generic",
    ready: async () => sleep(3000),
    seed: async () => null,
    kept: async () => {},
    expectedDenials: [],
    drive: null,
  };
  if (!existsSync(file)) return generic;
  return { ...generic, ...(await import(pathToFileURL(file).href)) };
}

/** A state folder for one test's fake host. */
export function stateDir(label) {
  const root = process.env.HARNESS_RUN_DIR;
  if (!root) return mkdtempSync(path.join(os.tmpdir(), `mike-contract-${label}-`));
  const d = path.join(path.resolve(root), `${label}-${SANDBOX ? "sandboxed" : "plain"}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Starts the package behind a fake host (the caller closes it: host.close()). */
export async function startApp(label, opts = {}) {
  const host = new FakeHost({ pkg: PKG, state: stateDir(label), sandbox: opts.sandbox ?? SANDBOX, models: opts.models ?? process.env.HARNESS_MODELS ?? "fake", log: () => {}, ...opts });
  await host.start();
  return host;
}

/** The line a test prints about how the app started. */
export const started = (host) => `${MANIFEST.name}: /healthz answered ${host.healthy.status} ${host.healthy.ms} ms after start${host.sandbox ? " (sandboxed)" : ""}; state ${host.state}`;

/** Every file under dir with its size, but the host's .tmp and sockets. */
export function snapshot(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === ".tmp" || r.startsWith(".tmp/")) continue;
      const p = path.join(d, n);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, r);
      else if (s.isFile()) out.set(r, s.size);
    }
  };
  walk(dir, "");
  return out;
}

export function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
