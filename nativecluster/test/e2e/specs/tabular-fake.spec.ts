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
    const start = await door.ledger();
    const before = start.waits.length;
    const unitsBefore = start.units.length;
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

    // The host heard the review at work, and then at rest (the robustness
    // campaign's U1: it heard `{"waiting": false}` once, at start, and never
    // again, so it could stop Mike as idle mid-review).
    let units = ledger.units.slice(unitsBefore).map((u) => u.report);
    expect(units.some((r) => r.waiting), `a units report said waiting while the review ran (${JSON.stringify(units)})`).toBe(true);
    await expect
        .poll(async () => {
            units = (await door.ledger()).units.slice(unitsBefore).map((u) => u.report);
            return units.at(-1)?.waiting;
        }, { timeout: 60_000, message: "the last units report lets Mike rest" })
        .toBe(false);
});
