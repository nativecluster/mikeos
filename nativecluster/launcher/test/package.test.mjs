// The package's one folder and its signing, as NativeCluster's Store takes
// them: the folder is named as the app (MikeOSS), and a package that came by
// AirDrop, its every file quarantined, signs and runs (MikeOS 2.1.0.1's publish
// renamed the folder and took the mark off by hand).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(here, "../../build");
const manifest = path.resolve(here, "../../nc-app.json");

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mike-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for Node: a program of its own, linked to nothing outside the
// system (this Mac's node may load a libnode beside it), that answers sign.sh's
// check of Node by running.
function standaloneProgram(dir) {
  const out = path.join(dir, "node-stand-in");
  const r = spawnSync("cc", ["-x", "c", "-", "-o", out], { input: "int main(void) { return 0; }\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

// A package of the fewest files sign.sh reads: the manifest, the launcher
// script, a program standing in for Node, LICENSE and NOTICE.
function fakePackage(dir, folder) {
  const pkg = path.join(dir, folder);
  mkdirSync(path.join(pkg, "runtime/bin"), { recursive: true });
  copyFileSync(manifest, path.join(pkg, "nc-app.json"));
  writeFileSync(path.join(pkg, "mike"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(pkg, "mike"), 0o755);
  copyFileSync(standaloneProgram(dir), path.join(pkg, "runtime/bin/node"));
  chmodSync(path.join(pkg, "runtime/bin/node"), 0o755);
  writeFileSync(path.join(pkg, "LICENSE"), "AGPL-3.0\n");
  writeFileSync(path.join(pkg, "NOTICE"), "MikeOSS for NativeCluster\n");
  return pkg;
}

function quarantined(file) {
  return spawnSync("xattr", ["-p", "com.apple.quarantine", file]).status === 0;
}

test("build.sh refuses a stage folder not named as the app, before it makes anything", (t) => {
  const dir = scratch(t);
  const r = spawnSync("bash", [path.join(build, "build.sh"), path.join(dir, "mikeos")], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /name the stage folder MikeOSS, not mikeos/);
  assert.equal(existsSync(path.join(dir, "mikeos")), false);
});

test("sign.sh refuses a package folder not named as the app", (t) => {
  const pkg = fakePackage(scratch(t), "mikeos");
  const r = spawnSync("sh", [path.join(build, "sign.sh"), pkg, "-"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /the package folder is mikeos, not MikeOSS/);
});

test("a package that came by AirDrop signs, runs, and zips as its one folder MikeOSS", { skip: process.platform !== "darwin" }, (t) => {
  const dir = scratch(t);
  const pkg = fakePackage(dir, "MikeOSS");
  const mark = "0083;6745b1c0;sharingd;";
  for (const f of ["nc-app.json", "mike", "runtime/bin/node", "LICENSE", "NOTICE"]) {
    assert.equal(spawnSync("xattr", ["-w", "com.apple.quarantine", mark, path.join(pkg, f)]).status, 0);
  }
  assert.ok(quarantined(path.join(pkg, "runtime/bin/node")));
  const zip = path.join(dir, "out.zip");
  const r = spawnSync("sh", [path.join(build, "sign.sh"), pkg, "-", zip], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["nc-app.json", "mike", "runtime/bin/node", "LICENSE", "NOTICE"]) {
    assert.equal(quarantined(path.join(pkg, f)), false, `${f} is still quarantined`);
  }
  const entries = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const tops = new Set(entries.map((e) => e.split("/")[0]).filter((e) => e !== "__MACOSX"));
  assert.deepEqual([...tops], ["MikeOSS"]);
  assert.ok(readdirSync(dir).includes("out.zip"));
});
