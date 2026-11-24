/**
 * The harness's front door, as the e2e specs use it: which person a request
 * comes from (NativeCluster's person is Mike's only login: the door's person
 * IS the user), and the door's control routes (the fake host's ledger of the
 * waiting line, a restart, scripted model answers).
 */
import { expect, type Page } from "@playwright/test";

export const FRONT = process.env.HARNESS_FRONT ?? "http://127.0.0.1:43900";

/** Headers that make every request of a context come from one person. */
export const personHeaders = (label: string): Record<string, string> => ({ "x-harness-person": label });

/** No one signed in; `pass` sends the request on with a ticket naming nobody. */
export const nobodyHeaders = (pass = false): Record<string, string> => ({
    "x-harness-person": "nobody",
    ...(pass ? { "x-harness-pass-nobody": "1" } : {}),
});

/** The person each Playwright worker is: worker 0 is alice. */
export const personForWorker = (index: number): string => (index === 0 ? "alice" : `w${index}`);

/** The email the fake host's ticket carries for a person (people.read). */
export const emailFor = (label: string): string => `${label}@harness.local`;

async function control<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${FRONT}/.harness/${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`the door's ${method} /.harness/${path} answered ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
}

export interface LedgerWait {
    seq: number;
    kind: string;
    lane: string;
    moved_to?: string;
    ticket: { origin?: string; from?: string; person?: string; request?: string };
    tag: { Task?: string; Model?: string; Job?: boolean };
    refused?: string;
}
export interface Ledger {
    summary: { waits: number; grants: number; releases: number; calls: number };
    waits: LedgerWait[];
    calls: { path: string; model: string; status: number; tool_calls?: string[]; stream?: boolean }[];
    problems: string[];
}

export const door = {
    state: () => control<{ app: { id: string; starts: number; sandbox: boolean }; models: string }>("GET", "state"),
    ledger: () => control<Ledger>("GET", "ledger"),
    problems: (final = true) => control<{ problems: string[] }>("GET", `ledger/problems${final ? "?final=1" : ""}`),
    restart: () => control<{ stopped: unknown }>("POST", "restart"),
    script: (answers: unknown[]) => control("POST", "models/script", answers),
};

/**
 * Every grant the app took since `since` waits went back exactly once: polls
 * until the app has released what it holds (a background job may still be
 * finishing), then asserts the ledger has no problem.
 */
export async function expectLineSettled(timeoutMs = 60_000): Promise<Ledger> {
    let problems: string[] = [];
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        problems = (await door.problems(true)).problems;
        if (problems.length === 0) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    expect(problems, "the waiting line's ledger: every wait's grant released exactly once").toEqual([]);
    return door.ledger();
}

/**
 * Picks the harness's model in a model menu ("Choose model"), when the page
 * shows one: the fake model (fake:harness) when the host runs fake models,
 * else `prefer`, else the first.
 */
export async function chooseModel(page: Page, prefer: RegExp = /harness/i): Promise<string | null> {
    const trigger = page.getByRole("button", { name: "Choose model", exact: true });
    try {
        await expect(trigger).toBeVisible({ timeout: 10_000 });
    } catch {
        return null;
    }
    await trigger.click();
    const items = page.getByRole("menu").locator('[role="menuitem"]:not([aria-expanded])');
    await expect(items.first()).toBeVisible();
    const wanted = items.filter({ hasText: prefer }).first();
    const pick = (await wanted.count()) > 0 ? wanted : items.first();
    const name = (await pick.innerText()).trim();
    await pick.click();
    return name;
}
