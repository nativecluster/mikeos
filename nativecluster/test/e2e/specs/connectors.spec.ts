/**
 * Settings → Connectors in Mike's NativeCluster app: every button it offers
 * opens a dialog that works, and none answers 400 or shows "Could not add
 * connector" (Pablo, 2026-11-24: "these buttons are broken").
 *
 * The app reaches the real services, as its own internet does in
 * NativeCluster: Notion, Airtable, Linear, Lawve and Legal Data Hunter
 * register Mike as a client (RFC 7591) and give a sign-in link; DeepWiki
 * (which needs no token, and takes one) and Sentry stand for a custom server
 * with a token and one that signs in. No sign-in is ever completed and no
 * person's data is sent. HARNESS_NO_INTERNET=1 skips this file.
 *
 * Each request passes on as from NativeCluster's app origin
 * (X-Harness-App-Origin): the app builds the sign-in's way back from it.
 */
import { test, expect, type Page, type Response } from "@playwright/test";
import { completeOnboardingIfRequired } from "../shim/onboarding";
import { personHeaders } from "../lib/door";

test.describe.configure({ mode: "serial" });
test.skip(process.env.HARNESS_NO_INTERNET === "1", "HARNESS_NO_INTERNET=1: the connectors reach the real services");

const APP_ORIGIN = "https://127.0.0.1:8494";
const stamp = Date.now().toString(36);

/** Each preset the app offers, and where its sign-in link must go. */
const SIGN_IN_HOSTS: Record<string, string> = {
    Notion: "mcp.notion.com",
    Airtable: "airtable.com",
    Linear: "mcp.linear.app",
    Lawve: "cloud.baguettedynamics.com",
    "Legal Data Hunter": "legaldatahunter.com",
};

type Failure = { method: string; path: string; status: number; body: string };

async function connectorsPage(browser: import("@playwright/test").Browser, baseURL: string | undefined, label: string) {
    const context = await browser.newContext({
        baseURL,
        extraHTTPHeaders: { ...personHeaders(label), "x-harness-app-origin": APP_ORIGIN },
    });
    const page = await context.newPage();
    const failures: Failure[] = [];
    page.on("response", async (r: Response) => {
        const url = new URL(r.url());
        if (!url.pathname.startsWith("/api/") || r.status() < 400) return;
        failures.push({ method: r.request().method(), path: url.pathname, status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) });
    });
    // The app's window opens no popup: a page that tried would fail there.
    page.on("popup", (p) => failures.push({ method: "POPUP", path: p.url(), status: 0, body: "" }));
    await page.goto("/assistant");
    await completeOnboardingIfRequired(page);
    return { context, page, failures };
}

