// requireAuth in the NativeCluster app (MIKE_NC_APP=1): NativeCluster is the
// only sign-in. The person the launcher names in X-NC-Person is the caller,
// as the Mike account nc_ensure_user keeps for them; nothing reaches GoTrue.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  assurance: vi.fn(),
  createRequestSupabase: vi.fn(),
}));
vi.mock("../lib/log", () => ({ devLog: vi.fn(), isDev: false, log: { warn: vi.fn() } }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: async () => null }));
vi.mock("../lib/authSession", () => ({
  createRequestSupabase: mocks.createRequestSupabase,
  clearRequestAuthCookies: vi.fn(),
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    rpc: mocks.rpc,
    auth: { getUser: mocks.getUser, mfa: { getAuthenticatorAssuranceLevel: mocks.assurance } },
    from: () => {
      throw new Error("requireAuth reads no table in the app");
    },
  }),
}));

import { requireAuth, requireMfaIfEnrolled } from "./auth";
import { resetNcPersonAccounts } from "../lib/authNcPeople";

const app = express();
app.get("/projects", requireAuth, (_req, res) =>
  res.json({
    userId: res.locals.userId,
    userEmail: res.locals.userEmail,
    source: res.locals.authSource,
  }),
);
app.post("/user/api-keys", requireAuth, requireMfaIfEnrolled, (_req, res) => res.json({ ok: true }));

describe("requireAuth in the NativeCluster app", () => {
  beforeEach(() => {
    process.env.MIKE_NC_APP = "1";
    resetNcPersonAccounts();
    mocks.rpc
      .mockReset()
      .mockImplementation(async (_name: string, args: { p_person: string; p_email: string | null }) => ({
        data: [
          {
            user_id: `user-of-${args.p_person}`,
            email: args.p_email ?? `${args.p_person}@people.invalid`,
          },
        ],
        error: null,
      }));
    mocks.getUser.mockReset();
    mocks.assurance.mockReset();
    mocks.createRequestSupabase.mockReset();
  });
  afterEach(() => {
    delete process.env.MIKE_NC_APP;
  });

  it("is the person the launcher names, as their Mike account", async () => {
    const response = await request(app)
      .get("/projects")
      .set("X-NC-Person", "p_alice")
      .set("X-NC-Person-Email", "Alice@Firm.Example")
      .set("X-NC-Person-Name", "Alice Example");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: "user-of-p_alice",
      userEmail: "alice@firm.example",
      source: "nativecluster",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("nc_ensure_user", {
      p_person: "p_alice",
      p_email: "alice@firm.example",
      p_name: "Alice Example",
    });
  });

  it("uses <person>@people.invalid without people.read", async () => {
    const response = await request(app).get("/projects").set("X-NC-Person", "p_bob");
    expect(response.body.userEmail).toBe("p_bob@people.invalid");
  });

  it("refuses everyone while nobody is signed in to NativeCluster", async () => {
    for (const person of ["", "lawyer@example.test"]) {
      const response = await request(app).get("/projects").set("X-NC-Person", person);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        code: "nc_person_required",
        detail: "Sign in to NativeCluster to use Mike.",
      });
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never asks GoTrue, and takes no token or cookie as anyone", async () => {
    const response = await request(app)
      .get("/projects")
      .set("Authorization", "Bearer someone-elses-token")
      .set("Cookie", "mike-session=stale")
      .set("X-NC-Person", "p_alice");
    expect(response.body.userId).toBe("user-of-p_alice");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
  });

  it("puts no Mike MFA in front of sensitive routes", async () => {
    const response = await request(app).post("/user/api-keys").set("X-NC-Person", "p_alice");
    expect(response.status).toBe(200);
    expect(mocks.assurance).not.toHaveBeenCalled();
  });

  it("fails closed when the account cannot be made", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "no function" } });
    const response = await request(app).get("/projects").set("X-NC-Person", "p_alice");
    expect(response.status).toBe(500);
  });

  it("leaves other deployments' sessions alone", async () => {
    delete process.env.MIKE_NC_APP;
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await request(app)
      .get("/projects")
      .set("Authorization", "Bearer token")
      .set("X-NC-Person", "p_alice");
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
