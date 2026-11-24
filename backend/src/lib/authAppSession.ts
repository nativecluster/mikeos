import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { supabaseSessionConfiguration } from "./runtimeConfig";
import { singleFlightRefreshFetch } from "./authRefresh";

/**
 * GoTrue clients for the NativeCluster app (lib/authApp.ts), where a Mike
 * session cannot live in a cookie: the browser keeps its tokens in
 * localStorage, the backend answers them in JSON bodies, and every request
 * presents the access token. Each client below is per request and keeps its
 * session in memory only, so nothing outlives the request on the server.
 *
 * GoTrue calls go through the same single-flight fetch as the cookie
 * clients (lib/authRefresh.ts): concurrent refreshes of one refresh token
 * share one GoTrue call, so a page's parallel requests never spend it twice.
 */
const refreshFetch = singleFlightRefreshFetch();
const STORAGE_KEY = "mike-app-session";

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function appClient(storage: MemoryStorage): SupabaseClient {
  const { url, key } = supabaseSessionConfiguration();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) must be set",
    );
  }
  return createClient(url, key, {
    global: { fetch: refreshFetch },
    auth: {
      storage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // No redirect flow runs in the app (Google, SSO and email links are
      // off there), so there is no code verifier to keep between requests.
      flowType: "implicit",
    },
  });
}

/** A client with no session yet: sign-in, sign-up and refresh. */
export function createAppAuthSupabase(): SupabaseClient {
  return appClient(new MemoryStorage());
}

/** The `exp` claim of a JWT, in Unix seconds, read without checking it. */
export function accessTokenExpiry(accessToken: string): number | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp
      : null;
  } catch {
    return null;
  }
}

/**
 * A client holding the session one request presented, for the routes that
 * act on it (the session, email, password, MFA, sign-out). Only the access
 * token travels on a request; the refresh token stays in the browser, so
 * this client can never refresh. GoTrue checked the token already
 * (middleware/auth.ts) and the browser refreshes well before the 90 s
 * margin auth-js keeps, so it never needs to.
 */
export function createAppSessionSupabase(
  accessToken: string,
  user?: User | null,
): SupabaseClient {
  const storage = new MemoryStorage();
  const expiresAt =
    accessTokenExpiry(accessToken) ?? Math.floor(Date.now() / 1000) + 60;
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "",
      token_type: "bearer",
      expires_at: expiresAt,
      expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      user: user ?? null,
    }),
  );
  return appClient(storage);
}

/** The tokens an app-mode answer carries for the browser to keep. */
export interface AppSessionTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  expires_in: number;
  token_type: string;
}

/**
 * The browser's copy of a GoTrue session: a sign-in's, a refresh's, or an
 * MFA verification's (which answers `expires_in` without `expires_at`).
 */
export function appSessionTokens(session: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
}): AppSessionTokens {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt =
    session.expires_at ??
    accessTokenExpiry(session.access_token) ??
    now + (session.expires_in ?? 3600);
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expiresAt,
    expires_in: session.expires_in ?? Math.max(0, expiresAt - now),
    token_type: session.token_type ?? "bearer",
  };
}