async function openConnectors(page: Page) {
    await page.goto("/settings/connectors");
    await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add custom connector" })).toBeVisible();
    // Placeholders until every source answered.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

/** The Connect dialog for `name`: a sign-in link to `host`, and the box for the address. */
async function expectConnectDialog(page: Page, name: string, host: string) {
    const dialog = page.getByRole("dialog").filter({ hasText: `Connect ${name}` });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const link = dialog.getByRole("link", { name: "Open the sign-in page" });
    const href = await link.getAttribute("href");
    expect(href, `${name}'s sign-in link`).toBeTruthy();
    const url = new URL(href!);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(host);
    // The way back is the app's own page on its origin.
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP_ORIGIN}/api/user/mcp-connectors/oauth/callback`);
    expect(await link.getAttribute("target")).toBe("_blank");
    await expect(dialog.getByLabel("Address from your browser")).toBeVisible();
    return dialog;
}

test("every connector button opens a dialog that works, with no 400 and no failure", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const { context, page, failures } = await connectorsPage(browser, baseURL, `conn-${stamp}`);
    await openConnectors(page);

    // Slack signs in only with a Slack app a company registered, and Mike's
    // package has none: not offered. Neither is any Google connector.
    await expect(page.getByRole("button", { name: "Add Slack connector" })).toHaveCount(0);
    for (const google of ["Google Drive", "Gmail", "Google Calendar"])
        await expect(page.getByRole("button", { name: `Add ${google} connector` })).toHaveCount(0);

    const offered = await page.getByRole("button", { name: /^Add .* connector$/ }).evaluateAll((els) =>
        els.map((el) => el.getAttribute("aria-label") ?? ""),
    );
    const presets = offered.map((label) => label.replace(/^Add (.*) connector$/, "$1")).filter((name) => name !== "custom" && name !== "CourtListener");
    expect(presets.sort()).toEqual(Object.keys(SIGN_IN_HOSTS).sort());
    expect(offered).toContain("Add CourtListener connector");
    expect(offered).toContain("Add custom connector");

    // Each preset: Add opens the Connect dialog; Cancel takes the connector
    // away again, and its card is back in Discover.
    for (const name of presets) {
        await page.getByRole("button", { name: `Add ${name} connector` }).click();
        const dialog = await expectConnectDialog(page, name, SIGN_IN_HOSTS[name]);
        await expect(page.getByText("Could not add connector")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("button", { name: `Add ${name} connector` })).toBeEnabled({ timeout: 15_000 });
    }

    // CourtListener: its key form saves, and it is installed.
    await page.getByRole("button", { name: "Add CourtListener connector" }).click();
    const keyDialog = page.getByRole("dialog").filter({ hasText: "CourtListener" });
    await keyDialog.getByLabel(/API token/).fill(`harness-not-a-real-token-${stamp}`);
    await keyDialog.getByRole("button", { name: "Save" }).click();
    await expect(keyDialog).toHaveCount(0);
    const installed = page.locator("section").filter({ has: page.getByRole("heading", { name: "Installed" }) });
    await expect(installed.getByText("CourtListener")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add CourtListener connector" })).toHaveCount(0);
    const status = await context.request.get("/api/user/integrations/courtlistener?workspace=personal");
    expect(await status.json()).toMatchObject({ installed: true, ownToken: true, enabled: true });

    // Custom, a server that takes a token: connected, its tools listed.
    await page.getByRole("button", { name: "Add custom connector" }).click();
    let custom = page.getByRole("dialog").filter({ hasText: "New Custom Connector" });
    await custom.getByPlaceholder("Connector label").fill("DeepWiki");
    await custom.getByPlaceholder("https://mcp.example.com/mcp").fill("https://mcp.deepwiki.com/mcp");
    await custom.getByPlaceholder("Bearer token").fill(`harness-not-a-real-token-${stamp}`);
    await custom.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(custom.getByText(/DeepWiki is connected\./)).toBeVisible({ timeout: 30_000 });
    await custom.getByRole("button", { name: "Done" }).click();
    await expect(installed.getByText("DeepWiki")).toBeVisible();
    const deepwiki = ((await (await context.request.get("/api/user/mcp-connectors?workspace=personal")).json()) as { name: string; authType: string; hasAuthConfig: boolean }[]).find(
        (c) => c.name === "DeepWiki",
    );
    expect(deepwiki).toMatchObject({ authType: "bearer", hasAuthConfig: true });

    // Custom, a server that signs in by registering Mike (Sentry's): the
    // same Connect dialog. A pasted address that is not this sign-in's is
    // refused in words inside it; Cancel goes back to the form.
    await page.getByRole("button", { name: "Add custom connector" }).click();
    custom = page.getByRole("dialog").filter({ hasText: "New Custom Connector" });
    await custom.getByPlaceholder("Connector label").fill("Sentry");
    await custom.getByPlaceholder("https://mcp.example.com/mcp").fill("https://mcp.sentry.dev/mcp");
    await custom.getByRole("button", { name: "Connect", exact: true }).click();
    const connect = await expectConnectDialog(page, "Sentry", "mcp.sentry.dev");
    await connect
        .getByLabel("Address from your browser")
        .fill(`${APP_ORIGIN}/api/user/mcp-connectors/oauth/callback?code=not-a-code&state=not-this-sign-in`);
    await connect.getByRole("button", { name: "Connect" }).click();
    await expect(connect.getByRole("alert")).toHaveText("That address is for another or an expired authorization. Start again.");
    await connect.getByRole("button", { name: "Cancel" }).click();
    await expect(connect).toHaveCount(0);
    await expect(custom.getByPlaceholder("Connector label")).toHaveValue("Sentry");
    await custom.getByRole("button", { name: "Cancel" }).click();

    // No 400 anywhere but the address refused on purpose, and no popup.
    const unexpected = failures.filter(
        (f) => !(f.method === "POST" && /\/oauth\/complete$/.test(f.path) && f.status === 400 && f.body.includes("oauth_state_invalid")),
    );
    expect(unexpected, "requests that failed").toEqual([]);
    expect(failures.length, "the one refusal on purpose").toBe(1);
    await expect(page.getByText("Could not add connector")).toHaveCount(0);
    await context.close();
});
