// The auth routes in the NativeCluster app (MIKE_NC_APP=1): the host drops
// every Set-Cookie, so the tokens travel in JSON bodies; each Mike account is
// bound to the NativeCluster person who first signed in with it; and the
// app's origin, https://127.0.0.1:<port>, is the request's own.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appClient: {
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
      getUser: vi.fn(),
      mfa: { challengeAndVerify: vi.fn(), verify: vi.fn() },
    },
  },
  createAppAuthSupabase: vi.fn(),
  createAppSessionSupabase: vi.fn(),
  createRequestSupabase: vi.fn(),
  clearRequestAuthCookies: vi.fn(),
  adminSignOut: vi.fn(),
  bindings: new Map<string, string>(),
  reportError: vi.fn((..._args: unknown[]) => "event-1"),
}));

vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError: mocks.reportError,
}));
vi.mock("../../../lib/authAppSession", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAppAuthSupabase: mocks.createAppAuthSupabase,
  createAppSessionSupabase: mocks.createAppSessionSupabase,
}));
vi.mock("../../../lib/authSession", () => ({
  createRequestSupabase: mocks.createRequestSupabase,
  clearRequestAuthCookies: mocks.clearRequestAuthCookies,
  publicAuthUser: (user: { id: string; email?: string }) => ({
    id: user.id,
    email: user.email ?? "",
    pendingEmail: null,
    createdWithGoogle: false,
  }),
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: {
      admin: { signOut: mocks.adminSignOut, listUsers: vi.fn() },
    },
    from: (table: string) => {
      expect(table).toBe("nativecluster_account_people");
      let userId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          userId = value;
          return query;
        },
        maybeSingle: async () => {
          const person = mocks.bindings.get(userId);
          return { data: person ? { nc_person: person } : null, error: null };
        },
        upsert: async (row: { user_id: string; nc_person: string }) => {
          if (!mocks.bindings.has(row.user_id)) mocks.bindings.set(row.user_id, row.nc_person);
          return { error: null };
        },
      };
      return query;
    },
  }),
}));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.authSource = "app";
    res.locals.token = "access-1";
    res.locals.authUser = { id: "user-1" };
    next();
  },
}));

import { authRouter } from "../auth.routes";
import { resetSignInOptionsCache } from "../auth.service";
import { resetAccountPersonCache } from "../../../lib/authPersonBinding";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);

const ORIGIN = "https://127.0.0.1:8493";
const HOST = "127.0.0.1:8493";
const user = { id: "user-1", email: "lawyer@example.test" };
const session = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: "bearer",
  user,
};

function post(path: string, person = "p_alice") {
  return request(app)
    .post(path)
    .set("Host", HOST)
    .set("Origin", ORIGIN)
    .set("X-NC-Person", person);
}

