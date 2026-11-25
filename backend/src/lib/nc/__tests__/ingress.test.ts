import { PassThrough } from "node:stream";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentNcScope, ncOriginFor } from "../context";
import { ncIngress, ncIngressEnabled } from "../ingress";
import {
  applyLaunchConfigSecrets,
  internalSecretMatches,
  launchSecrets,
  ncAppCredential,
  parseLaunchSecrets,
  readLaunchSecrets,
  resetLaunchSecrets,
} from "../launchSecrets";
import { setNcTickHandler } from "../tick";

const SECRET = "a".repeat(64);
const CREDENTIAL = "app-credential-for-the-host";

afterEach(() => {
  resetLaunchSecrets();
  setNcTickHandler(null);
  vi.unstubAllEnvs();
});

describe("the launcher's secrets on stdin", () => {
  // Review M3: the stack's keys were in the backend's environment, which any
  // program of the same macOS user reads (KERN_PROCARGS2, `ps -E`).
  it("carries the stack's keys too, into this process's memory alone", async () => {
    const line = {
      app_credential: CREDENTIAL,
      internal_secret: SECRET,
      supabase_publishable_key: "anon.jwt",
      supabase_secret_key: "service-role.jwt",
      download_signing_secret: "d".repeat(64),
      user_api_keys_encryption_secret: "u".repeat(64),
    };
    const input = new PassThrough();
    const reading = readLaunchSecrets(input);
    input.write(JSON.stringify(line) + "\n");
    await expect(reading).resolves.toMatchObject({ appCredential: CREDENTIAL, internalSecret: SECRET });
    const env: NodeJS.ProcessEnv = { SUPABASE_SECRET_KEY: "from the environment" };
    expect(applyLaunchConfigSecrets(env).sort()).toEqual([
      "DOWNLOAD_SIGNING_SECRET",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "USER_API_KEYS_ENCRYPTION_SECRET",
    ]);
    expect(env).toEqual({
      SUPABASE_PUBLISHABLE_KEY: "anon.jwt",
      SUPABASE_SECRET_KEY: "service-role.jwt",
      DOWNLOAD_SIGNING_SECRET: "d".repeat(64),
      USER_API_KEYS_ENCRYPTION_SECRET: "u".repeat(64),
    });
    input.end();
  });

  it("refuses a stack key that is empty or not a string, without saying it", () => {
    for (const bad of ["", 42, null]) {
      const line = JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET, supabase_secret_key: bad });
      expect(() => parseLaunchSecrets(line)).toThrow(/supabase_secret_key/);
    }
    const line = JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET, supabase_secret_key: "" });
    try {
      parseLaunchSecrets(line);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });

  it("sets nothing before the line is read, or when it carries no keys", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyLaunchConfigSecrets(env)).toEqual([]);
    expect(parseLaunchSecrets(JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET }))).toEqual({
      appCredential: CREDENTIAL,
      internalSecret: SECRET,
    });
  });

  it("reads one JSON line, keeps it in memory, and drops what follows", async () => {
    const input = new PassThrough();
    const reading = readLaunchSecrets(input);
    input.write('{"app_credential":"' + CREDENTIAL + '",');
    input.write('"internal_secret":"' + SECRET + '"}\nignored line\n');
    await expect(reading).resolves.toEqual({ appCredential: CREDENTIAL, internalSecret: SECRET });
    expect(launchSecrets()).toEqual({ appCredential: CREDENTIAL, internalSecret: SECRET });
    expect(ncAppCredential()).toBe(CREDENTIAL);
    input.end();
  });

  it("tells the backend once when stdin ends after the line (the launcher is gone)", async () => {
    const input = new PassThrough();
    const onEnd = vi.fn();
    const reading = readLaunchSecrets(input, onEnd);
    input.write(JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET }) + "\n");
    await reading;
    expect(onEnd).not.toHaveBeenCalled();
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("fails when stdin ends before the line, or the line is not the secrets", async () => {
    const early = new PassThrough();
    const reading = readLaunchSecrets(early);
    early.end('{"app_credential":"x"');
    await expect(reading).rejects.toThrow(/ended before/);

    const garbage = new PassThrough();
    const bad = readLaunchSecrets(garbage);
    garbage.write("app_credential=x internal_secret=" + SECRET + "\n");
    // The error never repeats the line: it holds the secrets.
    await expect(bad).rejects.toThrow("the launcher's secrets line is not JSON");
    await bad.catch((error: Error) => expect(error.message).not.toContain(SECRET));
    expect(launchSecrets()).toBeNull();
  });

  it("requires both values, the internal secret at least 32 characters", () => {
    expect(() => parseLaunchSecrets("{}")).toThrow(/app_credential/);
    expect(() => parseLaunchSecrets('{"app_credential":"c"}')).toThrow(/internal_secret/);
    expect(() => parseLaunchSecrets('{"app_credential":"c","internal_secret":"short"}')).toThrow(/internal_secret/);
    expect(() => parseLaunchSecrets("[1]")).toThrow(/app_credential/);
  });

  it("compares the header with the secret whatever its length", () => {
    expect(internalSecretMatches(SECRET, SECRET)).toBe(true);
    expect(internalSecretMatches(SECRET + "b", SECRET)).toBe(false);
    expect(internalSecretMatches("b", SECRET)).toBe(false);
    expect(internalSecretMatches("", SECRET)).toBe(false);
    expect(internalSecretMatches(undefined, SECRET)).toBe(false);
    expect(internalSecretMatches([SECRET], SECRET)).toBe(false);
  });

  it("is on only with MIKE_INTERNAL_SECRET_STDIN=1", () => {
    expect(ncIngressEnabled({})).toBe(false);
    expect(ncIngressEnabled({ MIKE_INTERNAL_SECRET_STDIN: "true" })).toBe(false);
    expect(ncIngressEnabled({ MIKE_INTERNAL_SECRET_STDIN: "1" })).toBe(true);
  });
});

