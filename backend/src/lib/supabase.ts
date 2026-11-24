import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseSocketFetch } from "./nc/supabaseSockets";

/**
 * The server-side database handle every service function takes as its first
 * argument. One name for the whole backend: services and job handlers accept
 * a `Db`, route handlers obtain one from `createServerSupabase()` and pass it
 * down. Declaring the alias here (instead of a private
 * `type Db = ReturnType<typeof createServerSupabase>` in every file) keeps
 * the seam explicit and lets tests substitute a fake with a single cast.
 */
export type Db = SupabaseClient<any, "public", any>;

let cachedAdminClient:
  | {
      url: string;
      key: string;
      sockets: string;
      client: SupabaseClient<any, "public", any>;
    }
  | undefined;

/**
 * Server-side Supabase client using the service role key.
 * Bypasses RLS — only use in API routes after verifying the user.
 *
 * Inside NativeCluster's sandbox (MIKE_REST_SOCKET / MIKE_AUTH_SOCKET) its
 * requests reach PostgREST and GoTrue over their unix sockets
 * (lib/nc/supabaseSockets.ts).
 */
export function createServerSupabase(): Db {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  }

  const sockets = `${process.env.MIKE_REST_SOCKET ?? ""}\n${process.env.MIKE_AUTH_SOCKET ?? ""}`;
  if (
    cachedAdminClient?.url === url &&
    cachedAdminClient.key === key &&
    cachedAdminClient.sockets === sockets
  ) {
    return cachedAdminClient.client;
  }

  const socketFetch = supabaseSocketFetch();
  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    ...(socketFetch ? { global: { fetch: socketFetch } } : {}),
  });
  cachedAdminClient = { url, key, sockets, client };
  return client;
}
