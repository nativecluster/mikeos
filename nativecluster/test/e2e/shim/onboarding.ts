/**
 * Stands in for e2e/onboarding.ts in the staged upstream specs (same export).
 * The NativeCluster app's onboarding leaves out the organization invitations
 * screen (sessions workstream, onboarding/steps.ts), so this one goes on to
 * the models screen from either; otherwise it is upstream's.
 */
import { expect, type Page } from "@playwright/test";

export async function completeOnboardingIfRequired(page: Page): Promise<void> {
    await page.waitForURL(/\/(assistant|onboarding\/profile)/, { timeout: 30_000 });
    if (new URL(page.url()).pathname === "/onboarding/profile") {
        const continueButton = page.getByRole("button", { name: "Continue" });
        const assistantInput = page.getByRole("combobox", { name: "How can I help?" });
        await expect(continueButton.or(assistantInput)).toBeVisible({ timeout: 15_000 });
        if (await continueButton.isVisible()) {
            await continueButton.click();
            await page.waitForURL(/\/onboarding\/practice/, { timeout: 15_000 });
            await page.getByRole("button", { name: "Skip" }).click();
            await page.waitForURL(/\/onboarding\/(invitations|models)/, { timeout: 15_000 });
            if (new URL(page.url()).pathname === "/onboarding/invitations") {
                await page.getByRole("button", { name: "Continue" }).click();
                await page.waitForURL(/\/onboarding\/models/, { timeout: 15_000 });
            }
            await page.getByRole("button", { name: "Finish" }).click();
        }
    }
    await page.waitForURL(/\/assistant/, { timeout: 15_000 });
}
