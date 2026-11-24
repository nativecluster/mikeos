/**
 * The create wizards' first step (a new project, tabular review or
 * workflow): Details, then Access, then the step that adds documents or
 * assets. Mike's NativeCluster app has no one to share with (accounts are
 * per computer) and skips Access, so these go past it only where a page
 * shows it.
 */
import { expect, type Page } from "@playwright/test";

/** The wizard's dialog is named for its step (Modal's last breadcrumb). */
const ACCESS_STEP = /^(Access|People)$/;

/** Clicks Details' Next, then Access's Next if there is an Access step. */
export async function nextPastAccess(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Details", exact: true })).toBeHidden();
    const access = page.getByRole("dialog", { name: ACCESS_STEP });
    if (await access.isVisible()) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(access).toBeHidden();
    }
}
