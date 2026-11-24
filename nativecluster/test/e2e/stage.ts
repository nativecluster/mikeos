/**
 * Stages Mike's upstream e2e specs to run, unchanged, against the packaged
 * app: each chosen spec file and the helpers they import are copied as they
 * are from the repository's e2e/ into nativecluster/test/e2e/.upstream/,
 * beside the harness's stand-ins for the three modules that reach Mike's
 * hosted login (fixtures.ts, users.ts, onboarding.ts; see shim/). The specs
 * import "./fixtures" and get the stand-in. Nothing in e2e/ is edited.
 */
import fs from "fs";
import path from "path";

const HERE = __dirname;
const REPO = path.resolve(HERE, "../../..");
export const UPSTREAM_DIR = path.join(HERE, ".upstream");

/** Specs that need no hosted service and no model call (backend + frontend only). */
export const UPSTREAM_SPECS = [
    "project-management.spec.ts",
    "tabular-reviews.spec.ts",
    "workflows-settings.spec.ts",
    "settings-search.spec.ts",
    "accessibility.spec.ts",
    "critical-path.spec.ts",
];

/** Specs that mock every /api call in the browser (upstream's "synthetic" project). */
export const SYNTHETIC_SPECS = [
    "assistant-streaming.spec.ts",
    "tabular-chat-lifecycle.spec.ts",
    "settings-search-latency.spec.ts",
    "legal-data-hunter.spec.ts",
];

/**
 * Upstream tests about Mike's own login, which the NativeCluster app does not
 * have (NativeCluster is its only login): left out by name, their files kept.
 * auth-flows.spec.ts is not staged at all for the same reason.
 */
export const NOT_IN_THE_APP = /login page has no critical accessibility violations|unauthenticated request to \/assistant redirects to login/;

export function stageUpstream(): void {
    fs.rmSync(UPSTREAM_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
    for (const f of [...UPSTREAM_SPECS, ...SYNTHETIC_SPECS, "helpers.ts", "llm.ts"]) {
        fs.copyFileSync(path.join(REPO, "e2e", f), path.join(UPSTREAM_DIR, f));
    }
    fs.cpSync(path.join(REPO, "e2e", "fixtures"), path.join(UPSTREAM_DIR, "fixtures"), { recursive: true });
    for (const f of ["fixtures.ts", "users.ts", "onboarding.ts"]) {
        fs.copyFileSync(path.join(HERE, "shim", f), path.join(UPSTREAM_DIR, f));
    }
    fs.writeFileSync(
        path.join(UPSTREAM_DIR, "README.txt"),
        "Staged by nativecluster/test/e2e/stage.ts from e2e/ (unchanged) and shim/ (the harness's stand-ins). Do not edit: it is copied again on every run.\n",
    );
}