describe("auth routes in the NativeCluster app", () => {
  beforeEach(() => {
    process.env.MIKE_NC_APP = "1";
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://mike.example.test";
    mocks.bindings.clear();
    resetAccountPersonCache();
    for (const fn of [
      ...Object.values(mocks.appClient.auth).filter((v) => typeof v === "function"),
      ...Object.values(mocks.appClient.auth.mfa),
    ]) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
    mocks.createAppAuthSupabase.mockReset().mockReturnValue(mocks.appClient);
    mocks.createAppSessionSupabase.mockReset().mockReturnValue(mocks.appClient);
    mocks.createRequestSupabase.mockReset();
    mocks.clearRequestAuthCookies.mockReset();
    mocks.adminSignOut.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.reportError.mockClear();
  });
  afterEach(() => {
    delete process.env.MIKE_NC_APP;
  });

  it("answers a log-in's tokens in the body, sets no cookie, and binds the account", async () => {
    mocks.appClient.auth.signInWithPassword.mockResolvedValue({
      data: { user, session },
      error: null,
    });
    const response = await post("/auth/login").send({
      email: user.email,
      password: "correct horse",
    });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toEqual({
      user: { id: "user-1", email: user.email, pendingEmail: null, createdWithGoogle: false },
      session: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        expires_at: 1_900_000_000,
        token_type: "bearer",
      },
    });
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
    expect(mocks.bindings.get("user-1")).toBe("p_alice");
  });

  it("refuses another NativeCluster person's account and revokes the session it made", async () => {
    mocks.bindings.set("user-1", "p_alice");
    mocks.appClient.auth.signInWithPassword.mockResolvedValue({
      data: { user, session },
      error: null,
    });
    const response = await post("/auth/login", "p_bob").send({
      email: user.email,
      password: "correct horse",
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_person_mismatch");
    expect(response.body.detail).toMatch(/belongs to another NativeCluster person on this computer/);
    expect(JSON.stringify(response.body)).not.toContain("access-1");
    expect(mocks.adminSignOut).toHaveBeenCalledWith("access-1", "local");
  });

  it.each(["/auth/login", "/auth/signup"])(
    "refuses %s while nobody is signed in to NativeCluster, before asking GoTrue",
    async (path) => {
      const response = await post(path, "").send({
        email: user.email,
        password: "a long enough password",
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("nc_person_required");
      expect(mocks.appClient.auth.signInWithPassword).not.toHaveBeenCalled();
      expect(mocks.appClient.auth.signUp).not.toHaveBeenCalled();
    },
  );

  it("answers a sign-up that GoTrue confirmed at once with its session, bound", async () => {
    mocks.appClient.auth.signUp.mockResolvedValue({
      data: { user, session },
      error: null,
    });
    const response = await post("/auth/signup").send({
      email: user.email,
      password: "a long enough password",
    });
    expect(response.status).toBe(201);
    expect(response.body.requiresEmailConfirmation).toBe(false);
    expect(response.body.session.refresh_token).toBe("refresh-1");
    expect(mocks.bindings.get("user-1")).toBe("p_alice");
    // The redirect GoTrue would mail is the app's own origin.
    expect(mocks.appClient.auth.signUp.mock.calls[0][0].options.emailRedirectTo).toMatch(
      /^https:\/\/127\.0\.0\.1:8493\/auth\/callback\?/,
    );
  });

  it("refreshes with the refresh token the browser keeps, rotated pair in the body", async () => {
    mocks.bindings.set("user-1", "p_alice");
    mocks.appClient.auth.refreshSession.mockResolvedValue({
      data: { user, session: { ...session, access_token: "access-2", refresh_token: "refresh-2" } },
      error: null,
    });
    const response = await post("/auth/refresh").send({ refresh_token: "refresh-1" });
    expect(response.status).toBe(200);
    expect(mocks.appClient.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: "refresh-1" });
    expect(response.body.session).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-2",
    });
  });

  it("answers a refresh token GoTrue refused with a 401, and an outage with a 503", async () => {
    mocks.appClient.auth.refreshSession.mockResolvedValue({
      data: { user: null, session: null },
      error: { __isAuthError: true, name: "AuthApiError", status: 400, code: "refresh_token_already_used" },
    });
    const refused = await post("/auth/refresh").send({ refresh_token: "refresh-1" });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("session_expired");

    mocks.appClient.auth.refreshSession.mockResolvedValue({
      data: { user: null, session: null },
      error: { __isAuthError: true, name: "AuthRetryableFetchError", status: 0 },
    });
    const outage = await post("/auth/refresh").send({ refresh_token: "refresh-1" });
    expect(outage.status).toBe(503);
  });

  it("refuses a refresh under another NativeCluster person", async () => {
    mocks.bindings.set("user-1", "p_alice");
    mocks.appClient.auth.refreshSession.mockResolvedValue({
      data: { user, session: { ...session, access_token: "access-2" } },
      error: null,
    });
    const response = await post("/auth/refresh", "p_bob").send({ refresh_token: "refresh-1" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_person_mismatch");
    expect(mocks.adminSignOut).toHaveBeenCalledWith("access-2", "local");
  });

  it("has no refresh route off the app", async () => {
    delete process.env.MIKE_NC_APP;
    const response = await request(app)
      .post("/auth/refresh")
      .set("Origin", "https://mike.example.test")
      .send({ refresh_token: "refresh-1" });
    expect(response.status).toBe(404);
  });

  it("signs out the presented session in GoTrue and clears no cookie", async () => {
    mocks.appClient.auth.signOut.mockResolvedValue({ error: null });
    const response = await post("/auth/logout")
      .set("X-Mike-Session", "access-1")
      .send({ scope: "local" });
    expect(response.status).toBe(204);
    expect(mocks.createAppSessionSupabase).toHaveBeenCalledWith("access-1");
    expect(mocks.appClient.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.clearRequestAuthCookies).not.toHaveBeenCalled();
  });

  it("answers the session through the token the request presented", async () => {
    mocks.appClient.auth.getUser.mockResolvedValue({ data: { user }, error: null });
    const response = await request(app).get("/auth/session").set("X-NC-Person", "p_alice");
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe("user-1");
    expect(mocks.createAppSessionSupabase).toHaveBeenCalledWith("access-1", { id: "user-1" });
  });

  it("answers the aal2 tokens an MFA verification issues", async () => {
    mocks.appClient.auth.mfa.challengeAndVerify.mockResolvedValue({
      data: {
        access_token: "access-aal2",
        refresh_token: "refresh-aal2",
        expires_in: 3600,
        token_type: "bearer",
        user,
      },
      error: null,
    });
    const response = await post("/auth/mfa/challenge-and-verify").send({
      factorId: "7f1f9a52-8d7b-4a77-9b8e-2b1e3d2c1a00",
      code: "123456",
    });
    expect(response.status).toBe(200);
    expect(response.body.session).toMatchObject({
      access_token: "access-aal2",
      refresh_token: "refresh-aal2",
    });
  });

  it.each(["/auth/oauth", "/auth/exchange", "/auth/handoff", "/auth/password-reset"])(
    "refuses %s, which needs a cookie or a redirect",
    async (path) => {
      const response = await post(path).send({ provider: "google", code: "x", email: user.email });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("nc_app_unavailable");
      expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
    },
  );

  it("accepts the request's own origin and refuses another app's port", async () => {
    const other = await request(app)
      .post("/auth/login")
      .set("Host", HOST)
      .set("Origin", "https://127.0.0.1:8494")
      .set("X-NC-Person", "p_alice")
      .send({ email: user.email, password: "correct horse" });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("untrusted_origin");
  });

  it("offers email and password alone", async () => {
    resetSignInOptionsCache();
    const response = await request(app).get("/auth/options");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ google: false, sso: false, signup: true });
  });
});
