import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Response } from "express";

// The 2026-11-24 security review, M1: in Mike's NativeCluster app sharing
// and organizations were off in the pages alone. One copy of Mike serves
// everyone who opens it on a computer, and a grant is keyed by an email
// NativeCluster gives every account, so B could share B's project or
// workflow straight into A's lists (B's documents and prompts beside A's,
// with A's connectors), or make an organization and invite A. Every route
// that shares, gives access, makes an organization or invites is refused in
// the app, before it reads anything; and every writer of a grant refuses
// too, whoever calls it.

const { dbTouched } = vi.hoisted(() => ({ dbTouched: vi.fn() }));
const untouchable = () =>
    new Proxy(
        {},
        {
            get(_target, key) {
                dbTouched(String(key));
                throw new Error(`a refused share reached the database (${String(key)})`);
            },
        },
    );

vi.mock("../../lib/supabase", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/supabase")>()),
    createServerSupabase: vi.fn(() => untouchable()),
}));
vi.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: Response, next: () => void) => {
        res.locals.userId = "user-bob";
        res.locals.userEmail = "bob@firm.example";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: Response, next: () => void) => next(),
}));

import { app } from "../../app";
import type { Db } from "../../lib/supabase";
import { NC_APP_SHARING_OFF_DETAIL } from "../../lib/authApp";
import { upsertProjectGrant } from "../../lib/projectAccess";
import { upsertContentGrant } from "../../lib/contentAccess";
import { setOrgAccessOverride, setOrgAccessOverrides } from "../../lib/orgAccessOverrides";
import { acceptInvitation, createInvitation, createOrg, resendInvitation, updateMember } from "../../lib/orgs";
import { shareWorkflow } from "../../modules/workflows/workflows.sharing";
import { sharePlaybook } from "../../modules/playbooks/playbooks.sharing";

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MIKE_NC_APP", "1");
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const ROUTES: Array<[method: "post" | "patch" | "put" | "delete", path: string, body?: object]> = [
    ["post", "/projects/p1/access", { email: "alice@firm.example", role: "owner" }],
    ["post", "/chat/c1/access", { email: "alice@firm.example", role: "viewer" }],
    ["post", "/tabular-review/r1/access", { email: "alice@firm.example", role: "viewer" }],
    ["post", "/workflows/w1/share", { emails: ["alice@firm.example"], role: "viewer" }],
    ["post", "/playbooks/44444444-4444-4444-4444-444444444444/share", { emails: ["alice@firm.example"], role: "viewer" }],
    ["post", "/orgs", { name: "Team" }],
    ["post", "/orgs/o1/invitations", { email: "alice@firm.example", role: "member" }],
    ["post", "/orgs/o1/invitations/i1/resend"],
    ["patch", "/orgs/o1/members/u2", { role: "owner" }],
    ["delete", "/orgs/o1/members/u2"],
    ["put", "/orgs/o1/members/u2/private-content-permission", { allowed: true }],
    ["post", "/orgs/o1/private-content/project/x1/open"],
    ["post", "/orgs/o1/archives/recover", { archive_ids: ["a1"] }],
    ["post", "/orgs/o1/restore"],
    ["post", "/user/invitations/i1/accept"],
    // Express routes a path whatever its case (review L1).
    ["post", "/Projects/p1/ACCESS", { email: "alice@firm.example", role: "owner" }],
    ["post", "/ORGS/", { name: "Team" }],
];

describe("sharing in the NativeCluster app", () => {
    it.each(ROUTES)("refuses %s %s in words, before it reads anything", async (method, path, body) => {
        const res = await request(app)[method](path).send(body ?? {});
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ code: "nc_app_unavailable", detail: NC_APP_SHARING_OFF_DETAIL });
        expect(dbTouched).not.toHaveBeenCalled();
    });

    it("still answers reads: the organizations list reaches its route", async () => {
        const res = await request(app).get("/orgs");
        expect(res.body.code).not.toBe("nc_app_unavailable");
        expect(dbTouched).toHaveBeenCalled();
    });

    it("is as before elsewhere: each route reaches its handler", async () => {
        vi.stubEnv("MIKE_NC_APP", "");
        for (const [method, path, body] of ROUTES) {
            dbTouched.mockClear();
            const res = await request(app)[method](path).send(body ?? {});
            expect(res.body.code, `${method} ${path}`).not.toBe("nc_app_unavailable");
            expect(dbTouched, `${method} ${path}`).toHaveBeenCalled();
        }
    });
});

describe("every writer of a grant in the NativeCluster app", () => {
    const db = () => untouchable() as Db;

    it("writes nothing, whoever calls it", async () => {
        expect(
            await upsertProjectGrant(db(), { projectId: "p1", email: "alice@firm.example", role: "owner", createdBy: "u" }),
        ).toEqual({ ok: false, kind: "validation", detail: NC_APP_SHARING_OFF_DETAIL });
        for (const kind of ["chat", "tabular_review"] as const) {
            expect(
                await upsertContentGrant(db(), { kind, resourceId: "r1", email: "alice@firm.example", role: "viewer", createdBy: "u" }),
            ).toEqual({ ok: false, kind: "validation", detail: NC_APP_SHARING_OFF_DETAIL });
        }
        for (const kind of ["project", "workflow", "playbook"] as const) {
            expect(
                await setOrgAccessOverride(db(), { kind, resourceId: "r1", orgId: "o1", userId: "u2", role: "owner", assignedBy: "u" }),
            ).toEqual({ ok: false, detail: NC_APP_SHARING_OFF_DETAIL });
            expect(
                await setOrgAccessOverrides(db(), { kind, resourceId: "r1", orgId: "o1", userIds: ["u2"], role: "owner", assignedBy: "u" }),
            ).toEqual({ ok: false, detail: NC_APP_SHARING_OFF_DETAIL });
        }
        expect(
            await shareWorkflow(db(), { workflowId: "w1", userId: "u", userEmail: "bob@firm.example", emails: ["alice@firm.example"], role: "viewer" }),
        ).toEqual({ ok: false, kind: "validation", detail: NC_APP_SHARING_OFF_DETAIL });
        await expect(
            sharePlaybook("u", "bob@firm.example", "pb1", { emails: ["alice@firm.example"], role: "viewer" }, db()),
        ).rejects.toMatchObject({ status: 403, message: NC_APP_SHARING_OFF_DETAIL });
        expect(await createOrg(db(), { userId: "u", name: "Team" })).toEqual({ ok: false, kind: "forbidden" });
        expect(
            await createInvitation(db(), { actorId: "u", orgId: "o1", email: "alice@firm.example", role: "member" }),
        ).toEqual({ ok: false, kind: "forbidden" });
        expect(await resendInvitation(db(), { actorId: "u", orgId: "o1", invitationId: "i1" })).toEqual({
            ok: false,
            kind: "forbidden",
        });
        expect(await acceptInvitation(db(), { userId: "u", userEmail: "alice@firm.example", invitationId: "i1" })).toEqual({
            ok: false,
            kind: "forbidden",
        });
        expect(await updateMember(db(), { actorId: "u", orgId: "o1", targetUserId: "u2", role: "owner" })).toEqual({
            ok: false,
            kind: "forbidden",
        });
        expect(dbTouched).not.toHaveBeenCalled();
    });
});