function appBehindTheDoor(secret: () => string | null = () => SECRET) {
  const app = express();
  app.use(ncIngress({ secret }));
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.all("/echo{/*rest}", async (req, res) => {
    // An await, as a route's database read would be.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const scope = currentNcScope();
    res.json({
      scope,
      origin: ncOriginFor(),
      body: req.body ?? null,
      internal: req.headers["x-nc-internal"] ?? null,
    });
  });
  return app;
}

describe("the backend's door", () => {
  it("answers 403 to every request without the right X-NC-Internal, /health too", async () => {
    const app = appBehindTheDoor();
    expect((await request(app).get("/health")).status).toBe(403);
    expect((await request(app).get("/health").set("X-NC-Internal", "wrong")).status).toBe(403);
    expect((await request(app).get("/health").set("X-NC-Internal", SECRET.slice(1))).status).toBe(403);
    const ok = await request(app).get("/health").set("X-NC-Internal", SECRET);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });

  it("answers 403 while the launcher's secret is not yet known", async () => {
    const app = appBehindTheDoor(() => null);
    expect((await request(app).get("/health").set("X-NC-Internal", SECRET)).status).toBe(403);
  });

  it("takes the default secret from the launcher's line", async () => {
    const app = express();
    app.use(ncIngress());
    app.get("/health", (_req, res) => res.json({ ok: true }));
    expect((await request(app).get("/health").set("X-NC-Internal", SECRET)).status).toBe(403);
    const input = new PassThrough();
    const reading = readLaunchSecrets(input);
    input.write(JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET }) + "\n");
    await reading;
    expect((await request(app).get("/health").set("X-NC-Internal", SECRET)).status).toBe(200);
    input.end();
  });

  it("puts the ticket's person and request into the request's scope, past the body parser and awaits", async () => {
    const res = await request(appBehindTheDoor())
      .post("/echo/chat")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_abc123")
      .set("X-NC-Request", "r_456")
      .send({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: "world" });
    expect(res.body.scope.request).toMatchObject({ person: "p_abc123", request: "r_456", task: "assistant" });
    expect(res.body.origin).toMatchObject({
      ticket: { origin: "request", person: "p_abc123", request: "r_456" },
      lane: "P",
      task: "assistant",
    });
    // The secret goes no further than the door.
    expect(res.body.internal).toBeNull();
  });

  it("names the task by the route, and long work a request starts waits as a job", async () => {
    const tabular = await request(appBehindTheDoor())
      .post("/echo/tabular-review/r1/generate")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_1")
      .send({});
    expect(tabular.body.origin).toMatchObject({
      task: "tabular",
      lane: "B",
      job: true,
      ticket: { origin: "job", from: "request", person: "p_1", request: "r_1" },
    });
    const tabularChat = await request(appBehindTheDoor())
      .post("/echo/tabular-review/r1/chat")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_2");
    expect(tabularChat.body.origin.task).toBe("assistant");
    const memory = await request(appBehindTheDoor())
      .get("/echo/projects/x/memory")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_3");
    expect(memory.body.origin.task).toBe("memory");
    const playbook = await request(appBehindTheDoor())
      .post("/echo/playbooks/p/review")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_4");
    expect(playbook.body.origin.task).toBe("playbook");
  });

  // Review L1: Express routes /Tabular-Review/… as /tabular-review/…, and
  // the task was read from the path as written: long work in lane P.
  it("names the task by the route whatever the case of its path", async () => {
    const tabular = await request(appBehindTheDoor())
      .post("/echo/TABULAR-REVIEW/r1/generate")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_5");
    expect(tabular.body.origin).toMatchObject({ task: "tabular", lane: "B", job: true });
    const playbook = await request(appBehindTheDoor())
      .post("/echo/PlayBooks/p/review")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p_1")
      .set("X-NC-Request", "r_6");
    expect(playbook.body.origin.task).toBe("playbook");
  });

  // Review L3: one rule for a person id. The ingress took any id of
  // `[A-Za-z0-9._:~-]`, the sign-in `p_` and `[A-Za-z0-9._-]`, the
  // connectors `p_` and letters and digits: an id one read as a person
  // another read as no one.
  it("reads a person by the one rule every part of Mike reads it with", async () => {
    for (const [sent, kept] of [
      ["p_7f3a", "p_7f3a"],
      ["p_" + "a".repeat(64), "p_" + "a".repeat(64)],
      ["p_" + "a".repeat(65), ""],
      ["p_al.ice", ""],
      ["p_al-ice", ""],
      ["p_a:b", ""],
      ["alice", ""],
      ["p_", ""],
    ]) {
      const res = await request(appBehindTheDoor())
        .get("/echo/x")
        .set("X-NC-Internal", SECRET)
        .set("X-NC-Person", sent)
        .set("X-NC-Request", "r_7");
      expect(res.body.scope.request.person, sent).toBe(kept);
    }
  });

  it("keeps a person or request id that is not an id out of the scope", async () => {
    const res = await request(appBehindTheDoor())
      .get("/echo/x")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "p 1; drop")
      .set("X-NC-Request", "");
    expect(res.body.scope.request).toMatchObject({ person: "", request: "" });
  });

  it("runs the host's beat for the launcher, never for a request a browser made", async () => {
    vi.stubEnv("MIKE_NC_APP", "1");
    const tick = vi.fn(async () => ["stale", "retention"]);
    setNcTickHandler(tick);
    const app = appBehindTheDoor();
    const beat = await request(app).post("/nc/v1/tick").set("X-NC-Internal", SECRET);
    expect(beat.status).toBe(200);
    expect(beat.body).toEqual({ ok: true, ran: ["stale", "retention"] });
    expect(tick).toHaveBeenCalledTimes(1);

    // Every request the launcher passes on carries X-NC-Person and X-NC-Request.
    const proxied = await request(app)
      .post("/nc/v1/tick")
      .set("X-NC-Internal", SECRET)
      .set("X-NC-Person", "")
      .set("X-NC-Request", "r_9");
    expect(proxied.status).toBe(404);
    expect(tick).toHaveBeenCalledTimes(1);
    expect((await request(app).post("/nc/v1/tick")).status).toBe(403);
  });

  it("leaves the beat's path alone outside the app", async () => {
    const tick = vi.fn(async () => []);
    setNcTickHandler(tick);
    const res = await request(appBehindTheDoor()).post("/nc/v1/tick").set("X-NC-Internal", SECRET);
    expect(res.status).toBe(404);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe("the real app behind the door", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("mounts the door first when MIKE_INTERNAL_SECRET_STDIN=1, and not otherwise", async () => {
    vi.stubEnv("SUPABASE_URL", "http://supabase.test.local");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "k");
    vi.stubEnv("SUPABASE_SECRET_KEY", "s");
    const plain = (await import("../../../app.js")).app;
    expect((await request(plain).get("/health")).status).toBe(200);

    vi.resetModules();
    vi.stubEnv("MIKE_INTERNAL_SECRET_STDIN", "1");
    const { app } = await import("../../../app.js");
    const secrets = await import("../launchSecrets.js");
    const input = new PassThrough();
    const reading = secrets.readLaunchSecrets(input);
    input.write(JSON.stringify({ app_credential: CREDENTIAL, internal_secret: SECRET }) + "\n");
    await reading;
    expect((await request(app).get("/health")).status).toBe(403);
    // Before every other middleware: an unknown route is refused, not 404.
    expect((await request(app).get("/no-such-route")).status).toBe(403);
    const ok = await request(app).get("/health").set("X-NC-Internal", SECRET);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    secrets.resetLaunchSecrets();
    input.end();
  });
});
