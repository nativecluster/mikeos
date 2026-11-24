import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAccountForPerson,
  resetAccountPersonCache,
} from "../authPersonBinding";

/** An in-memory `nativecluster_account_people`, with the PostgREST shape the code uses. */
function fakeDb(rows = new Map<string, string>()) {
  const calls = { selects: 0, upserts: 0 };
  const failures: { select?: unknown; upsert?: unknown } = {};
  let beforeInsert: (() => void) | null = null;
  const db = {
    from: vi.fn((table: string) => {
      expect(table).toBe("nativecluster_account_people");
      let userId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          userId = value;
          return query;
        },
        maybeSingle: async () => {
          calls.selects += 1;
          if (failures.select) return { data: null, error: failures.select };
          const person = rows.get(userId);
          return { data: person ? { nc_person: person } : null, error: null };
        },
        upsert: async (row: { user_id: string; nc_person: string }) => {
          calls.upserts += 1;
          if (failures.upsert) return { error: failures.upsert };
          beforeInsert?.();
          if (!rows.has(row.user_id)) rows.set(row.user_id, row.nc_person);
          return { error: null };
        },
      };
      return query;
    }),
  };
  return {
    db: db as never,
    rows,
    calls,
    failures,
    raceWith(person: string, userId: string) {
      beforeInsert = () => rows.set(userId, person);
    },
  };
}

describe("binding a Mike account to its NativeCluster person", () => {
  beforeEach(() => resetAccountPersonCache());

  it("binds an account to the person who first signs in with it", async () => {
    const fake = fakeDb();
    await expect(claimAccountForPerson(fake.db, "user-1", "p_alice")).resolves.toEqual({ ok: true });
    expect(fake.rows.get("user-1")).toBe("p_alice");
  });

  it("lets that person in again, from the cache once known", async () => {
    const fake = fakeDb(new Map([["user-1", "p_alice"]]));
    await expect(claimAccountForPerson(fake.db, "user-1", "p_alice")).resolves.toEqual({ ok: true });
    await expect(claimAccountForPerson(fake.db, "user-1", "p_alice")).resolves.toEqual({ ok: true });
    expect(fake.calls.selects).toBe(1);
    expect(fake.calls.upserts).toBe(0);
  });

  it("refuses anyone else, saying whose account it is", async () => {
    const fake = fakeDb(new Map([["user-1", "p_alice"]]));
    const refused = await claimAccountForPerson(fake.db, "user-1", "p_bob");
    expect(refused).toMatchObject({ ok: false, status: 403, code: "nc_person_mismatch" });
    expect(refused.ok === false && refused.reason === "refused" && refused.detail).toMatch(
      /belongs to another NativeCluster person on this computer/,
    );
    expect(fake.rows.get("user-1")).toBe("p_alice");
  });

  it("refuses everyone while nobody is signed in to NativeCluster, binding nothing", async () => {
    const fake = fakeDb();
    await expect(claimAccountForPerson(fake.db, "user-1", "")).resolves.toMatchObject({
      ok: false,
      code: "nc_person_required",
    });
    expect(fake.calls.selects + fake.calls.upserts).toBe(0);
  });

  it("binds once when two first sign-ins race, and refuses the loser", async () => {
    const fake = fakeDb();
    fake.raceWith("p_alice", "user-1");
    await expect(claimAccountForPerson(fake.db, "user-1", "p_bob")).resolves.toMatchObject({
      ok: false,
      code: "nc_person_mismatch",
    });
    expect(fake.rows.get("user-1")).toBe("p_alice");
  });

  it("fails closed when the binding cannot be read or written", async () => {
    const reading = fakeDb();
    reading.failures.select = { code: "08006", message: "connection lost" };
    await expect(claimAccountForPerson(reading.db, "user-1", "p_alice")).resolves.toMatchObject({
      ok: false,
      reason: "lookup_failed",
    });
    const writing = fakeDb();
    writing.failures.upsert = { code: "42P01", message: "missing table" };
    await expect(claimAccountForPerson(writing.db, "user-2", "p_alice")).resolves.toMatchObject({
      ok: false,
      reason: "lookup_failed",
    });
  });
});
