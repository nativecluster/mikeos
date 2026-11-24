// The contract tests' hooks for the Node probe (~/code/mikeos/nativecluster/
// probe), the stand-in package with Mike's contract: the ticket check, the
// socket, Next in-process, and the PGlite stack.

import { readFileSync } from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const name = "node-probe";

function results(host) {
  try {
    return JSON.parse(readFileSync(path.join(host.data, "probe-results.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Up once its stack has run (pgstack.total_ms is written at its end). */
export async function ready(host) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const r = results(host);
    if (r?.pgstack?.total_ms !== undefined && r.pid === host.proc?.pid) return r;
    await sleep(250);
  }
  throw new Error("the probe's stack did not finish within 180 s");
}

/** Its node:sqlite file counts one row a start: a restart must add one. */
export async function seed(host) {
  const r = await host.request("GET", "/api-probe/full", { as: "alice" });
  return r.json.probes.find((p) => p.name === "b_node_sqlite").result.rows;
}

export async function kept(host, rows) {
  const r = await host.request("GET", "/api-probe/full", { as: "alice" });
  const now = r.json.probes.find((p) => p.name === "b_node_sqlite").result.rows;
  if (now !== rows + 1) throw new Error(`probe.sqlite held ${rows} rows before the restart and ${now} after (want ${rows + 1})`);
}

/** Pages and routes, so Next does its work under the sandbox too. */
export async function exercise(host) {
  for (const p of ["/", "/isr", "/api/next-ping", "/hello.txt", "/api-probe"]) {
    const r = await host.request("GET", p, { as: "alice" });
    if (r.status !== 200) throw new Error(`GET ${p} answered ${r.status}`);
  }
  // The cached page again after its 5 s revalidate, as the probe's own page
  // does: Next regenerates it and keeps the result (in memory, by its config).
  await sleep(6500);
  await host.request("GET", "/isr", { as: "alice" });
  await sleep(2500);
  await host.request("GET", "/isr", { as: "alice" });
}

// The probe tries to write into its own package on purpose (to learn that
// it may not), and its stack tries real Postgres first.
export const expectedDenials = [/file-write\S* .*\/probe-write-test\.txt$/];

export const drive = null;
