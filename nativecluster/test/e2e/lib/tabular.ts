/**
 * Tabular review steps the harness's specs share (from upstream's
 * e2e/tabular-reviews.spec.ts, its helpers being file-local there).
 */
import { expect, type Page } from "@playwright/test";
import { PDF_FIXTURE } from "../../../../e2e/helpers";
import { chooseModel } from "./door";

/** Creates a review through the modal (as upstream's tabular spec does), the harness's model chosen. */
export async function createReview(page: Page, label: string, prefer?: RegExp): Promise<string> {
    await page.goto("/tabular-reviews");
    await expect(page.getByRole("heading", { name: "Tabular Reviews" })).toBeVisible();
    const name = `${label} ${Date.now()}`;
    await page.getByRole("heading", { name: "Tabular Reviews" }).locator("xpath=../div[1]").getByRole("button").last().click();
    const title = page.getByPlaceholder("Review name");
    await expect(title).toBeVisible();
    await title.fill(name);
    await chooseModel(page, prefer);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Access" })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Add Documents" })).toBeVisible();
    const created = page.waitForResponse((r) => /\/tabular-review\/?$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await page.locator('button[name="modalAction"][value="create-review"]').click();
    expect((await created).ok()).toBe(true);
    await expect(page).toHaveURL(/\/tabular-reviews\/[^/]+/, { timeout: 30_000 });
    return name;
}

/** Adds test.pdf, then one column, to the open review. */
export async function addDocumentAndColumn(page: Page, column: string, prompt: string): Promise<void> {
    await page.getByRole("button", { name: /Add Documents/ }).first().click();
    const upload = page.getByRole("dialog", { name: "Add Documents" }).getByRole("button", { name: "Upload", exact: true });
    await expect(upload).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles(PDF_FIXTURE);
    const confirm = page.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await confirm.click();
    await expect(page.getByText("test.pdf").first()).toBeVisible();

    await page.getByRole("button", { name: /Add Columns/ }).first().click();
    await page.getByPlaceholder("Column name").first().fill(column);
    await page.getByPlaceholder(/Write the analysis prompt/).first().fill(prompt);
    await page.getByRole("button", { name: "Add columns" }).click();
    await expect(page.getByText(column, { exact: true }).first()).toBeVisible();
}

/** Runs the review, unless adding the column already started it. */
export async function run(page: Page): Promise<void> {
    const runButton = page.getByTitle("Run review");
    try {
        await expect(runButton).toBeEnabled({ timeout: 10_000 });
        await runButton.click();
    } catch {
        // Already generating (the toolbar reads Stop), or nothing to run.
    }
}

