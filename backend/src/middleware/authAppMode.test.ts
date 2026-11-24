// requireAuth in the NativeCluster app (MIKE_NC_APP=1): no cookies, the
// access token in X-Mike-Session, and two keys, Mike's account AND the
// NativeCluster person the launcher names in X-NC-Person.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createRequestSupabase: vi.fn(),
  clearRequestAuthCookies: vi.fn(),
  bindings: new Map<string, string>(),
}));
vi.mock("../lib/log", () => ({ devLog: vi.fn(), isDev: false, log: { warn: vi.fn() } }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: async () => null }));
vi.mock("../lib/authSession", () => ({
  createRequestSupabase: mocks.createRequestSupabase,
  clearRequestAuthCookies: mocks.clearRequestAuthCookies,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: { getUser: mocks.getUser, mfa: { getAuthenticatorAssuranceLevel: vi.fn() } },
    from: (table: string) => {
      let userId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          userId = value;
          return query;
        },
        maybeSingle: async () => {
          if (table !== "nativecluster_account_people") return { data: null, error: null };
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

import { requireAuth } from "./auth";
import { resetAccountPersonCache } from "../lib/authPersonBinding";

const app = express();
app.get("/projects", requireAuth, (_req, res) =>
  res.json({ userId: res.locals.userId, source: res.locals.authSource }),
);
app.post("/projects", requireAuth, (_req, res) => res.json({ ok: true }));

const user = {
  id: "user-1",
  email: "lawyer@example.test",
  email_confirmed_at: "2026-11-24T00:00:00Z",
};

describe("requireAuth in the NativeCluster app", () => {
  beforeEach(() => {
    process.env.MIKE_NC_APP = "1";
    mocks.bindings.clear();
    resetAccountPersonCache();
    mocks.getUser.mockReset().mockImplementation(async (token: string) =>
      token === "good-token"
        ? { data: { user }, error: null }
        : { data: { user: null }, error: null },
    );
  });
  afterEach(() => {
    delete process.env.MIKE_NC_APP;
  });

  it("takes the session from X-Mike-Session and binds the account on its first use", async () => {
    const response = await request(app)
      .get("/projects")
      .set("X-Mike-Session", "good-token")
      .set("X-NC-Person", "p_alice");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "user-1", source: "app" });
    expect(mocks.getUser).toHaveBeenCalledWith("good-token");
    expect(mocks.bindings.get("user-1")).toBe("p_alice");
  });

  it("refuses a Mike session presented under another NativeCluster person", async () => {
    mocks.bindings.set("user-1", "p_alice");
    const response = await request(app)
      .get("/projects")
      .set("X-Mike-Session", "good-token")
      .set("X-NC-Person", "p_bob");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_person_mismatch");
    expect(response.body.detail).toMatch(/another NativeCluster person on this computer/);
  });

  it("refuses a Mike session when nobody is signed in to NativeCluster", async () => {
    mocks.bindings.set("user-1", "p_alice");
    const response = await request(app)
      .get("/projects")
      .set("X-Mike-Session", "good-token")
      .set("X-NC-Person", "");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_person_required");
  });

  it("never reads a cookie: without a token it is a 401", async () => {
    const response = await request(app)
      .get("/projects")
      .set("Cookie", "mike-session=stale")
      .set("X-NC-Person", "p_alice");
    expect(response.status).toBe(401);
    expect(mocks.createRequestSupabase).not.toHaveBeenCalled();
    expect(mocks.clearRequestAuthCookies).not.toHaveBeenCalled();
  });

  it("needs no Origin for a write: the token is the proof, not a cookie", async () => {
    const response = await request(app)
      .post("/projects")
      .set("X-Mike-Session", "good-token")
      .set("X-NC-Person", "p_alice");
    expect(response.status).toBe(200);
  });

  it("answers a token GoTrue does not know with a 401 the client refreshes on", async () => {
    const response = await request(app)
      .get("/projects")
      .set("X-Mike-Session", "expired-token")
      .set("X-NC-Person", "p_alice");
    expect(response.status).toBe(401);
    expect(mocks.bindings.size).toBe(0);
  });

  it("leaves other deployments' Bearer path and person-less requests alone", async () => {
    delete process.env.MIKE_NC_APP;
    const response = await request(app)
      .get("/projects")
      .set("Authorization", "Bearer good-token");
    expect(response.status).toBe(200);
    expect(response.body.source).toBeUndefined();
    expect(mocks.bindings.size).toBe(0);
  });
});
