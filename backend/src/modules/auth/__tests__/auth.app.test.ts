// The auth routes in the NativeCluster app (MIKE_NC_APP=1), where
// NativeCluster is Mike's only sign-in and GoTrue does not run: the session
// is the person the launcher names, the options offer nothing, signing out is
// NativeCluster's, and every other route is refused before it reaches GoTrue.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  createRequestSupabase: vi.fn(() => {
    throw new Error("no GoTrue client in the app");
  }),
  listUsers: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../../lib/authSession", () => ({
  createRequestSupabase: mocks.createRequestSupabase,
  clearRequestAuthCookies: vi.fn(),
  publicAuthUser: vi.fn(),
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => ({
    rpc: mocks.rpc,
    auth: { admin: { listUsers: mocks.listUsers } },
  }),
}));

import { authRouter } from "../auth.routes";
import { resetSignInOptionsCache } from "../auth.service";
import { resetNcPersonAccounts } from "../../../lib/authNcPeople";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);

const ORIGIN = "https://127.0.0.1:8493";
const HOST = "127.0.0.1:8493";

describe("auth routes in the NativeCluster app", () => {
  beforeEach(() => {
    process.env.MIKE_NC_APP = "1";
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://mike.example.test";
    process.env.MIKE_FIRST_RUN_SETUP = "true";
    resetNcPersonAccounts();
    resetSignInOptionsCache();
    mocks.rpc.mockReset().mockResolvedValue({
      data: [{ user_id: "user-1", email: "alice@firm.example" }],
      error: null,
    });
    mocks.createRequestSupabase.mockClear();
    mocks.listUsers.mockReset();
    vi.stubGlobal("fetch", mocks.fetch.mockReset());
  });
  afterEach(() => {
    delete process.env.MIKE_NC_APP;
    delete process.env.MIKE_FIRST_RUN_SETUP;
    vi.unstubAllGlobals();
  });

  it("answers the session as the NativeCluster person's account", async () => {
    const response = await request(app)
      .get("/auth/session")
      .set("X-NC-Person", "p_alice")
      .set("X-NC-Person-Email", "alice@firm.example");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: "user-1",
        email: "alice@firm.example",
        pendingEmail: null,
        createdWithGoogle: false,
      },
    });
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
  });

  it("answers no session while nobody is signed in to NativeCluster", async () => {
    const response = await request(app).get("/auth/session");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_person_required");
  });

  it("offers no sign-in of its own, asking GoTrue nothing", async () => {
    const response = await request(app).get("/auth/options");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ google: false, sso: false, setupRequired: false, signup: false });
    expect(mocks.listUsers).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("has nothing of Mike's to sign out", async () => {
    const response = await request(app)
      .post("/auth/logout")
      .set("Host", HOST)
      .set("Origin", ORIGIN)
      .send({ scope: "local" });
    expect(response.status).toBe(204);
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
  });

  it.each([
    ["post", "/auth/login"],
    ["post", "/auth/signup"],
    ["post", "/auth/setup"],
    ["post", "/auth/oauth"],
    ["post", "/auth/exchange"],
    ["post", "/auth/handoff"],
    ["post", "/auth/password-reset"],
    ["patch", "/auth/email"],
    ["patch", "/auth/password"],
    ["get", "/auth/mfa/factors"],
    ["get", "/auth/mfa/assurance"],
    ["post", "/auth/mfa/enroll"],
    ["post", "/auth/mfa/challenge"],
    ["post", "/auth/mfa/verify"],
    ["post", "/auth/mfa/challenge-and-verify"],
    ["delete", "/auth/mfa/factors/7f1f9a52-8d7b-4a77-9b8e-2b1e3d2c1a00"],
  ] as const)("refuses %s %s, which is NativeCluster's", async (method, path) => {
    const response = await request(app)
      [method](path)
      .set("Host", HOST)
      .set("Origin", ORIGIN)
      .set("X-NC-Person", "p_alice")
      .send({ email: "alice@firm.example", password: "a long enough password" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_app_unavailable");
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("accepts the request's own origin and refuses another app's port", async () => {
    const other = await request(app)
      .post("/auth/logout")
      .set("Host", HOST)
      .set("Origin", "https://127.0.0.1:8494");
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("untrusted_origin");
  });

  it("leaves every route to other deployments", async () => {
    delete process.env.MIKE_NC_APP;
    const response = await request(app)
      .post("/auth/login")
      .set("Origin", "https://mike.example.test")
      .send({ email: "alice@firm.example", password: "correct horse" });
    // The cookie client is asked (here it throws, which is a 500): no refusal.
    expect(response.body.code).not.toBe("nc_app_unavailable");
    expect(mocks.createRequestSupabase).toHaveBeenCalled();
  });
});
