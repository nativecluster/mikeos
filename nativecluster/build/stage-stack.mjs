// Stages PostgREST and GoTrue from upstream Mike's desktop/local-stack/bin
// into the package's stack/ folder, and proves every Mach-O there loads only
// from the package or Apple's system paths (after the probe's
// build/stage-stack.mjs, without Postgres: Mike's database is PGlite).
//
//   node build/stage-stack.mjs <local-stack/bin> <package folder>
//
// A package holds no link, so a library a binary references through a link
// becomes a real copy under the referenced name. Exits 1 if any reference
// would not resolve, or a link is left.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, copyFileSync, chmodSync } from "node:fs";
import path from "node:path";

const [src, pkg] = process.argv.slice(2);
if (!src || !pkg) throw new Error("usage: stage-stack.mjs <local-stack/bin> <package>");
const out = path.join(pkg, "stack");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const deps = (file) => {
  let text;
  try {
    text = execFileSync("/usr/bin/otool", ["-L", "-arch", "arm64", file], { encoding: "utf8" });
  } catch {
    return null; // not Mach-O
  }
  const lines = text.split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
  if (file.endsWith(".dylib")) {
    const id = execFileSync("/usr/bin/otool", ["-D", "-arch", "arm64", file], { encoding: "utf8" }).split("\n")[1]?.trim();
    return lines.filter((l) => l !== id);
  }
  return lines;
};
const isMachO = (f) => {
  try {
    return execFileSync("/usr/bin/file", ["-b", f], { encoding: "utf8" }).includes("Mach-O");
  } catch {
    return false;
  }
};
const systemPath = (p) => p.startsWith("/usr/lib/") || p.startsWith("/System/Library/");
const copy = (from, to) => {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(realpathSync(from), to);
  chmodSync(to, statSync(realpathSync(from)).mode & 0o777);
};

// 1. The two programs, GoTrue's migrations, the notices.
for (const f of ["postgrest", "gotrue"]) copy(path.join(src, f), path.join(out, f));
cpSync(path.join(src, "gotrue-migrations"), path.join(out, "gotrue-migrations"), { recursive: true, dereference: true });
mkdirSync(path.join(out, "notices"), { recursive: true });
for (const f of ["postgrest-LICENSE", "gotrue-LICENSE", "postgresql-COPYRIGHT", "sources.json"]) {
  if (existsSync(path.join(src, "notices", f))) copy(path.join(src, "notices", f), path.join(out, "notices", f));
}

// 2. Every library they reference (PostgREST's libpq and its own), by the
// name they use.
const missing = [];
const queue = ["postgrest", "gotrue"].map((f) => path.join(out, f));
const seen = new Set();
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f) || !isMachO(f)) continue;
  seen.add(f);
  for (const d of deps(f) ?? []) {
    if (systemPath(d)) continue;
    if (!d.startsWith("@loader_path/")) {
      missing.push(`${path.relative(out, f)} -> ${d} (outside the package and the system)`);
      continue;
    }
    const target = path.resolve(path.dirname(f), d.slice("@loader_path/".length));
    if (!existsSync(target)) {
      const from = path.join(src, path.relative(out, target));
      if (!existsSync(from)) {
        missing.push(`${path.relative(out, f)} -> ${d} (not in upstream either)`);
        continue;
      }
      copy(from, target);
    }
    queue.push(target);
  }
}

// 3. Proof: no link, nothing referenced that is not there.
const links = [];
const check = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (lstatSync(p).isSymbolicLink()) links.push(p);
    else if (e.isDirectory()) check(p);
  }
};
check(out);
console.log(JSON.stringify({ staged: out, machO_checked: [...seen].map((f) => path.relative(out, f)), links, missing }));
process.exit(links.length || missing.length ? 1 : 0);
