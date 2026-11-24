-- Migration date: 2026-11-24
-- The NativeCluster app's second key. Mike packaged as a NativeCluster app
-- (MIKE_NC_APP=1) runs on each person's own computer, where several people
-- may sign in to NativeCluster. Each Mike account belongs to the
-- NativeCluster person who first signed in with it, and a Mike session
-- presented under any other person is refused (backend/src/lib/
-- authPersonBinding.ts). Written once per account, never changed, and gone
-- with the account. Other deployments never write it.
create table if not exists public.nativecluster_account_people (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nc_person text not null check (length(nc_person) between 3 and 130),
  created_at timestamptz not null default now()
);

alter table public.nativecluster_account_people enable row level security;
revoke all on public.nativecluster_account_people from anon, authenticated;
grant all on public.nativecluster_account_people to service_role;
