import type { Db } from "./supabase";

/**
 * Two keys in the NativeCluster app (lib/authApp.ts): NativeCluster's person
 * AND Mike's account. Accounts are per computer there, and several people can
 * use one computer, each signed in to NativeCluster as themselves. A Mike
 * account belongs to the NativeCluster person who first signed in with it,
 * and a Mike session presented under any other person is refused, so knowing
 * (or finding) another person's Mike password on a shared computer is not
 * enough.
 *
 * The binding is a row per account in `public.nativecluster_account_people`
 * (migration 20261124_01), written once and never changed; it goes with the
 * account (on delete cascade). Bindings never change, so a match is cached
 * for the life of the process.
 */
const TABLE = "nativecluster_account_people";
const bound = new Map<string, string>();

export const NC_PERSON_REQUIRED_DETAIL =
  "Sign in to NativeCluster first, then log in to Mike.";
export const NC_PERSON_MISMATCH_DETAIL =
  "This Mike account belongs to another NativeCluster person on this " +
  "computer. Sign in to NativeCluster as that person, or log in to Mike " +
  "with an account of your own.";

export type AccountPersonCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "refused";
      status: 403;
      code: "nc_person_required" | "nc_person_mismatch";
      detail: string;
    }
  | { ok: false; reason: "lookup_failed"; error: unknown };

const required: AccountPersonCheck = {
  ok: false,
  reason: "refused",
  status: 403,
  code: "nc_person_required",
  detail: NC_PERSON_REQUIRED_DETAIL,
};
const mismatch: AccountPersonCheck = {
  ok: false,
  reason: "refused",
  status: 403,
  code: "nc_person_mismatch",
  detail: NC_PERSON_MISMATCH_DETAIL,
};

async function boundPerson(
  db: Db,
  userId: string,
): Promise<{ person: string | null; error: unknown }> {
  const { data, error } = await db
    .from(TABLE)
    .select("nc_person")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { person: null, error };
  const person = (data as { nc_person?: unknown } | null)?.nc_person;
  return { person: typeof person === "string" ? person : null, error: null };
}

/**
 * Check `userId` against the NativeCluster person `person` (empty for
 * nobody), binding the account to them if it is bound to nobody yet: its
 * first sign-in in the app. Two first sign-ins racing each other bind the
 * account once; the loser is refused.
 */
export async function claimAccountForPerson(
  db: Db,
  userId: string,
  person: string,
): Promise<AccountPersonCheck> {
  if (!person) return required;
  const cached = bound.get(userId);
  if (cached !== undefined) return cached === person ? { ok: true } : mismatch;

  const existing = await boundPerson(db, userId);
  if (existing.error) return { ok: false, reason: "lookup_failed", error: existing.error };
  let owner = existing.person;
  if (owner === null) {
    const { error } = await db
      .from(TABLE)
      .upsert(
        { user_id: userId, nc_person: person },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
    if (error) return { ok: false, reason: "lookup_failed", error };
    // Read it back: a first sign-in racing this one may have bound it first.
    const claimed = await boundPerson(db, userId);
    if (claimed.error) return { ok: false, reason: "lookup_failed", error: claimed.error };
    owner = claimed.person;
    if (owner === null) {
      return {
        ok: false,
        reason: "lookup_failed",
        error: new Error("account binding was not stored"),
      };
    }
  }
  bound.set(userId, owner);
  return owner === person ? { ok: true } : mismatch;
}

/** Test seam: forget the cached bindings. */
export function resetAccountPersonCache(): void {
  bound.clear();
}
