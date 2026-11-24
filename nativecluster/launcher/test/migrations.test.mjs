// Every migration from the NativeCluster app on names its objects' schema.
//
// On PGlite every connection is one session, and `gotrue migrate` needs
// that session's search_path to put auth first (lib/stack.mjs). The launcher
// resets it before Mike's own schema step, but an object a migration names
// without its schema would land wherever the session's search_path points at
// the time: in auth, had the reset not run. So a migration dated from
// 2026-11-24 (the app's first) must write `public.x`, `auth.users`, never a
// bare `x`, in every statement that makes, changes, removes or writes an
// object. Function bodies (dollar-quoted) are left out: a function sets its
// own search_path.
//
// Older migrations are recorded as applied on a fresh install (schema.sql
// holds them) and ran on Postgres; the PGlite probe loaded schema.sql with no
// failing statement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../backend/migrations");
const FIRST = "20261124";

/** The SQL with comments, string literals and dollar-quoted bodies blanked out. */
export function topLevelSql(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += "''";
      i = j + 1;
    } else if (sql[i] === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        out += " $body$ ";
        i = end === -1 ? sql.length : end + tag[0].length;
      } else {
        out += sql[i++];
      }
    } else {
      out += sql[i++];
    }
  }
  return out;
}

const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)`;
const IFX = String.raw`(?:if\s+(?:not\s+)?exists\s+)?`;
const RULES = [
  new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:unlogged\s+|temp(?:orary)?\s+)?table\s+${IFX}${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+${IFX}${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:type|sequence|domain)\s+${IFX}${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?${IFX}(?:[\w"]+\s+)?on\s+(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+[\w"]+[\s\S]*?\bon\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bcreate\s+policy\s+(?:"[^"]+"|[\w]+)\s+on\s+${NAME}`, "gi"),
  new RegExp(String.raw`\balter\s+(?:table|view|function|procedure|type|sequence)\s+${IFX}(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bdrop\s+(?:table|view|materialized\s+view|function|procedure|type|sequence|domain)\s+${IFX}${NAME}`, "gi"),
  new RegExp(String.raw`\binsert\s+into\s+${NAME}`, "gi"),
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${NAME}`, "gi"),
  new RegExp(String.raw`\bcomment\s+on\s+(?:table|view|function|type)\s+${NAME}`, "gi"),
  new RegExp(String.raw`\b(?:grant|revoke)\b[^;]*?\bon\s+(?:table\s+|function\s+|sequence\s+)?(?!all\s)(?!schema\s)${NAME}`, "gi"),
];

/** The objects a migration names without their schema. */
export function unqualified(sql) {
  const top = topLevelSql(sql);
  const found = [];
  for (const rule of RULES) {
    for (const m of top.matchAll(rule)) {
      if (!m[1].includes(".")) found.push(m[0].replace(/\s+/g, " ").slice(0, 120));
    }
  }
  return found;
}

test("the check finds a bare name and passes a qualified one", () => {
  assert.deepEqual(unqualified("create table if not exists public.a (id int); insert into public.a values (1);"), []);
  assert.equal(unqualified("create table things (id int);").length, 1);
  assert.equal(unqualified("create index i on things (id);").length, 1);
  assert.equal(unqualified("grant select on things to anon;").length, 1);
  assert.deepEqual(unqualified("grant select on all tables in schema public to service_role;"), []);
  // A function body is its own business.
  assert.deepEqual(unqualified("create or replace function public.f() returns void language sql as $$ insert into t values (1) $$;"), []);
  assert.deepEqual(unqualified("-- create table nope (id int);\nselect 1;"), []);
});

test("every migration from the app's first on names its schema", () => {
  const files = readdirSync(migrations).filter((f) => f.endsWith(".sql") && f.slice(0, 8) >= FIRST).sort();
  assert.ok(files.length > 0, `no migration from ${FIRST} on in ${migrations}`);
  const problems = files.flatMap((f) => unqualified(readFileSync(path.join(migrations, f), "utf8")).map((s) => `${f}: ${s}`));
  assert.deepEqual(problems, []);
});
