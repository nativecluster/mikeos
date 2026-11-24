import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureNcPersonAccount, resetNcPersonAccounts } from "../authNcPeople";

function fakeDb(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => answer);
  return { db: { rpc } as never, rpc };
}

describe("NativeCluster people as Mike accounts", () => {
  beforeEach(() => resetNcPersonAccounts());

  it("asks nc_ensure_user for the person's account, with NativeCluster's email and name", async () => {
    const { db, rpc } = fakeDb({
      data: [{ user_id: "user-1", email: "alice@firm.example" }],
      error: null,
    });
    await expect(
      ensureNcPersonAccount(db, { id: "p_alice", email: "alice@firm.example", name: "Alice" }),
    ).resolves.toEqual({ ok: true, account: { userId: "user-1", email: "alice@firm.example" } });
    expect(rpc).toHaveBeenCalledWith("nc_ensure_user", {
      p_person: "p_alice",
      p_email: "alice@firm.example",
      p_name: "Alice",
    });
  });

  it("sends no email or name when NativeCluster gives none", async () => {
    const { db, rpc } = fakeDb({
      data: [{ user_id: "user-1", email: "p_alice@people.invalid" }],
      error: null,
    });
    const result = await ensureNcPersonAccount(db, { id: "p_alice", email: "", name: "" });
    expect(result).toEqual({ ok: true, account: { userId: "user-1", email: "p_alice@people.invalid" } });
    expect(rpc).toHaveBeenCalledWith("nc_ensure_user", {
      p_person: "p_alice",
      p_email: null,
      p_name: null,
    });
  });

  it("asks once per person and email, then answers from memory", async () => {
    const { db, rpc } = fakeDb({ data: [{ user_id: "user-1", email: "a@firm.example" }], error: null });
    const person = { id: "p_alice", email: "a@firm.example", name: "Alice" };
    await ensureNcPersonAccount(db, person);
    await ensureNcPersonAccount(db, person);
    expect(rpc).toHaveBeenCalledTimes(1);
    // A new email from NativeCluster goes to the database, which updates it.
    await ensureNcPersonAccount(db, { ...person, email: "alice@firm.example" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("fails, and remembers nothing, when the account cannot be made", async () => {
    const failing = fakeDb({ data: null, error: { code: "42883", message: "function does not exist" } });
    await expect(
      ensureNcPersonAccount(failing.db, { id: "p_alice", email: "", name: "" }),
    ).resolves.toMatchObject({ ok: false });
    const empty = fakeDb({ data: [], error: null });
    await expect(
      ensureNcPersonAccount(empty.db, { id: "p_alice", email: "", name: "" }),
    ).resolves.toMatchObject({ ok: false });
    expect(empty.rpc).toHaveBeenCalledTimes(1);
  });
});
