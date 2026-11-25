/**
 * Creates a project as upstream's createProject (e2e/helpers.ts) does,
 * through the New project dialog, past an Access step only where the page
 * shows one: Mike's NativeCluster app skips it (lib/wizard.ts). The staged
 * upstream specs get the same through stage.ts.
 */
import { expect, type Page } from "@playwright/test";
import { nextPastAccess } from "./wizard";

export async function createProject(page: Page, projectName: string, filePath?: string | string[]): Promise<void> {
    const files = filePath === undefined ? [] : [filePath].flat();
    await page.goto("/projects");
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();
    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(projectName);

    await nextPastAccess(page);
    await expect(page.getByRole("dialog", { name: "Add Documents" })).toBeVisible();

    if (files.length) {
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: /^Upload/ }).click();
        await (await chooser).setFiles(files);
        await expect(page.getByRole("button", { name: new RegExp(`^Upload \\(${files.length}\\)`) })).toBeVisible({ timeout: 5_000 });
    }
    await page.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: files.length ? 30_000 : 15_000 });
}
