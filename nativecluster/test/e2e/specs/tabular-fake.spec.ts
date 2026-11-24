/**
 * A tabular review with the fake host's fake models: a document, a column,
 * Run, and the cells fill with the fake model's value. Its model calls are
 * background work: they wait in lane B as a job's units (the brief), and
 * each grant is released exactly once.
 */
import { test, expect } from "../shim/fixtures";
import { door, expectLineSettled } from "../lib/door";
import { createReview, addDocumentAndColumn, run } from "../lib/tabular";

test.beforeAll(async () => {
    const s = await door.state();
    test.skip(s.models !== "fake", "these cells are the fake models' (run with --models fake)");
});

test("the cells of a tabular review fill from the fake model, as background work", async ({ page }) => {
    test.setTimeout(240_000);
    const before = (await door.ledger()).waits.length;
    await createReview(page, "Harness review");
    await addDocumentAndColumn(page, "Parties", "Who are the parties to this document?");
    await run(page);
    await expect(page.getByText("Harness value for Parties").first()).toBeVisible({ timeout: 120_000 });

    const ledger = await expectLineSettled(120_000);
    const mine = ledger.waits.slice(before);
    expect(mine.length, "the review's cells waited in line").toBeGreaterThan(0);
    expect(mine.filter((w) => w.refused), "no wait was refused").toEqual([]);
    expect(
        mine.some((w) => (w.moved_to ?? w.lane) === "B" && w.ticket.origin === "job"),
        `tabular work waits in lane B as a job (waits: ${JSON.stringify(mine.map((w) => [w.kind, w.lane, w.ticket.origin, w.ticket.from]))})`,
    ).toBe(true);
});
