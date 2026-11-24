#!/usr/bin/env node
// Holds a finished run's ledger (<state>/ledger.json) to "every line wait has
// exactly one release": prints its summary and each problem, and exits 1 on
// any.
//
//   node nativecluster/test/fakehost/ledger-check.mjs <state dir or ledger.json>

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Ledger } from "./ledger.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: ledger-check.mjs <state dir or ledger.json>");
  process.exit(2);
}
const file = statSync(arg).isDirectory() ? path.join(arg, "ledger.json") : arg;
const data = JSON.parse(readFileSync(file, "utf8"));
const { summary: _s, problems: _p, ...fields } = data; // computed, not kept
const l = Object.assign(new Ledger(null), fields);
const problems = l.problems({ final: true });
const s = l.summary();
console.log(`ledger ${file}: ${s.waits} waits (${s.refused} refused), ${s.grants} grants, ${s.releases} releases, ${s.calls} model calls`);
for (const [k, n] of Object.entries(s.by)) console.log(`  ${n} x ${k}`);
for (const e of data.events ?? []) if (/refused|did not|failed|404/.test(e.words)) console.log(`  note: ${e.words}`);
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("every grant was released exactly once");
