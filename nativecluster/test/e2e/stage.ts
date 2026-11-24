/**
 * Stages Mike's upstream e2e specs to run against the packaged app: each
 * chosen spec file and the helpers they import are copied from the
 * repository's e2e/ into nativecluster/test/e2e/.upstream/, beside the
 * harness's stand-ins for the three modules that reach Mike's hosted login
 * (fixtures.ts, users.ts, onboarding.ts; see shim/). The specs import
 * "./fixtures" and get the stand-in. Nothing in e2e/ is edited.
 *
 * The copies are unchanged but for one step (APP_STEPS): the app skips the
 * create wizards' Access step (accounts are per computer), so the three
 * places that walk Details -> Access go past it only where there is one
 * (lib/wizard.ts). Each must match exactly once, or staging fails, so an
 * upstream change to them is noticed rather than silently run unpatched.
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
 * Upstream tests of what the NativeCluster app does not have, set aside by
 * title (their files are kept and staged). NativeCluster is Mike's only
 * login (Pablo, 2026-11-24): the app has no Mike login page, password, MFA,
 * account deletion or email change, and it runs its models through
 * NativeCluster alone, so Bring Your Own Keys and its provider cards are
 * hidden. Its window opens no popups, so connectors link by the device
 * grant or a pasted address instead of the OAuth popup.
 */
export const SET_ASIDE: readonly { spec: string; title: string; why: string }[] = [
    { spec: "accessibility.spec.ts", title: "login page has no critical accessibility violations", why: "the app has no Mike login page" },
    { spec: "critical-path.spec.ts", title: "unauthenticated request to /assistant redirects to login", why: "the app has no Mike login page: NativeCluster's host stops nobody signed in" },
    { spec: "settings-search.spec.ts", title: "finds a section by other words for it and opens it on click", why: "it opens Bring Your Own Keys, which the app hides" },
    { spec: "settings-search.spec.ts", title: "Enter opens the first result and lands on its section heading", why: "it opens Password, which the app hides" },
    { spec: "settings-search.spec.ts", title: "arrow keys move through results and Escape returns to the box", why: "it steps to Delete account, which the app hides" },
    { spec: "settings-search.spec.ts", title: "shares the title row and keeps its results inside the screen", why: "it opens Multi-Factor Authentication, which the app hides" },
    { spec: "workflows-settings.spec.ts", title: "settings page loads and shows user email", why: "it reads the email change field, which the app hides (the email is NativeCluster's)" },
    { spec: "workflows-settings.spec.ts", title: "API keys page shows provider cards and opens key dialogs", why: "Bring Your Own Keys and its Saved Providers, which the app hides" },
    { spec: "settings-search-latency.spec.ts", title: "settings search focuses a heading after delayed navigation", why: "it opens Password (Security), which the app hides" },
    { spec: "legal-data-hunter.spec.ts", title: "LDH Discover preset uses the shared OAuth popup and Installed controls", why: "the OAuth popup: the app links by the device grant or a pasted address" },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The set-aside titles, for the upstream projects' grepInvert. */
export const NOT_IN_THE_APP = new RegExp(SET_ASIDE.map((t) => escape(t.title)).join("|"));

const ACCESS_BLOCK = `    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Access" })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
`;
const PAST_ACCESS = "    await nextPastAccess(page);\n";

/** The one step the staged copies change: Details -> Access, where the app shows Access. */
const APP_STEPS: Record<string, { from: string; to: string }> = {
    "helpers.ts": { from: ACCESS_BLOCK, to: PAST_ACCESS },
    "tabular-reviews.spec.ts": { from: ACCESS_BLOCK, to: PAST_ACCESS },
    "workflows-settings.spec.ts": { from: ACCESS_BLOCK, to: PAST_ACCESS },
};
const WIZARD_IMPORT = 'import { nextPastAccess } from "../lib/wizard";\n';

/** A file as staged: with its APP_STEPS change, which must match exactly once. */
export function staged(file: string, text: string): string {
    const step = APP_STEPS[file];
    if (!step) return text;
    const at = text.indexOf(step.from);
    if (at < 0 || text.indexOf(step.from, at + 1) >= 0) {
        throw new Error(`stage.ts: e2e/${file} no longer walks Details -> Access exactly once as the harness expects: update APP_STEPS`);
    }
    return WIZARD_IMPORT + text.slice(0, at) + step.to + text.slice(at + step.from.length);
}

export function stageUpstream(): void {
    fs.rmSync(UPSTREAM_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
    for (const f of [...UPSTREAM_SPECS, ...SYNTHETIC_SPECS, "helpers.ts", "llm.ts"]) {
        const text = fs.readFileSync(path.join(REPO, "e2e", f), "utf8");
        fs.writeFileSync(path.join(UPSTREAM_DIR, f), staged(f, text));
    }
    fs.cpSync(path.join(REPO, "e2e", "fixtures"), path.join(UPSTREAM_DIR, "fixtures"), { recursive: true });
    for (const f of ["fixtures.ts", "users.ts", "onboarding.ts"]) {
        fs.copyFileSync(path.join(HERE, "shim", f), path.join(UPSTREAM_DIR, f));
    }
    fs.writeFileSync(
        path.join(UPSTREAM_DIR, "README.txt"),
        "Staged by nativecluster/test/e2e/stage.ts from e2e/ (unchanged but for the Access step, APP_STEPS) and shim/ (the harness's stand-ins). Do not edit: it is copied again on every run.\n",
    );
}
