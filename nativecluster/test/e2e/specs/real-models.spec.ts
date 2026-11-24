/**
 * Two small proofs on this Mac's real NativeCluster (the fake host run with
 * --models nativecluster; HARNESS_REAL_MODELS=1): one short chat and one
 * tiny tabular review (one document, one column). The only real model calls
 * the harness makes; few and small, and judged only for being answered.
 */
import { test, expect } from "../shim/fixtures";
import { expectSavedAnswer } from "../../../../e2e/helpers";
import { chooseModel, door, expectLineSettled } from "../lib/door";
import { createReview, addDocumentAndColumn, run } from "../lib/tabular";

const SMALL = new RegExp(process.env.HARNESS_REAL_MODEL ?? "qwen2\\.5:7b|7b", "i");

test.beforeAll(async () => {
    const s = await door.state();
    test.skip(s.models !== "nativecluster", "run the fake host with --models nativecluster");
});

test("one short chat on a real model", async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto("/assistant");
    await chooseModel(page, SMALL);
    await page.getByPlaceholder("How can I help?").fill("Reply with exactly: harness ok");
    await page.getByPlaceholder("How can I help?").press("Enter");
    await expect(page).toHaveURL(/\/assistant\/chat\/[^/]+$/);
    await expectSavedAnswer(page, "ok");
    await expectLineSettled(300_000);
});

test("one tiny tabular review on a real model", async ({ page }) => {
    test.setTimeout(900_000);
    await createReview(page, "Harness real review", SMALL);
    await addDocumentAndColumn(page, "Title", "What is the document's title? One line.");
    await run(page);
    const cell = page.locator("td, [role=gridcell]").filter({ hasText: /\S/ }).filter({ hasNotText: /^test\.pdf$/ });
    await expect(cell.first()).toBeVisible({ timeout: 600_000 });
    await expectLineSettled(600_000);
});
