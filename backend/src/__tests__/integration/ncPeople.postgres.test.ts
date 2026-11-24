import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// nc_ensure_user, NativeCluster's sign-in for Mike in the NativeCluster app,
// against real PostgreSQL semantics: a disposable database in Docker
// (MIKE_TEST_POSTGRES_CONTAINER) or PGlite (MIKE_TEST_PGLITE_MODULE, the
// path or file URL of @electric-sql/pglite's dist/index.js), as in
// orgLifecycle.postgres.test.ts. auth.users is reduced to the GoTrue columns
// the function writes, with GoTrue's unique email index.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const pgliteModule = process.env.MIKE_TEST_PGLITE_MODULE;
const database = `mike_nc_people_${process.pid}_${Date.now()}`;
let embedded:
  | {
      exec: (s: string) => Promise<unknown>;
      query: (s: string) => Promise<{ rows: Record<string, unknown>[] }>;
      close: () => Promise<void>;
    }
  | undefined;
const dockerSql = (s: string) =>
  execFileSync(
    "docker",
    ["exec", "-i", container!, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-XqAt", "-F", "|"],
    { input: s, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
const execute = async (s: string) => {
  if (embedded) await embedded.exec(s);
  else dockerSql(s);
};
/** The first row's columns, as text, in order. */
const row = async (s: string): Promise<string[]> => {
  if (embedded) {
    const first = (await embedded.query(s)).rows[0] ?? {};
    return Object.values(first).map((v) => (v === null ? "" : String(v)));
  }
  return dockerSql(s).split("\n")[0]!.split("|");
};
const ensure = (person: string, email: string | null = null, name: string | null = null) =>
  row(
    `select user_id, email from public.nc_ensure_user('${person}', ${email === null ? "null" : `'${email}'`}, ${name === null ? "null" : `'${name}'`})`,
  );

const AUTH_USERS = `
create schema auth;
create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  confirmation_token varchar(255),
  recovery_token varchar(255),
  email_change_token_new varchar(255),
  email_change varchar(255),
  is_sso_user boolean not null default false
);
create unique index users_email_partial_key on auth.users (email) where (is_sso_user = false);
`;

describe.skipIf(!container && !pgliteModule)("nc_ensure_user in PostgreSQL", () => {
  let created = false;
  beforeAll(async () => {
    if (pgliteModule) {
      const href = pgliteModule.startsWith("file:") ? pgliteModule : new URL(`file://${resolve(pgliteModule)}`).href;
      const { PGlite } = await import(href);
      const { pgcrypto } = await import(new URL("./contrib/pgcrypto.js", href).href);
      const { pg_trgm } = await import(new URL("./contrib/pg_trgm.js", href).href);
      embedded = new PGlite({ extensions: { pgcrypto, pg_trgm } });
      await execute("create role anon; create role authenticated; create role service_role bypassrls;");
    } else {
      execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
      created = true;
    }
    await execute(AUTH_USERS);
    await execute(readFileSync(resolve("schema.sql"), "utf8"));
    // The migration replays cleanly over the schema that already has it.
    await execute(readFileSync(resolve("migrations/20261124_01_nativecluster_people.sql"), "utf8"));
  }, 120_000);
  afterAll(async () => {
    if (embedded) await embedded.close();
    if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
  });
  beforeEach(async () => {
    await execute("truncate auth.users, public.organizations cascade;");
  });

  it("makes a confirmed account for a new person, with the usual profile, organization and memory", async () => {
    const [userId, email] = await ensure("p_alice", "Alice@Firm.Example", "Alice Example");
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(email).toBe("alice@firm.example");
    expect(
      await row(
        `select email, email_confirmed_at is not null as confirmed, aud,
                raw_app_meta_data->>'provider' as provider, raw_user_meta_data->>'nc_person' as person
           from auth.users where id = '${userId}'`,
      ),
    ).toEqual(["alice@firm.example", "true", "authenticated", "nativecluster", "p_alice"]);
    expect(await row(`select email, display_name from public.user_profiles where user_id = '${userId}'`)).toEqual([
      "alice@firm.example",
      "Alice Example",
    ]);
    expect(await row(`select count(*) from public.org_members where user_id = '${userId}'`)).toEqual(["1"]);
    expect(
      await row(`select count(*) from public.memory_files where scope = 'user' and user_id = '${userId}'`),
    ).toEqual(["1"]);
  });

  it("answers the same account on every later request", async () => {
    const [first] = await ensure("p_alice", "alice@firm.example");
    const [again] = await ensure("p_alice", "alice@firm.example");
    expect(again).toBe(first);
    expect(await row("select count(*) from auth.users")).toEqual(["1"]);
    expect(await row("select count(*) from public.nativecluster_people")).toEqual(["1"]);
  });

  it("uses <person>@people.invalid without people.read, and NativeCluster's email once it has one", async () => {
    const [userId, placeholder] = await ensure("p_Bob");
    expect(placeholder).toBe("p_bob@people.invalid");
    const [same, real] = await ensure("p_Bob", "bob@firm.example");
    expect(same).toBe(userId);
    expect(real).toBe("bob@firm.example");
    expect(await row(`select email from public.user_profiles where user_id = '${userId}'`)).toEqual([
      "bob@firm.example",
    ]);
    // Losing people.read later never downgrades it.
    expect(await ensure("p_Bob")).toEqual([userId, "bob@firm.example"]);
  });

  it("never takes another account's email", async () => {
    const [alice] = await ensure("p_alice", "shared@firm.example");
    const [carol, email] = await ensure("p_carol", "shared@firm.example");
    expect(carol).not.toBe(alice);
    expect(email).toBe("p_carol@people.invalid");
    expect(await ensure("p_alice", "shared@firm.example")).toEqual([alice, "shared@firm.example"]);
  });

  it("refuses anything that is not a NativeCluster person", async () => {
    await expect(ensure("")).rejects.toThrow(/not a NativeCluster person/);
    await expect(ensure("alice@firm.example")).rejects.toThrow(/not a NativeCluster person/);
    expect(await row("select count(*) from auth.users")).toEqual(["0"]);
  });

  it("is gone with its account", async () => {
    const [userId] = await ensure("p_alice");
    await execute(`delete from auth.users where id = '${userId}'`);
    expect(await row("select count(*) from public.nativecluster_people")).toEqual(["0"]);
  });
});
