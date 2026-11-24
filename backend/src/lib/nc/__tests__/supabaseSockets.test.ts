import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  installSupabaseSocketFetch,
  supabaseSocketFetch,
  supabaseSocketRoute,
  supabaseSockets,
} from "../supabaseSockets";
import { closeUnixSocketAgents } from "../unixFetch";
import { createServerSupabase } from "../../supabase";
import { singleFlightRefreshFetch } from "../../authRefresh";
import { socketDir, startUnixServer, type UnixServer } from "./unixServer";

let dir: string;
let rest: UnixServer;
let auth: UnixServer;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = socketDir();
  rest = await startUnixServer(
    (req, res) => {
      if (req.url?.startsWith("/slow")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("first ");
        // The second part only after the client asked for it (/slow?go).
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: 1, url: req.url }]));
    },
    { dir, name: "rest.sock" },
  );
  auth = await startUnixServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ users: [], aud: "authenticated", url: req.url }));
    },
    { dir, name: "auth.sock" },
  );
  env = {
    SUPABASE_URL: "http://mike.internal",
    MIKE_REST_SOCKET: rest.socketPath,
    MIKE_AUTH_SOCKET: auth.socketPath,
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeUnixSocketAgents();
  await rest.close();
  await auth.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("supabaseSocketRoute", () => {
  const sockets = { base: "http://mike.internal", rest: "/s/rest.sock", auth: "/s/auth.sock" };

  it("sends /rest/v1/* to PostgREST and /auth/v1/* to GoTrue, each without its prefix", () => {
    expect(supabaseSocketRoute("http://mike.internal/rest/v1/chats?select=*&id=eq.1", sockets)).toEqual({
      socketPath: "/s/rest.sock",
      url: "http://mike.internal/chats?select=*&id=eq.1",
    });
    expect(supabaseSocketRoute("http://mike.internal/rest/v1/rpc/claim_db_jobs", sockets)).toEqual({
      socketPath: "/s/rest.sock",
      url: "http://mike.internal/rpc/claim_db_jobs",
    });
    expect(supabaseSocketRoute("http://mike.internal/auth/v1/token?grant_type=refresh_token", sockets)).toEqual({
      socketPath: "/s/auth.sock",
      url: "http://mike.internal/token?grant_type=refresh_token",
    });
    expect(supabaseSocketRoute("http://mike.internal/rest/v1", sockets)?.url).toBe("http://mike.internal/");
    expect(supabaseSocketRoute("http://mike.internal/rest/v1?x=1", sockets)?.url).toBe("http://mike.internal/?x=1");
  });

  it("leaves every other URL alone", () => {
    expect(supabaseSocketRoute("http://mike.internal/storage/v1/object/x", sockets)).toBeNull();
    expect(supabaseSocketRoute("http://mike.internal/rest/v10/x", sockets)).toBeNull();
    expect(supabaseSocketRoute("https://example.com/rest/v1/x", sockets)).toBeNull();
    expect(
      supabaseSocketRoute("http://mike.internal/auth/v1/user", { base: sockets.base, rest: sockets.rest }),
    ).toBeNull();
  });

  it("is off unless a socket is set", () => {
    expect(supabaseSockets({ SUPABASE_URL: "http://mike.internal" })).toBeNull();
    expect(supabaseSocketFetch({ SUPABASE_URL: "http://mike.internal" })).toBeUndefined();
    expect(supabaseSockets({ MIKE_REST_SOCKET: "/s/rest.sock" })).toBeNull();
    expect(supabaseSockets({ SUPABASE_URL: "http://mike.internal/", MIKE_REST_SOCKET: "/r" })).toEqual({
      base: "http://mike.internal",
      rest: "/r",
    });
  });
});

describe("supabaseSocketFetch over real sockets", () => {
  it("carries method, headers and body, and answers with a global Response", async () => {
    const fetchVia = supabaseSocketFetch(env)!;
    const response = await fetchVia("http://mike.internal/rest/v1/rpc/f?x=1", {
      method: "POST",
      headers: { apikey: "k", "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1, url: "/rpc/f?x=1" }]);
    expect(rest.seen).toHaveLength(1);
    expect(rest.seen[0]).toMatchObject({ method: "POST", url: "/rpc/f?x=1", body: '{"a":1}' });
    expect(rest.seen[0].headers.apikey).toBe("k");
    expect(rest.seen[0].headers.prefer).toBe("return=representation");
    expect(rest.seen[0].headers.host).toBe("mike.internal");
  });

  it("streams a body sent as a ReadableStream", async () => {
    const fetchVia = supabaseSocketFetch(env)!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part one, "));
        controller.enqueue(new TextEncoder().encode("part two"));
        controller.close();
      },
    });
    await (await fetchVia("http://mike.internal/rest/v1/upload", { method: "POST", body })).text();
    expect(rest.seen[0].body).toBe("part one, part two");
  });

  it("passes an answer on as it streams, and an abort ends it", async () => {
    const fetchVia = supabaseSocketFetch(env)!;
    const controller = new AbortController();
    const response = await fetchVia("http://mike.internal/rest/v1/slow", { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    // The server has sent only its first part and is still holding the answer.
    expect(new TextDecoder().decode(first.value)).toBe("first ");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("refuses at once on an already aborted signal", async () => {
    const fetchVia = supabaseSocketFetch(env)!;
    await expect(
      fetchVia("http://mike.internal/rest/v1/x", { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(rest.seen).toHaveLength(0);
  });

  it("reads a Request's own fields", async () => {
    const fetchVia = supabaseSocketFetch(env)!;
    await fetchVia(
      new Request("http://mike.internal/auth/v1/admin/users?page=2", {
        method: "PUT",
        headers: { authorization: "Bearer svc" },
        body: "{}",
      }),
    );
    expect(auth.seen[0]).toMatchObject({ method: "PUT", url: "/admin/users?page=2", body: "{}" });
    expect(auth.seen[0].headers.authorization).toBe("Bearer svc");
  });

  it("sends a URL no socket serves to the base fetch", async () => {
    const base = vi.fn(async () => new Response("elsewhere"));
    const fetchVia = supabaseSocketFetch(env, base as unknown as typeof fetch)!;
    expect(await (await fetchVia("http://mike.internal/storage/v1/object/x")).text()).toBe("elsewhere");
    expect(await (await fetchVia("https://example.com/rest/v1/x")).text()).toBe("elsewhere");
    expect(base).toHaveBeenCalledTimes(2);
    expect(rest.seen).toHaveLength(0);
  });
});

describe("supabase-js through the sockets", () => {
  it("createServerSupabase reaches PostgREST and GoTrue over their sockets", async () => {
    vi.stubEnv("SUPABASE_URL", "http://mike.internal");
    vi.stubEnv("SUPABASE_SECRET_KEY", "service-key");
    vi.stubEnv("MIKE_REST_SOCKET", rest.socketPath);
    vi.stubEnv("MIKE_AUTH_SOCKET", auth.socketPath);
    // Nothing reaches the network: a fetch that is called fails the test.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("global fetch used"); }));
    const db = createServerSupabase();
    const { data, error } = await db.from("chats").select("id").eq("id", 1);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1, url: "/chats?select=id&id=eq.1" }]);
    expect(rest.seen[0].headers.apikey).toBe("service-key");

    const users = await db.auth.admin.listUsers();
    expect(users.error).toBeNull();
    expect(auth.seen[0].url).toMatch(/^\/admin\/users/);
  });

  it("the installed global fetch routes clients made without a fetch of their own", async () => {
    const original = vi.fn(async () => new Response("not supabase"));
    vi.stubGlobal("fetch", original);
    expect(installSupabaseSocketFetch(env)).toBe(true);
    // Idempotent: a second install does not wrap twice.
    expect(installSupabaseSocketFetch(env)).toBe(true);
    const client = createClient("http://mike.internal", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await client.from("profiles").select("*");
    expect(data).toEqual([{ id: 1, url: "/profiles?select=*" }]);
    expect(await (await fetch("https://example.com/")).text()).toBe("not supabase");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("routes a fetch resolved at call time (the session clients' refresh fetch) and a direct fetch to SUPABASE_URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not supabase")));
    installSupabaseSocketFetch(env);
    // lib/authSession.ts hands GoTrue this fetch; it reads globalThis.fetch per call.
    const refresh = singleFlightRefreshFetch();
    const token = await refresh("http://mike.internal/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: "r" }),
    });
    expect(token.status).toBe(200);
    expect(auth.seen[0]).toMatchObject({ method: "POST", url: "/token?grant_type=refresh_token" });
    // GoTrue's public settings, read with a plain fetch of SUPABASE_URL.
    await (await fetch("http://mike.internal/auth/v1/settings", { headers: { apikey: "k" } })).text();
    expect(auth.seen[1]).toMatchObject({ method: "GET", url: "/settings" });
    expect(rest.seen).toHaveLength(0);
  });

  it("installs nothing when the sockets are off", () => {
    const original = globalThis.fetch;
    expect(installSupabaseSocketFetch({ SUPABASE_URL: "http://mike.internal" })).toBe(false);
    expect(globalThis.fetch).toBe(original);
  });
});
