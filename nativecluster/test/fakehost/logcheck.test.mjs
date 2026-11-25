// The harness's log check (log-check.mjs): what must never be in the app's
// logs after a run is found, wherever the run kept them, and a clean log
// passes. run-all.sh once passed while the jobs worker crashed on a
// RangeError and was respawned (the robustness campaign, 2026-11-24).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLogs } from "./log-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function run(files) {
  const root = mkdtempSync(path.join(tmpdir(), "mike-logcheck-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("finds a RangeError, a dead or respawned worker thread, an uncaught exception and a forced exit", () => {
  const root = run({
    "e2e-plain/Data/Mike/logs/backend.log": [
      "2026-11-24T10:00:00Z info Mike backend running",
      "[worker-thread:jobs] error RangeError [Error]: Maximum call stack size exceeded",
      "[worker-thread:jobs] exited with code 1; respawning in 5s",
      "! Graceful shutdown timed out — forcing exit",
    ].join("\n"),
    "contract/line-plain-1/Data/Mike/logs/launcher.log": "2026-11-24T10:00:00Z error uncaught exception TypeError: x is undefined\n",
  });
  try {
    const kinds = scanLogs([root]).map((f) => f.kind);
    assert.deepEqual(kinds, ["an uncaught exception", "a RangeError", "a worker thread that died", "a forced exit"]);
    const status = (() => {
      try {
        execFileSync(process.execPath, [path.join(here, "log-check.mjs"), root], { stdio: "pipe" });
        return 0;
      } catch (e) {
        return e.status;
      }
    })();
    assert.equal(status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes clean logs, and never reads requests.log or a document's own words", () => {
  const root = run({
    "e2e/Data/Mike/logs/backend.log": "2026-11-24T10:00:00Z info Shutting down gracefully (stdin closed)\nShutdown complete\n",
    "e2e/Data/Mike/logs/requests.log": "GET /api/RangeError 200\n",
    "e2e/Data/Mike/storage/doc.log": "RangeError in a document someone uploaded\n",
  });
  try {
    assert.deepEqual(scanLogs([root]), []);
    execFileSync(process.execPath, [path.join(here, "log-check.mjs"), root], { stdio: "pipe" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
