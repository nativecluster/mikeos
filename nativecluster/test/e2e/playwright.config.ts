/**
 * Mike's e2e tests against the packaged NativeCluster app, through the fake
 * host's front door (nativecluster/test/fakehost/front.mjs).
 *
 *   HARNESS_PKG=<package dir> npx playwright test -c nativecluster/test/e2e
 *   HARNESS_BROWSER=webkit …  # the same in WebKit (default Chromium)
 *
 * starts the fake host (fake models) on 127.0.0.1:43900 and stops it after.
 * HARNESS_FRONT=<url> uses a door already running instead (run-all.sh starts
 * its own, plain or sandboxed). HARNESS_SANDBOX=1 starts the app under
 * NativeCluster's sandbox; HARNESS_MODELS=nativecluster sends model calls to
 * this Mac's NativeCluster; HARNESS_REAL_MODELS=1 adds the "real" project
 * (one short chat, one tiny tabular review) and nothing else.
 *
 * Projects, by the package's manifest:
 *   the Node probe: probe (its page, Next in-process, the door's refusals);
 *   Mike: upstream (Mike's own specs, unchanged, staged by stage.ts),
 *         upstream-synthetic (upstream's browser-mocked specs),
 *         harness (people, chat and tabular with fake models, documents
 *                  parsed in the app's parser threads, the door,
 *                  Settings → Connectors against the real services, the
 *                  pages under their enforced CSP),
 *         real (HARNESS_REAL_MODELS=1 only).
 */
import fs from "fs";
import path from "path";
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { stageUpstream, UPSTREAM_DIR, UPSTREAM_SPECS, SYNTHETIC_SPECS, NOT_IN_THE_APP, SET_ASIDE } from "./stage";

const HERE = __dirname;
const TEST_DIR = path.resolve(HERE, "..");
const PORT = Number(process.env.HARNESS_PORT ?? 43900);
const FRONT = process.env.HARNESS_FRONT ?? `http://127.0.0.1:${PORT}`;
process.env.HARNESS_FRONT = FRONT; // the workers' door (lib/door.ts)

const pkg = process.env.HARNESS_PKG ? path.resolve(process.env.HARNESS_PKG) : null;
if (!pkg && !process.env.HARNESS_APP) throw new Error("set HARNESS_PKG to the package folder (or HARNESS_APP=mike|node-probe with HARNESS_FRONT)");
const manifest = pkg ? JSON.parse(fs.readFileSync(path.join(pkg, "nc-app.json"), "utf8")) : { id: process.env.HARNESS_APP, name: process.env.HARNESS_APP };
const app = manifest.id === "node-probe" ? "probe" : /mike/i.test(`${manifest.id} ${manifest.name}`) ? "mike" : "other";
const isMain = process.env.TEST_WORKER_INDEX === undefined;
if (app === "mike" && isMain) {
    stageUpstream();
    // Upstream tests of what the app does not have (stage.ts SET_ASIDE): not
    // run, each with its reason, said once at the start of a run.
    console.log(`set aside, ${SET_ASIDE.length} upstream tests of what the app does not have:`);
    for (const t of SET_ASIDE) console.log(`  - ${t.spec} › ${t.title}: ${t.why}`);
}

const runs = path.join(TEST_DIR, ".runs");
const sandbox = process.env.HARNESS_SANDBOX === "1";
const models = process.env.HARNESS_MODELS ?? "fake";
const real = process.env.HARNESS_REAL_MODELS === "1";
if (isMain && !process.env.HARNESS_STATE) process.env.HARNESS_STATE = path.join(runs, `e2e-${sandbox ? "sandboxed" : "plain"}-${models}-${Date.now()}`);

// HARNESS_BROWSER=webkit runs every project in WebKit (Safari's engine, the
// one NativeCluster's own window uses) instead of Chromium.
const browserName = process.env.HARNESS_BROWSER === "webkit" ? "webkit" : "chromium";
const chrome = { ...(browserName === "webkit" ? devices["Desktop Safari"] : devices["Desktop Chrome"]) };

const projects: PlaywrightTestConfig["projects"] =
    app === "probe"
        ? [{ name: "probe", testDir: path.join(HERE, "specs"), testMatch: [/probe\.spec\.ts/, /door\.spec\.ts/], use: chrome }]
        : [
              { name: "upstream", testDir: UPSTREAM_DIR, testMatch: UPSTREAM_SPECS, grepInvert: NOT_IN_THE_APP, use: chrome },
              { name: "upstream-synthetic", testDir: UPSTREAM_DIR, testMatch: SYNTHETIC_SPECS, grepInvert: NOT_IN_THE_APP, fullyParallel: false, use: chrome },
              {
                  name: "harness",
                  testDir: path.join(HERE, "specs"),
                  testMatch: [/people\.spec\.ts/, /chat-fake\.spec\.ts/, /tabular-fake\.spec\.ts/, /extraction\.spec\.ts/, /door\.spec\.ts/, /connectors\.spec\.ts/, /csp\.spec\.ts/],
                  use: chrome,
              },
              ...(real ? [{ name: "real", testDir: path.join(HERE, "specs"), testMatch: [/real-models\.spec\.ts/], use: chrome }] : []),
          ];

const cli = sandbox ? path.join(TEST_DIR, "../dev/sandboxed.mjs") : path.join(TEST_DIR, "fakehost/cli.mjs");

export default defineConfig({
    fullyParallel: false,
    // One PGlite session serves every connection: one worker, as upstream's local default.
    workers: Number(process.env.E2E_WORKERS ?? 1),
    timeout: 60_000,
    expect: { timeout: 15_000 },
    retries: 0,
    outputDir: path.join(runs, "playwright-results"),
    reporter: [["list"], ["json", { outputFile: path.join(runs, "playwright-report.json") }]],
    use: {
        baseURL: FRONT,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects,
    webServer: process.env.HARNESS_FRONT_RUNNING
        ? undefined
        : {
              command: `node ${JSON.stringify(cli)} ${JSON.stringify(pkg)} --front ${PORT} --models ${models} --state ${JSON.stringify(process.env.HARNESS_STATE)}`,
              url: `${FRONT}/.harness/ready`,
              reuseExistingServer: false,
              timeout: 300_000,
              stdout: "pipe",
              stderr: "pipe",
              gracefulShutdown: { signal: "SIGTERM", timeout: 75_000 },
          },
});
