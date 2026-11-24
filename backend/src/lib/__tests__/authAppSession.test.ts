import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenExpiry,
  appSessionTokens,
  createAppAuthSupabase,
  createAppSessionSupabase,
} from "../authAppSession";

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.signature`;
}

describe("NativeCluster app sessions", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://mike.internal";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-key";
  });

  it("reads a token's expiry without trusting anything else in it", () => {
    expect(accessTokenExpiry(jwt({ exp: 1_900_000_000 }))).toBe(1_900_000_000);
    expect(accessTokenExpiry(jwt({ sub: "user-1" }))).toBeNull();
    expect(accessTokenExpiry("not-a-jwt")).toBeNull();
    expect(accessTokenExpiry("a.%%%.c")).toBeNull();
  });

  it("answers the browser the tokens it keeps, with an absolute expiry", () => {
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    expect(
      appSessionTokens({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        expires_at: now + 3600,
        token_type: "bearer",
      }),
    ).toEqual({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      expires_at: now + 3600,
      token_type: "bearer",
    });
    // An MFA verification answers expires_in alone.
    const verified = appSessionTokens({
      access_token: "opaque",
      refresh_token: "refresh-2",
      expires_in: 1800,
    });
    expect(verified.expires_at).toBe(now + 1800);
    expect(verified.token_type).toBe("bearer");
    vi.useRealTimers();
  });

  it("holds the presented session in memory, so GoTrue is asked nothing to read it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = jwt({ exp, sub: "user-1", aal: "aal1", amr: [] });
    const client = createAppSessionSupabase(token, { id: "user-1" } as never);
    const { data } = await client.auth.getSession();
    expect(data.session?.access_token).toBe(token);
    expect(data.session?.expires_at).toBe(exp);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("starts sign-in clients with no session, each its own", async () => {
    const first = createAppAuthSupabase();
    const second = createAppAuthSupabase();
    expect(first).not.toBe(second);
    expect((await first.auth.getSession()).data.session).toBeNull();
  });

  it("needs GoTrue's address and key", () => {
    delete process.env.SUPABASE_URL;
    expect(() => createAppAuthSupabase()).toThrow(/SUPABASE_URL/);
  });
});
