/**
 * Stands in for e2e/fixtures.ts in the staged upstream specs (same exports:
 * test, expect, Page, and the e2eAccount and workerStorageState fixtures),
 * and is the fixture the harness's own specs use.
 *
 * Upstream signs each worker in to Mike's own login through Supabase's admin
 * API. In the NativeCluster app there is no Mike login: every request of a
 * worker's browser carries X-Harness-Person, so the front door's ticket names
 * that worker's person, who is the Mike user. The worker's stored state is
 * what the app keeps in the origin's localStorage once onboarding is done.
 */
import fs from "fs";
import path from "path";
import { test as base, expect } from "@playwright/test";
import { completeOnboardingIfRequired } from "./onboarding";
import { workerAccount, type E2eAccount } from "./users";
import { personHeaders } from "../lib/door";
export { expect };
export type { Page } from "@playwright/test";

type WorkerFixtures = {
    /** This worker's person and the email its ticket carries. */
    e2eAccount: E2eAccount;
    /** The worker's state once its person has opened Mike and finished onboarding. */
    workerStorageState: string;
};

export const test = base.extend<object, WorkerFixtures>({
    e2eAccount: [
        async ({}, use, workerInfo) => {
            await use(workerAccount(workerInfo.parallelIndex));
        },
        { scope: "worker" },
    ],

    workerStorageState: [
        async ({ browser, e2eAccount }, use, workerInfo) => {
            const file = path.resolve(workerInfo.project.outputDir, `.auth/worker-${workerInfo.parallelIndex}.json`);
            if (!fs.existsSync(file)) {
                const context = await browser.newContext({
                    baseURL: workerInfo.project.use.baseURL,
                    extraHTTPHeaders: personHeaders(e2eAccount.person),
                });
                const page = await context.newPage();
                await page.goto("/assistant");
                await completeOnboardingIfRequired(page);
                await context.storageState({ path: file });
                await context.close();
            }
            await use(file);
        },
        { scope: "worker" },
    ],

    storageState: async ({ workerStorageState }, use) => {
        await use(workerStorageState);
    },

    // Every request of the test's browser comes from the worker's person.
    extraHTTPHeaders: async ({ e2eAccount }, use) => {
        await use(personHeaders(e2eAccount.person));
    },
});
