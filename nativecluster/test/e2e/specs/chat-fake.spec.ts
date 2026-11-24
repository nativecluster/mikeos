/**
 * Mike's chat through the host's waiting line, with the fake host's fake
 * models (fixed answers; a tool call when tools are offered): an answer
 * streams, a tool call shows and its result reaches the answer, and every
 * wait in line gets exactly one release.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "../shim/fixtures";
import { PDF_FIXTURE, expectSavedAnswer } from "../../../../e2e/helpers";
import { createProject } from "../lib/projects";
import { chooseModel, door, expectLineSettled } from "../lib/door";

test.beforeAll(async () => {
    const s = await door.state();
    test.skip(s.models !== "fake", "these answers are the fake models' (run with --models fake)");
});

test("an answer streams from the fake model, through the line", async ({ page }) => {
    test.setTimeout(120_000);
    const before = (await door.ledger()).waits.length;
    const word = `harness-${randomUUID()}`;
    await page.goto("/assistant");
    await chooseModel(page);
    const streamed = page.waitForResponse((r) => (r.headers()["content-type"] ?? "").includes("text/event-stream"), { timeout: 60_000 });
    await page.getByPlaceholder("How can I help?").fill(`Reply with exactly: ${word}`);
    await page.getByPlaceholder("How can I help?").press("Enter");
    await expect(page).toHaveURL(/\/assistant\/chat\/[^/]+$/);
    await streamed;
    await expectSavedAnswer(page, word);

    const ledger = await expectLineSettled();
    const mine = ledger.waits.slice(before);
    expect(mine.length, "the chat waited in line").toBeGreaterThan(0);
    expect(mine.some((w) => w.lane === "P" && w.ticket.origin === "request"), "a person's turn waits in lane P on its request's ticket").toBe(true);
    expect(mine.filter((w) => w.refused), "no wait was refused").toEqual([]);
    expect(ledger.calls.some((c) => c.stream), "a streamed model call").toBe(true);
});

test("a document chat calls read_document, shows it, and answers from its result", async ({ page }) => {
    test.setTimeout(180_000);
    const before = (await door.ledger()).calls.length;
    await createProject(page, `Harness document ${Date.now()}`, PDF_FIXTURE);
    await page.goto(`${page.url().split("?")[0]}/assistant`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/assistant\/chat$/, { timeout: 30_000 });
    await chooseModel(page);
    const input = page.getByPlaceholder("How can I help?");
    await input.fill("Read test.pdf and quote its first line.");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/projects\/[^/]+\/assistant\/chat\/[^/]+$/);
    // The tool call shows in the answer (its label while it runs, its
    // document after), and the fake model then quotes the tool's result:
    // "Test PDF Document" is only in the PDF, never in the question.
    await expect(page.getByText(/Reading document|test\.pdf/).first()).toBeVisible({ timeout: 60_000 });
    await expectSavedAnswer(page, "Test PDF Document");

    const ledger = await expectLineSettled();
    const calls = ledger.calls.slice(before);
    expect(calls.some((c) => (c.tool_calls ?? []).includes("read_document")), "the fake model called read_document").toBe(true);
    expect(calls.filter((c) => c.status >= 400), "no model call failed").toEqual([]);
});
