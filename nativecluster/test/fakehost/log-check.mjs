#!/usr/bin/env node
// The app's own logs, held to what must never be in them after a run of
// the harness: a RangeError (a stack overflow), a worker thread that died
// or was respawned, an uncaught exception, a forced exit. run-all.sh passed
// while Mike's jobs worker crashed on a RangeError and was respawned, since
// no step read the app's logs (the robustness campaign, 2026-11-24): every
// contract and e2e step now ends with this check.
//
//   node nativecluster/test/fakehost/log-check.mjs <state dir>...
//
// Reads every `logs/*.log` (but requests.log) and every app-output.log
// under the folders named, at any depth, and exits 1 naming each line
// found, by file and line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORRIES = [
  ["a RangeError", /RangeError|Maximum call stack size exceeded/],
  ["a worker thread that died", /\[worker-thread:[A-Za-z_-]+\] (?:error\b|exited with code)/],
  ["a worker thread respawned", /respawning in \d+s/],
  ["an uncaught exception", /uncaught exception|Uncaught (?:exception|[A-Za-z]*Error)\b/i],
  ["a forced exit", /forcing exit/],
];

// Folders never holding the app's logs, and too big to walk.
const SKIP = new Set(["node_modules", "pglite", "storage", "playwright", ".tmp", "web", "backend", "runtime"]);

/** Every log file under `dir`: logs/*.log (not requests.log) and app-output.log. */
export function logFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth < 8) walk(full, depth + 1);
      } else if (e.isFile()) {
        if (e.name === "app-output.log") out.push(full);
        else if (path.basename(d) === "logs" && e.name.endsWith(".log") && e.name !== "requests.log") out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** The worrying lines under the folders: {kind, file, line, text}. */
export function scanLogs(dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const file of logFiles(dir)) {
      if (statSync(file).size > 512 * 1024 * 1024) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, i) => {
          for (const [kind, re] of WORRIES) {
            if (re.test(text)) {
              found.push({ kind, file, line: i + 1, text: text.slice(0, 300) });
              break;
            }
          }
        });
    }
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error("usage: log-check.mjs <state dir>...");
    process.exit(2);
  }
  const files = dirs.flatMap(logFiles);
  const found = scanLogs(dirs);
  if (!found.length) {
    console.log(`log-check: ${files.length} log file${files.length === 1 ? "" : "s"}, nothing worrying`);
    process.exit(0);
  }
  console.error(`log-check: ${found.length} worrying line${found.length === 1 ? "" : "s"} in the app's logs:`);
  for (const f of found.slice(0, 40)) console.error(`  ${f.kind}: ${f.file}:${f.line}: ${f.text}`);
  process.exit(1);
}
