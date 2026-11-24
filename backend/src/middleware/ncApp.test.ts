import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => {
    throw new Error("a refused route reaches nothing");
  },
}));

import { unavailableInNcApp } from "./ncApp";
import { userRouter } from "../modules/user/user.routes";

describe("routes NativeCluster owns in its app", () => {
  afterEach(() => {
    delete process.env.MIKE_NC_APP;
  });

  it("are refused in the app and passed on elsewhere", async () => {
    const app = express();
    app.post("/thing", unavailableInNcApp, (_req, res) => res.json({ ok: true }));
    process.env.MIKE_NC_APP = "1";
    const refused = await request(app).post("/thing");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("nc_app_unavailable");
    delete process.env.MIKE_NC_APP;
    expect((await request(app).post("/thing")).body).toEqual({ ok: true });
  });

  it.each([
    ["delete", "/account"],
    ["post", "/security/password-set"],
    ["patch", "/security/mfa-login"],
  ] as const)("include %s /user%s, before it asks anything", async (method, path) => {
    process.env.MIKE_NC_APP = "1";
    const app = express();
    app.use(express.json());
    app.use("/user", userRouter);
    const response = await request(app)[method](`/user${path}`).set("X-NC-Person", "p_alice");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("nc_app_unavailable");
  });
});
