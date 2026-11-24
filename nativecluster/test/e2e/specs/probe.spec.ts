/**
 * The Node probe (Mike's stand-in package) in a browser, through the front
 * door: Next renders in the app's process, the page's own fetches reach the
 * probe's routes, a route handler and a cached page with tickets the door
 * signs, and its report is kept.
 */
import { test, expect } from "@playwright/test";
import { personHeaders } from "../lib/door";

test.use({ extraHTTPHeaders: personHeaders("alice") });

test("the probe's page renders on the server and its client finishes its round", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Node probe" })).toBeVisible();
    await expect(page.locator("#ssr")).toContainText("Rendered on the server");
    // The client asks /api-probe, a Next route, a public file and the cached
    // page three times (with a revalidation between), then posts its report.
    await expect(page.locator("#probe")).toContainText("report kept: 200", { timeout: 45_000 });
    const lines = await page.locator("#probe").innerText();
    expect(lines).toMatch(/\/api-probe -> 200/);
    expect(lines).toMatch(/\/api\/next-ping -> 200/);
    expect(lines).toMatch(/\/hello\.txt -> 200/);
    expect(lines).not.toMatch(/-> (403|404|5\d\d)/);
});

test("the probe's summary says Next, PGlite and its stack ran", async ({ request }) => {
    const r = await request.get("/api-probe");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.next.ok).toBe(true);
    for (const k of ["a_runtime_and_files", "b_node_sqlite", "c_pglite", "d_webassembly", "e_worker_threads", "f_child_process_textutil"]) {
        expect(body.summary[k], k).toBe("ok");
    }
});

test("Next's route handler sees the host's Host header, never an absolute address of its own", async ({ request }) => {
    const r = await request.get("/api/next-ping");
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.host).toMatch(/^127\.0\.0\.1:\d+$/);
});
