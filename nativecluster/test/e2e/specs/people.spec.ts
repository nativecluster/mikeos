/**
 * NativeCluster is Mike's only login (Pablo, 2026-11-24): each NativeCluster
 * person is a Mike user of their own, made on first use, the ticket's person
 * passed by the launcher as X-NC-Person. These replace a "two keys" test:
 *   (a) two people on one door see separate projects and documents;
 *   (b) a request naming no person is refused in words, 403;
 *   (c) the same person sees their data after the app restarts.
 * Each test uses people of its own (fresh labels), so it starts with fresh
 * Mike accounts whatever ran before.
 */
import { test, expect, type Browser } from "@playwright/test";
import { PDF_FIXTURE } from "../../../../e2e/helpers";
import { createProject } from "../lib/projects";
import { completeOnboardingIfRequired } from "../shim/onboarding";
import { door, personHeaders, nobodyHeaders } from "../lib/door";

test.describe.configure({ mode: "serial" });

const NOBODY_WORDS = "Sign in to NativeCluster to use Mike.";
const stamp = Date.now().toString(36);

async function personPage(browser: Browser, baseURL: string | undefined, label: string) {
    const context = await browser.newContext({ baseURL, extraHTTPHeaders: personHeaders(label) });
    const page = await context.newPage();
    await page.goto("/assistant");
    await completeOnboardingIfRequired(page);
    return { context, page };
}

async function projectNames(api: { get: (u: string) => Promise<{ status(): number; json(): Promise<unknown> }> }) {
    const r = await api.get("/api/projects?include=documents");
    expect(r.status()).toBe(200);
    const body = (await r.json()) as unknown;
    const list = (Array.isArray(body) ? body : ((body as { projects?: unknown[] }).projects ?? [])) as { name: string; documents?: { filename?: string }[] }[];
    return list;
}

test("(a) two people on one computer see separate projects and documents", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const ann = await personPage(browser, baseURL, `ann-${stamp}`);
    const ben = await personPage(browser, baseURL, `ben-${stamp}`);
    const annProject = `Ann's matter ${stamp}`;
    const benProject = `Ben's matter ${stamp}`;

    await createProject(ann.page, annProject, PDF_FIXTURE);
    const annUrl = ann.page.url().split("?")[0];
    await createProject(ben.page, benProject);

    const annSees = await projectNames(ann.context.request);
    const benSees = await projectNames(ben.context.request);
    expect(annSees.map((p) => p.name)).toContain(annProject);
    expect(annSees.map((p) => p.name)).not.toContain(benProject);
    expect(benSees.map((p) => p.name)).toContain(benProject);
    expect(benSees.map((p) => p.name)).not.toContain(annProject);
    expect(annSees.find((p) => p.name === annProject)?.documents?.map((d) => d.filename)).toContain("test.pdf");
    expect(benSees.flatMap((p) => p.documents ?? []).map((d) => d.filename)).not.toContain("test.pdf");

    // On screen too: Ben's projects list never shows Ann's project, and
    // Ann's project's own address shows Ben nothing of it.
    await ben.page.goto("/projects");
    await expect(ben.page.getByText(benProject).first()).toBeVisible();
    await expect(ben.page.getByText(annProject)).toHaveCount(0);
    const annId = new URL(annUrl).pathname.split("/").filter(Boolean)[1];
    const direct = await ben.context.request.get(`/api/projects/${annId}`);
    expect(direct.status(), "Ben asking for Ann's project by its id").toBeGreaterThanOrEqual(400);
    await ben.page.goto(annUrl);
    await expect(ben.page.getByText("test.pdf")).toHaveCount(0);

    await ann.context.close();
    await ben.context.close();
});

test("(b) a request naming no NativeCluster person is refused in words", async ({ browser, baseURL, playwright }) => {
    // The real host never passes such a request from a browser: it answers
    // 401 itself. The door's pass-nobody switch sends one on, to hold Mike to
    // its own refusal.
    const host = await playwright.request.newContext({ baseURL, extraHTTPHeaders: nobodyHeaders(false) });
    expect((await host.get("/assistant")).status(), "the host's own answer to nobody").toBe(401);
    await host.dispose();

    const nobody = await playwright.request.newContext({ baseURL, extraHTTPHeaders: nobodyHeaders(true) });
    const r = await nobody.get("/api/projects");
    expect(r.status()).toBe(403);
    expect(await r.text()).toContain(NOBODY_WORDS);
    await nobody.dispose();

    const context = await browser.newContext({ baseURL, extraHTTPHeaders: nobodyHeaders(true) });
    const page = await context.newPage();
    await page.goto("/assistant");
    await expect(page.getByText(NOBODY_WORDS).first()).toBeVisible({ timeout: 20_000 });
    await context.close();
});

test("(c) the same person sees their data after the app restarts", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const label = `cara-${stamp}`;
    const before = await personPage(browser, baseURL, label);
    const name = `Kept across a restart ${stamp}`;
    await createProject(before.page, name, PDF_FIXTURE);
    await before.context.close();

    const restarted = (await door.restart()) as { stopped: { exit: unknown; leftAfterExit: unknown[] } };
    expect(restarted.stopped.leftAfterExit, "processes left behind by the stop").toEqual([]);

    const after = await personPage(browser, baseURL, label);
    const list = await projectNames(after.context.request);
    const kept = list.find((p) => p.name === name);
    expect(kept, `${label}'s project after the restart`).toBeTruthy();
    expect(kept?.documents?.map((d) => d.filename)).toContain("test.pdf");
    await after.page.goto("/projects");
    await expect(after.page.getByText(name).first()).toBeVisible();
    await after.context.close();
});
