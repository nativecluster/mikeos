import type { Db } from "./supabase";

/**
 * NativeCluster's people as Mike accounts, in the NativeCluster app
 * (lib/authApp.ts). Each NativeCluster person has one Mike account on the
 * computer, made on their first request by `public.nc_ensure_user` (migration
 * 20261124_01): an auth.users row written in SQL, since GoTrue does not run
 * in the app, whose insert fires the usual triggers (profile, personal
 * organization, memory). The person's email comes from NativeCluster
 * (people.read); without one the account's is `<person>@people.invalid`.
 *
 * A person's account never changes, so it is cached for the life of the
 * process, with the email it was asked for: a new email from NativeCluster
 * asks the database again, which updates the account's.
 */
export interface NcPersonAccount {
  userId: string;
  /** The account's email now: NativeCluster's, or the placeholder. */
  email: string;
}

export const NC_PERSON_REQUIRED_DETAIL = "Sign in to NativeCluster to use Mike.";

const accounts = new Map<string, { askedEmail: string; account: NcPersonAccount }>();

export type EnsureNcPersonResult =
  | { ok: true; account: NcPersonAccount }
  | { ok: false; error: unknown };

export async function ensureNcPersonAccount(
  db: Db,
  person: { id: string; email: string; name: string },
): Promise<EnsureNcPersonResult> {
  const cached = accounts.get(person.id);
  if (cached && cached.askedEmail === person.email) {
    return { ok: true, account: cached.account };
  }
  const { data, error } = await db.rpc("nc_ensure_user", {
    p_person: person.id,
    p_email: person.email || null,
    p_name: person.name || null,
  });
  if (error) return { ok: false, error };
  const answer = (Array.isArray(data) ? data[0] : data) as
    | { user_id?: unknown; email?: unknown }
    | null
    | undefined;
  if (typeof answer?.user_id !== "string" || typeof answer.email !== "string") {
    return { ok: false, error: new Error("nc_ensure_user answered no account") };
  }
  const account = { userId: answer.user_id, email: answer.email.toLowerCase() };
  accounts.set(person.id, { askedEmail: person.email, account });
  return { ok: true, account };
}

/** Test seam: forget the cached accounts. */
export function resetNcPersonAccounts(): void {
  accounts.clear();
}
