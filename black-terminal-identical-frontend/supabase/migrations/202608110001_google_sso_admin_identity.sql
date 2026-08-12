begin;

-- Administrator identity is explicit control-plane state. It must never come
-- from browser-editable user metadata or a role value supplied by OAuth.
create table if not exists public.bt_admin_identity_allowlist (
  email text primary key,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  constraint bt_admin_identity_allowlist_email_normalized
    check (email = lower(trim(email)) and position('@' in email) > 1)
);

alter table public.bt_admin_identity_allowlist enable row level security;
revoke all on public.bt_admin_identity_allowlist from anon, authenticated;

insert into public.bt_admin_identity_allowlist (email, note)
values ('danielnotexist@gmail.com', 'Black Terminal owner administrator identity')
on conflict (email) do nothing;

-- Keep Google profile bootstrap and administrative identity reconciliation in
-- one trigger so both new OAuth identities and later verified-email updates
-- receive the same deterministic role.
create or replace function public.black_terminal_create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text;
  resolved_display_name text;
  resolved_first_name text;
  resolved_last_name text;
  resolved_role text := 'user';
begin
  if new.email_confirmed_at is not null
     and exists (
       select 1
       from public.bt_admin_identity_allowlist admin_identity
       where admin_identity.email = lower(trim(new.email))
         and admin_identity.active
     ) then
    resolved_role := 'admin';
  end if;

  resolved_display_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    split_part(new.email, '@', 1),
    'Black Terminal User'
  );
  resolved_first_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'given_name', ''),
    nullif(split_part(resolved_display_name, ' ', 1), '')
  );
  resolved_last_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'family_name', ''),
    nullif(trim(substr(resolved_display_name, length(split_part(resolved_display_name, ' ', 1)) + 1)), '')
  );

  -- Reuse a pre-provisioned legacy profile when it has not yet been linked to
  -- an Auth identity. This preserves its administrator role and entitlements.
  update public.bt_users profile
  set auth_user_id = new.id,
      email = coalesce(new.email, profile.email),
      display_name = coalesce(nullif(profile.display_name, ''), resolved_display_name),
      first_name = coalesce(nullif(profile.first_name, ''), resolved_first_name),
      last_name = coalesce(nullif(profile.last_name, ''), resolved_last_name),
      email_verified = new.email_confirmed_at is not null,
      role = case when resolved_role = 'admin' then 'admin' else profile.role end,
      product_tier = case when resolved_role = 'admin' then 'admin' else profile.product_tier end
  where profile.username = (
    select candidate.username
    from public.bt_users candidate
    where candidate.auth_user_id is null
      and lower(candidate.email) = lower(new.email)
    order by (candidate.role = 'admin') desc, candidate.created_at asc
    limit 1
  )
    and not exists (
      select 1 from public.bt_users linked where linked.auth_user_id = new.id
    );

  -- Auth updates enrich the existing profile and only elevate from the
  -- server-owned allowlist. They never demote an administrator implicitly.
  update public.bt_users profile
  set email = coalesce(new.email, profile.email),
      display_name = coalesce(nullif(profile.display_name, ''), resolved_display_name),
      first_name = coalesce(nullif(profile.first_name, ''), resolved_first_name),
      last_name = coalesce(nullif(profile.last_name, ''), resolved_last_name),
      email_verified = new.email_confirmed_at is not null,
      role = case when resolved_role = 'admin' then 'admin' else profile.role end,
      product_tier = case when resolved_role = 'admin' then 'admin' else profile.product_tier end
  where profile.auth_user_id = new.id;
  if found then return new; end if;

  desired_username := lower(regexp_replace(
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
      split_part(new.email, '@', 1),
      'user'
    ),
    '[^a-zA-Z0-9_-]', '', 'g'
  ));
  if length(desired_username) < 3 then
    desired_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  if exists (select 1 from public.bt_users where username = desired_username) then
    desired_username := left(desired_username, 48) || '_' || substr(new.id::text, 1, 8);
  end if;

  insert into public.bt_users (
    username, email, role, status, auth_user_id, display_name,
    first_name, last_name, email_verified, product_tier, permissions
  ) values (
    desired_username, new.email, resolved_role, 'offline', new.id, resolved_display_name,
    resolved_first_name, resolved_last_name, new.email_confirmed_at is not null,
    case when resolved_role = 'admin' then 'admin' else 'retail' end,
    '[]'::jsonb
  )
  on conflict (username) do update
  set email = excluded.email,
      display_name = coalesce(nullif(public.bt_users.display_name, ''), excluded.display_name),
      first_name = coalesce(nullif(public.bt_users.first_name, ''), excluded.first_name),
      last_name = coalesce(nullif(public.bt_users.last_name, ''), excluded.last_name),
      email_verified = excluded.email_verified,
      role = case when excluded.role = 'admin' then 'admin' else public.bt_users.role end,
      product_tier = case when excluded.role = 'admin' then 'admin' else public.bt_users.product_tier end
  where public.bt_users.auth_user_id = excluded.auth_user_id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_black_terminal on auth.users;
create trigger on_auth_user_created_black_terminal
after insert or update of email, email_confirmed_at, raw_user_meta_data on auth.users
for each row execute function public.black_terminal_create_profile();

-- Reconcile users who completed Google SSO before this migration was applied.
update public.bt_users profile
set role = 'admin',
    product_tier = 'admin',
    email_verified = true
from auth.users identity
where profile.auth_user_id = identity.id
  and identity.email_confirmed_at is not null
  and exists (
    select 1
    from public.bt_admin_identity_allowlist admin_identity
    where admin_identity.email = lower(trim(identity.email))
      and admin_identity.active
  );

commit;
