-- Migration date: 2026-11-24
-- nc_ensure_user's placeholder email, for a NativeCluster person who comes
-- without one (no people.read, or their email is another account's), was
-- lower(<person id>)@people.invalid: two ids that differ only in case would
-- share it, and the second person's account could never be made (the
-- email's unique keys refuse it). It is now a hash of the id as given
-- (the 2026-11-24 security review, L8). Accounts made before keep their
-- email; only a new account's placeholder changes. Safe to re-run.

-- The Mike account of a NativeCluster person, made on their first request:
-- an auth.users row written here, confirmed, since GoTrue does not run in
-- the app. Its insert fires the usual triggers (the profile, the personal
-- organization, the memory file), so the account is like any other. The
-- email is the one NativeCluster gives (people.read), or
-- nc-<a hash of the person's id>@people.invalid without it or when another
-- account already has it; a real email NativeCluster gives later replaces a
-- placeholder or an older one, unless another account has it. Returns the
-- account and the email it has now.
create or replace function public.nc_ensure_user(
  p_person text,
  p_email text default null,
  p_name text default null
)
returns table (user_id uuid, email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person text := pg_catalog.btrim(coalesce(p_person, ''));
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_name text := nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_name, '')), 200), '');
  v_placeholder text;
  v_user uuid;
  v_current text;
begin
  if v_person !~ '^p_[A-Za-z0-9._-]{1,128}$' then
    raise exception 'not a NativeCluster person: %', v_person using errcode = '22023';
  end if;
  -- A hash of the id, whose case it keeps: two ids that differ only in
  -- case never share a placeholder (and the profile's lower(email) key).
  v_placeholder := 'nc-' || pg_catalog.left(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_person, 'UTF8')), 'hex'),
    32
  ) || '@people.invalid';
  if v_email = ''
     or pg_catalog.length(v_email) > 320
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or v_email like '%@people.invalid' then
    v_email := null;
  end if;

  -- One account per person, however many first requests race to make it.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('nc_ensure_user:' || v_person, 0)
  );

  select p.user_id into v_user
    from public.nativecluster_people as p
   where p.nc_person = v_person;

  if v_user is not null then
    select u.email into v_current from auth.users as u where u.id = v_user;
    if v_email is not null
       and v_current is distinct from v_email
       and not exists (
         select 1 from auth.users as u
          where pg_catalog.lower(u.email) = v_email and u.id <> v_user
       ) then
      update auth.users as u
         set email = v_email, updated_at = pg_catalog.now()
       where u.id = v_user;
      v_current := v_email;
    end if;
    return query select v_user, v_current;
    return;
  end if;

  if v_email is null or exists (
    select 1 from auth.users as u where pg_catalog.lower(u.email) = v_email
  ) then
    v_email := v_placeholder;
  end if;

  v_user := pg_catalog.gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user,
    'authenticated', 'authenticated', v_email, '',
    pg_catalog.now(),
    pg_catalog.jsonb_build_object(
      'provider', 'nativecluster',
      'providers', pg_catalog.jsonb_build_array('nativecluster')
    ),
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object('name', v_name, 'nc_person', v_person)
    ),
    pg_catalog.now(), pg_catalog.now(),
    '', '', '', ''
  );
  insert into public.nativecluster_people (nc_person, user_id)
  values (v_person, v_user);
  return query select v_user, v_email;
end;
$$;

revoke all on function public.nc_ensure_user(text, text, text)
  from public, anon, authenticated;
grant execute on function public.nc_ensure_user(text, text, text) to service_role;
